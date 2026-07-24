# Project Progress

[简体中文](progress.md) | **English**

Last reviewed: 2026-07-24

## Current Milestone

Item-level recovery for oversized turns and a bounded image-input MVP are
implemented. The next milestone returns to project-oriented navigation and
read-only discovery without changing the manual-approval or remote-access
trust model.

## Current Baseline

The implementation currently provides:

- React desktop and mobile layouts for listing, searching, creating, resuming,
  and refreshing native Codex threads, with a 44-pixel conversation header and
  a responsive one-line composer.
- Incremental recent-turn loading through `thread/turns/list`, adaptive page
  sizing, retryable older pages, and summary fallback. New threads are fixed to
  the `paginated` history contract so oversized turns can recover through a
  narrowly allowed ascending `thread/items/list`; old `legacy` threads retain
  the one-turn full-detail retry.
- Streamed messages, reasoning, plans, command output, file changes, MCP calls,
  web searches, turn diffs, and unknown-item fallback rendering, with explicit
  stream and message-size bounds.
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
  explicit, and history uses safe image placeholders.
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

This file describes the handoff baseline on `main`. After pulling the latest
`origin/main`, another device can resume from the ordered outcomes in `Next`
without relying on prior chat history.

## Known Gaps

- Existing `legacy` threads have no official migration path and do not support
  `thread/items/list`; they remain summary-only when a full single turn still
  exceeds the gateway limit. A paginated thread also cannot recover an item
  that by itself exceeds 1 MiB by shrinking the page further.
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
- The sidebar is a flat thread list. There are no project groups, Skills view,
  Activity view, usage panel, or thread-management actions.
- Image attachments are deleted after a turn completes. Normal subsequent
  Codex context is unaffected, but another native client cannot use the deleted
  `localImage.path` to edit history and reattach the original image; persistent
  attachment ownership and garbage collection are not designed. General file
  and audio input are also not exposed.
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
- `paginated` history remains an experimental persistence contract. CLI
  upgrades must recheck item pagination plus fork, rollback, and detached
  review support.
- Rich rendering must treat all agent, command, diff, and ANSI content as
  untrusted text and must bound memory and DOM growth.
- Modern approval rationale must remain keyed by thread, turn, and item id;
  legacy call ids are attached only when they identify one command uniquely.
- `config/read` results must remain projected at the gateway to model and
  reasoning effort only; never forward the complete Codex configuration.
- Image bytes must remain outside WebSocket JSON. The browser must not provide
  host paths, and temporary-attachment format checks, quotas, one-use
  consumption, and cleanup backstops must remain enforced.
- Skills and future host tools must not introduce path or command pass-through
  around the gateway allowlists.
- Automatic recovery and read-only views must not claim thread ownership or
  redirect approval requests away from the browser that started or resumed it.
- A browser terminal would bypass Codex approval and therefore requires a
  separate threat model, isolation boundary, and explicit opt-in.

## Verification

Verified on 2026-07-24 with Node.js `v24.13.0`, npm `11.18.0`, and Codex CLI
`0.145.0`:

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test` passed: 23 files, 259 tests. The server tests were run in an
  environment that permits loopback socket binding.
- `npm run build` passed.
- `node scripts/visual-check.mjs` (the script behind `npm run check:visual`)
  passed against the production build on port 4173 with deterministic desktop
  and mobile fixtures, including the new-thread dialog, configured model
  selections, image previews, grouped tools, and a simulated approval reason:
  no horizontal overflow, overlapping controls, clipped rich content, console
  errors, or page errors.
