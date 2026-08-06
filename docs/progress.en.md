# Project Progress

[简体中文](progress.md) | **English**

Last reviewed: 2026-08-07

## Current Milestone

The multi-type file-input P2 item is complete. One `+` menu selects images or
ordinary files, and clipboard input distinguishes previewable images from file
cards. Ordinary files reach Codex through constrained temporary uploads and a
gateway-built application context; the browser cannot submit paths or
`additionalContext`. Successful turns retain bounded local download copies in
same-Origin IndexedDB. The earlier constrained native fork, P1 text steering
and aggregate long-history DOM budget, cwd continuity, Agent-output file
handoff, gateway hardening, and bounded structured Plan recovery remain in
place. No next near-term item has been selected.

## Current Baseline

The implementation currently provides:

- React desktop and mobile layouts for listing, searching, creating, resuming,
  and refreshing native Codex threads, with a 44-pixel conversation header and
  an always-editable responsive multiline composer where Enter inserts a
  newline and either the button or `Ctrl+Enter` sends; `Cmd+Enter` is also
  supported on macOS. While a turn runs, the same composer can send text-only
  steering to the active turn captured at submission; attachment drafts remain
  intact while attachment, model, and effort controls stay disabled. An unconfirmed
  normal send or steering submission remains separate from text entered while
  it is in flight. After the original turn stops being active, failed steering
  remains visible but cannot be retried incorrectly as a new turn. A newly
  created thread remains in the sidebar throughout
  its first turn until the canonical active or archived list confirms its
  metadata. Concurrent list refreshes apply only the latest result, and turn
  completion hydrates the name, preview, and time so a sparse status notification
  cannot make the entry disappear or degrade to a UUID.
- Active and Archived group threads by exact cwd and place pinned threads first
  within each group while preserving the existing order of the rest. One thread
  action menu opens from desktop right-click, a 550 ms mobile long press, or the
  explicit `...` entry point. Rename, pin, and unpin remain available while a
  thread has a turn in progress. Idle Active or Archived threads can be forked;
  success normally selects the new thread, while a user selection made during
  the request is preserved and only the list updates. Threads with active turns
  still cannot be forked, archived, or deleted; other idle threads can be archived, archived threads can
  be restored, and either kind of idle thread can be deleted after a confirmation
  warns that the thread and descendant sessions may be permanently removed.
  Cross-client name, archive, restore, and delete notifications reconcile the
  lists and current selection. Deletion also removes that thread's browser-local
  image and file copies from memory and IndexedDB.
- A fourth read-only Skills tab groups skill names, descriptions,
  `user`/`repo`/`system`/`admin` scopes, and enabled states by cwd, and reports
  load failures only as a count. The directory starts loading when the tab is
  first opened. Manual refresh sends `forceReload: true`, while a
  `skills/changed` notification rescans a directory that has already been
  loaded. At most 16 directories are loaded with the current cwd first; a
  deleted historical directory degrades independently instead of hiding valid
  projects. Separate generation guards prevent older Skills or thread-list
  responses from replacing newer state.
- A third read-only Activity tab combines native thread runtime status,
  `activeFlags`, pending requests, and bounded `turn/started`, `turn/completed`,
  and `thread/status/changed` events into Needs attention, Running now, and
  Recent sections. The recent-event ring retains only a thread id, optional
  turn id, activity kind, time, and turn duration when available; names and cwd
  values used for display come from the read-only thread list. It never retains
  cross-thread command output, MCP parameters, or file contents. An explicit
  idle snapshot supersedes a transient running event left from before a
  disconnect. Viewing or refreshing Activity reads the thread list without
  resuming or claiming threads or changing approval routing; selecting an entry
  follows the normal explicit user flow.
- The toolbar displays Connecting, retry attempts, Disconnected/Error,
  Connected · Syncing, Sync failed, Ready, or Working and supports immediate
  retry. WebSocket backoff resets only after Codex is actually ready. The first
  ready state establishes a baseline. Retrying a Codex child-process Error uses a
  bounded read-only `model/list` probe to trigger the gateway restart, while a
  WebSocket failure rebuilds the browser connection. A later ready state on the
  same or a new connection uses `thread/read` and
  `thread/turns/list` to resynchronize the selected thread from a read-only
  snapshot before sending is re-enabled, reusing the bounded notification
  buffer and two-pass coordinator. A failed sync keeps sending disabled and
  offers a read-only retry. Disconnects clear stale browser approvals, while
  the gateway reoffers requests that remain unresolved after reconnection.
  Recovery does not replay unconfirmed writes such as `turn/start`; if a
  disconnect interrupted a thread's first load, the user must explicitly retry
  it rather than invoking ownership-changing background `thread/resume`.
