# ADR 0009: Submit image input through temporary gateway attachments

- Status: Accepted
- Decision date: 2026-07-24

## Context

Codex app-server supports `localImage` entries with host paths in
`turn/start.input`, but a browser can neither provide a host path safely nor be
allowed to bypass the gateway and construct that protocol input directly.
Encoding images as Base64 inside WebSocket messages would quickly exceed the
existing 900 KiB client limit and approximately 1 MiB gateway limits, while
increasing memory use in the browser, gateway, and JSONL channel.

Ask Codex needs to deliver browser-selected images to the local app-server
without exposing a general-purpose file endpoint, accepting browser paths, or
raising message limits. Uploaded files also require explicit format
validation, resource quotas, and a cleanup lifecycle.

## Decision

- Upload image bytes temporarily through an HTTP attachment endpoint protected
  by the existing token and Origin/Host policy. Do not place the bytes in a
  WebSocket message or have the browser convert them into a Base64 protocol
  field.
- Accept only PNG, JPEG, and WebP. The gateway validates both the declared media
  type and file magic bytes instead of trusting a filename or the browser's
  `Content-Type` alone.
- Return only an opaque, one-use `attachmentId` after upload, never a host path.
  In `turn/start`, the browser may submit only that ID and a constrained image
  detail. After consuming the ID, the gateway uses its private registry to
  rebuild the official `{ type: "localImage", path, detail? }` input. Policy
  continues to reject browser-provided paths, remote images, and other
  unsupported media types.
- Limit each image to 10 MiB and each turn to four images. The attachment owner
  for one Ask Codex server instance may retain at most eight attachments and
  40 MiB; the underlying temporary store globally retains at most 32
  attachments and 64 MiB. These quotas cover both pending and leased
  attachments.
- A pending ID expires after 10 minutes. Once consumed by a turn, the attachment
  becomes an active lease and is normally deleted when that turn completes, its
  submission request fails, app-server enters an error state, or Ask Codex
  closes. A separate six-hour safety TTL deletes a lease once it reaches that
  bound even if no turn-completion notification has arrived, preventing a
  failed turn or lost notification from consuming resources indefinitely.
- The server creates and controls the temporary directory and files, using
  `0700` for the directory and `0600` for files. An ID is a single-use,
  in-process capability; all previously returned but unconsumed IDs become
  invalid when the Ask Codex service restarts.
- Preserve the existing 900 KiB client limit and the gateway's approximately
  1 MiB inbound and outbound limits. Image upload is not a reason to raise
  browser or gateway message limits.
- The MVP deletes temporary files after a turn completes. Codex retains
  `localImage.path` so native UIs can reattach an image when editing history;
  after completion, other native clients therefore cannot use that path to
  reattach the original image. This is a known MVP compatibility limitation.
  Supporting that workflow requires a separate design for persistent
  attachment ownership and garbage collection.

## Consequences

- Images larger than the WebSocket message limit can reach Codex through a
  bounded HTTP upload while the browser remains unable to select arbitrary
  host files.
- One-use IDs, format checks, and count and byte quotas bound the impact of
  replay, format spoofing, and memory or disk abuse.
- Normal turns promptly reclaim images after completion, and abnormal leases
  also have an eventual bound. Draft images that were not sent before a service
  restart must be uploaded again.
- An exceptional turn that remains incomplete for more than six hours is not
  guaranteed to retain its temporary images. This trades indefinite lease
  retention for bounded resource use.
- Ask Codex can restore and display history items containing images, but other
  native clients cannot rely on a deleted temporary path to edit history and
  reattach the original image.
- This decision enables image input only; it does not create general upload,
  download, audio, or arbitrary file-access capabilities.

## Alternatives Considered

- Send Base64 or data URLs directly in WebSocket `turn/start`: rejected because
  this would exceed existing message limits and materially increase
  serialization and memory costs.
- Accept browser-provided `localImage.path` values: rejected because a remote
  browser path does not identify a trusted host file and would bypass the
  gateway's parameter-rebuilding boundary.
- Retain every uploaded image permanently: deferred because it requires a
  stable storage location, a restart-safe index, reference tracking,
  user-visible deletion semantics, and bounded garbage collection, all beyond
  the image-input MVP.
- Expand the attachment endpoint to general file or audio uploads: deferred
  because each app-server input requires its own protocol validation, product
  representation, and security policy.
