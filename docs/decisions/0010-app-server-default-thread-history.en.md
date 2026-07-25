# ADR 0010: Use the app-server default history contract for new threads

- Status: Accepted
- Decision date: 2026-07-25
- Supersedes: [ADR 0008](0008-paginated-thread-history.en.md)

## Context

ADR 0008 used the experimental Codex CLI 0.145.0 schema to make the gateway
inject `historyMode: "paginated"` for every new thread. Real first-turn testing
showed that the field's presence in the schema does not mean every runtime can
write paginated threads end to end; the first turn can fail with
`paginated_threads is not supported yet`. A successful `thread/start` is not a
sufficient probe because the failure can occur only when starting the turn.

App-server does not advertise a capability that can reliably establish this
support before a turn. `thread/start` and `turn/start` also have no idempotency
key. Retrying after an error or timeout can create duplicate threads, duplicate
turns, or orphaned threads. An image failure also consumes and releases one-use
attachments, so the original request cannot safely be redirected to a hidden
replacement thread.

## Decision

- The gateway no longer sends the experimental `historyMode` field in
  `thread/start`; app-server chooses its default history contract. The browser
  still cannot provide or select this field.
- Do not infer paginated write support from a CLI version, an error string, or a
  successful `thread/start`, and do not automatically retry `thread/start` or
  `turn/start`.
- Keep the narrowly constrained `thread/items/list` policy and select recovery
  from Codex's returned `thread.historyMode` for existing paginated threads.
  Default or `legacy` threads retain bounded full-turn retry and summary
  fallback.
- Do not migrate, rewrite, or automatically delete existing threads. Reconsider
  selecting paginated history for new threads only after app-server advertises
  an explicit capability and the real first-turn path has been verified.

## Consequences

- New threads no longer fail their first turn because Ask Codex forced an
  experimental contract that the runtime did not fully support.
- New threads using app-server's default `legacy` contract may remain
  summary-only when one full turn exceeds the gateway limit.
- Existing paginated threads, including those created by other clients, retain
  item-level recovery; the read policy and client implementation remain useful.
- Empty paginated threads created before this fix and unable to start a turn are
  not migrated automatically; the user should create a new thread.

## Alternatives Considered

- Explicitly send `historyMode: "legacy"`: not selected because the field itself
  remains experimental. Omitting it preserves app-server ownership of its
  default persistence contract.
- Retry after a specific error: rejected because the requests are not
  idempotent, and an error or timeout does not prove that the first request made
  no state change.
- Enable pagination by CLI version: rejected because schema or version presence
  does not prove that the complete first-turn write path is usable.
- Let the browser select the history mode: rejected because the persistence
  contract remains a gateway and app-server policy concern.