- The toolbar Usage dialog shows the selected thread from an in-memory LRU of
  at most 32 token snapshots, latest-context use, account totals and recent
  daily activity, and single- or multi-bucket rate windows, reset times, and a
  safe credit summary. Account reads call `account/usage/read` and
  `account/rateLimits/read` concurrently. Rolling
  `account/rateLimits/updated` notifications merge sparsely. Updates received
  during a read cannot be overwritten by its older response, absent or null
  account metadata does not erase a full snapshot, and rolling buckets remain
  capped at 32. Reached rate or spend-control limits are called out explicitly.
  API-key and Bedrock sign-in modes that do not support account usage degrade
  independently in the panel without a misleading toast.
- Incremental recent-turn loading through `thread/turns/list`, adaptive page
  sizing, retryable older pages, and summary fallback. App-server chooses the
  default history contract for new threads instead of Ask Codex forcing the
  experimental `paginated` mode. Existing paginated threads can still recover
  through a narrowly allowed ascending `thread/items/list`; default or `legacy`
  threads retain the one-turn full-detail retry. Loaded history normally mounts
  only the latest 24 turns, with Earlier/Newer moving by 12 turns and an active
  turn pinned inside that budget. Prepended history, appended turns, browsing
  away from the bottom, and thread switches preserve predictable windows and
  scroll positions. `thread/fork` excludes complete history from its initial
  response and sends the new thread through the same pagination path, so neither
  default nor `paginated` sources enlarge the fork response with long history.
- Streamed messages, reasoning, plans, command output, file changes, MCP calls,
  web searches, turn diffs, and unknown-item fallback rendering. Consecutive
  historical reasoning with content stays grouped and expandable in place,
  while each turn in progress keeps a fixed reasoning status slot at its bottom:
  active reasoning animates and idle reasoning appears muted, so reasoning
  lifecycles no longer repeatedly change the stream height. The current turn's
  structured plan also appears above the composer as a compact normal-layout
  summary that expands into a bounded scrolling step list; the summary
  disappears when the turn ends while the historical plan stays in its original
  turn. Realtime Plans and recovery snapshots use one strict bounded projection.
  The gateway caches each thread and turn's latest complete notification and
  attaches it to read-only turn results and lifecycle notifications. A Plan
  object, explicit unrecoverable `null`, or absent unknown cache field replaces,
  clears, or preserves browser state respectively; a resync snapshot also
  supersedes earlier buffered Plans that it covers. A successful fork copies
  bounded in-process Plan records from the source to the new thread ID,
  preserving recoverable and explicitly unavailable states without making the
  cache a cross-process source of truth. A turn diff is explicitly shown as a
  whole-turn change summary at the end of its turn;
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
- Explicit absolute local CommonMark links in completed Agent messages render
  as download controls with confirmation, pending, failure, and download-started
  states. An absolute local link without a valid capability becomes
  inert text; external web links retain their existing behavior. The gateway
  issues short-lived opaque IDs only from authoritative app-server `thread.cwd`
  plus completion evidence. It accepts no browser path, cwd, thread id, request
  body, or query, and uses no `ASK_CODEX_DOWNLOAD_ROOTS`. Consumption resolves
  through a pinned canonical root-directory fd and rechecks root `dev`/`ino`,
  target `realpath`, the opened file fd, regular-file type, the 25-MiB limit,
  the two-download concurrency bound, and a two-minute active-transfer deadline.
- Browser handling for command and file-change approvals and structured
  `request_user_input` requests. Approval buttons and gateway responses are
  narrowed to string decisions allowed by the protocol and actually offered in
  app-server `availableDecisions`; malformed, unknown, or exclusively
  client-unsupported structured decisions fail closed. Captured command
  approval reasons remain attached to the exact command item for the current
  browser session.
