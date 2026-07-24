# ADR 0007: Use Simplified Chinese as the primary project documentation language

- Status: Accepted
- Decision date: 2026-07-24

## Context

Project documentation was originally written primarily in English, but the
project maintainer wants day-to-day reading, planning, and maintenance to use
Simplified Chinese. Retaining English versions helps English-speaking readers
understand the project and prevents language choice from obstructing
collaboration.

ADRs are immutable historical records. ADRs 0001 through 0006 were accepted in
English, so their originals cannot be rewritten or renamed solely to change the
primary documentation language. Without consistent file-naming and
synchronization rules, bilingual documents would gradually diverge and readers
would not know which entry point is the default.

## Decision

- Use Simplified Chinese as the primary project documentation language. For
  ordinary documents, the default filename contains the Chinese version and a
  corresponding `.en.md` file with the same basename contains the English
  version.
- Preserve the English originals and filenames of ADRs 0001 through 0006, and
  provide a `.zh-CN.md` Chinese translation with the same basename for each
  record.
- Beginning with ADR 0007, the default ADR filename contains the Chinese
  original and a corresponding `.en.md` file with the same basename contains
  the English translation.
- Use `docs/decisions/README.md` as the primary Chinese index and
  `docs/decisions/README.en.md` as the English index. Each index links to the
  records in its own language.
- When a semantic change is made to either version of a bilingual document,
  update the other language in the same change. Pure formatting changes or
  corrections specific to expression in one language need not create unrelated
  edits, but both documents must retain the same technical meaning.
- Keep commands, filenames, paths, environment variables, protocol methods,
  field names, code identifiers, and other technical text that requires exact
  matching unchanged rather than translating it.

This decision governs the primary language and mirroring of project-maintained
documentation. It does not require translating source code, generated files,
dependency content, or protocol definitions.

## Consequences

- Chinese readers can use default filenames as the primary documentation entry
  points, while English readers can find corresponding versions through a
  consistent `.en.md` suffix.
- Semantic documentation changes require maintaining both languages, adding a
  small review and maintenance cost.
- Historical ADR naming differs from new ADR naming, but this preserves both
  accepted-record immutability and a consistent Chinese-default rule going
  forward.
- Reviews of bilingual changes must check technical facts, links, and status
  consistency in addition to language quality.

## Alternatives Considered

- Keep only Chinese documentation: rejected because it would unnecessarily
  reduce accessibility for English readers and discard existing English
  material.
- Continue using English as the primary language and add Chinese notes only as
  needed: rejected because it does not match the maintainer's primary working
  language.
- Rename or rewrite ADRs 0001 through 0006 so Chinese files use the default
  filenames: rejected because accepted ADRs are immutable historical records.
- Leave synchronization unspecified and allow both languages to evolve
  independently: rejected because this would create conflicting sources of
  project truth.
