#!/usr/bin/env node
// Postinstall: fetch a WHIP-capable ffmpeg 8.1 static binary for the current
// platform and drop it into <package>/bin/ffmpeg. Idempotent — re-runs check
// the existing binary and skip if it already has WHIP.
//
// All platforms pull from our own GitHub release. Upstream sources we mirror:
//   linux x64 / arm64   → BtbN/FFmpeg-Builds  (latest n8.1 GPL static)
//   windows x64 / arm64 → BtbN/FFmpeg-Builds
//   macOS x64 / arm64   → ffmpeg.martin-riedl.de  (the only WHIP-capable
//                         static darwin build — evermeet/Homebrew/OSXExperts
//                         all omit the WHIP muxer)
// Mirroring everything ourselves means one URL pattern, version-pinned, and
// no per-source rate-limit/asset-rename surprises. Refresh via
// `scripts/refresh-ffmpeg.mjs` (or by hand) when we bump the bundled version.
import { existsSync, mkdirSync, statSync, chmodSync, rmSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = resolve(PKG_DIR, 'bin');
const BIN = resolve(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const MIRROR_TAG = 'ffmpeg-v8.1.1';
const MIRROR = `https://github.com/aidenlabsdotdev/proxyhuman-mcp/releases/download/${MIRROR_TAG}`;

// Linux uses BtbN's tar.xz (binary at `<dir>/bin/ffmpeg`); everyone else uses
// a zip (binary at root, except win32 which is at `<dir>/bin/ffmpeg.exe`).
const ARCHIVES = {
  'linux-x64':    { url: `${MIRROR}/ffmpeg-linux-x64.tar.xz`,   ext: 'tar.xz' },
  'linux-arm64':  { url: `${MIRROR}/ffmpeg-linux-arm64.tar.xz`, ext: 'tar.xz' },
  'win32-x64':    { url: `${MIRROR}/ffmpeg-win32-x64.zip`,      ext: 'zip' },
  'win32-arm64':  { url: `${MIRROR}/ffmpeg-win32-arm64.zip`,    ext: 'zip' },
  'darwin-x64':   { url: `${MIRROR}/ffmpeg-darwin-x64.zip`,     ext: 'zip' },
  'darwin-arm64': { url: `${MIRROR}/ffmpeg-darwin-arm64.zip`,   ext: 'zip' },
};

function hasWhip(binPath) {
  const r = spawnSync(binPath, ['-hide_banner', '-h', 'muxer=whip'], { encoding: 'utf8' });
  return r.status === 0 && /WHIP/.test(r.stdout);
}

if (existsSync(BIN) && statSync(BIN).size > 1024 && hasWhip(BIN)) {
  console.log(`[ffmpeg] already installed (${BIN}), skipping`);
  process.exit(0);
}

const key = `${process.platform}-${process.arch}`;
const archive = ARCHIVES[key];
if (!archive) {
  console.error(`[ffmpeg] no prebuilt for ${key}; please install a WHIP-capable ffmpeg manually and set FFMPEG_PATH`);
  process.exit(0); // don't fail npm install — let the runtime explain
}

mkdirSync(BIN_DIR, { recursive: true });
const tmp = resolve(BIN_DIR, `_dl.${archive.ext}`);

console.log(`[ffmpeg] downloading ${archive.url}`);
const res = await fetch(archive.url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`[ffmpeg] download failed: ${res.status} ${res.statusText}`);
  process.exit(0);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
console.log(`[ffmpeg] downloaded ${(statSync(tmp).size / 1024 / 1024).toFixed(1)} MB`);

// Extract just the ffmpeg binary. We use system tar/unzip — both are
// universally available on dev machines (tar is built into Windows 10+ too).
let r;
if (archive.ext === 'tar.xz') {
  // BtbN linux archives: ffmpeg lives at `<dirname>/bin/ffmpeg`
  r = spawnSync(
    'tar',
    ['-xJf', tmp, '--strip-components=2', '-C', BIN_DIR, '--wildcards', '*/bin/ffmpeg'],
    { stdio: 'inherit' },
  );
} else {
  // -j flattens directories; matches ffmpeg(.exe) at root (martin-riedl) or
  // one level deep in a versioned folder (BtbN win32).
  r = spawnSync('unzip', ['-jo', tmp, '*/ffmpeg*', 'ffmpeg*', '-d', BIN_DIR], { stdio: 'inherit' });
}
rmSync(tmp);
if (r.status !== 0) {
  console.error(`[ffmpeg] extraction failed (exit ${r.status})`);
  process.exit(0);
}

chmodSync(BIN, 0o755);

if (!hasWhip(BIN)) {
  console.error('[ffmpeg] installed binary missing WHIP muxer — please report');
  process.exit(0);
}
console.log(`[ffmpeg] ✓ installed at ${BIN}`);
