# ADR 0004: Keep cross-device project context in versioned documents

- Status: Accepted
- Decision date: 2026-07-23

## Context

Development continues across devices and Codex sessions. Source code shows the
implemented behavior, and Git preserves changes, but neither provides a concise
account of stable product intent, current priorities, durable rationale, and
known risks. Putting all of that information in `AGENTS.md` would make mandatory
instructions long, expensive to load, and likely to become stale.

Free-form handoff notes and chat history are not reliably available on every
device. A growing progress log or single decisions file would also become noisy
and create frequent merge conflicts.

## Decision

Keep a small versioned context system under `docs/`:

- `context.md` for stable goals, non-goals, system shape, and constraints.
- `progress.md` for a replaceable current-state snapshot, immediate next work,
  material gaps, risks, and checks actually run.
- One file per durable architecture decision under `decisions/`, indexed by
  `decisions/README.md` and preserved when superseded.
- `ideas.md` for undecided product candidates without roadmap commitment.

Keep only a short routing and maintenance policy in `AGENTS.md`. Commit relevant
documentation with the source it describes and use Git to transfer the complete
handoff between devices.

## Consequences

- A new developer or Codex session can recover intent without reading all
  history or every design record.
- Documentation changes are required only for material state or decision
  changes, not routine edits.
- `progress.md` must be actively trimmed instead of becoming a changelog.
- Uncommitted work remains device-local and cannot be made portable by
  documentation alone.

## Alternatives Considered

- Put all context in `AGENTS.md`: rejected because mandatory instructions should
  stay short and normative.
- Rely only on commit history and issues: rejected because they do not provide a
  curated current-state handoff or stable product context.
- Keep one append-only progress and decisions log: rejected because it grows
  noisy and creates avoidable cross-branch conflicts.
- Rely on chat history or assistant memory: rejected as the source of truth
  because it is not guaranteed to be available, current, or versioned with the
  code.
