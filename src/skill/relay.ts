import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { SessionReady } from '../protocol.js';

export interface RelayHandshake {
  sessionId: string;
  whipUrl: string;
  viewerUrl: string;
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

  connect(): Promise<RelayHandshake> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'skill_hello', apiKey: this.apiKey }));
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
