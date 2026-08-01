# Project Progress

[简体中文](progress.md) | **English**

Last reviewed: 2026-08-01

## Current Milestone

Project-oriented thread navigation and read-only Skills discovery are
implemented. Active and Archived organize threads by working directory and put
pinned threads first within each group. The shared action menu adds rename,
pin, and unpin while turns in progress continue to restrict only archive and
delete. A third Skills tab presents bounded read-only metadata by working
directory through the official `skills/list` method. The next milestone moves
to cross-thread Activity and usage visibility without changing the trust model
for manual approval, remote access, or host capabilities.

## Current Baseline

The implementation currently provides:

- React desktop and mobile layouts for listing, searching, creating, resuming,
  and refreshing native Codex threads, with a 44-pixel conversation header and
  an always-editable responsive multiline composer where Enter inserts a
  newline and either the button or `Ctrl+Enter` sends; `Cmd+Enter` is also
  supported on macOS. Unconfirmed sends remain separate from drafts typed while
  a send is in flight. A newly created thread remains in the sidebar throughout
  its first turn until the canonical active or archived list confirms its
  metadata. Concurrent list refreshes apply only the latest result, and turn
  completion hydrates the name, preview, and time so a sparse status notification
  cannot make the entry disappear or degrade to a UUID.
- Active and Archived group threads by exact cwd and place pinned threads first
  within each group while preserving the existing order of the rest. One thread
  action menu opens from desktop right-click, a 550 ms mobile long press, or the
  explicit `...` entry point. Rename, pin, and unpin remain available while a
  thread has a turn in progress. Threads with active turns still cannot be
  archived or deleted; other idle threads can be archived, archived threads can
  be restored, and either kind of idle thread can be deleted after a confirmation
  warns that the thread and descendant sessions may be permanently removed.
  Cross-client name, archive, restore, and delete notifications reconcile the
  lists and current selection. Deletion also removes that thread's browser-local image
  previews from memory and IndexedDB.
- A third read-only Skills tab groups skill names, descriptions,
  `user`/`repo`/`system`/`admin` scopes, and enabled states by cwd, and reports
  load failures only as a count. The directory starts loading when the tab is
  first opened. Manual refresh sends `forceReload: true`, while a
  `skills/changed` notification rescans a directory that has already been
  loaded. At most 16 directories are loaded with the current cwd first; a
  deleted historical directory degrades independently instead of hiding valid
  projects. Separate generation guards prevent older Skills or thread-list
  responses from replacing newer state.
- Incremental recent-turn loading through `thread/turns/list`, adaptive page
  sizing, retryable older pages, and summary fallback. App-server chooses the
  default history contract for new threads instead of Ask Codex forcing the
  experimental `paginated` mode. Existing paginated threads can still recover
  through a narrowly allowed ascending `thread/items/list`; default or `legacy`
  threads retain the one-turn full-detail retry.
- Streamed messages, reasoning, plans, command output, file changes, MCP calls,
  web searches, turn diffs, and unknown-item fallback rendering. Consecutive
  historical reasoning with content stays grouped and expandable in place,
  while each turn in progress keeps a fixed reasoning status slot at its bottom:
  active reasoning animates and idle reasoning appears muted, so reasoning
  lifecycles no longer repeatedly change the stream height. The current turn's
  structured plan also appears above the composer as a compact normal-layout
  summary that expands into a bounded scrolling step list; the summary
  disappears when the turn ends while the historical plan stays in its original
  turn. A turn diff
  is explicitly shown as a whole-turn change summary at the end of its turn;
  the following turn footer shows the app-server's native start time and total
  duration, silently omitting missing fields. Stream and message sizes remain
  explicitly bounded. Non-full completion or resync snapshots do not erase
  already materialized streamed content; only an explicit `full` snapshot may
  replace items.
- Reusable syntax-highlighted code blocks, copy and wrap controls, structured
  unified/split diffs, safe raw-diff fallback, and bounded two-level tool
  disclosures. Consecutive first-class machine activities form a zero-gap stack
  separated only by single rules, including commands, file changes, MCP calls,
  searches, dynamic tools, subagent/collaboration activity, image views, and
  image generation, while assistant messages remain prominent.
- Browser handling for command and file-change approvals and structured
  `request_user_input` requests. Captured command approval reasons remain
  attached to the exact command item for the current browser session.
- New-thread working-directory and sandbox settings, explicit idle-thread
  sandbox overrides, next-turn model and reasoning controls beside the
  composer, and active-turn interruption. Initial model and effort selections
  come from a strictly filtered effective Codex config read; alternatives come
  from `model/list`. Existing thread cwd is read-only and routine resume no
  longer resends flattened sandbox state.
- An Express/WebSocket gateway that starts `codex app-server` over JSONL stdio,
  rebuilds parameters for an explicit RPC allowlist, and routes app-server
  requests to the owning browser. `thread/name/set`, `thread/metadata/update`,
  and `skills/list` accept only bounded, field-by-field reconstructed
  parameters. The Skills response projects only name, description, optional
  flattened `interface.shortDescription`, scope, enabled state, and an error
  count per cwd; skill paths, dependencies, remaining interface metadata, and
  specific error text do not reach the browser. Top-level Skills RPC failures
  from the upstream app-server also use a fixed redacted message.
- Composer support for selecting, pasting, previewing, removing, and sending
  PNG, JPEG, and WebP images, including image-only turns, with the entry point
  enabled only when a model explicitly declares image input. Image bytes use
  a temporary HTTP attachment endpoint governed by the existing HTTP token and
  Origin/Host policy. One-use IDs are rebuilt into official `localImage` paths
  at the gateway; count, byte, concurrency, storage, and lifecycle limits are
  explicit. Successfully sent images retain bounded browser-local previews in
  IndexedDB. The same browser profile and Origin can restore clickable
  thumbnails after a page or thread reload and a browser restart. Local copies
  have a default 30-day TTL and an eight-image/40-MiB limit; clearing site data,
  browser storage reclamation, or using another device, browser, profile, or
  Origin makes history fall back to safe placeholders.
