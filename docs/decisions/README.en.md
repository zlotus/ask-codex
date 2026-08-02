# Architecture Decision Records

ADRs preserve durable project decisions and the reasons behind them. Read only
the records relevant to the current task.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-codex-app-server-stdio.md) | Accepted | Use the documented Codex app-server protocol over JSONL stdio. |
| [0002](0002-security-gateway-and-manual-approval.md) | Accepted | Keep the gateway as a strict policy boundary and enforce manual approval. |
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

For the primary Simplified Chinese index, see [README.md](README.md).

## Lifecycle

Each ADR has a status of `Proposed`, `Accepted`, `Rejected`, `Deprecated`, or
`Superseded`. Accepted records are historical and must not be deleted or
rewritten when the decision changes. Add a replacement ADR, mark the earlier
record `Superseded by ADR NNNN`, and link the two records.

Use an ADR for a lasting architecture, security, protocol, dependency, product,
or workflow choice with meaningful alternatives. Do not create one for routine
implementation changes or temporary task planning.
