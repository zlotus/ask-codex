# Project Documentation

[简体中文](README.md) | **English**

Simplified Chinese is the primary language for active project documentation in
this repository. An unsuffixed path contains the Chinese source, and the
matching `.en.md` file is its English mirror.

This directory carries the durable context needed to continue Ask Codex work
from another device or in a new Codex session. It complements Git; it does not
replace committed source, tests, issues, or pull requests.

## Reading Order

For non-trivial implementation work:

1. Read [`context.en.md`](context.en.md) for the stable product and engineering
   boundaries.
2. Read [`progress.en.md`](progress.en.md) for the implemented baseline,
   current milestone, known gaps, and next work.
3. Use the [decision index](decisions/README.en.md) to open only ADRs relevant to
   the task.
4. Read [`ideas.en.md`](ideas.en.md) only when planning product direction. Its
   entries are candidates, not commitments.

Deployment documentation remains in the operator guides:

- [Chinese](cloudflare-tunnel.md)
- [English](cloudflare-tunnel.en.md)

## Language And Historical ADRs

The active context documents use the Chinese-primary naming rule described
above. ADRs `0001` through `0006` predate that rule and are append-only
historical records, so their original English files retain the unsuffixed
names and their Chinese translations use `.zh-CN.md`. Do not rename or rewrite
those English originals merely to make their filenames follow the new rule.
New ADRs and the decision index use an unsuffixed Chinese source and a
synchronized `.en.md` English mirror unless preserving an existing historical
filename requires the legacy pattern.

## Source Responsibilities

- `AGENTS.md` defines mandatory repository instructions and security
  invariants.
- The installed CLI-generated schema defines the current Codex app-server
  protocol.
- Code, tests, and configuration define implemented behavior.
- `context.md` records stable purpose, goals, non-goals, and constraints.
- `progress.md` is a replaceable current-state handoff, not a cumulative log.
- `decisions/` records durable choices, their rationale, and alternatives.
- `ideas.md` holds undecided possibilities without assigning delivery dates.
- README and deployment guides provide user and operator instructions.

When sources disagree, verify against the appropriate authority and update the
stale documentation in the same change.

## Cross-Device Handoff

Before switching devices:

1. Finish or deliberately stop at a coherent boundary.
2. Update `progress.md` only when the implemented state, milestone, material
   risk, or immediate next steps changed.
3. Add an ADR when the work accepted or replaced a durable design decision.
4. Record only checks that actually ran.
5. Commit the source and related documentation together, then push the branch.

After switching devices, fetch the branch and follow the reading order above.
Do not use these documents to describe uncommitted files that exist on only one
device. These are developer handoff steps; an AI assistant must not commit or
push unless the user explicitly requests it.

## Editing Rules

Keep the documents short and explain why the project is shaped as it is. Avoid
duplicating code, issue backlogs, release notes, or routine implementation
details. Small fixes, renames, formatting changes, and unresolved discussion do
not require context-document updates.

Keep each Chinese source and English mirror synchronized whenever content
changes. Translation-only wording fixes do not change the underlying decision
or implementation state.

ADRs are append-only historical records. If an accepted decision changes, add a
new ADR, mark the old ADR `Superseded`, and link both records. Do not rewrite the
old rationale to make it match the new decision.
