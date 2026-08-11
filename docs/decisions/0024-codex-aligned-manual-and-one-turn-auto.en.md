# ADR 0024: Match manual mode to Codex and retain human fallback in one-turn auto

- Status: Accepted
- Decision date: 2026-08-11
- Supersedes: [ADR 0023](0023-per-turn-manual-and-auto-execution-environments.en.md)
- Amends: [ADR 0002](0002-security-gateway-and-manual-approval.md)

## Context

ADR 0023 set default manual mode to `untrusted + readOnly` and one-turn auto
mode to `on-request + workspaceWrite`. Both combinations retained human
approval, but their product behavior was the reverse of normal Codex use:
ordinary commands and workspace edits met an earlier boundary in the default
mode, while the mode called automatic still paused at sandbox boundaries. In
practice this produced too many prompts, retries after failed operations, and
guessing about permission state.

[Official OpenAI sandbox documentation](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)
defines `workspace-write + on-request` as the low-friction local automation
combination: workspace reads, writes, and commands run automatically, while
sandbox crossings ask the user. `danger-full-access` removes filesystem and
network sandbox boundaries. `never` means Codex does not pause for approval at
all, so it also removes the human fallback for requests that still require an
explicit decision. That does not satisfy the product requirement that ordinary
operations stay silent while anything that cannot be allowed automatically can
still be approved manually.

Stable Codex CLI 0.147.0 `TurnStartParams` independently supports
`approvalPolicy` and `sandboxPolicy`; `AskForApproval` includes `on-request`,
`SandboxPolicy` includes `dangerFullAccess`, and stable server requests define
human responses for command, file, granular permission, and MCP elicitation
requests. No experimental settings API is required.

## Decision

- Browser direct `turn/start` submits only a field-rebuilt
  `executionMode: "manual" | "auto"`, defaulting to `manual`. The browser may
  not submit approval, reviewer, complete sandbox, writable-root, network, or
  temporary-directory policy.
- For every `manual` turn, the gateway injects `approvalPolicy: "on-request"`,
  `approvalsReviewer: "user"`, and a `workspaceWrite` sandbox. Reads, writes,
  and routine commands inside the workspace proceed directly. Codex asks the
  user before network access not already enabled by the sandbox,
  outside-workspace writes, protected `.git` writes, and other sandbox
  crossings. After approval, Codex continues through its normal
  elevated-execution path.
- For every explicit `auto` turn, the gateway injects
  `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`, and
  `{ type: "dangerFullAccess" }`. Filesystem and network sandbox boundaries are
  removed, so ordinary command, file, and network operations run silently when
  possible. Stable requests that still require an explicit decision because of
  rules, permission tools, MCP, or another confirmation surface to the user
  instead of being silently rejected by `never`.
- Ask Codex rebuilds every supported stable human response field by field.
  Command and file approvals can return only decisions actually offered by
  app-server. A granular permission request can be accepted exactly as requested
  or declined, and an accepted grant is forced to the current turn. Standard MCP
  typed forms and HTTP(S) URL elicitations can be accepted or declined.
  `openai/form`, which the client cannot safely validate, is shown but can only
  be declined; unknown request types continue to fail closed.
- New-thread `thread/start` is fixed to `on-request + workspace-write`; resume
  and fork remain fixed to `on-request` and accept no browser sandbox override.
  A cross-device queued send first restores authoritative thread state, then
  explicitly materializes its turn as `manual`. Steering carries no execution
  policy.
- The UI exposes no read-only, workspace-write, or Full access selector. Auto
  can be armed one turn at a time only on an existing idle thread or a configured
  new-thread draft. While Working, the control is locked to the current turn's
  launch mode. Completion, cancellation, failure, or a failed start clears it;
  viewing another session cannot rewrite a started turn's mode.
- Thread creation, resume, fork, queue operations, steering, and later ordinary
  turns do not inherit the one-turn selection. Even if app-server retains a
  previous turn override, Ask Codex resubmits the complete mode for every later
  direct turn.
- `externalSandbox` authority belongs to the external environment, so Ask Codex
  cannot promise full automatic access. Auto remains unavailable and no turn
  sandbox override is sent for such a thread.
- Browser-supplied `never`, `granular`, and every other raw policy field are
  rejected. The implementation uses no experimental settings RPC, permission
  profile, or other experimental permissions API.

## Rationale

Default manual mode should reproduce behavior Codex users already understand,
not introduce an Ask Codex-specific RO/RW model. `on-request + workspaceWrite`
keeps routine development continuous while retaining human approval for Git
metadata writes, restricted network access, and writes outside the workspace.
Auto uses `dangerFullAccess` to remove the common execution boundaries while
retaining `on-request + user` as the human escape hatch when an action still
cannot be allowed automatically. It means "automatic where possible," not a
promise that
every future request type is prompt-free; that is more intuitive than a silent
rejection under `never`.

The gateway still rebuilds both combinations for each turn. This prevents the
browser from forging low-level permissions and prevents a one-turn choice from
becoming persistent thread or device state.

## Consequences

- Default manual mode prompts much less for routine commands and edits. A
  `git commit` still asks when it writes protected `.git` state, for example,
  but after approval it is not rejected by an Ask Codex read-only policy.
- Auto is more dangerous than ADR 0023: the model can use the network and read
  or write outside the workspace for that turn, normally without a sandbox
  prompt. The UI must keep it explicit, one-shot, and immutable while running,
  and must not persist it.
- Rule, granular permission, or MCP confirmations may still appear in auto mode.
  This is the intended human fallback and must not be described as fully
  approval-free.
- Queue sends and every later ordinary direct turn must explicitly restore
  manual mode so an app-server-retained full-access override cannot leak forward.
- The gateway still keeps bounded authoritative sandbox state returned by
  app-server to preserve `workspaceWrite` details and identify
  `externalSandbox`. The browser sees only the sandbox type and cannot edit it.

## Alternatives Considered

- Retain ADR 0023 manual mode as `untrusted + readOnly`: rejected because it
  diverges from normal Codex behavior and adds prompts and failure surfaces to
  ordinary development work.
- Use `untrusted + workspaceWrite` for manual mode: rejected because untrusted
  commands still prompt frequently instead of reserving approval for
  consequential boundary crossings.
- Use `never + dangerFullAccess` for auto: rejected because `never` suppresses
  requests the user could otherwise handle, turning recoverable confirmation
  into a silent rejection.
- Keep auto as `on-request + workspaceWrite`: rejected because common network
  and outside-workspace boundaries still pause too often to provide broad
  automation.
- Expose RO, RW, and Full access in the UI: rejected because the product needs
  two per-turn modes that match Codex intuition; the gateway should continue to
  own the low-level combinations.
- Use an automatic approval reviewer: rejected because it adds a review flow and
  model calls and cannot replace the user when a request cannot be allowed
  automatically.
