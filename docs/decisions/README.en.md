# Architecture Decision Records

ADRs preserve durable project decisions and the reasons behind them. Read only
the records relevant to the current task.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-codex-app-server-stdio.md) | Accepted | Use the documented Codex app-server protocol over JSONL stdio. |
| [0002](0002-security-gateway-and-manual-approval.md) | Accepted; amended by 0020, with the relevant policy last amended by 0024 | Keep the gateway as a strict policy boundary and enforce manual approval. |
| [0003](0003-cloudflare-access-dual-gate.md) | Accepted | Use Cloudflare Access and the Ask Codex token as independent remote-access gates. |
| [0004](0004-versioned-project-context.md) | Accepted | Keep concise cross-device development context in versioned documents. |
| [0005](0005-thread-and-turn-settings.md) | Accepted; amended by 0006 | Separate thread identity and sandbox settings from next-turn model controls. |
| [0006](0006-configured-turn-defaults.md) | Accepted | Amend model defaults to use filtered effective Codex configuration. |
| [0007](0007-document-language.en.md) | Accepted | Use Simplified Chinese as the primary project documentation language and maintain corresponding English versions. |
| [0008](0008-paginated-thread-history.en.md) | Superseded by 0010 | Use paginated history for new threads and recover oversized turns through item pages. |
| [0009](0009-temporary-image-attachments.en.md) | Accepted | Submit images to Codex through constrained temporary HTTP attachments and one-use IDs. |
| [0010](0010-app-server-default-thread-history.en.md) | Accepted | Use the app-server default history contract for new threads while retaining read recovery for paginated threads. |
| [0011](0011-browser-local-image-previews.en.md) | Accepted | Retain bounded sent-image previews in IndexedDB for the same browser profile and Origin. |
| [0012](0012-read-only-connection-recovery.en.md) | Accepted | Recover connections from read-only snapshots without claiming threads or replaying unconfirmed writes. |
| [0013](0013-thread-working-directory-defaults-and-file-download-scope.en.md) | Accepted | Use the selected thread's Working directory as new-thread context and a constrained file-download scope. |
| [0014](0014-bounded-structured-plan-recovery.en.md) | Accepted | Recover structured Plans through bounded gateway snapshots with distinct recoverable, unrecoverable, and unknown states. |
| [0015](0015-explicit-active-turn-steering.en.md) | Accepted | Bind explicit text steering to an exact active turn with strict confirmation, ownership, and no-replay semantics. |
| [0016](0016-constrained-native-thread-fork.en.md) | Accepted | Expose native fork only by source thread ID with strict parameter, result, ownership, and no-replay semantics. |
| [0017](0017-constrained-file-input-and-browser-local-copies.en.md) | Accepted | Submit ordinary files through temporary gateway context and retain bounded download copies only in the same-Origin browser. |
| [0018](0018-server-persistent-explicit-message-queue.en.md) | Accepted | Persist cross-device text in a server outbox and consume it only through an explicitly synchronized browser without replay. |
| [0019](0019-monotonic-plan-revisions-during-resync.en.md) | Accepted | Use monotonic gateway revisions so an older resync snapshot cannot swallow a newer buffered Plan. |
| [0020](0020-one-turn-prompt-free-approval.en.md) | Superseded by 0022 | Keep manual approval as the default while allowing one explicitly armed prompt-free turn on an existing idle thread. |
| [0021](0021-first-turn-one-shot-prompt-free-approval.en.md) | Superseded by 0022 | Default every turn to manual and extend the explicit one-shot choice to a configured new thread's first turn. |
| [0022](0022-sandbox-aware-one-turn-auto-run.en.md) | Superseded by 0023 | Use `untrusted` for ordinary direct turns and `on-request` for one-shot auto-run while retaining human review at the sandbox boundary. |
| [0023](0023-per-turn-manual-and-auto-execution-environments.en.md) | Superseded by 0024 | Have the gateway independently pin each direct turn to a manual or automatic approval and sandbox combination. |
| [0024](0024-codex-aligned-manual-and-one-turn-auto.en.md) | Accepted | Match manual mode to normal Codex permissions and keep human fallback in one broadly automatic turn. |
| [0025](0025-prioritize-chrome-less-mobile-launch-over-pwa-installation.en.md) | Accepted | Prioritize address-bar-free mobile launch and omit a PWA Manifest for now. |
| [0026](0026-unbounded-app-server-jsonl-and-bounded-browser-projection.en.md) | Accepted | Leave app-server stdout JSONL lines unbounded while keeping browser messages bounded through projections. |

For the primary Simplified Chinese index, see [README.md](README.md).

## Lifecycle

Each ADR has a status of `Proposed`, `Accepted`, `Rejected`, `Deprecated`, or
`Superseded`. Accepted records are historical and must not be deleted or
rewritten when the decision changes. Add a replacement ADR, mark the earlier
record `Superseded by ADR NNNN`, and link the two records.

Use an ADR for a lasting architecture, security, protocol, dependency, product,
or workflow choice with meaningful alternatives. Do not create one for routine
implementation changes or temporary task planning.
