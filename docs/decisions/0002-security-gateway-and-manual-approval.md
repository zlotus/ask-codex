# ADR 0002: Make the gateway a strict manual-approval boundary

- Status: Accepted
- Decision date: 2026-07-21
- Recorded retrospectively: 2026-07-23

## Context

A browser able to call arbitrary app-server methods or provide unrestricted
parameters would effectively control the host-side Codex process. Remote access
increases the impact of browser compromise, proxy mistakes, and protocol drift.
The browser therefore cannot be trusted to choose the gateway's security
policy, even though Ask Codex is a single-user application.

Codex also sends requests back to clients for approvals, structured questions,
permissions, and elicitations. Unknown or partially supported request shapes
must not silently become approval grants.

## Decision

Use the server as a policy boundary rather than a transparent proxy:

- Maintain a complete allowlist of browser-callable RPC methods.
- Rebuild each method's parameters from explicit allowed fields and validated
  values; reject unknown fields.
- Inject `approvalPolicy: "on-request"` and
  `approvalsReviewer: "user"` for thread creation and resume regardless of
  browser input.
- Route app-server approval requests through a separate response policy and
  fail closed for unsupported granular permissions and MCP elicitations.
- Preserve an existing `externalSandbox` when resuming instead of silently
  replacing it.
- Validate absolute working directories, enforce resource limits, keep the web
  token out of the Codex child environment, and expose no general-purpose file
  or terminal endpoint.

Every newly exposed protocol capability requires a narrow gateway policy and
focused tests for allowed and rejected inputs.

## Consequences

- Browser or UI bugs cannot directly opt out of the configured manual approval
  model or invoke arbitrary app-server methods.
- New Codex features require deliberate policy work on both request directions.
- Some upstream capabilities remain unavailable until Ask Codex can represent
  them safely.
- The user must review consequential requests, which adds friction but is a core
  product constraint rather than an optional mode.

## Alternatives Considered

- Forward arbitrary browser RPC methods and parameters: rejected because it
  removes the gateway's security boundary.
- Allow browser-selected approval policies, including `never`: rejected because
  a compromised client could disable human review.
- Auto-approve selected tool categories: rejected as a default because category
  names do not reliably capture command, path, and environment impact.
- Expose a browser terminal for parity with broader web IDEs: deferred as a
  separate high-risk host capability that does not pass through Codex approval.