- New-thread working-directory and sandbox settings, explicit idle-thread
  sandbox overrides, next-turn model and reasoning controls beside the
  composer, and active-turn interruption. With a current selection, new-thread
  cwd comes from the exact current thread or matching Active or Archived
  summary; without one it comes from the bootstrap default. The new-thread
  sandbox always resets to `workspace-write`. Initial model and effort
  selections come from a strictly filtered effective Codex config read;
  alternatives come from `model/list`. Existing thread cwd is read-only and
  routine resume no longer resends flattened sandbox state.
- An Express/WebSocket gateway that starts `codex app-server` over JSONL stdio,
  rebuilds parameters for an explicit RPC allowlist, and routes app-server
  requests to the owning browser. `thread/name/set`, `thread/metadata/update`,
  and `skills/list` accept only bounded, field-by-field reconstructed
  parameters. The Skills response projects only name, description, optional
  flattened `interface.shortDescription`, scope, enabled state, and an error
  count per cwd; skill paths, dependencies, remaining interface metadata, and
  specific error text do not reach the browser. Top-level Skills RPC failures
  from the upstream app-server also use a fixed redacted message. Account usage
  and rate-limit reads accept only empty browser parameters and send no params
  upstream. Results project at most 366 daily buckets and 32 rate-limit
  buckets while dropping account identity, reset-credit details, and unknown
  fields. `account/rateLimits/updated` uses the same field-level sparse
  projection, and all three account-read failures use fixed redacted messages.
- `thread/fork` accepts only a source thread ID. The gateway fixes `on-request`,
  the user reviewer, and `excludeTurns: true`, rejecting rollout paths, cwd,
  model, permissions, instructions, cut points, and unknown fields. A response
  must prove the new ID, source linkage, absolute cwd, history mode, sandbox,
  and approval settings. The browser never receives rollout paths, instruction
  sources, runtime workspace roots, or unknown result fields. Success claims
  only the new thread without changing the source owner; failures, disconnects,
  malformed results, and ID collisions claim nothing and are never replayed.
- WebSocket upgrades accept only a raw request-target exactly equal to `/ws`,
  rejecting queries, fragments, normalized paths, and authority or absolute
  forms before authentication. Ordinary `thread/resume` sends no sandbox
  override and therefore preserves `externalSandbox`; an explicit override
  first probes the authoritative sandbox with fixed parameters and fails closed
  on an untrusted result or concurrent settings notification. Resume, turn
  start, and text steering operations for one thread are serialized;
  indeterminate results cancel already queued successors, and thread ownership
  is committed synchronously only after a structurally valid upstream success.
  A steering response must also return the same `turnId` as the sanitized
  `expectedTurnId`. Failure, disconnect, or a malformed result cannot take
  ownership from the previous browser.
- One composer `+` menu selects images or ordinary files. Clipboard PNG, JPEG,
  and WebP files become image previews; other files become cards with name and
  size. Image entry still requires an explicit model image-input declaration,
  while ordinary files do not. Both kinds share a four-attachment turn limit
  and a 10-MiB per-file limit. Bytes use temporary HTTP endpoints governed by
  the existing token and Origin/Host policy. Image IDs become official
  `localImage` input; file IDs become path-free history markers plus a
  gateway-controlled application `additionalContext`. The browser cannot submit
  paths, cwd, or `additionalContext`, and count, byte, concurrency, storage, and
  lease limits remain explicit. Successfully sent image previews and ordinary
  file download copies are bounded separately in same-Origin IndexedDB, each
  with a default 30-day TTL and eight-item/40-MiB limit. File history metadata
  must exactly match its local Blob before download is enabled. Clearing site
  data, storage reclamation, or another device, browser, profile, or Origin
  falls back to safe placeholders.
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

## Incomplete Work And Boundaries

The former nine-gap flat list no longer treats unlike items as equal. P1
steering and the aggregate DOM budget, plus P2 fork and multi-type file input,
are complete. The remainder is organized by actionability below. Priorities are
the current recommendation, not delivery commitments.

### Implementation Candidates

- **P2, standalone**: a persistent cross-device message queue. It needs its own
  ADR for idempotency keys, expiry, acknowledgement, active-turn conflicts, and
  approval ownership. Do not merge it with completed no-auto-replay steering
  into one send semantic.