- Bounded browser, gateway, and app-server messages; linear JSONL accumulation;
  backpressure eviction; approval rerouting; and snapshot-based recovery when
  an oversized notification cannot be forwarded.
- Enforced `on-request` user approval, fail-closed unsupported permissions,
  loopback defaults, token and Origin checks, connection and request limits,
  and exact trusted-public-origin support.
- An English and Chinese Cloudflare Tunnel deployment guide for loopback-hosted
  Cloudflare Access plus an independent Ask Codex token gate.
- Deterministic desktop and mobile production visual fixtures that do not
  create a real Codex turn.

This file describes the current verified handoff baseline on `main`. Another
device can pull the latest `origin/main` and resume from `Next` without relying
on prior chat history; only checks explicitly listed under `Verification` count
as executed.

## Known Gaps

- Default and existing `legacy` threads have no official migration path and do
  not support `thread/items/list`; they remain summary-only when a full single
  turn still exceeds the gateway limit. A paginated thread also cannot recover
  an item that by itself exceeds 1 MiB by shrinking the page further.
- When last verified with Codex CLI 0.145.0, paginated threads did not support
  fork, rollback, or detached review. Ask Codex does not currently expose those
  operations, but the restriction still applies to another client operating on
  the same native thread.
- Loaded history pages remain mounted. Heavy closed disclosures are lazy and
  Markdown/diff work is bounded, but very long manually expanded histories do
  not yet use viewport virtualization or an aggregate DOM budget.
- When last verified with Codex CLI 0.145.0, completed `commandExecution`
  history did not contain approval reasons. Ask Codex can retain reasons
  captured during the current browser session and through in-session resync,
  but cannot reconstruct them after a page reload or on another device from
  native thread history alone.
- There is no independent cross-thread Activity view, usage panel, or thread
  fork action.
- Image attachments are deleted after a turn completes. Normal subsequent
  Codex context is unaffected, but another native client cannot use the deleted
  `localImage.path` to edit history and reattach the original image; persistent
  attachment ownership and garbage collection are not designed. Browser-local
  previews are not cross-device attachment storage: they are available only in
  the same browser profile and Origin and may become placeholders because of
  the 30-day TTL, eight-image/40-MiB limit, site-data clearing, or browser
  reclamation. General file and audio input are also not exposed.
- Turn steering, persistent cross-device message queues, fixed host actions,
  and an embedded PTY are not implemented.

## Next

1. Add an independent read-only Activity surface for viewing current and recent
   work across threads without claiming thread ownership or changing approval
   routing.
2. Add a read-only usage panel through an explicitly allowed and narrowly
   projected official app-server method; do not add new host execution
   capabilities first.

Later candidates remain in [`ideas.en.md`](ideas.en.md); their presence there is
not a delivery commitment.

## Risks And Watchpoints

- The installed Codex CLI defines an evolving protocol. Protocol work must
  compare generated bindings and update normalization and tests together.
- `paginated` history remains an experimental persistence contract. Do not
  force it for new threads until app-server advertises an explicit capability
  and the real first-turn path is verified. CLI upgrades must still recheck item
  pagination plus fork, rollback, and detached review support.
- Rich rendering must treat all agent, command, diff, and ANSI content as
  untrusted text and must bound memory and DOM growth.
- Modern approval rationale must remain keyed by thread, turn, and item id;
  legacy call ids are attached only when they identify one command uniquely.
- `config/read` results must remain projected at the gateway to model and
  reasoning effort only; never forward the complete Codex configuration.
- Image bytes must remain outside WebSocket JSON. The browser must not provide
  host paths, and temporary-attachment format checks, quotas, one-use
  consumption, and cleanup backstops must remain enforced.
- IndexedDB previews may store only the thread/turn key, Blobs, media types,
  sizes, ordering, and lifecycle metadata needed for restoration, never the
  token, host paths, original filenames, or one-use attachment ids;
  local-storage failure must not affect an accepted turn.
- Skills and future host tools must not bypass the gateway allowlists. The
  Skills directory must continue stripping skill paths, dependencies, interface
  metadata other than the flattened `interface.shortDescription`, and error
  text instead of introducing path or command pass-through.
- Automatic recovery and read-only views must not claim thread ownership or
  redirect approval requests away from the browser that started or resumed it.
- A browser terminal would bypass Codex approval and therefore requires a
  separate threat model, isolation boundary, and explicit opt-in.

## Verification

Verification for this round was completed on 2026-08-01 with Node.js
`v24.18.0`, npm `12.0.2`, and Codex CLI `0.146.0`:

- Current experimental TypeScript bindings were generated from the installed
  CLI and compared for `thread/name/set`, `thread/metadata/update`,
  `skills/list`, `skills/changed`, and the related thread and skill fields.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- `NODE_ENV=test npm test` passed: 28 test files and 394 tests. Server tests ran
  in an environment that permits loopback socket binding.
- `CHROME_BIN=/usr/bin/chromium ASK_CODEX_VISUAL_URL=http://127.0.0.1:4173
  ASK_CODEX_VISUAL_OUTPUT=/tmp/ask-codex-visual-project-nav-final npm run
  check:visual` passed against the current production build. Desktop and
  390x844 mobile fixtures verified project grouping, in-group pinning, thread
  menus, Rename, Archived, and Skills layouts without horizontal overflow,
  clipping, content overlap, console errors, or page errors. Deterministic
  browser fixtures intercepted every RPC and created no real Codex turn.
