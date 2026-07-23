# Architecture Decision Records

ADRs preserve durable project decisions and the reasons behind them. Read only
the records relevant to the current task.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-codex-app-server-stdio.md) | Accepted | Use the documented Codex app-server protocol over JSONL stdio. |
| [0002](0002-security-gateway-and-manual-approval.md) | Accepted | Keep the gateway as a strict policy boundary and enforce manual approval. |
| [0003](0003-cloudflare-access-dual-gate.md) | Accepted | Use Cloudflare Access and the Ask Codex token as independent remote-access gates. |
| [0004](0004-versioned-project-context.md) | Accepted | Keep concise cross-device development context in versioned documents. |

## Lifecycle

Each ADR has a status of `Proposed`, `Accepted`, `Rejected`, `Deprecated`, or
`Superseded`. Accepted records are historical and must not be deleted or
rewritten when the decision changes. Add a replacement ADR, mark the earlier
record `Superseded by ADR NNNN`, and link the two records.

Use an ADR for a lasting architecture, security, protocol, dependency, product,
or workflow choice with meaningful alternatives. Do not create one for routine
implementation changes or temporary task planning.
