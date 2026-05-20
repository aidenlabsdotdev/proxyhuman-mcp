import { CdpSession } from './cdp.js';
import { RelayConnection } from './relay.js';
import { FfmpegPublisher } from './ffmpeg-publisher.js';
import type { ConnectOptions, BrowserSession, SessionState, SessionOutcome } from './types.js';
import { isTerminalState } from './types.js';
import type { ViewerJoined, ViewerLeft, ViewerCommand } from '@proxyhuman/protocol';

const DEFAULT_API = 'https://app.proxyhuman.ai';

/** Publisher self-description sent on new_session. Loaded from package.json. */
const PUBLISHER_NAME = '@proxyhuman/mcp';
// PUBLISHER_VERSION is injected by the bundler / read at runtime from package.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
let PUBLISHER_VERSION = 'unknown';
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
  if (pkg.version) PUBLISHER_VERSION = pkg.version;
} catch { /* dev mode, ignore */ }

export async function connectBrowser(opts: ConnectOptions): Promise<BrowserSession> {
  const apiUrl = opts.apiUrl ?? DEFAULT_API;

  // ── 1. Connect to Chrome via CDP, gather metadata BEFORE handshake ────────
  const cdp = new CdpSession();
  await cdp.connect(opts.cdpTarget);

  await cdp.cmd('Emulation.clearDeviceMetricsOverride').catch(() => {});

  // Read viewport size — we encode 1:1 so the page renders natural resolution.
  // libx264 needs even dimensions, so round down to 2.
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

  // Install the in-page focus observer (isolated world). Fires `Runtime.bindingCalled`
  // with name=__phFocus on every focus transition. We subscribe below, after the
  // relay handshake so the first event has a session to attach to.
  await cdp.installFocusObserver().catch((err) => {
    process.stderr.write(`[proxyhuman] installFocusObserver failed: ${err}\n`);
  });

  // Read initial URL + browser version for the session metadata.
  const tree = await cdp.cmd('Page.getFrameTree').catch(() => null) as
    | { frameTree?: { frame?: { url?: string } } }
    | null;
  const initialUrl = tree?.frameTree?.frame?.url ?? null;
  process.stderr.write(`[proxyhuman] initial frame URL: ${initialUrl ?? '(none)'}\n`);

  const browserInfo = await cdp.cmd('Browser.getVersion').catch(() => null) as
    | { product?: string; userAgent?: string }
    | null;

  // ── 2. Handshake with API, carrying full target metadata ──────────────────
  const relay = new RelayConnection(apiUrl, opts.apiKey);
  const handshake = await relay.connect({
    prompt: opts.prompt ?? null,
    publisher: {
      name: PUBLISHER_NAME,
      version: PUBLISHER_VERSION,
    },
    target: {
      cdpUrl: opts.cdpTarget,
      initialUrl,
      viewport: { width: viewport[0], height: viewport[1] },
      browserVersion: browserInfo?.product ?? null,
      userAgent: browserInfo?.userAgent ?? null,
    },
  });
  const { sessionId, whipUrl, viewerUrl } = handshake;
  process.stderr.write(`[proxyhuman] session=${sessionId} viewerUrl=${viewerUrl}\n`);
  process.stderr.write(`[proxyhuman] whipUrl=${whipUrl}\n`);

  // ── 3. URL tracking ───────────────────────────────────────────────────────
  let currentUrl = initialUrl ?? '';
  const sendUrl = (url: string) => {
    if (!url || url.startsWith('chrome-')) return;
    currentUrl = url;
    relay.send({ type: 'url_update', url });
  };

  cdp.on('Page.frameNavigated', (params: any) => {
    if (params?.frame?.parentId) return;
    sendUrl(params?.frame?.url ?? '');
  });

  if (initialUrl) sendUrl(initialUrl);

  // ── Sensitive-field detection ─────────────────────────────────────────────
  // Page-side observer calls window.__phFocus(json); CDP delivers it as
  // Runtime.bindingCalled. We forward to the relay so the API can flip
  // sensitive mode (input gets redacted in the recorded action log).
  let lastSensitive: boolean | null = null;
  cdp.on('Runtime.bindingCalled', (params: any) => {
    if (params?.name !== '__phFocus') return;
    let payload: { isSensitive?: boolean; fieldType?: string };
    try {
      payload = JSON.parse(params.payload ?? '{}');
    } catch {
      return;
    }
    const isSensitive = !!payload.isSensitive;
    if (isSensitive === lastSensitive) return;
    lastSensitive = isSensitive;
    relay.send({
      type: 'focus_changed',
      isSensitive,
      ...(payload.fieldType ? { fieldType: payload.fieldType } : {}),
    });
  });

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
      relay.send({ type: 'publish_started' });
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

  // ── 5. State machine ──────────────────────────────────────────────────────
  let state: SessionState = 'awaiting_viewer';
  let outcome: SessionOutcome | null = null;
  let viewerCount = 0;
  const stateListeners: Array<(from: SessionState | null, to: SessionState, o: SessionOutcome | null) => void> = [];
  const completeListeners: Array<() => void> = [];

  const transition = (to: SessionState, o: SessionOutcome | null = null) => {
    if (isTerminalState(state)) return;          // terminal is sticky
    if (state === to) return;                    // no-op
    const from = state;
    state = to;
    if (o) outcome = o;
    process.stderr.write(`[proxyhuman] state ${from} → ${to}${o ? ` (${o.type})` : ''}\n`);
    // Push to relay so api-worker can persist into the event log.
    try {
      relay.send({ type: 'state_changed', from, to, outcome: o ?? null });
    } catch {}
    for (const h of stateListeners) {
      try { h(from, to, o); } catch {}
    }
    if (isTerminalState(to)) {
      for (const h of completeListeners) {
        try { h(); } catch {}
      }
    }
  };

  // Request-timeout enforcement lives entirely server-side now (see the
  // DO alarm in api-worker). The server sends `cancel_handoff` when its
  // per-tier timeout elapses; we handle that below same as any other
  // cancel. Previously this MCP had its own hardcoded 30-min idle timer
  // that fired before the server's per-tier limit for Pro users (2h),
  // truncating sessions they were paying for.

  // CDP target died — fail hard.
  cdp.on('close', () => {
    if (!isTerminalState(state)) {
      transition('failed', { type: 'cdp_lost' });
      void teardown();
    }
  });

  // ffmpeg publisher crashed mid-stream.
  publisher.on('exit', () => {
    if (state === 'streaming') {
      transition('failed', { type: 'encoder_crash' });
      void teardown();
    }
  });

  let stopTimer: NodeJS.Timeout | null = null;
  relay.on('message', async (msg: ViewerJoined | ViewerLeft | ViewerCommand) => {
    if (msg.type === 'viewer_joined') {
      viewerCount = (msg as ViewerJoined).viewerCount;
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      transition('streaming');
      await startStream();
    } else if (msg.type === 'viewer_left') {
      viewerCount = (msg as ViewerLeft).viewerCount;
      if (viewerCount === 0) {
        if (stopTimer) clearTimeout(stopTimer);
        stopTimer = setTimeout(() => {
          stopTimer = null;
          transition('paused');
          stopStream().catch(() => {});
        }, 5_000);
      }
    } else if (msg.type === 'human_done') {
      process.stderr.write('[proxyhuman] human_done received\n');
      transition('complete', { type: 'human_done' });
      void teardown();
    } else if ((msg as { type: string }).type === 'cancel_handoff') {
      // API-worker forwarded an explicit cancel (dashboard / agent /sessions/:id/cancel).
      const reason = (msg as { reason?: string }).reason;
      process.stderr.write(`[proxyhuman] cancel_handoff${reason ? ` (${reason})` : ''}\n`);
      transition('cancelled', { type: 'cancelled', reason });
      void teardown();
    } else {
      await cdp.dispatchInput(msg as Record<string, unknown>, viewport).catch(() => {});
    }
  });

  relay.once('close', () => {
    // Only count as `failed` if we hadn't already reached a terminal state.
    if (!isTerminalState(state)) {
      transition('failed', { type: 'disconnected' });
      void teardown();
    }
  });

  async function teardown() {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    await stopStream().catch(() => {});
    cdp.close();
    relay.close();
  }

  // ── 6. Return session handle ──────────────────────────────────────────────
  return {
    sessionId,
    viewerUrl,
    get state() { return state; },
    get outcome() { return outcome; },
    get viewerCount() { return viewerCount; },
    async close() {
      await teardown();
    },
    async cancel(reason?: string) {
      if (isTerminalState(state)) return;
      transition('cancelled', { type: 'cancelled', reason });
      await teardown();
    },
    onDisconnect(handler: () => void) {
      relay.once('close', handler);
    },
    onComplete(handler: () => void) {
      completeListeners.push(handler);
      if (isTerminalState(state)) handler();
    },
    onStateChange(handler) {
      stateListeners.push(handler);
    },
  };
}

export type { ConnectOptions, BrowserSession };
