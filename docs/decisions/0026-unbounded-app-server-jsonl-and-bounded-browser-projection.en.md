# ADR 0026: Leave app-server JSONL lines unbounded and keep browser projections bounded

- Status: Accepted
- Decision date: 2026-08-14
- Extends: [ADR 0001](0001-codex-app-server-stdio.md), [ADR 0010](0010-app-server-default-thread-history.en.md)

## Context

Ask Codex previously limited each stdout JSONL line from `codex app-server` to
8 MiB and terminated the child process when that limit was exceeded. In
practice, app-server can accumulate long command output in a complete
`commandExecution.aggregatedOutput` and include it again in `item/completed`,
`turn/completed`, `turn/start`, or history-read results. One message can
therefore exceed 8 MiB, stop later lifecycle delivery to the browser, and
interrupt an otherwise healthy thread.

The official app-server protocol defines stdio as one JSON-RPC message per JSONL
line but specifies no 8 MiB line limit. A model context window and the serialized
size of a local protocol message are also different resources: context
compaction does not guarantee that command output in history RPCs or completion
notifications remains below a transport threshold.

The browser boundary still needs an explicit budget. Browsers should not receive
multi-megabyte copies of cumulative tool output, and one large response should
not make the Node event loop recursively copy, sanitize, and serialize the
complete object before discovering that it cannot be sent.

## Decision

- Trusted `codex app-server` stdout JSONL has no fixed per-line byte limit by
  default. The reader grows its buffer as needed and returns to initial capacity
  after a large line; explicit `maxStdoutLineBytes` remains only as a test and
  diagnostic injection option.
- App-server stdout lines above 1 MiB produce metadata-only diagnostics:
  direction, associated RPC method, message and thread/turn/item identifiers,
  largest-string path and category, top-level string-byte totals, and
  image/base64 markers. If a response omits thread identifiers, bounded
  `threadId`/`turnId`/`itemId` values from the method request are used only for
  diagnostic correlation. Logs contain no body text, command output, MCP
  arguments, or credentials.
- App-server-to-browser WebSocket messages retain the 1 MiB limit. A bounded
  size estimate runs before recursive sanitization and `JSON.stringify`, avoiding
  an initial full-object copy.
- Oversized item lifecycle notifications retain IDs, type, status, command
  metadata, exit information, and omission counts without resending full
  cumulative output. Oversized turn lifecycle notifications retain IDs, status,
  and timing while marking items as not loaded.
- Oversized history, resume, and `turn/start` results first become bounded
  summaries. If a summary is still too large, a second projection retains only
  turn shells, status, timing, cursors, and omission counts. Results whose shape
  cannot be proven or reduced within budget return a small RPC error without
  closing the browser or app-server.
- `turn/plan/updated` remains governed by the existing Plan cache's field and
  size rules. An oversized Plan records an unrecoverable tombstone and sends
  `planUnavailable`; a generic large-message warning cannot replace that state.
- The frontend merges omission metadata from compact completion notifications
  with content already received through streaming and never lets a summary
  overwrite existing output.

## Rationale

The fixed 8 MiB value constrained the wrapper implementation rather than the
upstream protocol. Terminating the shared app-server turns one large but valid
message into a thread interruption visible to every browser. Separating trusted
local protocol input from the untrusted and potentially slow browser transport
preserves protocol compatibility while retaining browser memory, serialization,
and backpressure controls.

## Consequences

- Large command output or long history no longer terminates app-server and an
  active thread solely because one stdout JSONL line exceeds 8 MiB.
- Browsers may receive a summary, omission indicator, or resync request instead
  of complete cumulative output. Any bounded prefix already received through
  streaming remains visible.
- App-server can still emit a very large valid line, so gateway peak memory
  depends on that line's size. Metadata diagnostics identify the actual source;
  absence of a fixed upstream limit does not authorize unbounded browser or
  external-client input.
- Compact history may omit Agent text from which a file-download capability
  would otherwise be issued. That capability fails closed and can be recovered
  only when a smaller native page yields the complete item.

## Alternatives Considered

- Raise the fixed stdout limit: not selected because 16, 32, or 64 MiB remains
  an arbitrary protocol-independent termination point and does not handle a
  larger valid result.
- Remove the browser 1 MiB limit too: rejected because it would move duplicate
  cumulative output, main-thread serialization stalls, and slow-client
  backpressure directly to every device.
- Send only `gateway/resyncRequired` for every large message: not selected
  because it loses `item/completed` and `turn/completed` completion state, which
  is exactly what leaves the UI showing running indefinitely.
- Depend on model context compaction for message sizing: rejected because model
  context and app-server JSON-RPC serialization are separate layers; command
  output and history objects can grow independently.
