# @proxyhuman/mcp

[ProxyHuman](https://proxyhuman.ai) MCP server — let an AI agent ask a human
for help with a browser-based task (signing in, solving a captcha, completing
2FA, reading an OTP from email/SMS, entering payment info, picking a
subjective option) and get back a structured log of what the human did.

Pairs with [`@proxyhuman/skills`](https://www.npmjs.com/package/@proxyhuman/skills)
(via [`npx skills`](https://www.npmjs.com/package/skills)), which provides the
`SKILL.md` that tells the agent *when* to reach for this MCP.

## Install

```bash
# 1. Install the MCP server (this package)
npm i -g @proxyhuman/mcp

# 2. Sign up — a Clerk-issued long-lived API key is saved to
#    ~/.proxyhuman/config.json. Verification OTP is sent to your email.
proxyhuman sign-up --email you@example.com
proxyhuman verify <code-from-email>

# 3. Register the MCP in your harness:
claude mcp add proxyhuman -- proxyhuman-mcp
#   or for Hermes / Codex / Cursor / etc., the harness-specific equivalent
```

The `npm i -g` postinstall fetches a WHIP-capable ffmpeg 8.1 (BtbN on Linux/
Windows, evermeet.cx on macOS) and stages it in the package's `bin/`. ~134 MB
one-time download, used by the MCP to publish the browser's screencast to
Cloudflare Realtime SFU.

## Two bins

| Binary           | Purpose                                                   |
|------------------|-----------------------------------------------------------|
| `proxyhuman-mcp` | The stdio MCP server. Register this with your harness.    |
| `proxyhuman`     | CLI for `sign-up`, `verify`, `me`, and `config show/get/set`. |

## MCP tools

| Tool                              | Description                                                                                                                              |
|-----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `open_browser_handoff_link`       | Mints a viewer URL that mirrors the agent's Chrome to the human's phone/desktop. Does NOT notify — your harness owns the messaging channel. |
| `wait_for_human_handback`         | Blocks until the human clicks "return control to agent" (or timeout). Returns the structured action log and final page URL.              |

## Config resolution (priority order)

| Setting     | Order                                                                                                       |
|-------------|-------------------------------------------------------------------------------------------------------------|
| `api_key`   | tool arg → `PROXYHUMAN_API_KEY` env → `~/.proxyhuman/config.json`                                            |
| `api_url`   | tool arg → `PROXYHUMAN_API` env → `~/.proxyhuman/config.json` → `https://api.proxyhuman.ai`                  |
| `cdp_target`| tool arg → `PROXYHUMAN_CDP` env → `~/.hermes/config.yaml::browser.cdp_url` → probe localhost ports → default |

## How it talks to the rest of the system

```
agent → @proxyhuman/mcp (this) ──┐
                                  │ HTTP/WS
                                  ▼
                           api.proxyhuman.ai
                          (Worker + Durable Object)
                                  │
                                  ▼
                       Cloudflare Realtime SFU
                                  ▲
                                  │ WebRTC (UDP)
                                  ▼
                       human's phone/desktop
                          (app.proxyhuman.ai)
```

`@proxyhuman/mcp` runs on the customer's machine (it needs CDP access to a
local Chrome and a local ffmpeg). Everything else is hosted on Cloudflare.

## Source

Developed by [Aiden Labs](https://aidenlabs.dev). This repo
([`aidenlabsdotdev/proxyhuman-mcp`](https://github.com/aidenlabsdotdev/proxyhuman-mcp))
is what npm publishes from — issues and PRs welcome here.
