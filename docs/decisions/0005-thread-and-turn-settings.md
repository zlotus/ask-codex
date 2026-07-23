# ADR 0005: Separate thread and next-turn settings

- Status: Accepted
- Decision date: 2026-07-23
- Amended by: [ADR 0006](0006-configured-turn-defaults.md) for model and effort default sourcing only

## Context

The original toolbar presented working directory, sandbox, model, and reasoning
effort as four equivalent settings that could be edited at any time. They do
not have equivalent lifecycle or risk. Working directory identifies the
project context of a thread. Sandbox changes affect execution policy. Model and
reasoning effort are sticky app-server overrides for the next and subsequent
turns. Keeping all four controls permanently visible also consumed a large
part of the mobile viewport.

Repeatedly resending a flattened sandbox value while resuming a thread could
also overwrite richer upstream permission state. Hiding every permission
signal would create the opposite problem by making non-default or full-access
execution easy to overlook.

## Decision

- Choose the working directory when preparing a new thread and treat it as the
  thread's project identity. The normal thread UI does not edit it; changing
  projects means starting a new thread.
- Start each new-thread dialog at `workspace-write`, even when the previous
  thread used broader access. Allow an idle existing thread's sandbox to be
  changed only through explicit thread settings, and keep non-default sandbox
  state visible in the compact header. Preserve `externalSandbox` unchanged.
- Put model and reasoning-effort controls beside the composer. Their values
  apply to the next and subsequent turns. Disable changes during an active
  turn. When the model catalog identifies defaults, resolve a Default selection
  to the explicit default model id and reasoning effort; when it does not, show
  Current instead of claiming that an omitted field resets sticky state.
- Resume existing threads without routinely resending cwd, model, or a
  flattened sandbox. Send a sandbox value only after an explicit user change;
  continue sending the fixed cwd and resolved model settings with `turn/start`.
- Keep gateway-enforced `approvalPolicy: "on-request"` and
  `approvalsReviewer: "user"` independent of these presentation choices.

The selected working directory remains an execution context, not a filesystem
security boundary. Sandbox enforcement and manual approval remain the relevant
security controls.

## Consequences

- The conversation gets a 44-pixel header instead of a multi-row settings
  toolbar, especially improving the mobile viewport.
- Thread/project identity is clearer and cannot drift through an accidental
  cwd edit in the middle of a conversation.
- Full-access and other non-default sandbox states remain visible without
  occupying permanent space for the common `workspace-write` case.
- The client must distinguish explicit sandbox overrides from values merely
  observed while resuming a thread.
- Moving an existing conversation to another directory is intentionally not a
  routine operation; the user starts a new thread instead.

## Alternatives Considered

- Keep all settings in the toolbar: rejected because it wastes mobile space
  and implies that all four values have the same lifecycle.
- Hide sandbox state completely after thread creation: rejected because broad
  or externally managed access must remain visible.
- Resend all visible settings before every turn: rejected because it can
  overwrite richer app-server state and makes passive display values act like
  explicit user changes.
- Allow cwd changes within an existing thread: rejected because it weakens the
  relationship between thread history, project instructions, and future
  project-oriented navigation.
