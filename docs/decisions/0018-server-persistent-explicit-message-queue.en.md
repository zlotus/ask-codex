# ADR 0018: Server-persistent, explicitly consumed cross-device message queue

- Status: Accepted
- Decision date: 2026-08-07
- Extends: [ADR 0002](0002-security-gateway-and-manual-approval.md), [ADR 0012](0012-read-only-connection-recovery.en.md)
- Does not change: [ADR 0015](0015-explicit-active-turn-steering.en.md)

## Context

Users need to prepare text in one browser or device and later send it to the
same native Codex thread from another device. Browser-local drafts do not cross
devices, while connection recovery deliberately does not replay a `turn/start`
whose result is unknown. Implementing the queue as automatic retry after a
disconnect could create duplicate turns and could execute in the background
without an active browser to own approvals.

The stable Codex CLI 0.147.0 bindings contain
`turn/start.clientUserMessageId`, but the generated schema does not define the
scope or lifetime of duplicate keys, behavior for the same key with a different
payload, or cross-process behavior. Field presence therefore is not a verified
idempotency guarantee. Stable `thread/inject_items` only appends raw Responses
API history items; it does not create a normal turn or provide the confirmation
and approval-owner semantics this product needs. Experimental remote-control,
realtime, or other protocol methods should not become dependencies of the first
queue version.

## Decision

- The queue is an Ask Codex-owned, server-persistent text outbox, not native
  Codex thread history. V1 accepts only an existing thread ID, one non-empty
  text value, and the last visible turn ID at enqueue time. It accepts no
  attachments, paths, cwd, `additionalContext`, model, effort, sandbox, or raw
  app-server parameters.
- Browsers can call only field-reconstructed local RPCs:
  `messageQueue/list`, `messageQueue/enqueue`, `messageQueue/cancel`, and
  `messageQueue/send`. Lists are scoped by thread. Cancel and send must include
  the current item revision so two devices cannot act from the same stale
  snapshot. A `messageQueue/changed` notification containing no message body
  tells other authenticated browsers to read again.
- A connected browser that has completed read-only synchronization must
  explicitly click send to consume an item. Timers, startup, WebSocket
  reconnect, Codex ready, and background thread refresh never send queue items.
  A queue item is never converted to `turn/steer`. The browser that successfully
  dispatches the item becomes the approval owner.
- Persistent state follows `queued -> claimed -> dispatching -> confirmed`.
  Context changes, a busy thread, an unavailable read, or a known upstream
  rejection enter `needsReview`; the user must explicitly confirm again using
  the new revision. Once `turn/start` may have executed without a valid result,
  the item becomes `indeterminate`, cannot be requeued or resent, and can only
  be removed after the user checks native thread history. Cancellation,
  expiration, and confirmation enter `cancelled`, `expired`, and `confirmed`.
- `claimed` is a short lease before the `turn/start` text-dispatch boundary. It
  may include stable `thread/read` and `thread/resume` preparation. Because the
  queued text has not been submitted, it can safely return to `queued` after a
  gateway restart. `dispatching` means that write boundary has been crossed and
  must recover as `indeterminate`. Every state transition is atomically
  persisted before the next step. Notifications, elapsed time, and inference
  never convert an unknown outcome back to a sendable state.
- Before send, inside the per-thread ownership-write serialization section, the
  gateway uses stable `thread/read` with `includeTurns: true` to verify the
  thread ID, runtime status, and last turn ID. Active or system-error threads
  are blocked; a changed last turn enters `needsReview`. Explicit context-change
  confirmation permits another attempt but never bypasses the busy-thread
  check. The current protocol has no cross-app-server revision/CAS, so this
  check narrows the race window without promising cross-process atomicity.
- Immediately before the actual send, stable `thread/resume` with
  `excludeTurns: true` ensures the thread is loaded. Both resume and
  `turn/start` fix `approvalPolicy: "on-request"` and
  `approvalsReviewer: "user"`; no sandbox override is supplied, preserving an
  existing `externalSandbox`. `turn/start` contains exactly one text input.
  Only a structurally valid `TurnStartResponse` reaches `confirmed`.
- V1 does not submit `clientUserMessageId` and does not use
  `thread/inject_items`. A later ADR may authorize bounded retry of
  `indeterminate` items only after upstream documentation or controlled tests
  establish duplicate handling, scope, retention, and payload-conflict behavior.
- Persistence uses mature Node.js 22 filesystem APIs and commits a complete,
  versioned JSON document through a same-directory temporary file, file `fsync`,
  atomic `rename`, and directory `fsync`. The default path is
  `$XDG_STATE_HOME/ask-codex/message-queue.json`, or
  `~/.local/state/ask-codex/message-queue.json` when XDG state is unset. An
  absolute `ASK_CODEX_QUEUE_PATH` may override it. Exactly one Ask Codex gateway
  process may use a queue file.
- Each text is limited to 64 KiB UTF-8. The store allows at most 64 active
  items, 128 total records, and 4 MiB. Active items expire after 7 days;
  `confirmed`, `cancelled`, and `expired` records are retained for at most 24
  hours. Directories and files are created with modes `0700` and `0600`.
  Unknown versions, malformed structures, duplicate IDs, and oversized files
  fail closed at startup rather than silently discarding unsent user text.

## Rationale

Only a server outbox can retain drafts across browsers and devices. Explicit
consumption preserves user control over execution time and approval
responsibility. Separating local claim/revision deduplication from unknown
upstream outcomes prevents concurrent duplicate sends within one gateway
without pretending that app-server offers end-to-end exactly-once delivery.
Mature atomic file replacement avoids an extra database dependency for a
single-process bounded queue and preserves the project's Node.js 22.12 runtime
baseline.

## Consequences

- Plain text queued on one device persists in the gateway and appears in the
  same thread panel on another authenticated device, where it can be sent or
  cancelled.
- A gateway or network failure near the write boundary may require the user to
  check native thread history before clearing an `indeterminate` item. The
  system requires human judgment rather than risking duplicate execution.
- Context checking requires a potentially large stable
  `thread/read(includeTurns: true)`. Failure or an untrusted response prevents
  send. A very long legacy thread may need to be opened and managed normally
  rather than weakening verification.
- The queue stores user text in plaintext with permissions equivalent to the
  operating-system account running Ask Codex. It stores no token, attachment,
  path, tool output, or approval content.
- This is not a multi-process database. Two gateways cannot share one path,
  and synchronization across hosts remains out of scope.

## Alternatives Considered

- Browser IndexedDB drafts only: not adopted because they cannot cross devices.
- Start turns automatically without a browser: rejected because it changes
  execution timing and can leave approvals without an owner.
- Convert queue items into active-turn `turn/steer`: rejected because steering
  is bound to one exact turn and has different semantics.
- Automatically retry timed-out `turn/start`: rejected because
  `clientUserMessageId` idempotency semantics are not formally established;
  field presence alone does not authorize replay.
- Use `thread/inject_items`: rejected because it mutates model-visible history
  instead of creating a normal turn and bypasses the standard execution,
  confirmation, and owner flow.
- Use `node:sqlite` or a third-party database: not adopted for V1 because the
  project supports Node.js 22.12 and a single-process bounded state machine is
  satisfied by mature atomic filesystem APIs. Multi-process writers or larger
  audit queries would require a separate decision.
