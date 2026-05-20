#!/usr/bin/env node
/**
 * ProxyHuman MCP server — exposes "ask the human" as MCP tools.
 *
 * The harness (Claude Desktop / Claude Code / etc.) spawns this server over
 * stdio. The server owns a Map of in-flight browser sessions; each tool call
 * mutates that map. Sessions die when the harness disconnects.
 *
 * Tools (intent-named so the agent reaches for them when stuck on a browser
 * task it can't or shouldn't solve alone):
 *
 *   1. open_browser_handoff_link(cdp_target?, prompt?, …)
 *        → { viewerUrl, sessionId }
 *      Mints a hand-off URL that mirrors the agent's Chrome to the human's
 *      phone/desktop. Does NOT notify the human — the agent's harness is
 *      responsible for delivering viewerUrl through whatever messaging
 *      channel it has (Hermes: hermes_user_message; Slack/SMS/Discord/etc.).
 *
 *   2. wait_for_human_handback(sessionId, timeoutSec?)
 *        → { outcome, currentUrl, actions[] }
 *      Blocks until the human clicks "return control to agent" (or timeout).
 *      Returns the structured action log + final URL.
 *
 * Typical sequence:
 *   open_browser_handoff_link → send viewerUrl to the user via your harness
 *   → wait_for_human_handback → continue from the result
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectBrowser, type BrowserSession } from './skill/index.js';
import { resolveApiKey, resolveApiUrl, resolveCdpTarget, CONFIG_PATH } from './config.js';

const DEFAULT_API = resolveApiUrl();
const DEFAULT_KEY = resolveApiKey();

interface Live {
  session: BrowserSession;
  apiUrl: string;
  apiKey: string;
  prompt: string | null;
  createdAt: number;
  /** Resolves when the session reaches any terminal state. */
  terminal: Promise<void>;
}

const sessions = new Map<string, Live>();

async function fetchActions(apiUrl: string, apiKey: string, sessionId: string) {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/sessions/${sessionId}/actions`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return { currentUrl: '', actions: [] as unknown[] };
  return res.json() as Promise<{ currentUrl: string; actions: unknown[] }>;
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

const server = new McpServer({ name: 'proxyhuman', version: '0.1.0' });

server.registerTool('open_browser_handoff_link', {
  description:
    'Use when your task hits a step the human in the loop should do — signing ' +
    'in, solving a captcha, picking a subjective option, entering payment info, ' +
    'reading a verification email. Returns a viewer URL that mirrors the ' +
    'browser to the human\'s phone or desktop so they can click around inside ' +
    'the same Chrome session you\'re driving, then press "return control to ' +
    'agent" when done.\n\n' +
    'IMPORTANT — this tool DOES NOT notify the human. It only mints the URL. ' +
    'After this call you MUST surface the viewerUrl to the human via your ' +
    'harness\'s own messaging tool (if you are running under Hermes, use the ' +
    'tool that sends a user-facing message — e.g. SMS, Discord, Slack, ' +
    'whatever your Hermes config routes through). Only after you have ' +
    'delivered the URL should you call `wait_for_human_handback`.',
  inputSchema: {
    cdp_target: z.string().optional().describe('Chrome CDP HTTP endpoint of the browser the human should take over (e.g. http://localhost:9222). Pass this explicitly when your agent is operating against a known browser session — it scopes the hand-off precisely. If omitted, the server tries common defaults.'),
    prompt: z.string().optional().describe('Optional instruction recorded with the session — purely informational.'),
  },
}, async ({ cdp_target, prompt }) => {
  const cdpTarget = cdp_target ?? await resolveCdpTarget();
  const apiKey = DEFAULT_KEY;
  if (!apiKey) {
    return err(`No API key found. Run \`proxyhuman sign-up --email you@example.com\` or set PROXYHUMAN_API_KEY. Config: ${CONFIG_PATH}`);
  }

  let session: BrowserSession;
  try {
    session = await connectBrowser({ apiKey, cdpTarget, prompt: prompt ?? null });
  } catch (e) {
    return err(`failed to start session: ${e}`);
  }

  // Resolves the first time we hit a terminal state. The session itself
  // owns the state machine; we just observe it.
  const terminal = new Promise<void>((resolve) => {
    session.onComplete(() => resolve());
  });

  sessions.set(session.sessionId, {
    session, apiUrl: DEFAULT_API, apiKey, prompt: prompt ?? null, createdAt: Date.now(), terminal,
  });

  return ok({
    sessionId: session.sessionId,
    viewerUrl: session.viewerUrl,
    state: session.state,
    prompt: prompt ?? null,
  });
});

