#!/usr/bin/env node
/**
 * `proxyhuman` CLI — bootstrap & inspection. Rare commands, kept out of the MCP
 * tool surface so they don't clutter the agent's tool list.
 *
 *   proxyhuman sign-up --email you@example.com [--username my-agent]
 *   proxyhuman verify <otp-code>
 *   proxyhuman me
 *   proxyhuman config show
 *   proxyhuman config get api_key
 *   proxyhuman config set <key> <value>
 *
 * State lives at ~/.proxyhuman/config.json (chmod 600). PROXYHUMAN_API_KEY env
 * var takes precedence over the file for ephemeral/CI usage.
 */
import { loadConfig, saveConfig, resolveApiKey, resolveApiUrl, CONFIG_PATH } from './config.js';

const args = process.argv.slice(2);
const cmd = args[0];

function getOpt(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function die(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${resolveApiUrl().replace(/\/$/, '')}${path}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep raw */ }
  if (!res.ok) die(`API ${res.status}: ${JSON.stringify(body)}`, 1);
  return body;
}

async function signUp(): Promise<void> {
  const email = getOpt('--email') ?? getOpt('-e');
  if (!email) die('usage: proxyhuman sign-up --email <you@example.com> [--username <name>]');
  const username = getOpt('--username') ?? getOpt('-u');
  const body = (await api('/api/v1/sign-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ human_email: email, ...(username ? { username } : {}) }),
  })) as { api_key: string; agent_id: string; email: string; verification_pending: boolean };

  saveConfig({ api_key: body.api_key, agent_id: body.agent_id, email: body.email });
  process.stdout.write(`Signed up.\n  api_key:  ${body.api_key}\n  agent_id: ${body.agent_id}\n  email:    ${body.email}\n`);
  if (body.verification_pending) {
    process.stdout.write(`\nOpen the welcome email at ${body.email} to verify (one click).\n`);
  }
  process.stdout.write(`\nSaved to ${CONFIG_PATH}.\n`);
}

// `verify` is now a no-op informational command — verification happens
// when the user clicks the magic-link email sent at sign-up time.
async function verify(): Promise<void> {
  process.stdout.write('Verification happens automatically when you open the welcome email sent at sign-up. If you missed it, sign in at https://app.proxyhuman.ai/ for a fresh link.\n');
}

async function me(): Promise<void> {
  const key = resolveApiKey();
  if (!key) die('no api_key found — run sign-up first');
  const body = await api('/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
}

function configCmd(): void {
  const sub = args[1];
  if (sub === 'show') {
    const cfg = loadConfig();
    process.stdout.write(JSON.stringify({ ...cfg, _path: CONFIG_PATH }, null, 2) + '\n');
    return;
  }
  if (sub === 'get') {
    const k = args[2] as keyof ReturnType<typeof loadConfig>;
    const cfg = loadConfig();
    const v = (cfg as Record<string, unknown>)[k as string];
    process.stdout.write((v == null ? '' : String(v)) + '\n');
    return;
  }
  if (sub === 'set') {
    const k = args[2], v = args[3];
    if (!k || v === undefined) die('usage: proxyhuman config set <key> <value>');
    saveConfig({ [k]: v });
    process.stdout.write(`set ${k}\n`);
    return;
  }
  die('usage: proxyhuman config <show|get|set>');
}

switch (cmd) {
  case 'sign-up': await signUp(); break;
  case 'verify':  await verify(); break;
  case 'me':      await me(); break;
  case 'config':  configCmd(); break;
  default:
    process.stdout.write(`proxyhuman — bootstrap CLI

Usage:
  proxyhuman sign-up --email <email> [--username <name>]
  proxyhuman verify <otp-code>
  proxyhuman me
  proxyhuman config <show|get <key>|set <key> <value>>

Config file: ${CONFIG_PATH}
`);
}
