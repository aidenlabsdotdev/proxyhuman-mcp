import { CdpSession } from './cdp.js';
import { RelayConnection } from './relay.js';
import { FfmpegPublisher } from './ffmpeg-publisher.js';
import type { ConnectOptions, BrowserSession } from './types.js';
import type { ViewerJoined, ViewerLeft, ViewerCommand } from '../protocol.js';

const DEFAULT_API = 'https://api.proxyhuman.ai';

export async function connectBrowser(opts: ConnectOptions): Promise<BrowserSession> {
  const apiUrl = opts.apiUrl ?? DEFAULT_API;

  // ── 1. Handshake with API ─────────────────────────────────────────────────
  const relay = new RelayConnection(apiUrl, opts.apiKey);
  const handshake = await relay.connect();
  const { sessionId, whipUrl, viewerUrl } = handshake;

  process.stderr.write(`[proxyhuman] session=${sessionId} viewerUrl=${viewerUrl}\n`);
  process.stderr.write(`[proxyhuman] whipUrl=${whipUrl}\n`);

  // ── 2. Connect to Chrome via CDP ──────────────────────────────────────────
  const cdp = new CdpSession();
  await cdp.connect(opts.cdpTarget);

  // Clear any stale viewport override from previous sessions so we read the
  // tab's true size below.
  await cdp.cmd('Emulation.clearDeviceMetricsOverride').catch(() => {});

  // Read the tab's actual viewport size — we encode 1:1 so the page renders at
  // its natural resolution. libx264 needs even dimensions, so round down to 2.
  const metrics = await cdp.cmd('Page.getLayoutMetrics') as {
    cssVisualViewport?: { clientWidth: number; clientHeight: number };
    visualViewport?: { clientWidth: number; clientHeight: number };
  };
  const vv = metrics.cssVisualViewport ?? metrics.visualViewport;
  const rawW = Math.max(2, Math.round(vv?.clientWidth ?? 1024));
  const rawH = Math.max(2, Math.round(vv?.clientHeight ?? 768));
  const viewport: [number, number] = [rawW & ~1, rawH & ~1];
  process.stderr.write(`[proxyhuman] tab viewport: ${viewport[0]}x${viewport[1]}\n`);

  await cdp.cmd('Page.enable').catch(() => {});

  let currentUrl = '';
  const sendUrl = (url: string) => {
    if (!url || url.startsWith('chrome-')) return;
    currentUrl = url;
    relay.send({ type: 'url_update', url });
  };

  cdp.on('Page.frameNavigated', (params: any) => {
    if (params?.frame?.parentId) return;
    sendUrl(params?.frame?.url ?? '');
  });

  const tree = await cdp.cmd('Page.getFrameTree').catch((e) => {
    process.stderr.write(`[proxyhuman] Page.getFrameTree failed: ${e}\n`);
    return null;
  }) as { frameTree?: { frame?: { url?: string } } } | null;
  process.stderr.write(`[proxyhuman] initial frame URL: ${tree?.frameTree?.frame?.url ?? '(none)'}\n`);
  if (tree?.frameTree?.frame?.url) sendUrl(tree.frameTree.frame.url);

  // ── 3. ffmpeg WHIP publisher (lazy: starts on first viewer) ───────────────
  const publisher = new FfmpegPublisher(whipUrl, opts.apiKey, opts.ffmpegPath);
  let streaming = false;

  const startStream = async () => {
    process.stderr.write(`[proxyhuman] startStream: currentUrl="${currentUrl}" streaming=${streaming}\n`);
    if (currentUrl) relay.send({ type: 'url_update', url: currentUrl });

    if (streaming) return;
    streaming = true;
    process.stderr.write('[proxyhuman] viewer joined — starting publish\n');
    try {
      const ready = new Promise<void>((resolve, reject) => {
        publisher.once('publishing', resolve);
        setTimeout(() => reject(new Error('WHIP handshake timed out')), 15_000);
      });
      publisher.start(viewport[0], viewport[1]);
      await cdp.startScreencast();
      await ready;
      relay.send({ type: 'stream_ready' });
      process.stderr.write('[proxyhuman] stream live — notified relay\n');
    } catch (err) {
      process.stderr.write(`[proxyhuman] startStream error: ${err}\n`);
      streaming = false;
    }
  };

  const stopStream = async () => {
    if (!streaming) return;
    streaming = false;
    await cdp.stopScreencast();
    publisher.stop();
    process.stderr.write('[proxyhuman] publish stopped\n');
  };

  // ── 4. Pipe CDP screencast frames → ffmpeg stdin ──────────────────────────
  let lastFrame: Buffer | null = null;
  let frameCount = 0;
  let keepAlivePushes = 0;
  const keepAlive = setInterval(() => {
    if (streaming && lastFrame) {
      publisher.pushFrame(lastFrame);
      keepAlivePushes++;
    }
  }, 60);
  setInterval(() => {
    if (streaming) process.stderr.write(`[proxyhuman] keepalive pushes=${keepAlivePushes} lastFrame=${lastFrame?.length ?? 'null'}\n`);
  }, 3000);
  setInterval(() => {
    if (streaming) process.stderr.write(`[proxyhuman] frames received: ${frameCount}\n`);
  }, 3000);
  cdp.on('Page.screencastFrame', async (params: any) => {
    frameCount++;
    const jpeg = Buffer.from(params.data, 'base64');
    lastFrame = jpeg;
    publisher.pushFrame(jpeg);
    await cdp.ackFrame(params.sessionId);
  });
  void keepAlive;

  // ── 5. Handle relay signals + input commands ──────────────────────────────
  let stopTimer: NodeJS.Timeout | null = null;
  relay.on('message', async (msg: ViewerJoined | ViewerLeft | ViewerCommand) => {
    if (msg.type === 'viewer_joined') {
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      await startStream();
    } else if (msg.type === 'viewer_left' && (msg as ViewerLeft).viewerCount === 0) {
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { stopTimer = null; stopStream().catch(() => {}); }, 5_000);
    } else if (msg.type === 'human_done') {
      process.stderr.write('[proxyhuman] human_done received — emitting complete\n');
      relay.emit('complete');
    } else {
      await cdp.dispatchInput(msg as Record<string, unknown>, viewport).catch(() => {});
    }
  });

  // ── 6. Return session handle ──────────────────────────────────────────────
  return {
    sessionId,
    viewerUrl,
    async close() {
      await stopStream();
      cdp.close();
      relay.close();
    },
    onDisconnect(handler: () => void) {
      relay.once('close', handler);
    },
    onComplete(handler: () => void) {
      relay.once('complete', handler);
    },
  };
}

export type { ConnectOptions, BrowserSession };
