import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { SessionReady, PublisherInfo, TargetInfo } from '@proxyhuman/protocol';

export interface RelayHandshake {
  sessionId: string;
  whipUrl: string;
  viewerUrl: string;
}

export interface ConnectArgs {
  /** Free-text shown to the human in the dashboard. */
  prompt?: string | null;
  /** Self-reported publisher identity (persisted on the session). */
  publisher?: PublisherInfo;
  /** Target browser info captured at attach time. */
  target?: TargetInfo;
}

export class RelayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private apiKey: string;

  constructor(apiBaseUrl: string, apiKey: string) {
    super();
    const wsBase = apiBaseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
    this.url = `${wsBase}/ws/skill`;
    this.apiKey = apiKey;
  }

  connect(args: ConnectArgs = {}): Promise<RelayHandshake> {
    return new Promise((resolve, reject) => {
      // Pass the API key on the WS handshake itself. The api-worker
      // requires this at upgrade time so anonymous bots can't open
      // /ws/skill and burn DO instances. We still send the apiKey in
      // the first new_session frame too (servers >=2026-05-19 verify
      // both; older servers fall through to the frame-only path).
      const ws = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      this.ws = ws;

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'new_session',
          apiKey: this.apiKey,
          prompt: args.prompt ?? null,
          publisher: args.publisher,
          target: args.target,
        }));
      });

      ws.on('error', reject);

      ws.on('message', (raw: Buffer | string, isBinary: boolean) => {
        if (isBinary) return;

        const msg = JSON.parse(raw.toString()) as { type: string; [k: string]: unknown };

        if (msg.type === 'session_ready') {
          const r = msg as unknown as SessionReady;
          resolve({ sessionId: r.sessionId, whipUrl: r.whipUrl, viewerUrl: r.viewerUrl });
          return;
        }
        if (msg.type === 'error') {
          reject(new Error(String(msg.message)));
          return;
        }
        this.emit('message', msg);
      });

      ws.on('close', () => this.emit('close'));
    });
  }

  send(msg: object): void {
    if (this.ws?.readyState === this.ws?.OPEN) {
      this.ws?.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
