# ADR 0014: Recover structured plans through bounded gateway snapshots

- Status: Accepted
- Decision date: 2026-08-05
- Extends: [ADR 0012](0012-read-only-connection-recovery.en.md)

## Context

In Codex CLI 0.146.0, each `turn/plan/updated` notification carries a complete
Plan snapshot rather than a step delta. The official `Turn`, `thread/read`, and
`thread/turns/list` structures do not contain a Plan. If a sleeping browser,
WebSocket disconnect, bounded read-only resynchronization buffer, or thread
switch misses one notification, a later official turn snapshot cannot restore
it. The UI can therefore remain on an earlier step until the next complete Plan
notification makes it appear to jump ahead.

Codex declares progress only when it actually emits `turn/plan/updated`. A step
can legitimately take a long time, and the model can wait until a block of work
is complete before updating the Plan again. The client must not infer completion
from tool counts, wall-clock time, or message content.

## Decision

- Keep the latest complete valid `turn/plan/updated` snapshot in the gateway,
  keyed by `[threadId, turnId]`, and use the same field-by-field reconstruction
  for realtime broadcast. Retain only `explanation` and each step's `step` plus
  the protocol statuses `pending | inProgress | completed`; do not pass unknown
  fields to the browser.
- Enforce explicit cache bounds: by default 512 records, 8 MiB total, 128 KiB
  per record, 128 steps, a 32-KiB explanation, and 8 KiB per step. Add at most
  256 KiB and 128 Plans to one RPC result, without cloning duplicate turn IDs.
  Limits must be positive safe integers. UTF-8 accounting includes identifiers,
  the map key, serialized content, and fixed record overhead.
- Do not broadcast a malformed or over-limit realtime Plan payload. Store a
  bounded tombstone and emit `gateway/resyncRequired`; a recovery snapshot uses
  `plan: null` plus a `turn/plan/updated` omission to say explicitly that the
  latest Plan cannot be recovered. A completely missing cache record is unknown
  and does not prove that the turn had no Plan, so it adds no `plan` field.
- Attach cached snapshots to turns in `thread/read`, `thread/turns/list`,
  `thread/resume`, `initialTurnsPage`, and `turn/start` results, plus
  `turn/started` and `turn/completed` notifications. WebSocket disconnects, turn
  completion, and Codex child-process restarts do not clear the cache. A
  successful thread deletion or `thread/deleted` notification does.
- Merge three states in the browser: a Plan object is an authoritative recovery
  snapshot; `plan: null` is explicitly unrecoverable or authoritatively empty
  and clears a stale Plan while retaining the relevant omission; an absent
  `plan` means unknown gateway state or an ordinary sparse turn and does not
  change a Plan already held by the browser. The browser parser repeats the
  step, text, and aggregate size limits.
- During read-only resynchronization, a turn snapshot with its own `plan` field
  covers earlier buffered Plan notifications for that turn. When `plan` is
  absent, buffered notifications still replay in arrival order. JSONL and
  WebSocket arrival order are authoritative. `emittedAtMs` and
  `gatewayReceivedAtMs` are retained for diagnostics only and never sort or
  resolve state conflicts.
- Keep this cache in the Ask Codex gateway process only; it is not a new
  persistent conversation database. After a gateway-process restart or record
  eviction, a Plan not observed again cannot be reconstructed through the
  current app-server read APIs.

## Rationale

The gateway is the narrowest shared point that observes app-server realtime
notifications and projects read-only snapshots for browsers. Keeping a complete
normalized snapshot lets reconnection, thread switching, and read races use one
state source without calling ownership-changing `thread/resume` or making the
browser guess model progress. Distinct recoverable, unrecoverable, and unknown
states prevent a cache miss from being mistaken for proof that no Plan exists.

## Consequences

- A latest Plan already observed by the gateway and still within budget can be
  restored through a later read-only turn snapshot. A missed notification no
  longer leaves waiting for another Plan update as the only recovery path.
- If the panel remains on a step without a connection or recovery warning,
  Codex has not sent another complete Plan. Several steps may still complete
  together later as part of normal model update cadence.
- Malformed, over-limit, or per-response-budget omissions are shown as
  unrecoverable instead of presenting an old Plan as current. With unknown
  cache state, an existing browser snapshot can remain, but a new page or other
  device cannot reconstruct a non-persistent Plan.
- Plan snapshots consume a small bounded amount of gateway memory and add a
  bounded amount to read-only turn responses. Entry, total-byte, and decoration
  limits degrade older records or additions to the current response rather than
  allowing unbounded amplification.

## Alternatives Considered

- Depend only on app-server turn reads: not selected because current official
  Turn and read responses contain no Plan.
- Keep the last Plan only in the browser: not selected because it cannot restore
  an update missed while disconnected, after reopening the page, or on another
  device.
- Persist Plans in a new local database: not selected because this issue needs
  recovery only across connection and Codex child-process lifecycles, while
  persistence would require additional versioning, cleanup, privacy, and native
  thread consistency rules.
- Advance steps from completed tools or elapsed time: not selected because only
  Codex's complete Plan notification declares Plan state; client inference
  would create a second unreliable execution state machine.
- Sort by `emittedAtMs`: not selected because timestamps are diagnostic while
  transport arrival is the protocol processing order.
