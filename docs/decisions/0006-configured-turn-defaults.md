# ADR 0006: Use configured turn defaults

- Status: Accepted
- Decision date: 2026-07-23
- Amends: [ADR 0005](0005-thread-and-turn-settings.md) for model and effort default sourcing only

## Context

ADR 0005 separated working directory and sandbox lifecycle from next-turn
model controls, but represented an empty selection as Default and resolved it
from the model catalog. The catalog's `defaultReasoningEffort` is a property of
the model, not the user's effective `model_reasoning_effort`. This could label
and send `low` even when Codex configuration selected `max`.

Reading `~/.codex/config.toml` directly in the gateway would duplicate Codex's
configuration parser and ignore higher-precedence overrides, profiles, system
configuration, and built-in defaults. Forwarding the complete `config/read`
response would expose unrelated configuration to the browser.

## Decision

- Keep ADR 0005's working-directory, sandbox, resume, and approval decisions;
  replace only its catalog-based model and effort default behavior.
- After app-server is ready, read the documented `config/read` method alongside
  `model/list`. The browser may not choose config layers or other parameters;
  the gateway always requests `includeLayers: false`.
- Project the config response at the gateway to bounded `model` and `effort`
  strings only. Never forward origins, layers, providers, instructions, MCP
  settings, paths, or unknown fields.
- Store actual model and effort values in the UI. Do not show synthetic Default
  choices or mark a catalog entry as `(default)`. Preserve configured values
  even when they are absent from the current model catalog.
- Use `model/list` only for alternate models, supported effort choices, and an
  explicit fallback when effective config omits a value. When changing model,
  preserve the current effort if supported; otherwise select that model's
  catalog effort or first supported effort.
- If `config/read` fails, surface the failure and leave model and effort
  overrides absent. Do not treat a failed read as an empty configuration and
  synthesize catalog defaults.
- Existing-thread resume values take precedence over startup defaults. A late
  config response or reconnect must not overwrite a restored thread or a user
  selection.
- Keep `approvalPolicy: "on-request"` and `approvalsReviewer: "user"` enforced
  independently at the gateway.

## Consequences

- The composer reflects the same explicit model and effort Codex resolved from
  its configuration instead of silently replacing them with catalog defaults.
- The gateway gains one read-only app-server method and a corresponding result
  policy. This response filter is a security boundary and requires focused
  leakage tests when the upstream schema changes.
- Effective defaults are refreshed after each app-server connection, but only
  initialize untouched composer state. Re-reading config for a newly entered
  cwd and its project `.codex/config.toml` remains a deliberate future
  extension rather than an implicit browser capability.

## Alternatives Considered

- Parse `~/.codex/config.toml` in Node: rejected because it would duplicate and
  incompletely implement Codex configuration precedence.
- Keep catalog Default choices: rejected because model catalog defaults and
  effective user configuration are different concepts.
- Forward raw `config/read`: rejected because it exposes configuration outside
  the narrow model-selection requirement.
