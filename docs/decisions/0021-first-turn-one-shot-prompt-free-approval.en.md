# ADR 0021: Extend one-shot prompt-free approval to a new thread's first turn

- Status: Accepted
- Decision date: 2026-08-09
- Amends: [ADR 0020](0020-one-turn-prompt-free-approval.en.md)

## Context

ADR 0020 limited `approvalPolicy: "never"` to the next direct turn of an
existing idle thread. That boundary preserved manual approval by default but
made new threads inconsistent: after explicitly configuring the working
directory and sandbox, a user still could not choose the same one-shot mode for
the first turn and had to complete one manual turn first.

The intended product boundary is per turn, not based on whether the thread
already exists. Every turn should default to manual approval, and every
prompt-free turn should require a fresh explicit user choice. A new thread must
still be configured first and created by the gateway under manual policy; only
the separate first `turn/start` that follows may apply the one-shot choice.

## Decision

- Every Ask Codex turn defaults to manual approval. The one-shot control is not
  persisted or inherited automatically; the user must arm it separately for
  every turn that should run without approval prompts.
- Enable the control only when the current existing thread is idle or when a
  new-thread draft has completed working-directory and sandbox configuration.
  Entering a fresh new-thread flow clears the previous choice, and the control
  remains unavailable before configuration is complete.
- A new thread's `thread/start` always uses `approvalPolicy: "on-request"`, with
  the gateway fixing `approvalsReviewer: "user"`. If the user explicitly arms
  the configured draft, only the separate first `turn/start` immediately after
  successful creation uses `approvalPolicy: "never"`.
- When a draft receives its real thread ID, the choice follows only the first
  turn already being submitted as part of the same user action. This is not
  cross-thread inheritance; selecting another thread or entering the
  new-thread flow again still clears it.
- Restore manual mode immediately after completion, cancellation, failure, an
  invalid start result, or a failed thread creation or turn start. The control
  cannot change while Working or sending. Queue operations, steering, resumed
  threads, and later turns neither inherit nor consume the choice.
- All other ADR 0020 boundaries remain: direct `turn/start` parameters are
  rebuilt field by field; the gateway accepts only `on-request` or `never` and
  injects the user reviewer; `never` does not widen the sandbox or depend on an
  experimental settings API.

## Rationale

Using the turn as the sole user-authorization unit gives first and later turns
the same predictable interaction: each starts manual and requires one click to
be prompt-free. Creating the thread with `on-request` before carrying the
one-shot choice on a separate `turn/start` avoids making `never` the new
thread's durable default and needs neither persistent state nor an experimental
protocol.

## Consequences

- After configuring a new thread, a user can explicitly arm one-shot
  prompt-free mode before sending its first message.
- The second turn returns to manual after the first ends. If it should also be
  automatic, the user must arm it again. Existing threads behave the same way.
- The new-thread settings dialog is not an approval grant. Configuration alone
  never enables `never`, and thread creation itself always remains manual.
- As in ADR 0020, after a `never` turn ends, the upstream thread setting may
  remain sticky until Ask Codex next writes an explicit `on-request`. This UI
  does not guarantee another Codex client's behavior during that window.

## Alternatives Considered

- Keep the first turn manual-only: rejected because it creates an exception
  based on thread age and conflicts with explicit per-turn authorization.
- Store a durable automatic mode in new-thread settings: rejected because it
  would carry across turns and enlarge the mistake window.
- Send `never` on `thread/start`: rejected because thread creation and first-turn
  execution are separate boundaries. Creation and resume remain fixed to
  manual policy; only a separate direct turn may use the one-shot choice.
