# AGENTS.md

[简体中文](AGENTS.md) | English

## Project Scope

Ask Codex is a single-user, local-first browser client for Codex. Keep the
integration on the documented `codex app-server` JSONL-over-stdio protocol.
Do not depend on Codex Desktop private IPC or expose the terminal UI.

## Documentation Language

- Simplified Chinese is the default language for project documentation. For
  ordinary documents, keep the default `.md` file as the Chinese primary
  version and the corresponding `.en.md` file as its English mirror.
- Do not rewrite historical accepted ADR originals. Use the `.zh-CN.md` suffix
  for Chinese translations of English ADRs.
- Draft new ADRs in Chinese and provide a corresponding `.en.md` English mirror.
- When document semantics change, update the Chinese and English versions in
  the same change.

## Architecture

- `src/`: React browser UI, protocol normalization, streamed state, and approvals.
- `server/`: Express/WebSocket gateway and the `codex app-server` child process.
- `server/rpc-policy.ts`: the complete browser-to-Codex RPC allowlist.
- `server/server-request-policy.ts`: browser responses to app-server requests.
- `scripts/visual-check.mjs`: desktop and mobile production UI smoke test.

## Project Context

For non-trivial work or when resuming development, read `docs/context.md` and
`docs/progress.md`, then only the task-relevant ADRs linked from
`docs/decisions/README.md`. Read `docs/ideas.md` only during product planning.

Treat the installed CLI-generated schema as the protocol source of truth, the
security invariants in this file as normative requirements, and code, tests,
and configuration as the source of implemented behavior. If these sources and
the documentation disagree, verify the behavior and update stale documentation
in the same change.

Keep `docs/context.md` stable and `docs/progress.md` as a concise current-state
snapshot, not a changelog or task diary. Record durable architecture, security,
protocol, dependency, product, or workflow decisions as dated ADRs. Preserve
accepted decisions; replace one with a new ADR and mark the old one superseded.

Do not update project-context documentation for routine edits, formatting,
small isolated fixes, or exploratory discussion that has not become an
accepted decision. Record only verification that was actually run.

## Security Invariants

- Never expose arbitrary app-server RPC methods or pass browser params through
  without rebuilding them from an allowlist.
- Fix `approvalPolicy: "on-request"` at the gateway for thread creation,
  resume, and queue consumption. Direct `turn/start` may accept only a
  field-rebuilt `on-request` or `never`, and the gateway must always inject
  `approvalsReviewer: "user"`. The product UI may explicitly arm `never` only
  for the next direct turn on an existing idle thread or a configured but
  not-yet-created new-thread draft. Every turn defaults to manual, and the user
  must arm each automatic turn separately. The control must be disabled while
  Working and restore the manual default after completion or a failed start.
  A new thread's `thread/start`, steering, queued sends, and later Ask Codex
  turns must not inherit that choice. `never` must not widen sandbox permissions.
- Never put `ASK_CODEX_TOKEN` in a URL or pass it to Codex, MCP servers, hooks,
  or commands. WebSocket authentication happens in the first message frame.
- Keep loopback-only defaults, strict Origin/Host checks, connection and request
  limits, and the non-loopback token requirement.
- Treat `ASK_CODEX_PUBLIC_ORIGIN` as one exact trusted-proxy origin, require a
  token whenever it is configured, and preserve the public `Host` at the proxy.
- Treat `ASK_CODEX_WORKSPACE` as an initial directory, not an access boundary.
- File-download candidates may derive only from the authoritative `thread.cwd`
  supplied by app-server and explicit absolute local file links in completed
  Agent messages.
- The browser must not submit `path`, `cwd`, or `threadId`. A download request
  may submit only a short-lived, single-use opaque capability ID issued by the
  gateway.
- Snapshot the canonical root identity when issuing a download capability. At
  consumption, verify that identity again, pin resolution to the matching root
  directory fd, and check target `realpath` plus containment through the opened
  file fd. Any mismatch must fail closed.
- Allow downloads only for regular files, and retain explicit resource limits
  on file size, capability count, concurrency, metadata, and lifecycle. Never
  introduce global download roots, including `ASK_CODEX_DOWNLOAD_ROOTS`.
- Unsupported granular permission grants and MCP elicitations must fail closed.
- Preserve an existing `externalSandbox` instead of overriding it on resume.
- Automatic connection recovery and read-only cross-thread views must not call
  `thread/resume` or change approval ownership. They may automatically retry
  only bounded read requests and must never replay unconfirmed writes.

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
