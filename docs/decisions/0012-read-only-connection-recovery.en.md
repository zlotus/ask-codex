# ADR 0012: Recover connections through read-only resynchronization

- Status: Accepted
- Decision date: 2026-08-02
- Extends: [ADR 0002](0002-security-gateway-and-manual-approval.md)

## Context

A sleeping mobile browser, network transition, WebSocket disconnect, or
`codex app-server` child-process restart can temporarily stop realtime
notifications. When the connection returns, the browser cannot reliably know
whether Codex accepted a write sent before the disconnect. Replaying it could
create a duplicate turn, answer an approval twice, or repeat a thread metadata
change.

`thread/resume` is not an ordinary read either. It resumes a thread and can
affect which client should receive approval requests. Background monitoring or
automatic recovery could therefore change thread ownership away from another
client actively using it. Conversely, restoring only the WebSocket without
checking the selected-thread snapshot can leave the UI showing incorrect turn,
approval, or send state after missed notifications.

## Decision

- Present transport reconnection, Codex child-process restart, and selected
  thread resynchronization as three distinct states. A WebSocket failure only
  rebuilds the browser connection; a bounded read-only probe may trigger a
  gateway restart after a Codex child-process error.
- When Codex becomes ready after a previously successful ready lifecycle and
  the selected thread was already fully loaded, read a snapshot through the
  constrained `thread/read` and `thread/turns/list` methods before re-enabling
  sends. Buffer realtime notifications within explicit bounds during the read,
  then apply them in order after coordinating the snapshot to avoid read versus
  notification races.
- Treat the first ready state as a baseline without unnecessary recovery reads.
  If a disconnect interrupted the first thread load, show an explicit retry
  action and let the user restart the normal selection flow; automatic recovery
  must not call `thread/resume`.
- Read-only cross-thread views such as Activity and background refreshes may use
  only methods explicitly allowed by the gateway, with rebuilt parameters and
  projected results. Only an explicit user thread selection enters the existing
  normal resume flow and accepts its ownership semantics.
- Do not automatically replay writes whose outcome is unknown, including
  `turn/start`, approval responses, interrupts, renames, archives, and deletes.
  The browser may retain an unconfirmed input draft, but the user decides
  whether to submit it again.
- Clear potentially stale browser approval UI on disconnect. The gateway
  reoffers unresolved app-server requests under its existing approval-owner and
  rerouting rules instead of the browser guessing and resending a response.
- Keep sending disabled when snapshot resynchronization fails and offer a retry
  that performs the same constrained reads only. Failure must not degrade into
  assuming that current state is synchronized.

## Consequences

- Automatic recovery can re-establish a verified selected-thread state without
  duplicating operations that have material effects.
- Read-only Activity and other monitoring surfaces do not claim threads or
  change approval routing merely by observing them in the background.
- A user may need to submit a request again when its pre-disconnect result was
  never confirmed. This is the explicit tradeoff for avoiding duplicate writes.
- Recovery requires additional bounded reads and notification coordination. A
  failed sync temporarily blocks sending while still allowing draft editing and
  another read-only retry.
- Future offline queues, turn steering, or cross-device message delivery must
  separately define idempotency keys, acknowledgement semantics, and ownership
  rules. This decision does not authorize automatic write replay.

## Alternatives Considered

- Replay every pending RPC after reconnecting: not selected because the browser
  cannot prove that an upstream write was not already applied, so replay could
  duplicate a turn, approval response, or metadata change.
- Call `thread/resume` in the background for every running thread: not selected
  because it is not a pure read and may change approval ownership among clients.
- Re-enable sending immediately after WebSocket ready without reading a
  snapshot: not selected because missed notifications can leave the UI wrong
  about the current turn, approvals, and whether sending is safe.
- Require a manual page refresh for every recovery: not selected because
  transport and read-only state verification can be automated within explicit
  bounds, and a brief mobile-browser sleep should not force local drafts to be
  discarded.
