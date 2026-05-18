import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

export class CdpSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private screencasting = false;

  /** Connect to a CDP target. If `tabMatch` is provided, it is matched as a
   *  case-insensitive substring against each tab's URL and title and the first
   *  match wins. Otherwise we probe each page target's `document.visibilityState`
   *  and pick the one Chrome considers visible (the user's active tab). */
  async connect(cdpHttpUrl: string, tabMatch?: string): Promise<void> {
    const base = cdpHttpUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/json`);
    const targets = await res.json() as CdpTarget[];
    const pages = targets.filter((t) => (t as any).type === 'page');

    let page: CdpTarget | undefined;
    if (tabMatch) {
      const needle = tabMatch.toLowerCase();
      page = pages.find((t) => {
        const url = ((t as any).url ?? '').toLowerCase();
        const title = ((t as any).title ?? '').toLowerCase();
        return url.includes(needle) || title.includes(needle);
      });
      if (!page) throw new Error(`No tab matching "${tabMatch}" at ${base}`);
    } else {
      const candidates = pages.filter((t) => /^https?:\/\//.test((t as any).url ?? ''));
      const visibilities = await Promise.all(
        candidates.map((t) => probeVisibility(t.webSocketDebuggerUrl).catch(() => null)),
      );
      const visibleIdx = visibilities.findIndex((v) => v === 'visible');
      page = visibleIdx >= 0 ? candidates[visibleIdx] : candidates[0] ?? pages[0];
    }
    if (!page) throw new Error(`No page target at ${base}`);
    process.stderr.write(`[proxyhuman] attached to tab: ${(page as any).title ?? ''} (${(page as any).url ?? '?'})\n`);
    await this.connectToTarget(page.webSocketDebuggerUrl);
  }

  async connectToTarget(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => { this.ws = ws; resolve(); });
      ws.on('error', reject);
      ws.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? {});
          }
        } else if (msg.method) {
          this.emit(msg.method, msg.params ?? {});
        }
      });
      ws.on('close', () => this.emit('close'));
    });
  }

  cmd(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('CDP not connected'));
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async startScreencast(quality = 60, everyNthFrame = 1): Promise<void> {
    if (this.screencasting) return;
    this.screencasting = true;
    await this.cmd('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame });
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencasting) return;
    this.screencasting = false;
    await this.cmd('Page.stopScreencast').catch(() => {});
  }

  async ackFrame(sessionId: number): Promise<void> {
    await this.cmd('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }

  async dispatchInput(msg: Record<string, unknown>, viewport: [number, number]): Promise<void> {
    const [vw, vh] = viewport;
    const type = msg.type as string;

    if (type === 'tap') {
      const x = (msg.x as number) * vw;
      const y = (msg.y as number) * vh;
      await this.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else if (type === 'scroll') {
      const x = (msg.x as number) * vw;
      const y = (msg.y as number) * vh;
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: msg.deltaX, deltaY: msg.deltaY });
    } else if (type === 'key') {
      const key = msg.key as string;
      const code = (msg.code as string) || key;
      const isPrintable = typeof key === 'string' && key.length === 1;
      const mods = (msg.modifiers as { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) ?? {};
      const modBits = (mods.altKey ? 1 : 0) | (mods.ctrlKey ? 2 : 0) | (mods.metaKey ? 4 : 0) | (mods.shiftKey ? 8 : 0);
      const vkc = virtualKeyCode(key, code);
      await this.cmd('Input.dispatchKeyEvent', {
        type: msg.event === 'keydown' ? 'keyDown' : 'keyUp',
        key, code,
        text: isPrintable && !mods.ctrlKey && !mods.metaKey ? key : '',
        unmodifiedText: isPrintable ? key : '',
        windowsVirtualKeyCode: vkc,
        nativeVirtualKeyCode: vkc,
        modifiers: modBits,
      });
    } else if (type === 'navigate') {
      await this.cmd('Page.navigate', { url: msg.url });
    } else if (type === 'history_back') {
      await this.cmd('Runtime.evaluate', { expression: 'history.back()' });
    } else if (type === 'history_forward') {
      await this.cmd('Runtime.evaluate', { expression: 'history.forward()' });
    } else if (type === 'reload') {
      await this.cmd('Page.reload', {});
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

async function probeVisibility(wsUrl: string): Promise<'visible' | 'hidden' | 'prerender' | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 1500);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.visibilityState', returnByValue: true } }));
    });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.id === 1) {
          clearTimeout(timeout);
          const val = m.result?.result?.value;
          ws.close();
          resolve(val === 'visible' || val === 'hidden' || val === 'prerender' ? val : null);
        }
      } catch {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(null);
      }
    });
    ws.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

// Subset of Windows virtual key codes; Chrome's Input.dispatchKeyEvent needs
// these for non-printable keys (Backspace, Enter, arrows, etc.) to actually
// fire their default actions in text fields and elsewhere.
const VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
  CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34,
  End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

function virtualKeyCode(key: string, code: string): number {
  if (VK[key] != null) return VK[key];
  if (VK[code] != null) return VK[code];
  if (key && key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if (c >= 0x30 && c <= 0x39) return c;
    if (c >= 0x41 && c <= 0x5a) return c;
  }
  return 0;
}
