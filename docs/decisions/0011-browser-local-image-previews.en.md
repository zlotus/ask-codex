# ADR 0011: Persist image previews locally in the browser

- Status: Accepted
- Decision date: 2026-07-25
- Supplements: [ADR 0009](0009-temporary-image-attachments.en.md)

## Context

ADR 0009 requires the gateway to retain attachments only for the short
lifecycle needed to submit image input and to delete temporary server files
after a turn completes. The current page can create previews directly from the
images selected by the user, but those in-memory Blob URLs become invalid when
the page unloads. After reloading the page or thread, Codex history can only
indicate that the user message contained images; it cannot restore the original
bytes for the browser.

Ask Codex needs the browser that sent an image to keep displaying its preview
after reloading a thread, while preserving the temporary server-attachment
boundary and without automatically making that preview copy available to other
browsers or Origins.

## Decision

- After an image turn starts successfully, save a local preview copy in browser
  IndexedDB. Store the data as an ordered group of Blobs keyed by `threadId` and
  `turnId`, preserving the original image order within the message.
- Retain at most eight images and 40 MiB of browser-local previews. When either
  limit is exceeded, evict the oldest complete message groups in write order;
  do not partially retain or display a group. Each group has a default 30-day
  TTL and expired groups are deleted during maintenance.
- Store only the Blobs, media types, sizes, ordering, and lifecycle metadata
  needed to restore previews. Do not store the Ask Codex token, host paths,
  original filenames, or one-use `attachmentId` values.
- Do not persist Blob URLs. During page initialization, read the valid Blob
  groups already constrained by the aggregate limits from IndexedDB, create
  object URLs, and manage and revoke those URLs within that page lifecycle.
- If IndexedDB is unavailable, quota is insufficient, a write fails, data
  expires, or the browser reclaims a record, do not affect the submitted turn.
  Its in-memory thumbnail remains available on the current page; if no local
  record can be restored later, history safely falls back to the existing image
  placeholder.
- Preview copies follow the browser's same-origin storage boundary and are
  available only in the same browser profile and Origin. Clearing site data,
  browser storage reclamation, using another device, browser, or profile, or
  accessing Ask Codex through another Origin makes historical images fall back
  to placeholders.
- Same-origin JavaScript can access images in IndexedDB. Ask Codex does not add
  application-level encryption to local preview copies and does not describe
  them as a vault against compromised same-origin scripts or privileged browser
  extensions.
- The server behavior from ADR 0009 remains unchanged: images still use
  constrained temporary attachments, the gateway still deletes server files
  after turn completion, no persistent image-read endpoint is added, and other
  native clients remain unable to reattach the deleted file.

## Consequences

- While its local preview record remains available, the same browser profile
  using the same Origin can restore thumbnails after reloading the page or
  thread, or after restarting the browser.
- The browser, rather than the server, determines final local-storage
  availability. The 30-day TTL and eight-image/40-MiB limits provide
  application-level bounds, but user actions, private browsing, or storage
  pressure may remove data earlier.
- Protocol history and IndexedDB records remain independent. A missing local
  record does not affect thread text, model context, or later turns; it affects
  preview rendering only.
- A different scheme, hostname, or port is a different Origin. Even in the same
  browser profile, previews are not automatically shared between a loopback
  address and a public HTTPS address.
- The server does not acquire a persistent image index, browser identity,
  download authorization, or orphaned-attachment garbage collection, so the
  existing token, Origin/Host, and temporary-attachment security boundaries do
  not expand.

## Alternatives Considered

- Continue using only in-memory Blob URLs: not selected because they cover only
  the current page lifecycle and cannot restore previews after a page reload.
- Use Web Storage: not selected because `localStorage` and `sessionStorage` can
  only store strings synchronously, Base64 encoding increases size, and their
  common quotas are unsuitable for up to 40 MiB of image Blobs.
- Use the Cache API: not selected because it is better suited to network caches
  keyed by requests and responses. IndexedDB structured records more directly
  support ordered per-thread and per-turn message groups, TTL, byte accounting,
  and whole-group FIFO eviction.
- Persist images on the server and expose a constrained read endpoint: not
  selected because the existing token and Origin are shared application-access
  gates and cannot distinguish browsers. Meeting this requirement would also
  require browser identity, stable storage, a durable index, read authorization,
  deletion semantics, and garbage collection while expanding the server-side
  file capability that ADR 0009 deliberately constrained.
