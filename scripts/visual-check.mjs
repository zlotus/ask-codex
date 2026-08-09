import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.ASK_CODEX_VISUAL_URL ?? "http://127.0.0.1:4173";
const browserPath = process.env.CHROME_BIN ?? "/usr/bin/chromium";
const outputDirectory = process.env.ASK_CODEX_VISUAL_OUTPUT ?? "/tmp/ask-codex-visual";
const fixtureImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const fixtureAttachmentId = "visualfixtureattachmentid0000001";
const fixtureDownloadCapabilityId = "d".repeat(32);
const fixtureDownloadHref = "/workspace/ask-codex/docs/progress.md:112";
const fixtureQueuedMessages = [{
  id: "q".repeat(32),
  threadId: "019-visual-thread",
  text: "Run the release checklist after the current review is complete.",
  expectedLastTurnId: "turn-newest",
  status: "queued",
  revision: 1,
  createdAt: 1_800_000_101_000,
  updatedAt: 1_800_000_101_000,
  expiresAt: 1_800_604_901_000,
}, {
  id: "r".repeat(32),
  threadId: "019-visual-thread",
  text: "Reconcile the updated context before sending this queued follow-up.",
  expectedLastTurnId: "turn-older",
  status: "needsReview",
  revision: 3,
  createdAt: 1_800_000_102_000,
  updatedAt: 1_800_000_103_000,
  expiresAt: 1_800_604_902_000,
  reviewReason: "contextChanged",
}];

function fixtureFilePart(name, mediaType, size) {
  const text = `Attached file: ${name}`;
  return {
    type: "text",
    text,
    text_elements: [{
      byteRange: { start: 0, end: Buffer.byteLength(text, "utf8") },
      placeholder: JSON.stringify({ type: "askCodexFile", name, mediaType, size }),
    }],
  };
}

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const consoleErrors = [];
const pageErrors = [];

const fixtureThread = {
  id: "019-visual-thread",
  name: "Renderer fixture",
  preview: "Verify code, command, and diff rendering",
  cwd: "/workspace/ask-codex",
  model: "gpt-5-codex",
  createdAt: 1_800_000_000,
  updatedAt: 1_800_000_100,
  status: { type: "idle" },
  isPinned: true,
};

const fixtureSiblingThread = {
  id: "019-visual-sibling-thread",
  name: "Navigation follow-up",
  preview: "Verify grouped project navigation",
  cwd: "/workspace/ask-codex",
  model: "gpt-5-codex",
  createdAt: 1_799_999_950,
  updatedAt: 1_799_999_980,
  status: { type: "active", activeFlags: ["waitingOnApproval"] },
  isPinned: false,
};

const fixtureOtherProjectThread = {
  id: "019-visual-other-project",
  name: "Client dashboard task",
  preview: "Verify a second project group",
  cwd: "/workspace/client-dashboard-with-a-long-project-directory-name",
  model: "gpt-5-codex",
  createdAt: 1_799_999_700,
  updatedAt: 1_799_999_750,
  status: { type: "active", activeFlags: [] },
  isPinned: false,
};

const fixtureArchivedThread = {
  id: "019-visual-archived-thread",
  name: "Archived fixture",
  preview: "Verify archived thread actions",
  cwd: "/workspace/ask-codex",
  model: "gpt-5-codex",
  createdAt: 1_799_999_800,
  updatedAt: 1_799_999_900,
  status: { type: "idle" },
};

const filePatch = [
  "@@ -1,4 +1,5 @@",
  " import { oldClient } from \"./client\";",
  "-const requestLimit = 10;",
  "+const requestLimit = 20;",
  "+const approvalPolicy = \"on-request\";",
  " export function connect() {",
  "   return oldClient(requestLimit);",
].join("\n");

const fixtureTurns = [
  {
    id: "turn-newest",
    status: "completed",
    startedAt: 1_800_000_060,
    completedAt: 1_800_000_100,
    durationMs: 40_250,
    items: [
      {
        id: "reasoning-one",
        type: "reasoning",
        summary: ["Inspect the existing renderer and preserve its bounded output behavior."],
        content: [],
      },
      {
        id: "reasoning-two",
        type: "reasoning",
        summary: ["Verify the implementation across desktop and mobile layouts."],
        content: ["The checks cover grouped reasoning, tool activity, and aggregate turn changes."],
      },
      {
        id: "command",
        type: "commandExecution",
        status: "completed",
        command: "npm run typecheck && npm test",
        aggregatedOutput: Array.from(
          { length: 720 },
          (_, index) => `Verification step ${String(index + 1).padStart(3, "0")}: passed with bounded output`,
        ).join("\n"),
        cwd: "/workspace/ask-codex",
        exitCode: 0,
        durationMs: 2840,
      },
      {
        id: "file-change",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/client.ts", kind: { type: "update", move_path: null }, diff: filePatch }],
      },
      {
        id: "collab-agent",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        prompt: "Inspect the responsive activity layout.",
        model: "gpt-5-codex",
        reasoningEffort: "medium",
        receiverThreadIds: ["019-visual-subagent"],
        agentsStates: { "019-visual-subagent": { status: "completed", message: null } },
      },
      {
        id: "subagent-activity",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "019-visual-subagent",
        agentPath: "/workspace/ask-codex/.agents/visual",
      },
      {
        id: "image-view",
        type: "imageView",
        path: "/workspace/ask-codex/visual-fixture.png",
      },
      {
        id: "agent-finish",
        type: "agentMessage",
        status: "completed",
        text: [
          "The bounded renderer is in place. Manual approval remains enforced at the gateway.",
          "",
          `[progress.md](${fixtureDownloadHref}) is available for download.`,
        ].join("\n"),
        askCodexFileDownloads: [{
          href: fixtureDownloadHref,
          capabilityId: fixtureDownloadCapabilityId,
        }],
      },
    ],
    diff: `diff --git a/src/client.ts b/src/client.ts\n--- a/src/client.ts\n+++ b/src/client.ts\n${filePatch}`,
  },
  {
    id: "turn-older",
    status: "completed",
    startedAt: 1_800_000_010,
    completedAt: 1_800_000_025,
    durationMs: 15_000,
    items: [
      {
        id: "user",
        type: "userMessage",
        content: [
          {
            type: "text",
            text: "Add a compact renderer with copy, wrapping, and safe large-output handling.",
            text_elements: [],
          },
          fixtureFilePart("renderer-notes.pdf", "application/pdf", 24_832),
        ],
      },
      {
        id: "agent-code",
        type: "agentMessage",
        status: "completed",
        text: [
          "The reusable component keeps language handling explicit:",
          "",
          "```typescript",
          "export function boundedAppend(current: string, delta: string) {",
          "  return `${current}${delta}`.slice(0, MAX_OUTPUT);",
          "}",
          "```",
          "",
          "It falls back to plain text for unknown languages.",
        ].join("\n"),
      },
    ],
  },
];

const fixtureImageTurn = {
  id: "turn-image-preview",
  status: "completed",
  itemsView: "full",
  items: [
    {
      id: "user-image-preview",
      type: "userMessage",
      content: [{ type: "localImage" }],
    },
    {
      id: "agent-image-preview",
      type: "agentMessage",
      text: "The uploaded image is available in this browser session.",
    },
  ],
};

