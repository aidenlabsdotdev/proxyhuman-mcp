// Persistent config — `~/.proxyhuman/config.json` (chmod 600). Mirrors the
// AgentMail CLI's `~/.agentmail/config.json` pattern. Env vars take precedence.
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface PersistedConfig {
  api_key?: string;
  agent_id?: string;
  email?: string;
}

export const CONFIG_PATH = resolve(homedir(), '.proxyhuman', 'config.json');

export function loadConfig(): PersistedConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PersistedConfig; }
  catch { return {}; }
}

export function saveConfig(patch: Partial<PersistedConfig>): PersistedConfig {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o700); }
  const next = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  chmodSync(CONFIG_PATH, 0o600);
  return next;
}

/** Env vars beat the config file (CI, ephemeral runs, harness-injected keys). */
export function resolveApiKey(): string | undefined {
  return process.env.PROXYHUMAN_API_KEY || loadConfig().api_key;
}

/** The base URL the package ships with. Only PROXYHUMAN_API overrides
 *  (staging / self-hosted relay). Not stored in the user config — that
 *  would just bit-rot. */
export function resolveApiUrl(): string {
  return process.env.PROXYHUMAN_API ?? 'https://app.proxyhuman.ai';
}

/** Hermes (the agent framework most users come from) writes the canonical
 *  CDP endpoint to ~/.hermes/config.yaml under browser.cdp_url. If it's there
 *  we honor it so we and Hermes always agree on which Chrome to talk to. We
 *  do a minimal YAML scrape — pulling a tiny yaml dep would be heavier than
 *  the matching itself. */
function readHermesBrowserCdpUrl(): string | undefined {
  const path = resolve(homedir(), '.hermes', 'config.yaml');
  if (!existsSync(path)) return undefined;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return undefined; }
  // Find a `browser:` mapping, then `cdp_url: …` indented under it (2+ spaces).
  const browserBlock = /^browser:\s*\n((?:[ \t]+.*\n?)+)/m.exec(raw)?.[1];
  if (!browserBlock) return undefined;
  const m = /^\s+cdp_url:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(browserBlock);
  return m?.[1]?.trim() || undefined;
}

/** Common CDP ports we'll auto-probe when nothing's been told to us
 *  explicitly. In rough order of how often each appears in the wild:
 *    9222 — Chrome's default, what Hermes uses
 *    9333, 9444 — our own dev/test conventions
 *    9221, 9223 — occasional alternative defaults */
const CDP_PROBE_PORTS = [9222, 9333, 9444, 9221, 9223];

async function probeCdp(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 400);
    const res = await fetch(`${url.replace(/\/$/, '')}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

/** Resolve a CDP HTTP URL. Priority:
 *    1. PROXYHUMAN_CDP env var (operator override)
 *    2. ~/.hermes/config.yaml :: browser.cdp_url  (the agent framework's truth)
 *    3. Probe localhost on common CDP ports — first reachable wins
 *    4. Fall back to http://localhost:9222 even if nothing's reachable; the
 *       caller will get a clear connect-time error.
 *
 *  Agents in a multi-browser setup should pass `cdp_target` explicitly when
 *  calling open_browser_handoff_link — this fallback is for bare-bones runs. */
export async function resolveCdpTarget(): Promise<string> {
  const env = process.env.PROXYHUMAN_CDP;
  if (env) return env;
  const hermes = readHermesBrowserCdpUrl();
  if (hermes) return hermes;
  for (const port of CDP_PROBE_PORTS) {
    const url = `http://localhost:${port}`;
    if (await probeCdp(url)) return url;
  }
  return 'http://localhost:9222';
}