- **P3, standalone**: a persistent Activity audit. Its data sensitivity,
  retention, and sources of truth need a separate definition; it cannot simply
  reuse the bounded structured Plan recovery cache.
- **P3, separate security project**: fixed host actions may expose only
  server-configured action IDs. Do not bundle an embedded PTY with them; it is
  currently unscheduled and requires its own isolation boundary and threat model.

### Upstream Or Protocol Limits

- Default and existing `legacy` threads have no official migration path and do
  not support `thread/items/list`; they remain summary-only when a full turn
  exceeds the gateway limit. A paginated item larger than 1 MiB cannot be
  recovered by shrinking its page further.
- When last verified with Codex CLI 0.145.0, paginated threads did not support
  rollback or detached review. Recheck these native-history actions after
  relevant CLI upgrades; the client cannot synthesize equivalent capabilities.
- Completed native `commandExecution` history does not contain approval reasons.
  The current browser session can preserve reasons it observed, but a reload or
  another device cannot reconstruct them from thread history.
- Other CLI or IDE app-server processes do not share item-level realtime
  Activity. Account usage and limits may also be unavailable for a sign-in mode
  or service and are not an API bill or exact USD cost.
- Official Turn and read results contain no structured Plan. After a gateway
  restart, cache eviction, or a notification lost before reaching the gateway,
  the current protocol cannot reconstruct that Plan from native history.

### Accepted Boundaries

- Under ADR 0013, file downloads intentionally do not list directories, accept
  browser paths, or export files absent from qualifying completed Agent messages.
  Capabilities remain short-lived, one-use, and local to the current process.
  This is a security scope, not unfinished functionality.
- Under ADR 0017, server copies of images and ordinary files are deleted after
  turn completion. IndexedDB previews and download copies serve only the same
  browser profile and Origin, each under 30-day and eight-item/40-MiB bounds.
  Without the same-Origin local copy, history shows a safe placeholder. These
  copies are neither cross-device storage nor persistent attachments that Codex
  can read again.
- Under ADR 0014, structured Plan recovery deliberately uses a bounded in-process
  cache rather than a new persistent conversation database. It covers ordinary
  disconnects and Codex child restarts but does not promise reconstruction across
  gateway processes or devices. This is an accepted tradeoff, not ordinary debt.
- The browser cannot submit arbitrary commands or gain an implicit shell. Fixed
  actions and a PTY, even if implemented later, require explicit authorization
  and isolation boundaries separate from Codex approval.

## Next

This P2 multi-type file-input milestone is complete; the next item has not been
selected. Prefer one standalone P2 design rather than introducing several new
persistent state models at once. Other candidates remain in
[`ideas.en.md`](ideas.en.md); presence in either document is not a delivery
commitment.

## Risks And Watchpoints

- The installed Codex CLI defines an evolving protocol. Protocol work must
  compare generated bindings and update normalization and tests together.
- `paginated` history remains an experimental persistence contract. Do not
  force it for new threads until app-server advertises an explicit capability
  and the real first-turn path is verified. CLI upgrades must still recheck item
  pagination and related native-history operations.
- `thread/fork` must continue accepting only a source thread ID while excluding
  complete history and permission overrides. It has no idempotency key, so an
  unknown result after disconnect or timeout must never be replayed automatically.
  CLI upgrades should recheck parameters, source linkage, returned history mode,
  and `thread/turns/list` compatibility; a real test fork is not a substitute for
  an explicit capability declaration.
- Rich rendering must treat all agent, command, diff, and ANSI content as
  untrusted text and must bound memory and DOM growth.
- File-download scope must continue to derive jointly from authoritative
  app-server `thread.cwd` and explicit absolute links in completed Agent
  messages; the browser must never select a path. Issuance snapshots canonical
  root identity, while consumption rechecks containment through a root-directory
  fd, target `realpath`, and file fd, with one-use, TTL, size, concurrency, and
  collection bounds. A `thread.cwd` of `/` is broad, so `ASK_CODEX_TOKEN` must be
  protected like the host-account password.
- Modern approval rationale must remain keyed by thread, turn, and item id;
  legacy call ids are attached only when they identify one command uniquely.
- `config/read` results must remain projected at the gateway to model and
  reasoning effort only; never forward the complete Codex configuration.