async function installFixture(page) {
  let imageTurnStarted = false;
  let failNextTurnStart = false;
  let fixtureSocket = null;
  await page.route("**/api/bootstrap", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ready: true,
      defaultCwd: "/workspace/ask-codex",
      authRequired: false,
      codexVersion: "codex-cli/visual-fixture",
    }),
  }));
  await page.route("**/api/attachments", (route) => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      attachment: {
        id: fixtureAttachmentId,
        mediaType: "image/png",
        size: fixtureImage.byteLength,
        expiresAt: Date.now() + 60_000,
      },
    }),
  }));
  await page.route(`**/api/file-downloads/${fixtureDownloadCapabilityId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/octet-stream",
    headers: {
      "Content-Disposition": "attachment; filename=progress.md; filename*=UTF-8''progress.md",
      "Content-Length": "24",
    },
    body: "visual download fixture\n",
  }));

  await page.routeWebSocket("**/ws", (socket) => {
    fixtureSocket = socket;
    globalThis.setTimeout(() => socket.send(JSON.stringify({
      type: "status",
      status: "ready",
      defaultCwd: "/workspace/ask-codex",
      version: "codex-cli/visual-fixture",
    })), 0);
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "rpc") return;
      if (message.method === "turn/start" && failNextTurnStart) {
        failNextTurnStart = false;
        socket.send(JSON.stringify({
          type: "rpcError",
          id: message.id,
          error: { code: -32000, message: "Visual fixture send was not confirmed" },
        }));
        return;
      }
      let result = {};
      if (message.method === "thread/list") {
        result = {
          data: message.params?.archived
            ? [fixtureArchivedThread]
            : [fixtureThread, fixtureSiblingThread, fixtureOtherProjectThread],
          nextCursor: null,
        };
      } else if (message.method === "skills/list") {
        result = {
          data: [{
            cwd: fixtureThread.cwd,
            skills: [{
              name: "project-continuity",
              description: "Maintain concise repository-owned development context across sessions.",
              shortDescription: "Maintain cross-session project context.",
              scope: "repo",
              enabled: true,
            }, {
              name: "disabled-audit-helper-with-a-long-name",
              description: "A disabled fixture used to verify bounded Skills layout.",
              scope: "user",
              enabled: false,
            }],
            errorCount: 1,
          }, {
            cwd: fixtureOtherProjectThread.cwd,
            skills: [{
              name: "release-review",
              description: "Review release readiness without exposing host paths.",
              scope: "system",
              enabled: true,
            }],
            errorCount: 0,
          }],
        };
      } else if (message.method === "model/list") {
        result = {
          data: [{
            model: "gpt-5-codex",
            displayName: "GPT-5 Codex",
            inputModalities: ["text", "image"],
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Thorough" },
            ],
          }],
          nextCursor: null,
        };
      } else if (message.method === "config/read") {
        result = { model: "gpt-5-codex", effort: "high" };
      } else if (message.method === "messageQueue/list") {
        result = { revision: 4, items: fixtureQueuedMessages };
      } else if (message.method === "account/rateLimits/read") {
        result = {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_003_600 },
            secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
            credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            planType: "plus",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        };
      } else if (message.method === "account/usage/read") {
        result = {
          summary: {
            lifetimeTokens: 1_250_000,
            peakDailyTokens: 92_000,
            longestRunningTurnSec: 185,
            currentStreakDays: 4,
            longestStreakDays: 11,
          },
          dailyUsageBuckets: [
            { startDate: "2026-07-30", tokens: 45_000 },
            { startDate: "2026-07-31", tokens: 67_000 },
            { startDate: "2026-08-01", tokens: 38_000 },
            { startDate: "2026-08-02", tokens: 72_000 },
          ],
        };
      } else if (message.method === "thread/resume") {
        result = {
          thread: { ...fixtureThread, turns: [] },
          model: "gpt-5-codex",
          cwd: fixtureThread.cwd,
          reasoningEffort: "high",
          sandbox: { type: "workspaceWrite" },
          initialTurnsPage: {
            data: imageTurnStarted ? [fixtureImageTurn, ...fixtureTurns] : fixtureTurns,
            nextCursor: "older-page",
            backwardsCursor: null,
          },
        };
      } else if (message.method === "thread/turns/list") {
        result = { data: [], nextCursor: null, backwardsCursor: null };
      } else if (message.method === "turn/start") {
        imageTurnStarted = true;
        result = { turn: fixtureImageTurn };
      }
      socket.send(JSON.stringify({ type: "rpcResult", id: message.id, result }));
      if (message.method === "thread/resume") {
        globalThis.setTimeout(() => {
          socket.send(JSON.stringify({
            type: "notification",
            method: "thread/tokenUsage/updated",
            params: {
              threadId: fixtureThread.id,
              turnId: "turn-newest",
              tokenUsage: {
                total: {
                  totalTokens: 84_000,
                  inputTokens: 60_000,
                  cachedInputTokens: 24_000,
                  cacheWriteInputTokens: 0,
                  outputTokens: 24_000,
                  reasoningOutputTokens: 8_000,
                },
                last: {
                  totalTokens: 20_000,
                  inputTokens: 14_000,
                  cachedInputTokens: 6_000,
                  cacheWriteInputTokens: 0,
                  outputTokens: 6_000,
                  reasoningOutputTokens: 2_000,
                },
                modelContextWindow: 200_000,
              },
            },
          }));
          socket.send(JSON.stringify({
            type: "request",
            id: "visual-command-approval",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: fixtureThread.id,
              turnId: "turn-newest",
              itemId: "command",
              startedAtMs: Date.now(),
              environmentId: null,
              command: "npm run typecheck && npm test",
              cwd: fixtureThread.cwd,
              reason: "Verify the implementation before reporting completion",
              availableDecisions: ["accept", "decline"],
            },
          }));
          globalThis.setTimeout(() => socket.send(JSON.stringify({
            type: "notification",
            method: "serverRequest/resolved",
            params: { requestId: "visual-command-approval" },
          })), 20);
        }, 20);
      }
    });
  });
  return {
    failNextSend() {
      failNextTurnStart = true;
    },
    notify(method, params) {
      if (!fixtureSocket) throw new Error("The visual fixture WebSocket is not connected");
      fixtureSocket.send(JSON.stringify({ type: "notification", method, params }));
    },
    request(id, method, params) {
      if (!fixtureSocket) throw new Error("The visual fixture WebSocket is not connected");
      fixtureSocket.send(JSON.stringify({ type: "request", id, method, params }));
    },
  };
}

async function ensureThreadSidebarOpen(page) {
  const sidebarInViewport = await page.locator(".sidebar").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.right > 0 && box.left < window.innerWidth && box.bottom > 0 && box.top < window.innerHeight;
  });
  if (!sidebarInViewport) {
    const openThreads = page.getByRole("button", { name: "Open threads" });
    if (await openThreads.isVisible()) await openThreads.click();
  }
}

async function selectFixture(page) {
  const fixtureButton = page.getByRole("button", { name: "Renderer fixture", exact: true });
  await ensureThreadSidebarOpen(page);
  await fixtureButton.click();
  await page.getByText("The bounded renderer is in place.", { exact: false }).waitFor();
  await page.waitForTimeout(250);
}

async function openRichDetails(page) {
  for (const selector of [".reasoning-block", ".activity-group", ".tool-activity", ".inline-details, .turn-diff"]) {
    await page.locator(selector).evaluateAll((elements) => {
      for (const element of elements) {
        if (!element.open) element.querySelector(":scope > summary")?.click();
      }
    });
    if (selector === ".activity-group") {
      await page.locator(".tool-reason-preview").first().waitFor();
    }
    await page.waitForTimeout(50);
  }
}

async function inspectFileDownload(page, screenshotPaths) {
  const trigger = page.getByRole("button", { name: "Download progress.md", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const initialBox = await trigger.boundingBox();
  await trigger.click();
  const confirmation = page.getByRole("group", { name: "Confirm download progress.md" });
  await confirmation.waitFor();
  const confirmationLayout = await confirmation.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const conversation = element.closest(".conversation-scroll")?.getBoundingClientRect();
    const controls = [...element.querySelectorAll("button")].map((button) => {
      const controlBox = button.getBoundingClientRect();
      return {
        width: controlBox.width,
        height: controlBox.height,
        contained: controlBox.left >= box.left && controlBox.right <= box.right &&
          controlBox.top >= box.top && controlBox.bottom <= box.bottom,
      };
    });
    return {
      width: box.width,
      height: box.height,
      contained: Boolean(conversation && box.left >= conversation.left && box.right <= conversation.right),
      controls,
      confirmFocused: document.activeElement?.getAttribute("aria-label") === "Confirm download progress.md",
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  await page.screenshot({ path: screenshotPaths.confirm, fullPage: true });

  const confirm = page.getByRole("button", { name: "Confirm download progress.md", exact: true });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    confirm.click(),
  ]);
  const started = page.getByRole("button", { name: "Download started progress.md", exact: true });
  await started.waitFor();
  const startedFeedback = await started.evaluate((element) => ({
    ariaDisabled: element.getAttribute("aria-disabled") === "true",
    hasCheck: Boolean(element.querySelector(".lucide-check")),
    focused: document.activeElement === element,
    label: element.querySelector(".markdown-file-download__label")?.textContent?.trim(),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  await page.screenshot({ path: screenshotPaths.started, fullPage: true });
  const restored = page.getByRole("button", {
    name: "Download already started progress.md",
    exact: true,
  });
  await restored.waitFor();
  await page.screenshot({ path: screenshotPaths.restored, fullPage: true });
  const restoredBox = await restored.boundingBox();
  const completion = await restored.evaluate((element) => ({
    ariaDisabled: element.getAttribute("aria-disabled") === "true",
    hasCheck: Boolean(element.querySelector(".lucide-check")),
    focused: document.activeElement === element,
    label: element.querySelector(".markdown-file-download__label")?.textContent?.trim(),
    feedbackRemoved: !element.parentElement?.querySelector('[role="status"]'),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  await download.cancel().catch(() => undefined);
  return {
    initialVisible: Boolean(initialBox && initialBox.width > 0 && initialBox.height > 0),
    stableConfirmationWidth: Boolean(initialBox && Math.abs(initialBox.width - confirmationLayout.width) <= 1),
    stableRestoredWidth: Boolean(initialBox && restoredBox && Math.abs(initialBox.width - restoredBox.width) <= 1),
    suggestedFilename: download.suggestedFilename(),
    confirmation: confirmationLayout,
    startedFeedback,
    completion,
  };
}

async function inspectRichLayout(page) {
  return page.evaluate(() => {
    const selectors = [
      ".reasoning-block",
      ".code-block",
      ".diff-viewer",
      ".command-block",
      ".activity-group",
      ".turn-footer",
      ".turn-meta",
      ".turn-meta__item",
    ];
    const clipped = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const footer = element.closest(".turn-footer")?.getBoundingClientRect();
        return box.left < 0 || box.right > window.innerWidth + 1 || Boolean(
          footer && (box.left < footer.left - 1 || box.right > footer.right + 1),
        );
      })
      .map((element) => element.className);
    const activityStackLayouts = [...document.querySelectorAll(".activity-stack")].map((stack) => {
      const children = [...stack.children].filter((element) => (
        element.matches(".reasoning-block, .tool-activity, .activity-group")
      ));
      const boundaries = children.slice(1).map((element, index) => {
        const previous = children[index];
        const previousBox = previous.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const previousStyle = window.getComputedStyle(previous);
        const style = window.getComputedStyle(element);
        return {
          gap: box.top - previousBox.bottom,
          dividerWidth: Number.parseFloat(previousStyle.borderBottomWidth) +
            Number.parseFloat(style.borderTopWidth),
        };
      });
      return { children: children.length, boundaries };
    });
    const activityTitles = [...document.querySelectorAll(".tool-activity-title > strong")]
      .map((element) => element.textContent?.trim());
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      clipped,
      codeBlocks: document.querySelectorAll(".code-block").length,
      diffViewers: document.querySelectorAll(".diff-viewer").length,
      reasoningBlocks: document.querySelectorAll(".reasoning-block").length,
      reasoningEntries: document.querySelectorAll(".reasoning-entry").length,
      groupedReasoningLabels: [...document.querySelectorAll(".reasoning-summary")]
        .filter((element) => element.textContent?.includes("Reasoning (2)")).length,
      commands: document.querySelectorAll(".command-block").length,
      activityGroups: document.querySelectorAll(".activity-group").length,
      activityStacks: activityStackLayouts.length,
      stackedActivityRuns: activityStackLayouts.filter(({ children }) => children > 1).length,
      activityStackGapViolations: activityStackLayouts.flatMap(({ boundaries }) => boundaries)
        .filter(({ gap }) => Math.abs(gap) > 0.5).length,
      activityStackDividerViolations: activityStackLayouts.flatMap(({ boundaries }) => boundaries)
        .filter(({ dividerWidth }) => Math.abs(dividerWidth - 1) > 0.01).length,
      formalActivityLabels: ["Spawn agent", "Agent started", "Viewed image"]
        .filter((label) => activityTitles.includes(label)),
      hiddenActivitySummaries: [...document.querySelectorAll(".command-summary")].filter((element) => {
        const box = element.getBoundingClientRect();
        return window.getComputedStyle(element).display === "none" || box.width === 0 || box.height === 0;
      }).length,
      reasonBlocks: document.querySelectorAll(".tool-reasons").length,
      scrollingToolOutputs: [...document.querySelectorAll(".tool-activity .code-block-content")]
        .filter((element) => element.scrollHeight > element.clientHeight).length,
      toolOutputTruncations: document.querySelectorAll(".tool-activity .code-block-truncation").length,
      turnFooters: document.querySelectorAll(".turn-footer").length,
      turnMetadata: document.querySelectorAll(".turn-meta").length,
      overlappingTurnFooterContent: [...document.querySelectorAll(".turn-footer")]
        .filter((footer) => {
          const metadata = footer.querySelector(".turn-meta")?.getBoundingClientRect();
          const status = footer.querySelector(".status-pill")?.getBoundingClientRect();
          return Boolean(metadata && status && metadata.left < status.right && metadata.right > status.left &&
            metadata.top < status.bottom && metadata.bottom > status.top);
        }).length,
      fileCards: document.querySelectorAll(".message-file").length,
      fileCardsContained: [...document.querySelectorAll(".message-file")].every((element) => {
        const box = element.getBoundingClientRect();
        const message = element.closest(".message")?.getBoundingClientRect();
        return Boolean(message && box.left >= message.left && box.right <= message.right);
      }),
      unavailableFileCards: document.querySelectorAll(".message-file__unavailable").length,
    };
  });
}

async function inspectActiveReasoning(page, fixture, screenshotPath) {
  const turnId = "turn-live-reasoning";
  const item = { id: "reasoning-live", type: "reasoning", summary: [], content: [] };
  fixture.notify("turn/started", {
    threadId: fixtureThread.id,
    turn: {
      id: turnId,
      status: "inProgress",
      startedAt: 1_800_000_110,
      items: [],
    },
  });
  fixture.notify("item/started", {
    threadId: fixtureThread.id,
    turnId,
    item,
  });
  const turn = page.locator(`[data-turn-id="${turnId}"]`);
  await turn.waitFor();
  const status = turn.getByRole("status", { name: "Turn status" });
  await status.waitFor();
  await status.getByText("Reasoning active", { exact: true }).waitFor();
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const active = await status.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const turnBox = element.closest(".turn")?.getBoundingClientRect();
    const line = element.querySelector(".turn-reasoning-status");
    const spinner = line?.querySelector("svg");
    const label = line?.querySelector("span");
    element.__askCodexVisualStatusSlot = true;
    if (line) line.__askCodexVisualStatusLine = true;
    if (spinner) spinner.__askCodexVisualStatusSpinner = true;
    if (label) label.__askCodexVisualStatusLabel = true;
    return {
      fitsViewport: box.left >= 0 && box.right <= window.innerWidth,
      nonExpandable: element.tagName === "DIV" && !element.querySelector("summary"),
      spinnerAnimation: spinner ? window.getComputedStyle(spinner).animationName : null,
      height: box.height,
      relativeTop: turnBox ? box.top - turnBox.top : null,
    };
  });
  fixture.notify("item/completed", {
    threadId: fixtureThread.id,
    turnId,
    item,
  });
  await status.getByText("Reasoning idle", { exact: true }).waitFor();
  const idle = await status.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const turnBox = element.closest(".turn")?.getBoundingClientRect();
    const line = element.querySelector(".turn-reasoning-status");
    const spinner = line?.querySelector("svg");
    const label = line?.querySelector("span");
    return {
      sameSlot: element.__askCodexVisualStatusSlot === true,
      sameLine: line?.__askCodexVisualStatusLine === true,
      sameSpinner: spinner?.__askCodexVisualStatusSpinner === true,
      sameLabel: label?.__askCodexVisualStatusLabel === true,
      spinnerAnimation: spinner ? window.getComputedStyle(spinner).animationName : null,
      height: box.height,
      relativeTop: turnBox ? box.top - turnBox.top : null,
      emptyReasoningHidden: !element.closest(".turn")?.querySelector(".reasoning-block, .activity-stack"),
    };
  });
  fixture.notify("turn/completed", {
    threadId: fixtureThread.id,
    turn: {
      id: turnId,
      status: "completed",
      startedAt: 1_800_000_110,
      completedAt: 1_800_000_112,
      durationMs: 2_000,
      items: [item],
    },
  });
  await status.getByText("completed", { exact: true }).waitFor();
  const completed = await status.evaluate((element) => ({
    sameSlot: element.__askCodexVisualStatusSlot === true,
    hasMetadata: Boolean(element.querySelector(".turn-meta")),
    hasReasoningStatus: Boolean(element.querySelector(".turn-reasoning-status")),
  }));
  return {
    fitsViewport: active.fitsViewport,
    nonExpandable: active.nonExpandable,
    spinnerAnimation: active.spinnerAnimation,
    idleSpinnerAnimation: idle.spinnerAnimation,
    sameSlot: idle.sameSlot,
    sameLine: idle.sameLine,
    sameSpinner: idle.sameSpinner,
    sameLabel: idle.sameLabel,
    stableHeight: Math.abs(active.height - idle.height) <= 0.5,
    stablePosition: active.relativeTop !== null && idle.relativeTop !== null &&
      Math.abs(active.relativeTop - idle.relativeTop) <= 0.5,
    emptyReasoningHidden: idle.emptyReasoningHidden,
    completedSameSlot: completed.sameSlot,
    completedHasMetadata: completed.hasMetadata,
    completedReasoningHidden: !completed.hasReasoningStatus,
  };
}

async function inspectFailedSubmission(page, fixture, screenshotPath) {
  fixture.failNextSend();
  await page.getByLabel("Message Codex").fill("Keep the next draft editable");
  await page.getByRole("button", { name: "Send message" }).click();
  const recovery = page.locator(".composer-failed-submission");
  await recovery.waitFor();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const result = await recovery.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const textarea = document.querySelector(".composer textarea");
    const send = document.querySelector('[aria-label="Send message"]');
    const toast = document.querySelector(".toast")?.getBoundingClientRect();
    const actions = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return {
      actionsUsable: actions.length === 2 && actions.every((action) => action.width >= 32 && action.height >= 32),
      fitsViewport: box.left >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      sendDisabled: send?.disabled === true,
      textareaEditable: textarea?.disabled === false,
      toastOverlap: Boolean(toast && box.left < toast.right && box.right > toast.left &&
        box.top < toast.bottom && box.bottom > toast.top),
    };
  });
  await page.getByRole("button", { name: "Discard unconfirmed message" }).click();
  await recovery.waitFor({ state: "hidden" });
  return result;
}

let activePlanSequence = 0;

async function inspectActivePlanDock(page, fixture, screenshotPrefix) {
  const sequence = ++activePlanSequence;
  const turnId = `visual-plan-turn-${sequence}`;
  const requestId = `visual-plan-approval-${sequence}`;
  const currentStep = [
    "Implement the active plan dock while preserving the historical plan and keeping every control",
    "visible across narrow mobile layouts without allowing the summary text to resize the workspace",
  ].join(" ");
  const plan = Array.from({ length: 14 }, (_, index) => ({
    step: index === 1 ? currentStep : `Verification step ${index + 1}: preserve bounded layout behavior`,
    status: index === 0 ? "completed" : index === 1 ? "inProgress" : "pending",
  }));

  fixture.notify("turn/started", {
    threadId: fixtureThread.id,
    turn: { id: turnId, status: "inProgress", items: [] },
  });
  fixture.notify("turn/plan/updated", {
    threadId: fixtureThread.id,
    turnId,
    explanation: "The current execution plan remains available next to the controls.",
    plan,
  });
  fixture.request(requestId, "item/commandExecution/requestApproval", {
    threadId: fixtureThread.id,
    turnId,
    itemId: `visual-plan-command-${sequence}`,
    command: "npm run typecheck && npm test",
    cwd: fixtureThread.cwd,
    reason: "Verify the plan dock alongside an approval request",
    availableDecisions: ["accept", "decline"],
  });

  const dock = page.getByRole("region", { name: "Current plan" });
  const approval = page.locator(".approval-panel");
  await dock.waitFor();
  await approval.waitFor();
  const toggle = dock.getByRole("button", { name: /current plan/i });
  const collapsed = await page.evaluate(() => {
    const workspace = document.querySelector(".workspace");
    const conversation = document.querySelector(".conversation-scroll");
    const planDock = document.querySelector(".active-plan-dock");
    const summary = document.querySelector(".active-plan-dock__summary");
    const current = document.querySelector(".active-plan-dock__current > span");
    const approvalPanel = document.querySelector(".approval-panel");
    const composer = document.querySelector(".composer-wrap");
    if (!workspace || !conversation || !planDock || !summary || !current || !approvalPanel || !composer) {
      return { complete: false };
    }
    const children = [...workspace.children];
    const dockBox = planDock.getBoundingClientRect();
    const summaryBox = summary.getBoundingClientRect();
    const approvalBox = approvalPanel.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    return {
      complete: true,
      correctOrder: [conversation, planDock, approvalPanel, composer]
        .map((element) => children.indexOf(element))
        .every((index, position, indexes) => index >= 0 && (position === 0 || index > indexes[position - 1])),
      composerVisible: composerBox.top >= 0 && composerBox.bottom <= window.innerHeight,
      fitsViewport: dockBox.left >= 0 && dockBox.right <= window.innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      position: window.getComputedStyle(planDock).position,
      summaryHeight: summaryBox.height,
      summaryCollapsed: summary.getAttribute("aria-expanded") === "false",
      currentTruncated: current.scrollWidth > current.clientWidth,
      noOverlap: dockBox.bottom <= approvalBox.top + 1 && approvalBox.bottom <= composerBox.top + 1,
    };
  });
  await page.screenshot({ path: `${screenshotPrefix}-collapsed.png`, fullPage: true });

  await toggle.click();
  await page.locator(".active-plan-dock__body").waitFor({ state: "visible" });
  const expanded = await page.evaluate(() => {
    const dock = document.querySelector(".active-plan-dock");
    const body = document.querySelector(".active-plan-dock__body");
    const approval = document.querySelector(".approval-panel");
    const composer = document.querySelector(".composer-wrap");
    if (!dock || !body || !approval || !composer) return { complete: false };
    const dockBox = dock.getBoundingClientRect();
    const approvalBox = approval.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const bodyStyle = window.getComputedStyle(body);
    return {
      complete: true,
      bodyScrollable: body.scrollHeight > body.clientHeight,
      bodyOverflow: bodyStyle.overflowY,
      composerVisible: composerBox.top >= 0 && composerBox.bottom <= window.innerHeight,
      fitsViewport: dockBox.left >= 0 && dockBox.right <= window.innerWidth && dockBox.bottom <= window.innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      noOverlap: dockBox.bottom <= approvalBox.top + 1 && approvalBox.bottom <= composerBox.top + 1,
      summaryExpanded: document.querySelector(".active-plan-dock__summary")
        ?.getAttribute("aria-expanded") === "true",
    };
  });
  await page.screenshot({ path: `${screenshotPrefix}-expanded.png`, fullPage: true });

  fixture.notify("turn/completed", {
    threadId: fixtureThread.id,
    turn: { id: turnId, status: "completed", itemsView: "notLoaded", items: [] },
  });
  await dock.waitFor({ state: "hidden" });
  const terminalPlan = page.getByRole("region", { name: "Plan" });
  await terminalPlan.getByRole("status").waitFor();
  const terminal = await terminalPlan.evaluate((element) => {
    const notice = element.querySelector(".plan-terminal-notice");
    return {
      complete: true,
      noticeVisible: Boolean(notice && notice.getClientRects().length > 0),
      noticeContained: Boolean(notice && notice.scrollWidth <= notice.clientWidth),
      spinnerStopped: !element.querySelector(".spin"),
      horizontalOverflow: element.scrollWidth > element.clientWidth,
    };
  });
  await page.screenshot({ path: `${screenshotPrefix}-terminal.png`, fullPage: true });
  fixture.notify("serverRequest/resolved", { requestId });
  await approval.waitFor({ state: "hidden" });
  return { collapsed, expanded, terminal, dismissed: true };
}

async function inspectMessageQueueDock(page, screenshotPath) {
  const dock = page.getByRole("region", { name: "Message queue" });
  await dock.waitFor();
  const initialToggle = dock.getByRole("button", { name: /Expand message queue/ });
  await initialToggle.waitFor();
  await page.locator(".message-queue-dock__body").waitFor({ state: "hidden" });
  const collapsed = await dock.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const composer = document.querySelector(".composer-wrap")?.getBoundingClientRect();
    return {
      bodyHidden: !element.querySelector(".message-queue-dock__body"),
      composerVisible: Boolean(composer && composer.top >= box.bottom - 1 && composer.bottom <= window.innerHeight),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      summaryCollapsed: element.querySelector(".message-queue-dock__summary")
        ?.getAttribute("aria-expanded") === "false",
    };
  });
  await initialToggle.click();
  await page.locator(".message-queue-dock__body").waitFor({ state: "visible" });
  await dock.getByText("Context changed", { exact: true }).waitFor();
  const expanded = await dock.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const composer = document.querySelector(".composer-wrap")?.getBoundingClientRect();
    const body = element.querySelector(".message-queue-dock__body");
    const rows = [...element.querySelectorAll(".message-queue-item")];
    const actions = [...element.querySelectorAll(".message-queue-dock__icon")]
      .map((button) => button.getBoundingClientRect());
    const statusText = [...element.querySelectorAll(".message-queue-item__status")]
      .map((status) => status.textContent?.trim());
    return {
      fitsViewport: box.left >= 0 && box.right <= window.innerWidth,
      composerVisible: Boolean(composer && composer.top >= box.bottom - 1 && composer.bottom <= window.innerHeight),
      bodyScrollableWhenNeeded: body ? ["auto", "scroll"].includes(window.getComputedStyle(body).overflowY) : false,
      rows: rows.length,
      actionsUsable: actions.length === 5 && actions.every((action) => action.width >= 32 && action.height >= 32),
      statusText,
      textContained: rows.every((row) => {
        const rowBox = row.getBoundingClientRect();
        const text = row.querySelector(".message-queue-item__text")?.getBoundingClientRect();
        return Boolean(text && text.left >= rowBox.left && text.right <= rowBox.right);
      }),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const toggle = dock.getByRole("button", { name: /Collapse message queue/ });
  await toggle.click();
  await page.locator(".message-queue-dock__body").waitFor({ state: "hidden" });
  await dock.getByRole("button", { name: /Expand message queue/ }).click();
  await page.locator(".message-queue-dock__body").waitFor({ state: "visible" });
  return { expanded, collapsed };
}

async function inspectThreadDialog(page) {
  const dialog = page.locator(".thread-settings-dialog");
  await dialog.waitFor();
  return dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const cwd = element.querySelector('[aria-label="Working directory"]');
    const sandbox = element.querySelector('[aria-label="Sandbox"]');
    return {
      fitsViewport: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      cwdEditable: cwd?.tagName === "INPUT" && !cwd.readOnly,
      sandboxEnabled: sandbox?.tagName === "SELECT" && !sandbox.disabled,
      sandbox: sandbox?.tagName === "SELECT" ? sandbox.value : null,
    };
  });
}

async function approvalControlSnapshot(page) {
  const control = page.locator(".composer-approval-toggle");
  await control.waitFor();
  return control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const footer = element.closest(".composer-footer")?.getBoundingClientRect();
    const input = element.querySelector('input[type="checkbox"]');
    return {
      checked: input?.checked === true,
      disabled: input?.disabled === true,
      usableSize: box.width >= 44 && box.height >= 24,
      contained: Boolean(footer && box.left >= footer.left && box.right <= footer.right),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectOneTurnAutoRun(page, screenshotPaths) {
  const control = page.locator(".composer-approval-toggle");
  const input = page.getByLabel("Auto-run sandboxed actions for next turn");
  const existing = await approvalControlSnapshot(page);
  await control.click();
  await page.waitForFunction(() => (
    document.querySelector('[aria-label="Auto-run sandboxed actions for next turn"]')?.checked === true
  ));
  const existingArmed = await approvalControlSnapshot(page);
  await control.click();

  const newThread = page.getByRole("button", { name: "New thread", exact: true });
  await ensureThreadSidebarOpen(page);
  await newThread.click();
  const dialog = await inspectThreadDialog(page);
  await page.screenshot({ path: screenshotPaths.dialog, fullPage: true });
  await page.getByRole("button", { name: "Create thread", exact: true }).click();
  await page.locator(".thread-settings-dialog").waitFor({ state: "hidden" });

  const configuredDraft = await approvalControlSnapshot(page);
  await control.click();
  await page.waitForFunction(() => (
    document.querySelector('[aria-label="Auto-run sandboxed actions for next turn"]')?.checked === true
  ));
  const configuredDraftArmed = await approvalControlSnapshot(page);
  await page.screenshot({ path: screenshotPaths.armedDraft, fullPage: true });

  await selectFixture(page);
  await page.waitForFunction(() => (
    document.querySelector('[aria-label="Auto-run sandboxed actions for next turn"]')?.checked === false
  ));
  const clearedAfterThreadSelection = !(await input.isChecked());
  return {
    existing,
    existingArmed,
    dialog,
    configuredDraft,
    configuredDraftArmed,
    clearedAfterThreadSelection,
  };
}

function oneTurnAutoRunInvalid(inspection) {
  const snapshots = [
    inspection.existing,
    inspection.existingArmed,
    inspection.configuredDraft,
    inspection.configuredDraftArmed,
  ];
  return inspection.existing.disabled || inspection.existing.checked ||
    inspection.configuredDraft.disabled || inspection.configuredDraft.checked ||
    !inspection.existingArmed.checked || inspection.existingArmed.disabled ||
    !inspection.configuredDraftArmed.checked || inspection.configuredDraftArmed.disabled ||
    !inspection.clearedAfterThreadSelection ||
    snapshots.some((snapshot) => (
      !snapshot.usableSize || !snapshot.contained || snapshot.horizontalOverflow
    ));
}

async function inspectThreadActionMenu(page) {
  const menu = page.getByRole("menu", { name: "Actions for Renderer fixture" });
  await menu.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
  return menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const labels = [...element.querySelectorAll('[role="menuitem"]')]
      .map((item) => item.textContent?.trim());
    return {
      fitsViewport: box.left >= 0 && box.top >= 0 &&
        box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      width: box.width,
      labels,
      focusInside: element.contains(document.activeElement),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectProjectNavigation(page) {
  await page.getByRole("button", { name: "Renderer fixture", exact: true }).waitFor();
  return page.locator(".thread-list").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const groups = [...element.querySelectorAll(".thread-group")];
    const rows = [...element.querySelectorAll(".thread-row")];
    const pinnedRow = element.querySelector('[aria-label="Renderer fixture"]');
    const pinnedIcon = pinnedRow?.querySelector(".thread-pin");
    const paths = [...element.querySelectorAll(".workspace-group-cwd")];
    return {
      groups: groups.length,
      groupsOpen: groups.every((group) => group.open),
      rows: rows.length,
      pinnedVisible: Boolean(pinnedIcon),
      pathsTruncatedOrContained: paths.every((path) => {
        const pathBox = path.getBoundingClientRect();
        return pathBox.left >= box.left && pathBox.right <= box.right &&
          path.scrollWidth >= path.clientWidth;
      }),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectRenameThreadDialog(page) {
  const dialog = page.getByRole("dialog", { name: "Rename thread" });
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Thread name");
  return dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const input = element.querySelector('[aria-label="Thread name"]');
    const buttons = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return {
      fitsViewport: box.left >= 0 && box.top >= 0 &&
        box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      inputFocused: document.activeElement === input,
      boundedInput: input?.maxLength === 200,
      buttonsContained: buttons.every((button) => (
        button.left >= box.left && button.top >= box.top &&
        button.right <= box.right && button.bottom <= box.bottom
      )),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectSkillsDirectory(page) {
  await page.getByText("project-continuity", { exact: true }).waitFor();
  return page.locator(".skills-directory").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const groups = [...element.querySelectorAll(".skills-workspace")];
    const entries = [...element.querySelectorAll(".skill-entry")];
    const paths = [...element.querySelectorAll(".workspace-group-cwd")];
    const text = element.textContent ?? "";
    return {
      groups: groups.length,
      groupsOpen: groups.every((group) => group.open),
      entries: entries.length,
      hasEnabledState: text.includes("Enabled") && text.includes("Disabled"),
      hasScopes: text.includes("repo") && text.includes("user") && text.includes("system"),
      hasBoundedError: /1 skill could not be loaded/i.test(text),
      noSensitiveFields: !/SKILL\.md|dependencies|interface|private/i.test(text),
      contentContained: entries.every((entry) => {
        const entryBox = entry.getBoundingClientRect();
        return entryBox.left >= box.left && entryBox.right <= box.right;
      }) && paths.every((path) => path.getBoundingClientRect().right <= box.right),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectActivityDirectory(page) {
  await page.getByRole("heading", { name: /Needs attention/ }).waitFor();
  await page.getByRole("heading", { name: /Running now/ }).waitFor();
  await page.getByRole("heading", { name: /Recent/ }).waitFor();
  return page.locator(".activity-directory").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll(".activity-entry")];
    const text = element.textContent ?? "";
    return {
      rows: rows.length,
      hasAttention: text.includes("Approval needed"),
      hasRunning: text.includes("Running"),
      hasRecent: text.includes("Updated"),
      contentContained: rows.every((row) => {
        const rowBox = row.getBoundingClientRect();
        return rowBox.left >= box.left && rowBox.right <= box.right;
      }),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectUsageDialog(page) {
  const dialog = page.getByRole("dialog", { name: "Usage and limits" });
  await dialog.waitFor();
  await page.getByText("42% used", { exact: true }).waitFor();
  await page.getByText("Account activity", { exact: true }).waitFor();
  return dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const scroll = element.querySelector(".usage-dialog-scroll");
    const headings = [...element.querySelectorAll(".usage-section > h2")]
      .map((heading) => heading.textContent?.trim());
    const buttons = [...element.querySelectorAll("button")]
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());
    return {
      fitsViewport: box.left >= 0 && box.top >= 0 &&
        box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      sections: headings,
      progressBars: element.querySelectorAll("progress").length,
      hasThreadUsage: (element.textContent ?? "").includes("Thread total"),
      readOnlyActions: buttons.every((label) => label === "Refresh usage" || label === "Close"),
      actionsContained: [...element.querySelectorAll(".usage-dialog-actions button")]
        .every((button) => {
          const buttonBox = button.getBoundingClientRect();
          return buttonBox.left >= box.left && buttonBox.right <= box.right &&
            buttonBox.top >= box.top && buttonBox.bottom <= box.bottom;
        }),
      contentContained: Boolean(scroll && scroll.scrollWidth <= scroll.clientWidth + 1),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectDeleteThreadDialog(page) {
  const dialog = page.getByRole("dialog", { name: "Delete thread permanently?" });
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Cancel");
  return dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    const text = element.textContent ?? "";
    return {
      fitsViewport: box.left >= 0 && box.top >= 0 &&
        box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      buttonsContained: buttons.every((button) => (
        button.left >= box.left && button.top >= box.top &&
        button.right <= box.right && button.bottom <= box.bottom
      )),
      warnsAboutDescendants: /descendant sessions may also be permanently deleted/i.test(text),
      warnsCannotUndo: /cannot be undone/i.test(text),
      cancelFocused: document.activeElement?.textContent?.trim() === "Cancel",
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function addFixtureImage(page) {
  await page.locator('[aria-label="Choose images"]').setInputFiles({
    name: "visual-fixture.png",
    mimeType: "image/png",
    buffer: fixtureImage,
  });
  await page.getByRole("button", { name: "Remove visual-fixture.png" }).waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector(".composer-attachment img");
    return image?.complete && image.naturalWidth > 0;
  });
}

async function inspectComposerImage(page) {
  return page.evaluate(() => {
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    const preview = document.querySelector(".composer-attachment")?.getBoundingClientRect();
    const image = document.querySelector(".composer-attachment img");
    const textarea = document.querySelector(".composer textarea")?.getBoundingClientRect();
    const action = document.querySelector(".composer-action")?.getBoundingClientRect();
    const footer = document.querySelector(".composer-footer")?.getBoundingClientRect();
    const remove = document.querySelector(".composer-attachment-remove")?.getBoundingClientRect();
    const add = document.querySelector(".composer-image-action")?.getBoundingClientRect();
    const overlaps = (first, second) => Boolean(first && second &&
      first.left < second.right && first.right > second.left &&
      first.top < second.bottom && first.bottom > second.top);
    return {
      count: document.querySelectorAll(".composer-attachment").length,
      previewLoaded: image?.tagName === "IMG" && image.complete && image.naturalWidth > 0,
      previewContained: Boolean(composer && preview &&
        preview.left >= composer.left && preview.right <= composer.right &&
        preview.top >= composer.top && preview.bottom <= composer.bottom),
      composerVisible: Boolean(composer && composer.left >= 0 && composer.right <= window.innerWidth &&
        composer.top >= 0 && composer.bottom <= window.innerHeight),
      controlsOverlap: overlaps(preview, textarea) || overlaps(preview, action) ||
        overlaps(preview, footer) || overlaps(textarea, action),
      removeVisible: Boolean(document.querySelector('.composer-attachment-remove')),
      compactControlsUsable: Boolean(remove && add &&
        remove.width >= 32 && remove.height >= 32 && add.width >= 32 && add.height >= 32),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function inspectAttachmentMenu(page, screenshotPath) {
  const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Add attachment", exact: true });
  await menu.waitFor();
  const layout = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const composer = element.closest(".composer")?.getBoundingClientRect();
    const items = [...element.querySelectorAll('[role="menuitem"]')];
    return {
      labels: items.map((item) => item.textContent?.trim()),
      fitsViewport: box.left >= 0 && box.top >= 0 &&
        box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      containedByComposerWidth: Boolean(composer && box.left >= composer.left && box.right <= composer.right),
      usableItems: items.every((item) => {
        const itemBox = item.getBoundingClientRect();
        return itemBox.width >= 100 && itemBox.height >= 32 &&
          itemBox.left >= box.left && itemBox.right <= box.right;
      }),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await trigger.click();
  await menu.waitFor({ state: "hidden" });
  return layout;
}

async function sendAndInspectFixtureImage(page) {
  await addFixtureImage(page);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Remove visual-fixture.png" }).waitFor({ state: "hidden" });
  return inspectSentFixtureImage(page);
}

async function inspectSentFixtureImage(page) {
  const preview = page.getByRole("link", { name: "Open uploaded image 1 of 1" });
  await preview.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector(".message-image-preview img");
    return image?.complete && image.naturalWidth > 0;
  });
  await page.waitForTimeout(100);
  await preview.scrollIntoViewIfNeeded();
  const [openedPage] = await Promise.all([
    page.waitForEvent("popup"),
    preview.click(),
  ]);
  await openedPage.waitForLoadState("domcontentloaded");
  const opened = openedPage.url().startsWith("blob:");
  await openedPage.close();
  const layout = await page.evaluate(() => {
    const link = document.querySelector(".message-image-preview");
    const image = link?.querySelector("img");
    const linkBox = link?.getBoundingClientRect();
    const imageBox = image?.getBoundingClientRect();
    const conversationBox = document.querySelector(".conversation-scroll")?.getBoundingClientRect();
    return {
      count: document.querySelectorAll(".message-image-preview").length,
      loaded: image?.complete && image.naturalWidth > 0,
      openable: link?.tagName === "A" && link.target === "_blank" && link.href.startsWith("blob:"),
      contained: Boolean(linkBox && imageBox && conversationBox &&
        linkBox.left >= conversationBox.left && linkBox.right <= conversationBox.right &&
        linkBox.top >= conversationBox.top && linkBox.bottom <= conversationBox.bottom &&
        imageBox.left >= linkBox.left && imageBox.right <= linkBox.right &&
        imageBox.top >= linkBox.top && imageBox.bottom <= linkBox.bottom),
      dimensionsStable: Boolean(linkBox && linkBox.width > 0 && linkBox.height > 0),
      objectFit: image ? window.getComputedStyle(image).objectFit : null,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  return { ...layout, opened };
}

async function reloadAndInspectFixtureImage(page) {
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor();
  const openThreads = page.getByRole("button", { name: "Open threads" });
  if (await openThreads.isVisible()) await openThreads.click();
  await selectFixture(page);
  return inspectSentFixtureImage(page);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const fixture = await installFixture(page);
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor();
  await page.waitForFunction(() => {
    const value = document.querySelector(".sidebar-footer span:nth-child(2)")?.textContent;
    return value === "connected" || value === "error";
  });

  const desktop = await page.evaluate(() => {
    const toolbar = document.querySelector(".toolbar")?.getBoundingClientRect();
    const composer = document.querySelector(".composer-wrap")?.getBoundingClientRect();
    const textarea = document.querySelector(".composer textarea")?.getBoundingClientRect();
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      toolbarVisible: Boolean(toolbar && toolbar.top >= 0 && toolbar.right <= window.innerWidth),
      toolbarHeight: toolbar?.height ?? 0,
      composerVisible: Boolean(composer && composer.bottom <= window.innerHeight && composer.left >= 0),
      composerTextareaHeight: textarea?.height ?? 0,
      modelSelection: document.querySelector('[aria-label="Model for next turn"]')?.value ?? null,
      effortSelection: document.querySelector('[aria-label="Reasoning effort for next turn"]')?.value ?? null,
      autoRunDisabled: document.querySelector(
        '[aria-label="Auto-run sandboxed actions for next turn"]',
      )?.disabled === true,
      autoRunChecked: document.querySelector(
        '[aria-label="Auto-run sandboxed actions for next turn"]',
      )?.checked === true,
      defaultLabels: [...document.querySelectorAll(".composer-setting option")]
        .filter((option) => option.textContent?.toLowerCase().includes("default")).length,
      connection: document.querySelector(".sidebar-footer span:nth-child(2)")?.textContent,
    };
  });
  await page.screenshot({ path: `${outputDirectory}/desktop.png`, fullPage: true });

  const desktopProjectNavigation = await inspectProjectNavigation(page);
  const desktopThreadRow = page.getByRole("button", { name: "Renderer fixture", exact: true });
  await desktopThreadRow.click({ button: "right" });
  const desktopThreadMenu = await inspectThreadActionMenu(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-thread-menu.png`, fullPage: true });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const desktopRenameDialog = await inspectRenameThreadDialog(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-rename-thread.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await desktopThreadRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const desktopDeleteDialog = await inspectDeleteThreadDialog(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-delete-thread.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "Archived", exact: true }).click();
  const desktopArchivedVisible = await page.getByRole("button", {
    name: "Archived fixture",
    exact: true,
  }).isVisible();
  await page.screenshot({ path: `${outputDirectory}/desktop-archived.png`, fullPage: true });
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  const desktopSkills = await inspectSkillsDirectory(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-skills.png`, fullPage: true });
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const desktopActivity = await inspectActivityDirectory(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-activity.png`, fullPage: true });
  await page.getByRole("tab", { name: "Active", exact: true }).click();

  await selectFixture(page);
  const desktopMessageQueue = await inspectMessageQueueDock(
    page,
    `${outputDirectory}/desktop-message-queue.png`,
  );
  await page.getByRole("button", { name: "Usage and limits", exact: true }).click();
  const desktopUsage = await inspectUsageDialog(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-usage.png`, fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const desktopFileDownload = await inspectFileDownload(
    page,
    {
      confirm: `${outputDirectory}/desktop-file-download-confirm.png`,
      started: `${outputDirectory}/desktop-file-download-started.png`,
      restored: `${outputDirectory}/desktop-file-download-restored.png`,
    },
  );

  const desktopAttachmentMenu = await inspectAttachmentMenu(
    page,
    `${outputDirectory}/desktop-add-menu.png`,
  );
  await addFixtureImage(page);
  const desktopComposerImage = await inspectComposerImage(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-attachment.png`, fullPage: true });
  await page.getByRole("button", { name: "Remove visual-fixture.png" }).click();
  const desktopOneTurnAutoRun = await inspectOneTurnAutoRun(page, {
    dialog: `${outputDirectory}/desktop-new-thread.png`,
    armedDraft: `${outputDirectory}/desktop-first-turn-auto.png`,
  });
  const desktopDialog = desktopOneTurnAutoRun.dialog;
  await page.screenshot({ path: `${outputDirectory}/desktop-readme.png`, fullPage: true });
  const desktopSentImage = await sendAndInspectFixtureImage(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-sent-image.png`, fullPage: true });
  const desktopReloadedImage = await reloadAndInspectFixtureImage(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-reloaded-image.png`, fullPage: true });
  await page.locator(".conversation-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: `${outputDirectory}/desktop-code.png`, fullPage: true });
  await openRichDetails(page);
  await page.locator(".reasoning-block").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${outputDirectory}/desktop-reasoning.png`, fullPage: true });
  await page.locator(".file-change-entry").scrollIntoViewIfNeeded();
  const desktopRich = await inspectRichLayout(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-rich.png`, fullPage: true });
  const desktopActiveReasoning = await inspectActiveReasoning(
    page,
    fixture,
    `${outputDirectory}/desktop-reasoning-active.png`,
  );
  const desktopFailedSubmission = await inspectFailedSubmission(
    page,
    fixture,
    `${outputDirectory}/desktop-failed-submission.png`,
  );
  const desktopActivePlan = await inspectActivePlanDock(
    page,
    fixture,
    `${outputDirectory}/desktop-plan`,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor();
  const mobileBefore = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    sidebarHidden: !document.querySelector(".sidebar")?.classList.contains("sidebar--open"),
    toolbarVisible: [...document.querySelectorAll(".toolbar, .toolbar-actions")].every((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    }),
    toolbarHeight: document.querySelector(".toolbar")?.getBoundingClientRect().height ?? 0,
    composerTextareaHeight: document.querySelector(".composer textarea")?.getBoundingClientRect().height ?? 0,
    modelSelection: document.querySelector('[aria-label="Model for next turn"]')?.value ?? null,
    effortSelection: document.querySelector('[aria-label="Reasoning effort for next turn"]')?.value ?? null,
    autoRunDisabled: document.querySelector(
      '[aria-label="Auto-run sandboxed actions for next turn"]',
    )?.disabled === true,
    autoRunChecked: document.querySelector(
      '[aria-label="Auto-run sandboxed actions for next turn"]',
    )?.checked === true,
    defaultLabels: [...document.querySelectorAll(".composer-setting option")]
      .filter((option) => option.textContent?.toLowerCase().includes("default")).length,
    composerSettingsVisible: [...document.querySelectorAll(".composer-setting")].every((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    }),
  }));
  await page.screenshot({ path: `${outputDirectory}/mobile.png`, fullPage: true });
  const mobileAttachmentMenu = await inspectAttachmentMenu(
    page,
    `${outputDirectory}/mobile-add-menu.png`,
  );
  await addFixtureImage(page);
  const mobileComposerImage = await inspectComposerImage(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-attachment.png`, fullPage: true });
  await page.getByRole("button", { name: "Remove visual-fixture.png" }).click();
  await page.getByRole("button", { name: "Thread settings", exact: true }).click();
  const mobileDialog = await inspectThreadDialog(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-new-thread.png`, fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open threads" }).click();
  await page.waitForTimeout(250);
  const sidebarBox = await page.locator(".sidebar--open").boundingBox();
  const mobileProjectNavigation = await inspectProjectNavigation(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-sidebar.png`, fullPage: true });
  const mobileMoreButtonVisible = await page.getByRole("button", {
    name: "More actions for Renderer fixture",
    exact: true,
  }).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && Number(style.opacity) > 0 &&
      box.width >= 28 && box.height >= 28;
  });
  const mobileThreadRow = page.getByRole("button", { name: "Renderer fixture", exact: true });
  const mobileThreadRowBox = await mobileThreadRow.boundingBox();
  if (!mobileThreadRowBox) throw new Error("The mobile thread row is not visible");
  const mobilePointer = {
    pointerId: 7,
    pointerType: "touch",
    button: 0,
    clientX: mobileThreadRowBox.x + 24,
    clientY: mobileThreadRowBox.y + 22,
  };
  await mobileThreadRow.dispatchEvent("pointerdown", mobilePointer);
  await page.waitForTimeout(600);
  const mobileThreadMenu = await inspectThreadActionMenu(page);
  await mobileThreadRow.dispatchEvent("pointerup", mobilePointer);
  await page.screenshot({ path: `${outputDirectory}/mobile-thread-menu.png`, fullPage: true });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const mobileDeleteDialog = await inspectDeleteThreadDialog(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-delete-thread.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  const mobileSkills = await inspectSkillsDirectory(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-skills.png`, fullPage: true });
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const mobileActivity = await inspectActivityDirectory(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-activity.png`, fullPage: true });
  await page.getByRole("tab", { name: "Active", exact: true }).click();
  await page.waitForTimeout(850);
  await selectFixture(page);
  const mobileMessageQueue = await inspectMessageQueueDock(
    page,
    `${outputDirectory}/mobile-message-queue.png`,
  );
  await page.getByRole("button", { name: "Usage and limits", exact: true }).click();
  const mobileUsage = await inspectUsageDialog(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-usage.png`, fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const mobileFileDownload = await inspectFileDownload(
    page,
    {
      confirm: `${outputDirectory}/mobile-file-download-confirm.png`,
      started: `${outputDirectory}/mobile-file-download-started.png`,
      restored: `${outputDirectory}/mobile-file-download-restored.png`,
    },
  );
  const mobileSentImage = await sendAndInspectFixtureImage(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-sent-image.png`, fullPage: true });
  const mobileReloadedImage = await reloadAndInspectFixtureImage(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-reloaded-image.png`, fullPage: true });
  await openRichDetails(page);
  await page.locator(".reasoning-block").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${outputDirectory}/mobile-reasoning.png`, fullPage: true });
  await page.locator(".file-change-entry").scrollIntoViewIfNeeded();
  const mobileRich = await inspectRichLayout(page);
  const splitActionHidden = await page.locator(".diff-split-action").first().evaluate((element) => (
    window.getComputedStyle(element).display === "none"
  ));
  await page.screenshot({ path: `${outputDirectory}/mobile-rich.png`, fullPage: true });
  const mobileActiveReasoning = await inspectActiveReasoning(
    page,
    fixture,
    `${outputDirectory}/mobile-reasoning-active.png`,
  );
  const mobileFailedSubmission = await inspectFailedSubmission(
    page,
    fixture,
    `${outputDirectory}/mobile-failed-submission.png`,
  );
  const mobileActivePlan = await inspectActivePlanDock(
    page,
    fixture,
    `${outputDirectory}/mobile-plan`,
  );
  const mobileOneTurnAutoRun = await inspectOneTurnAutoRun(page, {
    dialog: `${outputDirectory}/mobile-first-turn-dialog.png`,
    armedDraft: `${outputDirectory}/mobile-first-turn-auto.png`,
  });

  const result = {
    desktop: {
      ...desktop,
      attachmentMenu: desktopAttachmentMenu,
      composerImage: desktopComposerImage,
      sentImage: desktopSentImage,
      reloadedImage: desktopReloadedImage,
      dialog: desktopDialog,
      projectNavigation: desktopProjectNavigation,
      threadMenu: desktopThreadMenu,
      renameThreadDialog: desktopRenameDialog,
      deleteThreadDialog: desktopDeleteDialog,
      archivedVisible: desktopArchivedVisible,
      skills: desktopSkills,
      activity: desktopActivity,
      messageQueue: desktopMessageQueue,
      usage: desktopUsage,
      fileDownload: desktopFileDownload,
      rich: desktopRich,
      activeReasoning: desktopActiveReasoning,
      failedSubmission: desktopFailedSubmission,
      activePlan: desktopActivePlan,
      oneTurnAutoRun: desktopOneTurnAutoRun,
    },
    mobile: {
      ...mobileBefore,
      attachmentMenu: mobileAttachmentMenu,
      composerImage: mobileComposerImage,
      sentImage: mobileSentImage,
      reloadedImage: mobileReloadedImage,
      dialog: mobileDialog,
      projectNavigation: mobileProjectNavigation,
      threadMenu: mobileThreadMenu,
      deleteThreadDialog: mobileDeleteDialog,
      skills: mobileSkills,
      activity: mobileActivity,
      messageQueue: mobileMessageQueue,
      usage: mobileUsage,
      fileDownload: mobileFileDownload,
      moreButtonVisible: mobileMoreButtonVisible,
      sidebarVisible: Boolean(sidebarBox && sidebarBox.x >= 0 && sidebarBox.width <= 390),
      rich: mobileRich,
      activeReasoning: mobileActiveReasoning,
      failedSubmission: mobileFailedSubmission,
      activePlan: mobileActivePlan,
      oneTurnAutoRun: mobileOneTurnAutoRun,
      splitActionHidden,
    },
    consoleErrors,
    pageErrors,
    screenshots: outputDirectory,
  };

  console.log(JSON.stringify(result, null, 2));
  if (
    desktop.horizontalOverflow ||
    !desktop.toolbarVisible ||
    desktop.toolbarHeight > 46 ||
    !desktop.composerVisible ||
    desktop.composerTextareaHeight > 34 ||
    desktop.modelSelection !== "gpt-5-codex" ||
    desktop.effortSelection !== "high" ||
    !desktop.autoRunDisabled ||
    desktop.autoRunChecked ||
    desktop.defaultLabels > 0 ||
    oneTurnAutoRunInvalid(desktopOneTurnAutoRun) ||
    desktopComposerImage.count !== 1 ||
    !desktopComposerImage.previewLoaded ||
    !desktopComposerImage.previewContained ||
    !desktopComposerImage.composerVisible ||
    desktopComposerImage.controlsOverlap ||
    !desktopComposerImage.removeVisible ||
    !desktopComposerImage.compactControlsUsable ||
    desktopComposerImage.horizontalOverflow ||
    desktopSentImage.count !== 1 ||
    !desktopSentImage.loaded ||
    !desktopSentImage.openable ||
    !desktopSentImage.opened ||
    !desktopSentImage.contained ||
    !desktopSentImage.dimensionsStable ||
    desktopSentImage.objectFit !== "contain" ||
    desktopSentImage.horizontalOverflow ||
    desktopReloadedImage.count !== 1 ||
    !desktopReloadedImage.loaded ||
    !desktopReloadedImage.openable ||
    !desktopReloadedImage.opened ||
    !desktopReloadedImage.contained ||
    !desktopReloadedImage.dimensionsStable ||
    desktopReloadedImage.objectFit !== "contain" ||
    desktopReloadedImage.horizontalOverflow ||
    desktop.connection === "error" ||
    !desktopDialog.fitsViewport ||
    !desktopDialog.cwdEditable ||
    !desktopDialog.sandboxEnabled ||
    desktopDialog.sandbox !== "workspace-write" ||
    desktopProjectNavigation.groups < 2 ||
    !desktopProjectNavigation.groupsOpen ||
    desktopProjectNavigation.rows < 3 ||
    !desktopProjectNavigation.pinnedVisible ||
    !desktopProjectNavigation.pathsTruncatedOrContained ||
    desktopProjectNavigation.horizontalOverflow ||
    !desktopThreadMenu.fitsViewport ||
    desktopThreadMenu.width > 200 ||
    desktopThreadMenu.labels.join(",") !== "Rename,Unpin,Fork,Archive,Delete" ||
    !desktopThreadMenu.focusInside ||
    desktopThreadMenu.horizontalOverflow ||
    !desktopRenameDialog.fitsViewport ||
    !desktopRenameDialog.inputFocused ||
    !desktopRenameDialog.boundedInput ||
    !desktopRenameDialog.buttonsContained ||
    desktopRenameDialog.horizontalOverflow ||
    !desktopDeleteDialog.fitsViewport ||
    !desktopDeleteDialog.buttonsContained ||
    !desktopDeleteDialog.warnsAboutDescendants ||
    !desktopDeleteDialog.warnsCannotUndo ||
    !desktopDeleteDialog.cancelFocused ||
    desktopDeleteDialog.horizontalOverflow ||
    !desktopArchivedVisible ||
    desktopSkills.groups < 2 ||
    !desktopSkills.groupsOpen ||
    desktopSkills.entries < 3 ||
    !desktopSkills.hasEnabledState ||
    !desktopSkills.hasScopes ||
    !desktopSkills.hasBoundedError ||
    !desktopSkills.noSensitiveFields ||
    !desktopSkills.contentContained ||
    desktopSkills.horizontalOverflow ||
    desktopActivity.rows < 3 ||
    !desktopActivity.hasAttention ||
    !desktopActivity.hasRunning ||
    !desktopActivity.hasRecent ||
    !desktopActivity.contentContained ||
    desktopActivity.horizontalOverflow ||
    !desktopMessageQueue.expanded.fitsViewport ||
    !desktopMessageQueue.expanded.composerVisible ||
    !desktopMessageQueue.expanded.bodyScrollableWhenNeeded ||
    desktopMessageQueue.expanded.rows !== 2 ||
    !desktopMessageQueue.expanded.actionsUsable ||
    desktopMessageQueue.expanded.statusText.join(",") !== "Queued,Context changed" ||
    !desktopMessageQueue.expanded.textContained ||
    desktopMessageQueue.expanded.horizontalOverflow ||
    !desktopMessageQueue.collapsed.bodyHidden ||
    !desktopMessageQueue.collapsed.summaryCollapsed ||
    !desktopMessageQueue.collapsed.composerVisible ||
    desktopMessageQueue.collapsed.horizontalOverflow ||
    !desktopUsage.fitsViewport ||
    desktopUsage.sections.join(",") !== "Current thread,Rate limits,Account activity" ||
    desktopUsage.progressBars < 3 ||
    !desktopUsage.hasThreadUsage ||
    !desktopUsage.readOnlyActions ||
    !desktopUsage.actionsContained ||
    !desktopUsage.contentContained ||
    desktopUsage.horizontalOverflow ||
    !desktopFileDownload.initialVisible ||
    !desktopFileDownload.stableConfirmationWidth ||
    !desktopFileDownload.stableRestoredWidth ||
    desktopFileDownload.suggestedFilename !== "progress.md" ||
    !desktopFileDownload.confirmation.contained ||
    !desktopFileDownload.confirmation.confirmFocused ||
    desktopFileDownload.confirmation.controls.some((control) => (
      !control.contained || control.width < 27 || control.height < 27
    )) ||
    desktopFileDownload.confirmation.horizontalOverflow ||
    !desktopFileDownload.startedFeedback.ariaDisabled ||
    !desktopFileDownload.startedFeedback.hasCheck ||
    !desktopFileDownload.startedFeedback.focused ||
    desktopFileDownload.startedFeedback.label !== "Download started" ||
    desktopFileDownload.startedFeedback.horizontalOverflow ||
    !desktopFileDownload.completion.ariaDisabled ||
    !desktopFileDownload.completion.hasCheck ||
    !desktopFileDownload.completion.focused ||
    desktopFileDownload.completion.label !== "progress.md" ||
    !desktopFileDownload.completion.feedbackRemoved ||
    desktopFileDownload.completion.horizontalOverflow ||
    desktopAttachmentMenu.labels.join(",") !== "Add images,Add files" ||
    !desktopAttachmentMenu.fitsViewport ||
    !desktopAttachmentMenu.containedByComposerWidth ||
    !desktopAttachmentMenu.usableItems ||
    desktopAttachmentMenu.horizontalOverflow ||
    mobileBefore.horizontalOverflow ||
    !mobileBefore.sidebarHidden ||
    !mobileBefore.toolbarVisible ||
    mobileBefore.toolbarHeight > 46 ||
    mobileBefore.composerTextareaHeight > 34 ||
    mobileBefore.modelSelection !== "gpt-5-codex" ||
    mobileBefore.effortSelection !== "high" ||
    !mobileBefore.autoRunDisabled ||
    mobileBefore.autoRunChecked ||
    mobileBefore.defaultLabels > 0 ||
    !mobileBefore.composerSettingsVisible ||
    oneTurnAutoRunInvalid(mobileOneTurnAutoRun) ||
    mobileComposerImage.count !== 1 ||
    !mobileComposerImage.previewLoaded ||
    !mobileComposerImage.previewContained ||
    !mobileComposerImage.composerVisible ||
    mobileComposerImage.controlsOverlap ||
    !mobileComposerImage.removeVisible ||
    !mobileComposerImage.compactControlsUsable ||
    mobileComposerImage.horizontalOverflow ||
    mobileSentImage.count !== 1 ||
    !mobileSentImage.loaded ||
    !mobileSentImage.openable ||
    !mobileSentImage.opened ||
    !mobileSentImage.contained ||
    !mobileSentImage.dimensionsStable ||
    mobileSentImage.objectFit !== "contain" ||
    mobileSentImage.horizontalOverflow ||
    mobileReloadedImage.count !== 1 ||
    !mobileReloadedImage.loaded ||
    !mobileReloadedImage.openable ||
    !mobileReloadedImage.opened ||
    !mobileReloadedImage.contained ||
    !mobileReloadedImage.dimensionsStable ||
    mobileReloadedImage.objectFit !== "contain" ||
    mobileReloadedImage.horizontalOverflow ||
    !mobileDialog.fitsViewport ||
    !mobileDialog.cwdEditable ||
    !mobileDialog.sandboxEnabled ||
    mobileDialog.sandbox !== "workspace-write" ||
    mobileProjectNavigation.groups < 2 ||
    !mobileProjectNavigation.groupsOpen ||
    mobileProjectNavigation.rows < 3 ||
    !mobileProjectNavigation.pinnedVisible ||
    !mobileProjectNavigation.pathsTruncatedOrContained ||
    mobileProjectNavigation.horizontalOverflow ||
    !mobileThreadMenu.fitsViewport ||
    mobileThreadMenu.width > 200 ||
    mobileThreadMenu.labels.join(",") !== "Rename,Unpin,Fork,Archive,Delete" ||
    !mobileThreadMenu.focusInside ||
    mobileThreadMenu.horizontalOverflow ||
    !mobileDeleteDialog.fitsViewport ||
    !mobileDeleteDialog.buttonsContained ||
    !mobileDeleteDialog.warnsAboutDescendants ||
    !mobileDeleteDialog.warnsCannotUndo ||
    !mobileDeleteDialog.cancelFocused ||
    mobileDeleteDialog.horizontalOverflow ||
    mobileSkills.groups < 2 ||
    !mobileSkills.groupsOpen ||
    mobileSkills.entries < 3 ||
    !mobileSkills.hasEnabledState ||
    !mobileSkills.hasScopes ||
    !mobileSkills.hasBoundedError ||
    !mobileSkills.noSensitiveFields ||
    !mobileSkills.contentContained ||
    mobileSkills.horizontalOverflow ||
    mobileActivity.rows < 3 ||
    !mobileActivity.hasAttention ||
    !mobileActivity.hasRunning ||
    !mobileActivity.hasRecent ||
    !mobileActivity.contentContained ||
    mobileActivity.horizontalOverflow ||
    !mobileMessageQueue.expanded.fitsViewport ||
    !mobileMessageQueue.expanded.composerVisible ||
    !mobileMessageQueue.expanded.bodyScrollableWhenNeeded ||
    mobileMessageQueue.expanded.rows !== 2 ||
    !mobileMessageQueue.expanded.actionsUsable ||
    mobileMessageQueue.expanded.statusText.join(",") !== "Queued,Context changed" ||
    !mobileMessageQueue.expanded.textContained ||
    mobileMessageQueue.expanded.horizontalOverflow ||
    !mobileMessageQueue.collapsed.bodyHidden ||
    !mobileMessageQueue.collapsed.summaryCollapsed ||
    !mobileMessageQueue.collapsed.composerVisible ||
    mobileMessageQueue.collapsed.horizontalOverflow ||
    !mobileUsage.fitsViewport ||
    mobileUsage.sections.join(",") !== "Current thread,Rate limits,Account activity" ||
    mobileUsage.progressBars < 3 ||
    !mobileUsage.hasThreadUsage ||
    !mobileUsage.readOnlyActions ||
    !mobileUsage.actionsContained ||
    !mobileUsage.contentContained ||
    mobileUsage.horizontalOverflow ||
    !mobileFileDownload.initialVisible ||
    !mobileFileDownload.stableConfirmationWidth ||
    !mobileFileDownload.stableRestoredWidth ||
    mobileFileDownload.suggestedFilename !== "progress.md" ||
    !mobileFileDownload.confirmation.contained ||
    !mobileFileDownload.confirmation.confirmFocused ||
    mobileFileDownload.confirmation.controls.some((control) => (
      !control.contained || control.width < 27 || control.height < 27
    )) ||
    mobileFileDownload.confirmation.horizontalOverflow ||
    !mobileFileDownload.startedFeedback.ariaDisabled ||
    !mobileFileDownload.startedFeedback.hasCheck ||
    !mobileFileDownload.startedFeedback.focused ||
    mobileFileDownload.startedFeedback.label !== "Download started" ||
    mobileFileDownload.startedFeedback.horizontalOverflow ||
    !mobileFileDownload.completion.ariaDisabled ||
    !mobileFileDownload.completion.hasCheck ||
    !mobileFileDownload.completion.focused ||
    mobileFileDownload.completion.label !== "progress.md" ||
    !mobileFileDownload.completion.feedbackRemoved ||
    mobileFileDownload.completion.horizontalOverflow ||
    mobileAttachmentMenu.labels.join(",") !== "Add images,Add files" ||
    !mobileAttachmentMenu.fitsViewport ||
    !mobileAttachmentMenu.containedByComposerWidth ||
    !mobileAttachmentMenu.usableItems ||
    mobileAttachmentMenu.horizontalOverflow ||
    !mobileMoreButtonVisible ||
    !result.mobile.sidebarVisible ||
    desktopRich.horizontalOverflow ||
    desktopRich.clipped.length > 0 ||
    desktopRich.codeBlocks === 0 ||
    desktopRich.diffViewers === 0 ||
    desktopRich.reasoningBlocks !== 1 ||
    desktopRich.reasoningEntries !== 2 ||
    desktopRich.groupedReasoningLabels !== 1 ||
    desktopRich.commands === 0 ||
    desktopRich.activityGroups === 0 ||
    desktopRich.activityStacks === 0 ||
    desktopRich.stackedActivityRuns === 0 ||
    desktopRich.activityStackGapViolations > 0 ||
    desktopRich.activityStackDividerViolations > 0 ||
    desktopRich.formalActivityLabels.join(",") !== "Spawn agent,Agent started,Viewed image" ||
    desktopRich.hiddenActivitySummaries > 0 ||
    desktopRich.reasonBlocks === 0 ||
    desktopRich.scrollingToolOutputs === 0 ||
    desktopRich.toolOutputTruncations === 0 ||
    desktopRich.turnFooters < 2 ||
    desktopRich.turnMetadata < 2 ||
    desktopRich.overlappingTurnFooterContent > 0 ||
    desktopRich.fileCards !== 1 ||
    !desktopRich.fileCardsContained ||
    desktopRich.unavailableFileCards !== 1 ||
    !desktopActiveReasoning.fitsViewport ||
    !desktopActiveReasoning.nonExpandable ||
    desktopActiveReasoning.spinnerAnimation !== "spin" ||
    desktopActiveReasoning.idleSpinnerAnimation !== "none" ||
    !desktopActiveReasoning.sameSlot ||
    !desktopActiveReasoning.sameLine ||
    !desktopActiveReasoning.sameSpinner ||
    !desktopActiveReasoning.sameLabel ||
    !desktopActiveReasoning.stableHeight ||
    !desktopActiveReasoning.stablePosition ||
    !desktopActiveReasoning.emptyReasoningHidden ||
    !desktopActiveReasoning.completedSameSlot ||
    !desktopActiveReasoning.completedHasMetadata ||
    !desktopActiveReasoning.completedReasoningHidden ||
    !desktopFailedSubmission.actionsUsable ||
    !desktopFailedSubmission.fitsViewport ||
    !desktopFailedSubmission.sendDisabled ||
    !desktopFailedSubmission.textareaEditable ||
    desktopFailedSubmission.toastOverlap ||
    !desktopActivePlan.collapsed.complete ||
    !desktopActivePlan.collapsed.correctOrder ||
    !desktopActivePlan.collapsed.composerVisible ||
    !desktopActivePlan.collapsed.fitsViewport ||
    desktopActivePlan.collapsed.horizontalOverflow ||
    !["static", "relative"].includes(desktopActivePlan.collapsed.position) ||
    desktopActivePlan.collapsed.summaryHeight < 44 ||
    !desktopActivePlan.collapsed.summaryCollapsed ||
    !desktopActivePlan.collapsed.currentTruncated ||
    !desktopActivePlan.collapsed.noOverlap ||
    !desktopActivePlan.expanded.complete ||
    !desktopActivePlan.expanded.bodyScrollable ||
    !["auto", "scroll"].includes(desktopActivePlan.expanded.bodyOverflow) ||
    !desktopActivePlan.expanded.composerVisible ||
    !desktopActivePlan.expanded.fitsViewport ||
    desktopActivePlan.expanded.horizontalOverflow ||
    !desktopActivePlan.expanded.noOverlap ||
    !desktopActivePlan.expanded.summaryExpanded ||
    !desktopActivePlan.terminal.complete ||
    !desktopActivePlan.terminal.noticeVisible ||
    !desktopActivePlan.terminal.noticeContained ||
    !desktopActivePlan.terminal.spinnerStopped ||
    desktopActivePlan.terminal.horizontalOverflow ||
    !desktopActivePlan.dismissed ||
    mobileRich.horizontalOverflow ||
    mobileRich.clipped.length > 0 ||
    mobileRich.reasoningBlocks !== 1 ||
    mobileRich.reasoningEntries !== 2 ||
    mobileRich.groupedReasoningLabels !== 1 ||
    mobileRich.activityStacks === 0 ||
    mobileRich.stackedActivityRuns === 0 ||
    mobileRich.activityStackGapViolations > 0 ||
    mobileRich.activityStackDividerViolations > 0 ||
    mobileRich.formalActivityLabels.join(",") !== "Spawn agent,Agent started,Viewed image" ||
    mobileRich.hiddenActivitySummaries > 0 ||
    mobileRich.scrollingToolOutputs === 0 ||
    mobileRich.toolOutputTruncations === 0 ||
    mobileRich.turnFooters < 2 ||
    mobileRich.turnMetadata < 2 ||
    mobileRich.overlappingTurnFooterContent > 0 ||
    mobileRich.fileCards !== 1 ||
    !mobileRich.fileCardsContained ||
    mobileRich.unavailableFileCards !== 1 ||
    !mobileActiveReasoning.fitsViewport ||
    !mobileActiveReasoning.nonExpandable ||
    mobileActiveReasoning.spinnerAnimation !== "spin" ||
    mobileActiveReasoning.idleSpinnerAnimation !== "none" ||
    !mobileActiveReasoning.sameSlot ||
    !mobileActiveReasoning.sameLine ||
    !mobileActiveReasoning.sameSpinner ||
    !mobileActiveReasoning.sameLabel ||
    !mobileActiveReasoning.stableHeight ||
    !mobileActiveReasoning.stablePosition ||
    !mobileActiveReasoning.emptyReasoningHidden ||
    !mobileActiveReasoning.completedSameSlot ||
    !mobileActiveReasoning.completedHasMetadata ||
    !mobileActiveReasoning.completedReasoningHidden ||
    !mobileFailedSubmission.actionsUsable ||
    !mobileFailedSubmission.fitsViewport ||
    !mobileFailedSubmission.sendDisabled ||
    !mobileFailedSubmission.textareaEditable ||
    mobileFailedSubmission.toastOverlap ||
    !mobileActivePlan.collapsed.complete ||
    !mobileActivePlan.collapsed.correctOrder ||
    !mobileActivePlan.collapsed.composerVisible ||
    !mobileActivePlan.collapsed.fitsViewport ||
    mobileActivePlan.collapsed.horizontalOverflow ||
    !["static", "relative"].includes(mobileActivePlan.collapsed.position) ||
    mobileActivePlan.collapsed.summaryHeight < 44 ||
    !mobileActivePlan.collapsed.summaryCollapsed ||
    !mobileActivePlan.collapsed.currentTruncated ||
    !mobileActivePlan.collapsed.noOverlap ||
    !mobileActivePlan.expanded.complete ||
    !mobileActivePlan.expanded.bodyScrollable ||
    !["auto", "scroll"].includes(mobileActivePlan.expanded.bodyOverflow) ||
    !mobileActivePlan.expanded.composerVisible ||
    !mobileActivePlan.expanded.fitsViewport ||
    mobileActivePlan.expanded.horizontalOverflow ||
    !mobileActivePlan.expanded.noOverlap ||
    !mobileActivePlan.expanded.summaryExpanded ||
    !mobileActivePlan.terminal.complete ||
    !mobileActivePlan.terminal.noticeVisible ||
    !mobileActivePlan.terminal.noticeContained ||
    !mobileActivePlan.terminal.spinnerStopped ||
    mobileActivePlan.terminal.horizontalOverflow ||
    !mobileActivePlan.dismissed ||
    !splitActionHidden ||
    consoleErrors.length > 0 ||
    pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
