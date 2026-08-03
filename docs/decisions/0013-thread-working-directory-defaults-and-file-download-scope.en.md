# ADR 0013: Use the thread Working directory as new-thread context and a constrained file-download scope

- Status: Accepted
- Decision date: 2026-08-04
- Extends: [ADR 0002](0002-security-gateway-and-manual-approval.md), [ADR 0005](0005-thread-and-turn-settings.md)

## Context

The Working directory identifies a thread's project context. New threads
previously always returned to the bootstrap default supplied from
`ASK_CODEX_WORKSPACE`, even while the user was viewing a thread in another
project. That behavior increased the chance of choosing the wrong directory and
did not match the expectation of continuing from the current work.

Codex Agent messages also use CommonMark links for artifacts or documents on
the host. A browser cannot read those files directly, while treating an
absolute path as an ordinary link appends it to the public Ask Codex Origin and
may place it in browser history and proxy logs. Solving this must not turn the
gateway into a general file server that accepts arbitrary paths, nor require an
operator to maintain a global root list for every thread directory.

## Decision

### New-thread default context

- When no thread is selected, continue to use the default cwd supplied through
  bootstrap from `ASK_CODEX_WORKSPACE`.
- When a thread is selected, inherit cwd in this order: the current thread whose
  ID exactly matches the selection, an exact matching thread summary from the
  Active or Archived list, then the bootstrap default cwd. Do not fall back to
  generic settings state that may have been left behind by another thread.
- Inherit cwd only. Reset the sandbox to `workspace-write` whenever the
  new-thread settings open; model and reasoning effort continue to follow their
  existing default rules.
- `ASK_CODEX_WORKSPACE` remains an initial directory for the absence of thread
  context, not a filesystem access boundary.

### Constrained file downloads

- Do not introduce `ASK_CODEX_DOWNLOAD_ROOTS`. The authoritative `thread.cwd`
  returned by app-server defines a separate download scope for each thread.
  A cwd, path, or thread identifier supplied by the browser cannot establish or
  widen that scope.
- Issue download authority only for explicit CommonMark absolute local-file
  links in completed Agent content. Realtime content must be an `agentMessage`
  delivered by `item/completed`; historical content must belong to a turn whose
  status is explicitly `completed` and whose full items are present. Streaming,
  summary, failed, interrupted, user, reasoning, and other items fail closed.
  A trailing `:LINE` or `:LINE:COLUMN` locator is supported but is not part of
  the filename.
- The gateway parses the message and projects a short-lived, one-use, opaque
  capability ID to the browser. Downloads use an HTTP POST with the existing
  Bearer token. The request carries only the capability ID in the URL path and
  accepts no path, cwd, threadId, request body, or query parameters. Neither the
  host path nor the token may enter the download URL.
- Snapshot the canonical root identity of the authoritative cwd when each
  capability is issued. At consumption, verify that identity again, open and
  pin the matching root-directory fd, resolve the relative target through that
  fd, and recheck path and containment through target `realpath` and the opened
  file fd. This rejects root replacement, symlink retargeting, and
  check-versus-open races. Allow regular files only; reject directories,
  devices, FIFOs, and sockets by default.
- Limit each file to 25 MiB, each server instance to two concurrent downloads,
  and each active transfer to a two-minute wall-clock deadline. Pending
  capabilities, metadata, known thread cwd records, completed-turn evidence,
  and links signed per message all have explicit collection or byte bounds.
  Capabilities have a short TTL and become unusable after one consumption,
  expiry, a thread cwd change, thread deletion, loss of app-server authority,
  or an Ask Codex restart.
- Reuse the existing exact Origin, Host, and token policy for the HTTP endpoint.
  Return fixed errors that do not disclose paths, and set `no-store`, `nosniff`,
  `application/octet-stream`, and a safe `Content-Disposition`. Force a
  download rather than providing file previews.
- Never fall back to an ordinary web link for an absolute local path without a
  valid capability. External HTTP(S) links retain their existing behavior.

## Rationale

Exact cwd inheritance from the selected thread makes a new thread continue in
the project the user is currently handling while preserving a stable deployment
default when nothing is selected. Not inheriting the sandbox prevents project
context continuity from silently widening execution permissions.

Download authority derives jointly from completed Agent content and the
app-server-authoritative cwd, while the browser can redeem only an opaque,
one-use ID. This exports work that the model explicitly referenced without
creating a browser-controlled host-path lookup API. The gateway revalidates
scope, file identity, and resource use when the capability is consumed.

## Consequences

- A new thread opened from a selected thread defaults to the same project
  directory; one opened with no selection still uses the deployment's initial
  directory.
- Users can download regular files inside cwd when completed Agent messages
  link them explicitly, without requiring the browser to recognize a preview
  format. A file that is deleted, moved, retargeted, enlarged, or moved outside
  the scope before the click fails closed.
- When `thread.cwd` is `/`, the effective range may include most files readable
  by the host account. This is an explicit product tradeoff of allowing `/` as
  a real thread working directory; a hidden global root list does not change
  its semantics.
- `ASK_CODEX_TOKEN` must therefore be protected like the host account password.
  A client that holds the token and can reach the trusted Origin can continue
  threads and redeem short-lived capabilities derived from completed Agent
  links in those threads.
- If multiple browser clients receive the same one-use capability, the first
  successful consumer invalidates that ID for the others. Reading completed
  history again can issue a fresh short-lived capability.
- This capability is not a general file server: it cannot list directories,
  read a browser-selected path, preview arbitrary formats, or export a file that
  did not appear in qualifying Agent content.

## Alternatives Considered

- Configure `ASK_CODEX_DOWNLOAD_ROOTS`: not selected because threads can have
  different cwd values, so enumerating every project at startup creates
  duplicate configuration and drift. The authoritative `thread.cwd` already
  provides a more precise per-thread context.
- Always use the bootstrap default cwd for new threads: not selected because a
  user continuing from the current project must repeatedly select the directory
  and can start a thread in the wrong project.
- Inherit the sandbox together with cwd: not selected because directory context
  and execution permission have different risks and lifecycles. A new thread
  must still start from `workspace-write`.
- Let the browser send a path, cwd, or threadId to the download endpoint: not
  selected because that turns browser input into a host-file selector and
  weakens the gateway's parameter-rebuilding boundary.
- Turn local links into direct GET requests or add generic previews: not
  selected because paths would enter URLs, the preview surface would expand
  with every file type, and both choices move the service toward a general file
  server.
