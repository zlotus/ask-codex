# Project Progress

Last reviewed: 2026-07-23

## Current Milestone

The conversation-density and thread-setting refinement is implemented and
verified. The next milestone first closes the remaining item-level recovery gap
for oversized turns, then returns to project-oriented navigation and read-only
discovery without changing the manual-approval or remote-access trust model.

## Current Baseline

The implementation currently provides:

- React desktop and mobile layouts for listing, searching, creating, resuming,
  and refreshing native Codex threads, with a 44-pixel conversation header and
  a responsive one-line composer.
- Incremental recent-turn loading through `thread/turns/list`, adaptive page
  sizing, retryable older pages, summary fallback, and per-turn detail retry.
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

- A single turn whose full payload exceeds the gateway limit can fall back to a
  summary, and its one-turn detail retry can still exceed the same limit. The
  installed protocol provides `thread/items/list`, but it is not yet exposed by
  the browser RPC policy or represented as item-level pagination.
- Loaded history pages remain mounted. Heavy closed disclosures are lazy and
  Markdown/diff work is bounded, but very long manually expanded histories do
  not yet use viewport virtualization or an aggregate DOM budget.
- Completed `commandExecution` history does not contain approval reasons in
  Codex CLI 0.144.5. Ask Codex can retain reasons captured during the current
  browser session and through in-session resync, but cannot reconstruct them
  after a page reload or on another device from native thread history alone.
- The sidebar is a flat thread list. There are no project groups, Skills view,
  Activity view, usage panel, or thread-management actions.
- Turn steering, image input, persistent cross-device message queues, fixed host
  actions, and an embedded PTY are not implemented.

## Next

1. Add a strict `thread/items/list` policy and item-level pagination so an
   oversized single turn can recover full detail without raising message caps.
2. Group threads by working directory and add a read-only Skills catalog backed
   only by the official `skills/list` method.
3. Add a read-only Activity surface before considering any new host execution
   capability.

Later candidates remain in [`ideas.md`](ideas.md); their presence there is not
a delivery commitment.

## Risks And Watchpoints

- The installed Codex CLI defines an evolving protocol. Protocol work must
  compare generated bindings and update normalization and tests together.
- Rich rendering must treat all agent, command, diff, and ANSI content as
  untrusted text and must bound memory and DOM growth.
- Modern approval rationale must remain keyed by thread, turn, and item id;
  legacy call ids are attached only when they identify one command uniquely.
- `config/read` results must remain projected at the gateway to model and
  reasoning effort only; never forward the complete Codex configuration.
- Skills and future host tools must not introduce path or command pass-through
  around the gateway allowlists.
- Automatic recovery and read-only views must not claim thread ownership or
  redirect approval requests away from the browser that started or resumed it.
- A browser terminal would bypass Codex approval and therefore requires a
  separate threat model, isolation boundary, and explicit opt-in.

## Verification

Verified on 2026-07-23 with Node.js `v24.13.1`, npm `11.12.1`, and Codex CLI
`0.144.5`:

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test` passed: 21 files, 178 tests. The server tests were run in an
  environment that permits loopback socket binding.
- `npm run build` passed.
- `npm run check:visual` passed against the production build on port 4173 with
  deterministic desktop and mobile fixtures, including the new-thread dialog,
  configured model selections, grouped tools, and a simulated approval reason:
  no horizontal overflow, clipped rich content, console errors, or page errors.
