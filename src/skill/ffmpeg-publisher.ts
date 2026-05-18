import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { createWriteStream, type WriteStream, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Resolve the bundled ffmpeg binary relative to this module's location so it
// works whether we're imported from a node_modules install or run from src
// via tsx. The postinstall script in scripts/install-ffmpeg.mjs drops a
// WHIP-capable build at <package>/bin/ffmpeg.
function defaultFfmpegPath(): string {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = typeof __dirname === 'string' ? __dirname : process.cwd();
  }
  // After tsup bundle: dist/index.js → ../bin/ffmpeg
  // Running from src via tsx:  src/skill/ffmpeg-publisher.ts → ../../bin/ffmpeg
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    resolve(here, '..', 'bin', `ffmpeg${ext}`),
    resolve(here, '..', '..', 'bin', `ffmpeg${ext}`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}
const DEFAULT_FFMPEG = defaultFfmpegPath();

// ffmpeg's image2pipe demuxer behaves oddly when fed via a Node child_process
// stdio pipe (sometimes a socketpair on Linux): it never finishes detecting the
// input format. Routing JPEGs through a named pipe (FIFO) on disk makes ffmpeg
// see a normal POSIX pipe and the input pipeline starts immediately.
export class FfmpegPublisher extends EventEmitter {
  private proc: ChildProcess | null = null;
  private fifoPath: string | null = null;
  private fifoStream: WriteStream | null = null;
  private whipUrl: string;
  private apiKey: string;
  private ffmpegPath: string;

  constructor(whipUrl: string, apiKey: string, ffmpegPath?: string) {
    super();
    this.whipUrl = whipUrl;
    this.apiKey = apiKey;
    this.ffmpegPath = ffmpegPath ?? process.env.FFMPEG_PATH ?? DEFAULT_FFMPEG;
  }

  start(width: number, height: number): void {
    if (this.proc) return;

    this.fifoPath = `${tmpdir()}/proxyhuman-ffmpeg-${Date.now()}-${process.pid}.fifo`;
    if (existsSync(this.fifoPath)) unlinkSync(this.fifoPath);
    const mkResult = spawnSync('mkfifo', [this.fifoPath]);
    if (mkResult.status !== 0) {
      process.stderr.write(`[ffmpeg-publisher] mkfifo failed: ${mkResult.stderr?.toString()}\n`);
      return;
    }

    const args = [
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', '15',
      '-i', this.fifoPath,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '2000k',
      '-pix_fmt', 'yuv420p',
      '-vf', `scale=${width}:${height}`,
      '-g', '30',
      '-an',
      '-f', 'whip',
      '-handshake_timeout', '15000',
      // 1 MB UDP send buffer — default is too small for CF SFU's edge; we hit
      // EAGAIN inside libavformat when bursting keyframes otherwise.
      '-ts_buffer_size', '1048576',
      '-authorization', this.apiKey,
      this.whipUrl,
    ];

    process.stderr.write(`[ffmpeg-publisher] spawning: ${this.ffmpegPath} ${args.join(' ')}\n`);

    this.proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.fifoStream = createWriteStream(this.fifoPath);
    this.fifoStream.on('error', (err) => {
      process.stderr.write(`[ffmpeg-publisher] fifo write error: ${err}\n`);
    });

    let publishingEmitted = false;
    const watchForReady = (d: Buffer) => {
      process.stderr.write(`[ffmpeg] ${d}`);
      if (!publishingEmitted && d.includes('Muxer state=10')) {
        publishingEmitted = true;
        this.emit('publishing');
      }
    };
    this.proc.stdout?.on('data', watchForReady);
    this.proc.stderr?.on('data', watchForReady);
    this.proc.on('exit', (code) => {
      process.stderr.write(`[ffmpeg-publisher] exited with code ${code}\n`);
      this.cleanup();
    });
    this.proc.on('error', (err) => {
      process.stderr.write(`[ffmpeg-publisher] spawn error: ${err}\n`);
      this.cleanup();
    });
  }

  pushFrame(jpeg: Buffer): void {
    if (!this.fifoStream || this.fifoStream.destroyed) return;
    this.fifoStream.write(jpeg);
  }

  stop(): void {
    if (!this.proc) return;
    this.fifoStream?.end();
    setTimeout(() => this.proc?.kill(), 2000);
    this.proc = null;
  }

  private cleanup(): void {
    this.proc = null;
    this.fifoStream?.destroy();
    this.fifoStream = null;
    if (this.fifoPath && existsSync(this.fifoPath)) {
      try { unlinkSync(this.fifoPath); } catch {}
    }
    this.fifoPath = null;
  }
}
