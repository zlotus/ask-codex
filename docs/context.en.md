# Project Context

[简体中文](context.md) | **English**

Last reviewed: 2026-08-09

## Purpose

Ask Codex is a single-user, local-first browser client for Codex. It gives one
developer a responsive desktop and mobile interface to native Codex threads
while the Codex process, credentials, and workspace remain on the host.

The primary use case includes continuing development from another device and
reaching a trusted host through Cloudflare Zero Trust. Remote convenience must
not weaken manual approval by default or turn the browser gateway into a
general-purpose remote execution API. The user may explicitly arm one
prompt-free turn on an existing idle thread or the first turn of a configured
new-thread draft, but every turn still defaults to manual and requires its own
choice. The choice must not widen sandbox permissions or persist.

## Product Goals

- Provide a polished Codex-only conversation and development interface in a
  browser, including streamed messages, plans, tools, code, diffs, and approval
  requests.
- Preserve Codex-native thread history so CLI, editor, and browser workflows can
  continue the same conversations.
- Keep consequential actions visible and subject to the user's manual approval
  by default. Every one-turn prompt-free exception must be explicitly armed
  while idle, including a new thread's first turn, and restore the default when
  it ends.
- Remain practical on a small always-on Linux host, including ARM64, and usable
  from desktop and mobile browsers.
- Add rich client capabilities incrementally without broadening the gateway's
  authority by accident.

## Non-Goals

- A multi-user service, hosted SaaS product, or role-based collaboration system.
- A provider-neutral agent frontend or a replacement session database.
- A wrapper around the Codex terminal UI or Codex Desktop private IPC.
- An arbitrary browser-to-Codex RPC proxy, file server, or remote shell.
- Treating the initial workspace directory as a filesystem security boundary.
- Synchronizing uncommitted work between devices; Git remains the handoff
  mechanism for source and project documentation.

## System Shape

```text
Browser UI
  -> Ask Codex HTTP/WebSocket gateway
  -> codex app-server (JSONL over stdio)
  -> local workspace and Codex credentials
```

The React client owns presentation and normalized streamed state. The gateway
owns authentication, Origin and Host validation, request limits, RPC policy,
approval routing, and the Codex child process. Codex remains the authority for
threads, turns, items, models, and protocol behavior.

For public-hostname deployments, Cloudflare Access is an outer identity gate,
the Ask Codex token is an independent application gate, and Codex approval is
the execution gate. The service remains bound to loopback behind the tunnel.

## Long-Term Constraints

- Follow the documented `codex app-server` interface and generate bindings from
  the installed CLI when protocol details change.
- Treat the security invariants in `AGENTS.md` as normative. Product evolution
  must preserve the gateway policy boundary, manual approval by default, the
  one-turn prompt-free choice, fail-closed behavior, and independent
  remote-access gates.
- Prefer focused, auditable features over embedding a broad browser IDE. A full
  PTY, if ever added, must be treated as a separate high-risk host capability.
