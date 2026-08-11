# ADR 0023: Pin an independent manual or automatic environment to each turn

- Status: Accepted
- Decision date: 2026-08-11
- Supersedes: [ADR 0022](0022-sandbox-aware-one-turn-auto-run.en.md)
- Amends: [ADR 0002](0002-security-gateway-and-manual-approval.md)

## Context

ADR 0022 distinguished ordinary and automatic turns only through `untrusted`
and `on-request`, while retaining the thread's current sandbox. Stable
`TurnStartParams` approval and sandbox overrides affect the current and later
turns. Changing only approval therefore makes manual and automatic behavior
depend on sandbox state left by an earlier turn, and encourages a client to
change the sandbox through `thread/resume` before sending. That broadens the
thread-level state and ownership effects and can fail with
`thread/resume did not apply the requested sandbox` when upstream does not apply
the requested value.

The expected product model is that each turn's launch parameters pin its
execution environment. Manual mode should pause before commands, edits, network
access, or other boundary crossings. Automatic mode should run routine work in
the current workspace while retaining user review at the sandbox boundary. A
started turn must not change when the browser views another session or edits a
later turn's selection.

Stable Codex CLI 0.147.0 bindings show that `TurnStartParams` supports
`approvalPolicy`, `approvalsReviewer`, and a complete `sandboxPolicy` together.
[Official OpenAI approval and sandbox combinations](https://learn.chatgpt.com/docs/agent-approvals-security#common-sandbox-and-approval-combinations)
describe `untrusted + read-only` as the "Always ask for approval" configuration
and `on-request + workspace-write` as the automatic preset. Neither requires an
experimental settings API.

## Decision

- A browser direct `turn/start` submits only
  `executionMode: "manual" | "auto"`, defaulting to `manual`. The gateway
  rejects raw browser approval, reviewer, sandbox, writable-root, network, and
  temporary-directory policy.
- For every `manual` turn, the gateway injects
  `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`, and
  `{ type: "readOnly", networkAccess: false }`. Known-safe reads may still run;
  commands, edits, network access, and other operations that cross the boundary
  must create a user-reviewable approval.
- For every `auto` turn, the gateway injects
  `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`, and an
  authoritative `workspaceWrite` policy. Reads, edits, and commands inside the
  current workspace may run automatically. Writes outside the workspace,
  restricted network access, and other sandbox crossings still require user
  approval.
- Writable roots, network access, and temporary-directory options for
  `workspaceWrite` may come only from strictly validated app-server
  `thread/start`, `thread/resume`, or `thread/fork` results or
  `thread/settings/updated` notifications. The gateway caches authority for at
  most 4,096 threads in process. On a miss, it first performs a safe
  `thread/resume` probe without a sandbox override. If only `readOnly` is known,
  an auto turn uses a default `workspaceWrite` policy with no extra writable
  roots and network disabled. The browser sees only the sandbox type.
- Explicit `dangerFullAccess` remains unchanged, while `externalSandbox`
  receives no turn sandbox override. Auto mode is unavailable for either, and
  the gateway rejects forged `auto` requests. A user's deliberate Full access
  choice is not silently undone by the mode.
- Auto mode must not first mutate the sandbox through `thread/resume`. Ordinary
  resume remains available for explicit thread selection and synchronization;
  the existing safe resume flow may also apply a sandbox change that the user
  explicitly chose in the settings dialog.
- Auto remains an in-page, one-turn choice. While Working, the control is locked
  to the active turn's captured launch mode, including across session views. It
  returns to manual after completion, cancellation, failure, or a failed start.
  Thread creation, resume, fork, queue consumption, and steering do not inherit
  the choice.
- The implementation uses no experimental settings RPC, WebSocket app-server
  transport, permission profile, or other experimental API. Unsupported
  granular permissions and MCP elicitation continue to fail closed.

## Rationale

Approval controls when Codex pauses; sandboxing controls what it can do without
additional authority. Treating them as one per-turn product mode produces a
stable mental model. Rebuilding final parameters at the gateway from
authoritative app-server state prevents browser-forged writable roots or
network access and avoids implementing a one-turn choice as a thread-level
resume mutation.

## Consequences

- Default manual turns are stricter than under ADR 0022: workspace writes and
  command execution meet the read-only boundary. Known-safe reads may still run,
  so the product must not promise a prompt for every read operation.
- Auto turns can work continuously inside the workspace, while sandbox-boundary
  requests still reach the user through the existing owner route.
- App-server may record a turn override as a later setting, but this does not
  make the mode inherit: every later Ask Codex direct turn sends its complete
  manual or automatic combination again.
- The gateway must retain bounded sandbox authority and strip writable-root,
  network, and temporary-directory details from lifecycle results and settings
  notifications before forwarding them.

## Alternatives Considered

- Retain ADR 0022 and switch only between `untrusted` and `on-request`: rejected
  because it cannot pin each turn's writable boundary or make file changes meet
  manual mode's read-only boundary.
- Switch to `workspace-write` through `thread/resume` before auto mode: rejected
  because it changes thread-level state, broadens ownership and failure effects,
  and recreates the observed sandbox-override mismatch.
- Let the browser submit a complete `sandboxPolicy`: rejected because the
  browser is not authoritative for writable roots, network, or temporary paths.
- Persist auto mode in a thread, page, or device: rejected because the accepted
  interaction requires explicit per-turn choice.
- Use experimental settings or permission-profile APIs: rejected because mature
  stable `turn/start` fields are sufficient.
