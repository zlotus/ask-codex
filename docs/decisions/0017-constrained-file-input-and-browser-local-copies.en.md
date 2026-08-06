# ADR 0017: Constrained file input and browser-local download copies

- Status: Accepted
- Decision date: 2026-08-07
- Extends: [ADR 0009](0009-temporary-image-attachments.en.md), [ADR 0011](0011-browser-local-image-previews.en.md)
- Does not change: [ADR 0013](0013-thread-working-directory-defaults-and-file-download-scope.en.md)

## Context

Ask Codex can already submit PNG, JPEG, and WebP images to `turn/start` through
temporary attachments, but users also need to select or paste ordinary files
such as PDFs, documents, archives, and source files. The Codex CLI 0.146.0
app-server protocol has no general input type for raw browser file bytes, and
the browser must not provide host paths or construct arbitrary
`additionalContext`.

Live protocol validation found that `mention` input with `name` and `path` is
not suitable for ordinary local-file attachments. When the gateway adds a
controlled application `additionalContext` to an already sanitized request,
Codex can read a temporary absolute path with normal local tools. History reads
still do not return the original file bytes, so the server copy used by the
model and the browser-local copy used for user downloads need separate
lifecycles.

## Decision

- The composer uses one `+` menu for image and ordinary-file selection. On
  paste, PNG, JPEG, and WebP files become image previews and all other files
  become ordinary file cards. Images and files share a limit of 4 attachments
  per turn and 10 MiB per attachment.
- Ordinary file bytes use a dedicated HTTP endpoint that reuses the existing
  token, Origin/Host, concurrency, and quota policies. The browser receives only
  a process-local, one-shot opaque `attachmentId`; it cannot submit a path, cwd,
  or `additionalContext`.
- The gateway sanitizes the internal file input field by field. After consuming
  the ID, it builds a fixed application `additionalContext` namespace from the
  server-controlled temporary path and explicitly treats file contents as
  untrusted user data. The app-server user message retains only a text marker
  with a strict JSON placeholder containing display name, media type, and size,
  never the temporary path or attachment ID.
- Ordinary files reuse the image-attachment resource model. Pending IDs live up
  to 10 minutes. A consumed lease is normally deleted when the turn completes,
  submission fails, app-server errors, or the service closes, with a 6-hour
  lease ceiling. Each owner may hold at most 8 attachments and 40 MiB; the
  process may hold at most 32 and 64 MiB, with at most 4 concurrent uploads.
- After a turn starts successfully, the same browser Origin stores ordinary
  file Blobs in IndexedDB under `threadId` and `turnId`. The default TTL is 30
  days with limits of 8 files and 40 MiB. Whole oldest message groups are
  evicted when a limit is exceeded, and thread deletion removes its records.
  Download is offered only when name, media type, and size exactly match the
  history marker; otherwise the UI shows a non-downloadable file placeholder.
- Local file downloads use the Blob already held by the browser and do not mint
  ADR 0013 Agent-output download capabilities. Other devices, browsers,
  profiles, or Origins, and cleared or evicted local storage, cannot retrieve
  the original upload from Ask Codex.
- Ask Codex does not promise to understand every file format. It only gives
  Codex a constrained temporary path; parsing depends on the tools available in
  the current environment and model behavior.

## Consequences

- Users can select or paste multiple kinds of local files from one entry point.
  Sent user messages retain stable filename and size presentation, and the
  original can be downloaded while the same-Origin local copy remains.
- The gateway gains a constrained upload surface without becoming a general
  browser-selected host file service or expanding the Agent-output download
  scope.
- Codex reads a short-lived server copy. Native clients cannot rely on the
  historical temporary path to reattach the file after turn completion, and
  the browser-local copy provides no persistent model, cross-client, or
  cross-Origin access.
- Forged or malformed history markers, metadata mismatches, unavailable
  IndexedDB, or missing local records degrade only the download control; thread
  text and future turns remain usable.

## Alternatives Considered

- Carry files through `mention` input: not adopted because the current protocol
  and live validation do not provide reliable ordinary local-file semantics.
- Let the browser submit paths or custom `additionalContext`: rejected because
  that bypasses RPC parameter reconstruction and expands host-path and prompt
  injection surfaces.
- Encode files in WebSocket messages: rejected because Base64 and JSON increase
  memory and message size beyond the existing limits.
- Persist server uploads and expose historical downloads to every client: not
  adopted because it requires browser identity, a persistent index, reference
  tracking, deletion semantics, and garbage collection while expanding server
  file capabilities.
- Reuse ADR 0013 Agent-output download capabilities: rejected because a local
  user upload is not a host output derived from completed Agent content and an
  authoritative `thread.cwd`.
