# AGENTS.md

## Project Scope

Ask Agent is a single-user, local-first browser client for Codex. Keep the
integration on the documented `codex app-server` JSONL-over-stdio protocol.
Do not depend on Codex Desktop private IPC or expose the terminal UI.

## Architecture

- `src/`: React browser UI, protocol normalization, streamed state, and approvals.
- `server/`: Express/WebSocket gateway and the `codex app-server` child process.
- `server/rpc-policy.ts`: the complete browser-to-Codex RPC allowlist.
- `server/server-request-policy.ts`: browser responses to app-server requests.
- `scripts/visual-check.mjs`: desktop and mobile production UI smoke test.

## Security Invariants

- Never expose arbitrary app-server RPC methods or pass browser params through
  without rebuilding them from an allowlist.
- Keep `approvalPolicy: "on-request"` and `approvalsReviewer: "user"` enforced
  at the gateway.
- Never put `ASK_AGENT_TOKEN` in a URL or pass it to Codex, MCP servers, hooks,
  or commands. WebSocket authentication happens in the first message frame.
- Keep loopback-only defaults, strict Origin/Host checks, connection and request
  limits, and the non-loopback token requirement.
- Treat `ASK_AGENT_WORKSPACE` as an initial directory, not an access boundary.
- Unsupported granular permission grants and MCP elicitations must fail closed.
- Preserve an existing `externalSandbox` instead of overriding it on resume.

## Protocol Changes

The installed CLI defines the protocol. When Codex changes, generate current
bindings outside the repository and compare the relevant request, response,
notification, and union shapes:

```bash
schema_dir="$(mktemp -d)"
codex app-server generate-ts --experimental --out "$schema_dir"
```

Update normalization and focused tests together. In particular, verify thread
settings, indexed reasoning parts, plan deltas, file-change kinds, pagination,
modern and legacy approvals, and `request_user_input` responses.

## Verification

Run these before committing implementation changes:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

For UI changes, start the production build on port 4173 and also run
`npm run check:visual`. Do not create a real Codex turn merely to smoke-test the
UI unless the user has authorized the resulting API usage and thread mutation.
