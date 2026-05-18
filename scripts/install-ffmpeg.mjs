#!/usr/bin/env node
// Postinstall: fetch a WHIP-capable ffmpeg 8.1 static binary for the current
// platform and drop it into packages/browser-skill/bin/ffmpeg. Idempotent —
// re-runs check the existing binary and skip if it already has WHIP.
//
// Sources:
//   linux x64 / arm64  → BtbN/FFmpeg-Builds GitHub releases (n8.1 GPL static)
//   windows x64 / arm64 → BtbN
//   macOS              → evermeet.cx (BtbN doesn't build for darwin)
import { existsSync, mkdirSync, statSync, chmodSync, rmSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = resolve(PKG_DIR, 'bin');
const BIN = resolve(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// BtbN's `latest` release rolls forward and is what consistently has the
// versioned (`n8.1-latest`) asset names. Autobuild-dated releases use master
// commit hashes instead. We accept the rolling-forward risk in exchange for
// stable asset names.
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';

const SOURCES = {
  'linux-x64':    `${BTBN}/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz`,
  'linux-arm64':  `${BTBN}/ffmpeg-n8.1-latest-linuxarm64-gpl-8.1.tar.xz`,
  'win32-x64':    `${BTBN}/ffmpeg-n8.1-latest-win64-gpl-8.1.zip`,
  'win32-arm64':  `${BTBN}/ffmpeg-n8.1-latest-winarm64-gpl-8.1.zip`,
  // evermeet auto-redirects to the latest static darwin universal binary
  'darwin-x64':   'https://evermeet.cx/ffmpeg/getrelease/zip',
  'darwin-arm64': 'https://evermeet.cx/ffmpeg/getrelease/zip',
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
const url = SOURCES[key];
if (!url) {
  console.error(`[ffmpeg] no prebuilt for ${key}; please install a WHIP-capable ffmpeg manually and set FFMPEG_PATH`);
  process.exit(0); // don't fail npm install — let the runtime explain
}

mkdirSync(BIN_DIR, { recursive: true });
const tmpExt = url.endsWith('.zip') ? 'zip' : 'tar.xz';
const tmp = resolve(BIN_DIR, `_dl.${tmpExt}`);

console.log(`[ffmpeg] downloading ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`[ffmpeg] download failed: ${res.status} ${res.statusText}`);
  process.exit(0);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
console.log(`[ffmpeg] downloaded ${(statSync(tmp).size / 1024 / 1024).toFixed(1)} MB`);

// Extract just the ffmpeg binary. We use system tar/unzip — both are
// universally available on dev machines (tar is built into Windows 10+ too).
let r;
if (tmpExt === 'tar.xz') {
  r = spawnSync(
    'tar',
    ['-xJf', tmp, '--strip-components=2', '-C', BIN_DIR, '--wildcards', '*/bin/ffmpeg'],
    { stdio: 'inherit' },
  );
} else {
  // -j flattens directories; pick the ffmpeg(.exe) and the evermeet build has it at root
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
