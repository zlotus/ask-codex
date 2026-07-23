# Product Ideas

Last reviewed: 2026-07-23

These are candidates for future planning, not promises, accepted decisions, or
an ordered roadmap. Move an idea into `progress.md` only when it becomes near
term work, and use an issue or ADR when implementation is accepted and needs
tracking or durable rationale.

## Conversation And Rendering

- Viewport virtualization or an aggregate render budget for users who expand
  many history pages and large disclosures in one browser session.
- Optional safe ANSI color rendering for command output; control sequences are
  currently stripped to readable text.
- Native turn steering using `expectedTurnId`, plus thread rename, archive,
  unarchive, and fork actions.
- Token usage and rate-limit views that remain useful on mobile.

## Navigation And Skills

- Server-side resolution of a selected skill identifier to its catalog entry so
  the browser cannot supply an arbitrary skill path.
- Skill installation or configuration only after a separate security and
  protocol design; skill-triggered commands must continue through normal Codex
  approval.

## Cross-Device Workflow

- Image attachment and official `localImage` input with explicit size, type,
  storage, and lifecycle limits.
- A persistent message queue that can be prepared on one device and consumed by
  the active thread without duplicate or stale-turn delivery.
- Connection recovery that makes long-running turns and pending approvals clear
  after a mobile browser sleeps or reconnects.

## Host Capabilities

- Fixed host actions may expose server-configured action identifiers, never a
  browser-provided command string. Actions that execute repository code still
  require explicit confirmation and bounded output.
- An external browser-rendered SSH application on a separate Access-protected
  hostname may provide terminal access without embedding a shell in Ask Codex.
- A full embedded PTY, if pursued, must default off and use a separate endpoint,
  unprivileged user or container, environment allowlist, concurrency and idle
  limits, process-tree cleanup, and output backpressure. It does not inherit
  Codex approvals and therefore needs its own threat model.
