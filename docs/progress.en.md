# Project Progress

[简体中文](progress.md) | **English**

Last reviewed: 2026-07-31

## Current Milestone

Bounded thread lifecycle management is implemented. The sidebar separates
unarchived and archived threads into Active and Archived views, and opens one
shared action menu from desktop right-click, mobile long press, or an explicit
action button; a long press never deletes by itself. Idle threads can be
archived or unarchived, and can be permanently deleted after confirmation,
while threads with a turn in progress are protected. The next milestone returns
to project-oriented navigation and read-only discovery without changing the
manual-approval or remote-access trust model.

## Current Baseline

The implementation currently provides:

- React desktop and mobile layouts for listing, searching, creating, resuming,
  and refreshing native Codex threads, with a 44-pixel conversation header and
  an always-editable responsive multiline composer where Enter inserts a
  newline and the button sends. Unconfirmed sends remain separate from drafts
  typed while a send is in flight.
- Active and Archived views with one thread-action menu: desktop right-click,
  a 550 ms mobile long press, and an explicit `...` entry point all open the
  same actions. Threads with a turn in progress cannot be archived or deleted;
  other idle threads can be archived, archived threads can be restored, and
  either kind of idle thread can be deleted after a confirmation warns that the
  thread and descendant sessions may be permanently removed. Cross-client
  archive, restore, and delete notifications reconcile the lists and current
  selection. Deletion also removes that thread's browser-local image previews
  from memory and IndexedDB.
- Incremental recent-turn loading through `thread/turns/list`, adaptive page
  sizing, retryable older pages, and summary fallback. App-server chooses the
  default history contract for new threads instead of Ask Codex forcing the
  experimental `paginated` mode. Existing paginated threads can still recover
  through a narrowly allowed ascending `thread/items/list`; default or `legacy`
  threads retain the one-turn full-detail retry.
- Streamed messages, reasoning, plans, command output, file changes, MCP calls,
  web searches, turn diffs, and unknown-item fallback rendering. Consecutive
  reasoning items are grouped for display, empty completed reasoning is hidden,
  and only actively reasoning items animate. A turn diff is explicitly shown
  as a whole-turn change summary at the end of its turn. Stream and message
  sizes remain explicitly bounded. Non-full completion or resync snapshots do
  not erase already materialized streamed content; only an explicit `full`
  snapshot may replace items.
- Reusable syntax-highlighted code blocks, copy and wrap controls, structured
  unified/split diffs, safe raw-diff fallback, and bounded two-level tool
  disclosures that group consecutive commands, file changes, MCP calls, and
  searches while keeping assistant messages prominent.
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
  requests to the owning browser.
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

This file describes the current verified handoff baseline on `main`. After
pulling the latest `origin/main`, another device can resume from the ordered
outcomes in `Next` without relying on prior chat history.

## Known Gaps

- Default and existing `legacy` threads have no official migration path and do
  not support `thread/items/list`; they remain summary-only when a full single
  turn still exceeds the gateway limit. A paginated thread also cannot recover
  an item that by itself exceeds 1 MiB by shrinking the page further.
- Paginated threads in Codex CLI 0.145.0 do not support fork, rollback, or
  detached review. Ask Codex does not currently expose those operations, but
  the restriction still applies to another client operating on the same
  native thread.
- Loaded history pages remain mounted. Heavy closed disclosures are lazy and
  Markdown/diff work is bounded, but very long manually expanded histories do
  not yet use viewport virtualization or an aggregate DOM budget.
- Completed `commandExecution` history does not contain approval reasons in
  Codex CLI 0.145.0. Ask Codex can retain reasons captured during the current
  browser session and through in-session resync, but cannot reconstruct them
  after a page reload or on another device from native thread history alone.
- The sidebar still lists individual threads without project grouping. There is
  no Skills view, independent cross-thread Activity view, usage panel, thread
  rename, or fork action.
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

1. Group threads by working directory and add a read-only Skills catalog backed
   only by the official `skills/list` method.
2. Add a read-only Activity surface before considering any new host execution
   capability.

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
- Skills and future host tools must not introduce path or command pass-through
  around the gateway allowlists.
- Automatic recovery and read-only views must not claim thread ownership or
  redirect approval requests away from the browser that started or resumed it.
- A browser terminal would bypass Codex approval and therefore requires a
  separate threat model, isolation boundary, and explicit opt-in.

## Verification

This round of code verification was completed on 2026-07-31 with Node.js
`v24.18.0`, npm `12.0.2`, and Codex CLI `0.146.0`:

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test` passed: 26 files, 321 tests. The server tests were run in an
  environment that permits loopback socket binding.
- `npm run build` passed.
- `CHROME_BIN=/usr/bin/chromium ASK_CODEX_VISUAL_URL=http://127.0.0.1:4173 ASK_CODEX_VISUAL_OUTPUT=/tmp/ask-codex-visual-composer-reasoning npm run check:visual`
  passed against the current production build. Deterministic desktop and
  390x844 mobile fixtures covered the Active and Archived views, desktop
  context menu, mobile long-press menu, permanent-delete confirmation,
  new-thread dialog, configured model selections, draft image previews,
  thumbnail loading, bounded layout and new-tab behavior after sending and
  reloading, grouped tools, a simulated approval reason, consecutive reasoning
  grouping, active-reasoning animation, whole-turn change summaries, and the
  unconfirmed-send recovery row. No horizontal overflow, overlapping controls,
  clipped rich content, console errors, or page errors were found. The fixture
  canceled at deletion confirmation, intercepted all simulated RPCs in the
  browser test, and created no real Codex turn.

- Bindings generated from Codex CLI `0.146.0` were checked: reasoning
  `summary` and `content` may both be empty, and `turn/diff/updated` is the
  latest turn-level aggregate snapshot. No real turn was created.

The protocol verification recorded on 2026-07-25 still applies to the
protocol paths unchanged in this round:

- Bindings from the CLI current at that time were generated and checked:
  `TurnItemsView` is
  `notLoaded | summary | full`, and `turn/completed` carries a `Turn` object.
  No real turn was created.
- A direct app-server protocol smoke check passed: an ephemeral `thread/start`
  without `historyMode` returned `historyMode: "legacy"`; no real turn was
  created.