server.registerTool('wait_for_human_handback', {
  description:
    'Block until the human clicks "return control to agent", the connection ' +
    'drops, or the timeout elapses. Returns a structured log of what the ' +
    'human did (URLs they navigated to, text they typed, things they clicked) ' +
    'plus the final page URL — use this to decide your next step. Idempotent.\n\n' +
    'Call this AFTER you have already delivered the viewerUrl to the human ' +
    'via your harness\'s messaging tool. Calling this without notifying the ' +
    'human first means you will just time out — the URL alone doesn\'t reach ' +
    'them, since this MCP doesn\'t own a notification channel.',
  inputSchema: {
    sessionId: z.string().describe('Session id returned by open_browser_handoff_link'),
    timeoutSec: z.number().int().positive().optional().describe('Max seconds to wait (default 600 = 10m)'),
  },
}, async ({ sessionId, timeoutSec }) => {
  const live = sessions.get(sessionId);
  if (!live) return err(`session ${sessionId} not found`);

  const timeoutMs = (timeoutSec ?? 600) * 1000;
  let timedOut = false;
  await Promise.race([
    live.terminal,
    new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs)),
  ]);

  const log = await fetchActions(live.apiUrl, live.apiKey, sessionId);
  return ok({
    sessionId,
    state: live.session.state,
    outcome: live.session.outcome ?? (timedOut ? { type: 'timeout' } : null),
    viewerCount: live.session.viewerCount,
    currentUrl: log.currentUrl,
    actions: log.actions,
  });
});

server.registerTool('get_handoff_status', {
  description:
    'Non-blocking poll for the current state of a handoff session. Use this ' +
    'when you want to check whether the human has connected yet (state moves ' +
    'from `awaiting_viewer` → `streaming`), or whether they finished while ' +
    'you were doing something else. Cheap to call — does not consume the ' +
    'session like wait_for_human_handback does, so safe in a loop.\n\n' +
    'States:\n' +
    '  awaiting_viewer — URL minted, nobody has opened it yet\n' +
    '  streaming        — viewer connected, mirror active\n' +
    '  paused           — viewer left briefly (encoder stopped after 5s grace)\n' +
    '  complete         — human clicked "return control to agent" (TERMINAL)\n' +
    '  failed           — CDP/encoder/relay died (TERMINAL)\n' +
    '  cancelled        — agent or timeout aborted (TERMINAL)',
  inputSchema: {
    sessionId: z.string().describe('Session id returned by open_browser_handoff_link'),
  },
}, async ({ sessionId }) => {
  const live = sessions.get(sessionId);
  if (!live) return err(`session ${sessionId} not found`);
  return ok({
    sessionId,
    state: live.session.state,
    outcome: live.session.outcome,
    viewerCount: live.session.viewerCount,
    prompt: live.prompt,
    createdAt: live.createdAt,
  });
});

server.registerTool('cancel_handoff_link', {
  description:
    'Abort an in-flight handoff session — the agent decided it no longer ' +
    'needs help (got the answer elsewhere, wants to retry with a different ' +
    'prompt, user cancelled out-of-band). Transitions the session to ' +
    '`cancelled`, tears down the publisher, and frees the viewer URL. ' +
    'Idempotent on already-terminal sessions.',
  inputSchema: {
    sessionId: z.string().describe('Session id to cancel'),
    reason: z.string().optional().describe('Optional human-readable reason — recorded in the event log.'),
  },
}, async ({ sessionId, reason }) => {
  const live = sessions.get(sessionId);
  if (!live) return err(`session ${sessionId} not found`);
  await live.session.cancel(reason);
  return ok({
    sessionId,
    state: live.session.state,
    outcome: live.session.outcome,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
