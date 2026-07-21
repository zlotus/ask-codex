# Ask Agent

English | [简体中文](README.zh-CN.md)

Ask Agent is a local-first browser client for Codex. It talks to the official
`codex app-server` protocol instead of wrapping the terminal UI or patching the
Codex desktop application.

```text
Browser UI  <->  Ask Agent gateway  <->  codex app-server  <->  your workspace
              WebSocket             JSONL over stdio
```

The gateway keeps the Codex process and local credentials on the host. The
browser receives streamed thread, turn, tool, command, diff, and approval
events, but it does not get a general-purpose file-serving endpoint.

## Features

- Create, search, resume, and refresh Codex threads.
- Stream agent messages, reasoning summaries, plans, command output, file
  changes, MCP calls, and turn diffs.
- Review command and file-change approvals in the browser.
- Answer structured questions from `request_user_input`.
- Select the model, reasoning effort, sandbox, and absolute working directory.
- Interrupt an active turn.
- Responsive desktop and mobile layouts.
- Optional web access token, Origin checks, and loopback-only defaults.

## Requirements

- Node.js 22.12 or newer.
- A recent Codex CLI with `codex app-server` support.
- An existing Codex login. Run `codex login` first if needed.

The app-server WebSocket transport is experimental. Ask Agent uses the more
established JSONL-over-stdio transport behind its own browser gateway.

## Development

```bash
npm install
ASK_AGENT_WORKSPACE=/absolute/path/to/project npm run dev
```

Open `http://127.0.0.1:5173`. Vite serves the UI and proxies API and WebSocket
traffic to the gateway on `127.0.0.1:4173`.

## Production

```bash
npm run build
ASK_AGENT_WORKSPACE=/absolute/path/to/project npm start
```

Open `http://127.0.0.1:4173`.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASK_AGENT_HOST` | `127.0.0.1` | HTTP and WebSocket bind address |
| `ASK_AGENT_PORT` | `4173` | Gateway port |
| `ASK_AGENT_WORKSPACE` | server working directory | Initial absolute Codex working directory |
| `ASK_AGENT_TOKEN` | unset | Browser access token; required for non-loopback binds |
| `CODEX_BIN` | `codex` | Codex CLI executable |

## Remote Access

Do not expose this service directly to the public internet. Anyone who can use
the UI can instruct Codex to read files, modify the selected workspace, run
commands, and present requests for broader access.

Treat `ASK_AGENT_TOKEN` like a password for the operating-system account that
runs Ask Agent. `ASK_AGENT_WORKSPACE` selects the initial directory; it is not
an access boundary. An authenticated browser can select another absolute
directory and can choose full-access sandbox mode, subject to Codex approvals.

For access from another device:

1. Set a long random `ASK_AGENT_TOKEN`.
2. Bind to a private interface with `ASK_AGENT_HOST`.
3. Put the service behind TLS and an authenticated reverse proxy, VPN, or SSH
   tunnel.
4. Ensure proxy and application logs do not record authorization headers or
   WebSocket message bodies.
5. Keep Codex sandboxing enabled and review every escalation request, including
   the working directory and any session-level permission details.

The server refuses a non-loopback bind when no token is configured. This is a
single-user tool; the token is an access gate, not multi-user isolation or
role-based authorization.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run lint
# With the production server already running on port 4173:
npm run check:visual
```

The Codex protocol is versioned with the installed CLI. When upgrading Codex,
run the verification commands and smoke-test thread resume plus command and
file approval flows.

## Why Not Reuse `pi-web` or `codex-web`?

`pi-web` embeds the pi agent SDK and its session model directly, so its backend
cannot be swapped for Codex without replacing the event and approval layers.
The current `0xcaff/codex-web` reuses a patched Codex Desktop Electron bundle
and private IPC. Ask Agent instead targets the documented app-server interface,
which keeps the integration smaller and avoids redistributing the desktop
application.

See the official [Codex app-server documentation](https://developers.openai.com/codex/app-server/)
for the underlying thread, turn, item, and approval protocol.