- Attachment bytes must remain outside WebSocket JSON. The browser must not
  provide host paths or `additionalContext`; temporary-attachment format or
  metadata checks, quotas, one-use consumption, and cleanup backstops must
  remain enforced.
- IndexedDB local copies may store only the thread/turn key, Blobs, media types,
  sizes, ordering, and lifecycle metadata needed for restoration. Ordinary
  files may retain the original filename required for display and download;
  images still do not. Neither may store tokens, host paths, or one-use
  attachment IDs, and local-storage failure must not affect an accepted turn.
- Skills and future host tools must not bypass the gateway allowlists. The
  Skills directory must continue stripping skill paths, dependencies, interface
  metadata other than the flattened `interface.shortDescription`, and error
  text instead of introducing path or command pass-through.
- Automatic recovery and read-only views must not claim thread ownership or
  redirect approval requests away from the browser that started or resumed it.
  Ordinary reconnection and Codex restart may retry bounded read-only requests,
  never unconfirmed writes.
- `turn/steer` must remain bound to the `expectedTurnId` captured at submission,
  accept only field-rebuilt text input, and fail closed when the response
  `turnId` differs. Recovery must not replay steering automatically, and a
  failed retry must not degrade into `turn/start`.
- `turn/plan/updated` is a complete snapshot. JSONL and WebSocket arrival order
  must remain authoritative, and realtime delivery and cached recovery must use
  the same field projection and resource bounds. `emittedAtMs` and
  `gatewayReceivedAtMs` are diagnostic only and must never reorder Plan state.
- The sandbox probe and actual override are separate app-server RPCs. The
  current protocol has no CAS or revision-conditioned write, so another Codex
  process can still change the sandbox between them. The gateway serializes its
  own requests, observes settings notifications during the probe, and validates
  the final response to narrow this window and fail closed on inconsistency, but
  cannot provide a cross-process atomic guarantee.
- Account usage and rate-limit methods must retain empty-parameter rebuilding,
  field-level result and notification projections, bounded collections, and
  fixed upstream error messages. Rolling rate-limit notifications are sparse
  updates and must not clear the latest full snapshot with absent or null fields.
- A browser terminal would bypass Codex approval and therefore requires a
  separate threat model, isolation boundary, and explicit opt-in.

## Verification

Verification for this round was completed on 2026-08-07 with Node.js
`v24.18.0`, npm `12.0.2`, and Codex CLI `0.146.0`:

- Current experimental TypeScript bindings were generated from the installed
  CLI and compared for `ThreadResumeResponse.sandbox`,
  `ThreadSettingsUpdatedNotification.threadSettings.sandboxPolicy`,
  `CommandExecutionApprovalDecision`, `ReviewDecision`, `TurnStartResponse`,
  `TurnSteerParams`, `TurnSteerResponse`, the complete-snapshot
  `TurnPlanUpdatedNotification`, `ThreadForkParams`, `ThreadForkResponse`,
  `Thread.historyMode`, official Plan-free Turn read structures, and the
  notification envelope's `emittedAtMs`. Ordinary file input also received live
  protocol validation: `mention` was unsuitable for an ordinary local file,
  while gateway-built application `additionalContext` let Codex accurately read
  a controlled temporary path. No real turn or persistent test fork was created
  solely for automated checks.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- `NODE_ENV=test npx vitest run` passed: 37 test files and 637 tests. Server
  tests ran in an environment that permits loopback socket binding.
- `CHROME_BIN=/usr/bin/chromium ASK_CODEX_VISUAL_URL=http://127.0.0.1:4173
  ASK_CODEX_VISUAL_OUTPUT=/tmp/ask-codex-file-input-visual npm run
  check:visual` passed against the current production build. Desktop and
  390x844 mobile fixtures covered approvals, project navigation, Activity,
  Skills, Usage, Agent-output downloads, rich content, the fixed reasoning slot,
  images, Plans, the running-turn steering composer, the new attachment `+`
  menu, and ordinary-file history cards. The unavailable state also remained
  intact when no same-Origin Blob was present. There was no horizontal overflow,
  clipping, content overlap, console error, or page error. The thread action
  menu included and contained Fork in both viewports. Deterministic browser
  fixtures intercepted every RPC, upload, and download and created no real
  Codex turn or fork.
