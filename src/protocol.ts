// Wire-format types shared between this MCP, the browser-skill code it embeds,
// and the api-worker. Inlined here (rather than imported from a workspace
// package) so the published @proxyhuman/mcp tarball has zero monorepo deps.
// The same types live in packages/shared/src/index.ts for api-worker + app to
// consume via the workspace.

// ── Skill → API (WebSocket) ────────────────────────────────────────────────

export interface SkillHello {
  type: 'skill_hello';
  apiKey: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionReady {
  type: 'session_ready';
  sessionId: string;
  whipUrl: string;
  viewerUrl: string;
}

export interface ViewerJoined {
  type: 'viewer_joined';
  viewerCount: number;
}

export interface ViewerLeft {
  type: 'viewer_left';
  viewerCount: number;
}

export type ViewerCommand =
  | { type: 'tap'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; event: 'keydown' | 'keyup'; key: string; code: string }
  | { type: 'navigate'; url: string }
  | { type: 'history_back' }
  | { type: 'history_forward' }
  | { type: 'reload' }
  | { type: 'human_done' };

export type SkillBoundMessage = SessionReady | ViewerJoined | ViewerLeft | ViewerCommand;

// ── Viewer → API (WebSocket) ───────────────────────────────────────────────

export interface ViewerHello {
  type: 'viewer_hello';
  sessionId: string;
}

export interface StreamReady {
  type: 'stream_ready';
  whepUrl: string;
  iceServers: IceServer[];
}

export interface SessionEnded {
  type: 'session_ended';
  reason: string;
}

export interface UrlUpdate {
  type: 'url_update';
  url: string;
}

export type ViewerBoundMessage = StreamReady | SessionEnded | UrlUpdate | ViewerCommand;
export type ViewerSentMessage = ViewerHello | ViewerCommand;

// ── REST ──────────────────────────────────────────────────────────────────

export interface CreateSessionResponse {
  sessionId: string;
  whipUrl: string;
  viewerUrl: string;
}

// ── Action recording ──────────────────────────────────────────────────────

export type RecordedAction =
  | { ts: number; type: 'type'; text: string }
  | { ts: number; type: 'press'; key: string; modifiers?: string[] }
  | { ts: number; type: 'tap'; x: number; y: number }
  | { ts: number; type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { ts: number; type: 'navigate'; url: string }
  | { ts: number; type: 'back' }
  | { ts: number; type: 'forward' }
  | { ts: number; type: 'reload' }
  | { ts: number; type: 'url_update'; url: string }
  | { ts: number; type: 'human_done' };

export interface SessionActionsResponse {
  sessionId: string;
  currentUrl: string;
  actions: RecordedAction[];
}

export type SessionStatus = 'waiting' | 'streaming' | 'ended';

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  viewerCount: number;
  createdAt: number;
}
