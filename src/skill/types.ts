export interface ConnectOptions {
  /** ProxyHuman API key */
  apiKey: string;
  /** Chrome DevTools Protocol HTTP endpoint, e.g. http://localhost:9222 */
  cdpTarget: string;
  /** API base URL, defaults to https://api.proxyhuman.ai */
  apiUrl?: string;
  /** Path to ffmpeg binary, defaults to ../bin/ffmpeg or $FFMPEG_PATH */
  ffmpegPath?: string;
  /** Free-text shown to the human in the dashboard. */
  prompt?: string | null;
}

/**
 * Full session lifecycle. See packages/shared/src/index.ts for canonical docs.
 *   awaiting_viewer → streaming ↔ paused → complete
 *                          ↓             ↓
 *                       failed       cancelled
 * Terminal: complete | failed | cancelled.
 */
export type SessionState =
  | 'awaiting_viewer'
  | 'streaming'
  | 'paused'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type SessionOutcome =
  | { type: 'human_done' }
  | { type: 'disconnected' }
  | { type: 'timeout' }
  | { type: 'cancelled'; reason?: string }
  | { type: 'cdp_lost' }
  | { type: 'encoder_crash' }
  | { type: 'relay_error'; detail?: string };

export const TERMINAL_STATES: readonly SessionState[] = [
  'complete', 'failed', 'cancelled',
];

export function isTerminalState(s: SessionState): boolean {
  return TERMINAL_STATES.includes(s);
}

export interface BrowserSession {
  sessionId: string;
  viewerUrl: string;
  /** Current state (snapshot). Use onStateChange for transitions. */
  readonly state: SessionState;
  /** Terminal outcome — null until state is terminal. */
  readonly outcome: SessionOutcome | null;
  /** Viewer count from the relay's most recent event. */
  readonly viewerCount: number;
  close(): Promise<void>;
  /**
   * Explicitly abort the handoff (agent decided it no longer needs help, or
   * wants to retry). Transitions to `cancelled` and tears down the publisher.
   */
  cancel(reason?: string): Promise<void>;
  onDisconnect(handler: () => void): void;
  onComplete(handler: () => void): void;
  /** Fires for every state transition. */
  onStateChange(handler: (from: SessionState | null, to: SessionState, outcome: SessionOutcome | null) => void): void;
}

export type RelayMessage = {
  type: string;
  [key: string]: unknown;
};
