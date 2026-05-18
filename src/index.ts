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
  outcome: 'human_done' | 'timeout' | 'disconnected' | null;
  completion: Promise<'human_done' | 'disconnected'>;
}

const sessions = new Map<string, Live>();

async function fetchActions(apiUrl: string, sessionId: string) {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/sessions/${sessionId}/actions`);
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
    api_url: z.string().optional().describe('ProxyHuman relay/API base URL (default https://api.proxyhuman.ai)'),
    api_key: z.string().optional().describe('ProxyHuman API key (default "dev-key")'),
    prompt: z.string().optional().describe('Optional instruction recorded with the session — purely informational.'),
  },
}, async ({ cdp_target, api_url, api_key, prompt }) => {
  const cdpTarget = cdp_target ?? await resolveCdpTarget();
  const apiUrl = api_url ?? DEFAULT_API;
  const apiKey = api_key ?? DEFAULT_KEY;
  if (!apiKey) {
    return err(`No API key found. Run \`proxyhuman sign-up --email you@example.com\` or set PROXYHUMAN_API_KEY. Config: ${CONFIG_PATH}`);
  }

  let session: BrowserSession;
  try {
    session = await connectBrowser({ apiKey, cdpTarget, apiUrl });
  } catch (e) {
    return err(`failed to start session: ${e}`);
  }

  const completion = new Promise<'human_done' | 'disconnected'>((resolve) => {
    session.onComplete(() => resolve('human_done'));
    session.onDisconnect(() => resolve('disconnected'));
  });

  sessions.set(session.sessionId, { session, apiUrl, outcome: null, completion });

  // When completion resolves, stash the outcome so peek/wait see it.
  completion.then((o) => {
    const s = sessions.get(session.sessionId);
    if (s && s.outcome === null) s.outcome = o;
  });

  return ok({
    sessionId: session.sessionId,
    viewerUrl: session.viewerUrl,
    status: 'waiting',
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
  const winner = await Promise.race([
    live.completion,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
  if (live.outcome === null) live.outcome = winner;

  const log = await fetchActions(live.apiUrl, sessionId);
  return ok({
    outcome: live.outcome,
    sessionId,
    currentUrl: log.currentUrl,
    actions: log.actions,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
