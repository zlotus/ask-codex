# ADR 0015: Explicit text steering bound to the active turn

- Status: Accepted
- Decision date: 2026-08-05
- Extends: [ADR 0002](0002-security-gateway-and-manual-approval.md), [ADR 0012](0012-read-only-connection-recovery.en.md)

## Context

Codex CLI 0.146.0 provides native `turn/steer` so a user can add input while a
turn is still running. A request must carry `threadId`, `expectedTurnId`, and
`input`, and the response returns the turn ID that accepted the steering. If a
browser sends against only the idea that "a turn is running" instead of pinning
the request to an exact turn, input could reach the wrong turn when one finishes
or changes between the click and request processing.

Steering is also a write with material effects. After a disconnect or timeout,
the browser cannot know whether Codex accepted it; automatic replay could
duplicate an instruction. When multiple browsers observe one thread, approvals
caused by a successful steering request also need an explicit owner.

## Decision

- Call `turn/steer` only after an explicit user submission while the selected
  thread has an active `inProgress` turn. Capture that turn ID at submission and
  use it both as `expectedTurnId` and as the identity of the unconfirmed
  submission; text entered while it is in flight remains a separate draft.
- Limit the first steering release to one non-empty text input item. Do not
  upload images or submit `cwd`, model, reasoning effort, sandbox, or other turn
  settings while running. Keep image, model, and effort controls disabled while
  retaining the interrupt action.
- Add `turn/steer` to the gateway's explicit allowlist and rebuild its parameters
  field by field. Accept only `threadId`, `expectedTurnId`, and text `input`;
  reject unknown fields, host paths, setting overrides, non-text input, and
  malformed or over-limit content.
- Project only `{ turnId }` back to the browser and require that `turnId` exactly
  match the sanitized request's `expectedTurnId`. A missing, malformed, or
  mismatched result fails closed and cannot confirm the submission.
- Serialize `turn/steer` with `thread/resume` and `turn/start` for the same
  thread. Make the requesting browser the approval owner only after a valid
  upstream success for the expected turn. Failure, disconnect, a Codex error,
  or an indeterminate result must not change ownership. An indeterminate result
  cancels already queued ownership writes for that thread under the existing
  rule.
- Remove an unconfirmed input from the UI only after a matching response. Keep
  a failed input separate from text entered while sending; allow explicit retry
  only while its original turn remains the current active turn, and retain the
  original `expectedTurnId`.
- Never replay `turn/steer` automatically during connection recovery, read-only
  resynchronization, or page reload. The user decides whether to retry against
  the still-active original turn or edit the content into a later new turn.

## Rationale

`expectedTurnId` is the protocol's concurrency guard and must survive through
both browser and gateway processing instead of relying on mutable "current
turn" state. A strict text-only scope reuses the existing composer experience
without assuming unverified semantics for running-turn attachments or settings.
Aligning confirmation, ownership, and no-replay behavior with other ownership
writes preserves consistent approval and idempotency boundaries under multiple
clients and connection failures.

## Consequences

- A user can add text while Codex is working without interrupting the turn or
  waiting for it to finish.
- If the turn finishes before the request is processed, steering fails
  explicitly instead of silently becoming a new turn or targeting another
  active turn.
- An indeterminate network result may require the user to judge and reorganize
  the input manually. This is the explicit tradeoff for avoiding duplicate
  steering.
- Images and next-turn settings remain unavailable while running. Before
  exposing them, compare the app-server schema again and define attachment
  ownership and one-use consumption semantics.

## Alternatives Considered

- Queue running input as the next turn: not selected because it changes native
  steering semantics and requires persistent queue, deduplication, expiry, and
  cross-device ownership design.
- Automatically fall back to `turn/start` after the active turn changes: not
  selected because the user submitted steering for an exact turn; silent
  conversion changes both context and execution timing.
- Automatically replay a timed-out request: not selected because `turn/steer`
  has no idempotency key that lets the browser prove it was not executed.
- Allow images and setting overrides in the first release: not selected because
  the need is supplemental text and those capabilities introduce separate
  protocol and lifecycle questions.
