# ADR 0019: Resolve Plans during resync with monotonic revisions

- Status: Accepted
- Decision date: 2026-08-07
- Extends: [ADR 0014](0014-bounded-structured-plan-recovery.en.md)

## Context

ADR 0014 makes the gateway cache the latest complete `turn/plan/updated` and
attach that Plan to read-only resynchronization snapshots. The browser buffers
realtime notifications that arrive while resynchronizing. Previously, any turn
with its own `plan` field in the snapshot was treated as covering every buffered
Plan notification for that turn.

That test had no ordering evidence. After a snapshot request reads the cache but
before its response reaches the browser, the gateway can observe a newer Plan
and place its realtime notification in the browser's resync buffer. When the old
snapshot completes, it can incorrectly discard that newer notification. The
Plan panel then remains on an old step until Codex emits another Plan. A network
transition from Working through Retry to Sync widens this race window, so the
symptom is strongly associated with reconnect even though Codex did not stop
updating the Plan.

## Decision

- Assign every observed Plan update a process-local, monotonically increasing
  positive safe-integer revision. Both valid Plans and tombstones representing
  an unrecoverable latest Plan receive a revision.
- Attach the same revision to the gateway's field-rebuilt realtime notification
  and cached recovery snapshot as `askCodexPlanRevision`. This is Ask Codex
  gateway metadata, not an upstream app-server field, and is never sent to
  Codex.
- During resync, treat a buffered notification as covered only when both it and
  the snapshot have valid revisions and the notification revision is less than
  or equal to the snapshot revision. A newer notification must replay in its
  original arrival order.
- Do not infer coverage when either revision is absent or invalid. For old
  gateways, decoration-budget fallback, and unknown cache state, unversioned
  buffered notifications still replay. A snapshot with a `plan` but no valid
  revision still follows the existing three-state merge rules.
- Store the revision alongside its Plan in browser state. A sparse turn snapshot
  without `plan` preserves the existing Plan and revision; an explicit Plan or
  tombstone updates both. Gateway restart loses both cache and counter, so a
  revision is not a persistent cross-process identity and revisions from
  different gateway instances are never compared.
- Transport arrival order remains authoritative. `emittedAtMs` and
  `gatewayReceivedAtMs` remain diagnostic only and do not resolve conflicts.

## Rationale

The revision is assigned by the same gateway that creates cached snapshots and
realtime projections, so it directly expresses their order. It distinguishes a
notification already represented by a snapshot from one observed after the
snapshot read without an ownership-changing RPC, synchronized clocks, or Plan
persistence. When a revision is absent, replay may briefly reapply or replay an
older complete Plan. Notifications retain their original arrival order, so the
newer progress is not silently discarded in the final state.

## Consequences

- A new Plan observed during Working -> Retry -> Sync is no longer swallowed by
  an older resync snapshot, so the panel continues to reflect the latest
  progress actually observed by the gateway.
- The client still does not infer Codex execution progress. A step remains
  unchanged when Codex emits no new Plan.
- Each recoverable Plan gains one small integer of metadata, included in the
  existing cache byte budget. The gateway fails closed if the counter approaches
  `Number.MAX_SAFE_INTEGER`; this is not practically reachable in one process.
- The fix uses only Ask Codex projection metadata and stable app-server
  notifications. It introduces no experimental Codex API.

## Alternatives Considered

- Let any Plan-bearing snapshot cover every buffered notification: rejected
  because it cannot prove that the snapshot is newer.
- Always replay every buffered Plan even when trustworthy revisions are
  available: this avoids a stall but lets an old notification already proven
  covered overwrite a newer snapshot, creating the opposite regression.
- Compare client or server timestamps: rejected because those timestamps are
  diagnostic and do not reliably represent the cache-read boundary.
- Persist a global revision or Plans: not adopted because this race exists only
  inside one gateway process's resync window. ADR 0014's bounded in-process
  cache boundary remains unchanged.
