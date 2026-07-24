# ADR 0008: Use paginated history for new threads

- Status: Accepted
- Decision date: 2026-07-24

## Context

Ask Codex bounds browser, gateway, and app-server message sizes.
`thread/turns/list` can fall back to a summary when a full turn is too large,
but requesting that same full turn again still exceeds the same limit and
cannot recover its detail.

Codex CLI 0.145.0 provides the experimental `thread/start.historyMode` field
and `thread/items/list`. Item listing is available only for threads created
with the `paginated` history contract; existing `legacy` threads return
`thread/items/list is not supported yet`. The two modes persist different
event structures, and upstream provides no migration API. Editing local
metadata alone could cause projection failures or history loss.

In this CLI version, paginated threads also do not support fork, rollback, or
detached review. Ask Codex does not currently expose those operations, but the
restriction still applies when another client operates on the same native
thread.

## Decision

- The gateway injects `historyMode: "paginated"` into every new
  `thread/start`. The browser cannot provide or select this field.
- Expose `thread/items/list` to the browser only through a narrow policy: both
  `threadId` and `turnId` are required, all parameters are rebuilt, and
  `limit` is capped at 100.
- The client manually loads item pages for one turn in ascending order. When a
  page exceeds the message limit, it retries with smaller pages down to one
  item per page instead of raising existing message limits.
- Select the recovery path from Codex's returned `thread.historyMode`. Keep the
  existing one-turn full-detail retry for `legacy` threads. When the mode is
  unknown, item pagination may be attempted and falls back only when upstream
  explicitly reports that the method is unsupported.
- Do not migrate or manually rewrite existing `legacy` threads. They retain
  their original Codex-native history contract.

## Consequences

- Oversized turns in new threads can recover detail incrementally, deduplicated
  by item id across pages, while preserving the gateway's bounded-message
  model.
- An old `legacy` thread whose full single turn still exceeds the limit remains
  summary-only. A paginated thread also cannot bypass the gateway limit when
  one item by itself exceeds 1 MiB.
- Paginated threads retain the current Codex CLI restrictions on fork,
  rollback, and detached review. CLI upgrades must recheck those capabilities
  and the experimental protocol shapes.
- Passive turn or item reads do not claim approval ownership. Ownership remains
  established only by the browser that starts or resumes a thread or starts a
  turn.

## Alternatives Considered

- Raise the gateway message limit: rejected because it only postpones the same
  failure and increases browser and gateway memory risk.
- Manually convert existing threads to `paginated`: rejected because there is
  no official migration contract and the persisted event structures differ.
- Let the browser choose the history mode: rejected because it exposes an
  unnecessary persistence-policy switch and could create new threads that
  cannot be paged.
- Call `thread/items/list` unconditionally for every thread: rejected because
  known `legacy` threads must fail, creating useless requests and ambiguous
  errors.
