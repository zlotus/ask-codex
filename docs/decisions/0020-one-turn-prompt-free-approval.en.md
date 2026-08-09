# ADR 0020: Offer a one-turn prompt-free mode for the next direct turn

- Status: Superseded by [ADR 0022](0022-sandbox-aware-one-turn-auto-run.en.md)
- Decision date: 2026-08-07
- Amends: [ADR 0002](0002-security-gateway-and-manual-approval.md)

## Context

Ask Codex has treated manual approval as the default execution boundary.
Requirements research and technical planning usually need no operation outside
the workspace sandbox, but the model may still read files or run commands
inside it. Reviewing each request interrupts those conversations. Making an
entire thread or browser session permanently automatic would create a much
larger mistake window and ambiguous cross-device recovery semantics.

The stable `TurnStartParams` in Codex CLI 0.147.0 supports
`approvalPolicy: "on-request" | "never"` on `turn/start`. `never` removes
approval prompts but does not widen the current sandbox; operations that would
need approval to cross it fail. The upstream policy affects later turns, so Ask
Codex cannot rely on omission to restore its default. This decision does not
depend on experimental `thread/settings/update`.

## Decision

- Ask Codex startup, thread creation, and thread resume continue to use
  `approvalPolicy: "on-request"`, with the gateway fixing
  `approvalsReviewer: "user"`. Cross-device queue consumption also remains
  fixed to manual approval.
- Enable the one-turn control only when the currently selected existing thread
  is idle. Its state lives only in the current page's memory; it is not stored
  on the thread, in browser storage, or in the cross-device queue. Switching
  threads or entering new-thread creation clears it.
- Once armed, the next `turn/start` sent directly from the composer explicitly
  uses `approvalPolicy: "never"`. The control cannot change while Working or
  while the request is being sent. It clears when the turn completes, is
  cancelled, fails, or when `turn/start` returns no valid turn. A failed start
  also fails closed to manual mode.
- Every ordinary direct turn explicitly sends `approvalPolicy: "on-request"`
  instead of relying on app-server's current setting. `turn/steer` and queue
  operations neither read nor consume the one-turn control.
- The gateway accepts only `on-request` or `never` for direct `turn/start`,
  rejects other values and any browser-supplied reviewer, and always injects
  the user reviewer. All other RPC allowlists, parameter rebuilding, and
  fail-closed boundaries remain unchanged.
- `never` does not change the sandbox. The UI must state that sandbox limits
  still apply; this mode is neither full access nor an automatic grant beyond
  the sandbox.
- Completion does not automatically call `thread/resume` or an experimental
  settings RPC to reset upstream state because that could change approval
  ownership or add an immature protocol dependency. Ask Codex restores its own
  behavior by sending `on-request` explicitly on the next write.

## Rationale

A one-shot control that defaults off and can change only while idle limits the
convenience window to the next turn the user deliberately selects. Carrying the
policy on stable `turn/start` needs no persistent state and avoids experimental
thread-settings APIs. Explicitly restoring `on-request` on every later write
prevents a sticky upstream setting from accidentally extending auto mode in Ask
Codex.

## Consequences

- Requirements research and technical discussion can proceed continuously,
  while new threads, resume, queue consumption, and later turns remain manual
  by default.
- An authenticated compromised browser can now request `never` repeatedly.
  This amends ADR 0002's earlier threat model in which the browser could not
  select `never`. The gateway still constrains methods, parameters, and sandbox,
  but cannot treat this UI choice as a defense against a malicious browser.
- After a `never` turn ends and before Ask Codex sends the next explicit
  `on-request` write, the upstream thread setting may remain `never`. Approval
  behavior for a turn started from another Codex client in that window is not
  guaranteed by this UI. An automatic reset was rejected because it can change
  ownership.
- Refreshing the page or switching threads clears an armed but unused control.
  An ordinary gateway reconnect within the same page retains that in-memory
  state and permits changes during Retry/Sync, but does not synchronize it to
  another page or device.

## Alternatives Considered

- Switch the whole thread or session to automatic mode: rejected because its
  duration and cross-device ownership are unclear and its mistake window is
  larger.
- Change the policy while Working: rejected because the active turn's policy is
  already fixed and the control would be misleading.
- Automatically approve selected tool categories: not adopted because a
  category cannot reliably express command, path, and environment impact.
- Automatically call `thread/resume` or `thread/settings/update` after a turn:
  rejected because the former changes ownership, the latter is experimental,
  and both add a write for ephemeral UI state.
