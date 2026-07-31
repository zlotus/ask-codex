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
        id: "agent-finish",
        type: "agentMessage",
        status: "completed",
        text: "The bounded renderer is in place. Manual approval remains enforced at the gateway.",
      },
    ],
    diff: `diff --git a/src/client.ts b/src/client.ts\n--- a/src/client.ts\n+++ b/src/client.ts\n${filePatch}`,
  },
  {
    id: "turn-older",
    status: "completed",
    items: [
      {
        id: "user",
        type: "userMessage",
        text: "Add a compact renderer with copy, wrapping, and safe large-output handling.",
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
          data: message.params?.archived ? [fixtureArchivedThread] : [fixtureThread],
          nextCursor: null,
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

async function selectFixture(page) {
  await page.getByRole("button", { name: "Renderer fixture", exact: true }).click();
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

async function inspectRichLayout(page) {
  return page.evaluate(() => {
    const selectors = [".reasoning-block", ".code-block", ".diff-viewer", ".command-block", ".activity-group"];
    const clipped = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.left < 0 || box.right > window.innerWidth + 1;
      })
      .map((element) => element.className);
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
      hiddenActivitySummaries: [...document.querySelectorAll(".command-summary")].filter((element) => {
        const box = element.getBoundingClientRect();
        return window.getComputedStyle(element).display === "none" || box.width === 0 || box.height === 0;
      }).length,
      reasonBlocks: document.querySelectorAll(".tool-reasons").length,
      scrollingToolOutputs: [...document.querySelectorAll(".tool-activity .code-block-content")]
        .filter((element) => element.scrollHeight > element.clientHeight).length,
      toolOutputTruncations: document.querySelectorAll(".tool-activity .code-block-truncation").length,
    };
  });
}

async function inspectActiveReasoning(page, fixture, screenshotPath) {
  const item = { id: "reasoning-live", type: "reasoning", summary: [], content: [] };
  fixture.notify("item/started", {
    threadId: fixtureThread.id,
    turnId: "turn-newest",
    item,
  });
  const status = page.getByRole("status", { name: "Reasoning in progress" });
  await status.waitFor();
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const result = await status.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const spinner = element.querySelector(".reasoning-spinner");
    return {
      fitsViewport: box.left >= 0 && box.right <= window.innerWidth,
      nonExpandable: element.tagName === "DIV" && !element.querySelector("summary"),
      spinnerAnimation: spinner ? window.getComputedStyle(spinner).animationName : null,
    };
  });
  fixture.notify("item/completed", {
    threadId: fixtureThread.id,
    turnId: "turn-newest",
    item,
  });
  await status.waitFor({ state: "hidden" });
  return result;
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
  fixture.notify("serverRequest/resolved", { requestId });
  await approval.waitFor({ state: "hidden" });
  return { collapsed, expanded, dismissed: true };
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
      defaultLabels: [...document.querySelectorAll(".composer-setting option")]
        .filter((option) => option.textContent?.toLowerCase().includes("default")).length,
      connection: document.querySelector(".sidebar-footer span:nth-child(2)")?.textContent,
    };
  });
  await page.screenshot({ path: `${outputDirectory}/desktop.png`, fullPage: true });

  const desktopThreadRow = page.getByRole("button", { name: "Renderer fixture", exact: true });
  await desktopThreadRow.click({ button: "right" });
  const desktopThreadMenu = await inspectThreadActionMenu(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-thread-menu.png`, fullPage: true });
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
  await page.getByRole("tab", { name: "Active", exact: true }).click();

  await addFixtureImage(page);
  const desktopComposerImage = await inspectComposerImage(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-attachment.png`, fullPage: true });
  await page.getByRole("button", { name: "Remove visual-fixture.png" }).click();
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  const desktopDialog = await inspectThreadDialog(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-new-thread.png`, fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await selectFixture(page);
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
    defaultLabels: [...document.querySelectorAll(".composer-setting option")]
      .filter((option) => option.textContent?.toLowerCase().includes("default")).length,
    composerSettingsVisible: [...document.querySelectorAll(".composer-setting")].every((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    }),
  }));
  await page.screenshot({ path: `${outputDirectory}/mobile.png`, fullPage: true });
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
  await page.waitForTimeout(850);
  await selectFixture(page);
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

  const result = {
    desktop: {
      ...desktop,
      composerImage: desktopComposerImage,
      sentImage: desktopSentImage,
      reloadedImage: desktopReloadedImage,
      dialog: desktopDialog,
      threadMenu: desktopThreadMenu,
      deleteThreadDialog: desktopDeleteDialog,
      archivedVisible: desktopArchivedVisible,
      rich: desktopRich,
      activeReasoning: desktopActiveReasoning,
      failedSubmission: desktopFailedSubmission,
      activePlan: desktopActivePlan,
    },
    mobile: {
      ...mobileBefore,
      composerImage: mobileComposerImage,
      sentImage: mobileSentImage,
      reloadedImage: mobileReloadedImage,
      dialog: mobileDialog,
      threadMenu: mobileThreadMenu,
      deleteThreadDialog: mobileDeleteDialog,
      moreButtonVisible: mobileMoreButtonVisible,
      sidebarVisible: Boolean(sidebarBox && sidebarBox.x >= 0 && sidebarBox.width <= 390),
      rich: mobileRich,
      activeReasoning: mobileActiveReasoning,
      failedSubmission: mobileFailedSubmission,
      activePlan: mobileActivePlan,
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
    desktop.defaultLabels > 0 ||
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
    !desktopThreadMenu.fitsViewport ||
    desktopThreadMenu.width > 200 ||
    desktopThreadMenu.labels.join(",") !== "Archive,Delete" ||
    !desktopThreadMenu.focusInside ||
    desktopThreadMenu.horizontalOverflow ||
    !desktopDeleteDialog.fitsViewport ||
    !desktopDeleteDialog.buttonsContained ||
    !desktopDeleteDialog.warnsAboutDescendants ||
    !desktopDeleteDialog.warnsCannotUndo ||
    !desktopDeleteDialog.cancelFocused ||
    desktopDeleteDialog.horizontalOverflow ||
    !desktopArchivedVisible ||
    mobileBefore.horizontalOverflow ||
    !mobileBefore.sidebarHidden ||
    !mobileBefore.toolbarVisible ||
    mobileBefore.toolbarHeight > 46 ||
    mobileBefore.composerTextareaHeight > 34 ||
    mobileBefore.modelSelection !== "gpt-5-codex" ||
    mobileBefore.effortSelection !== "high" ||
    mobileBefore.defaultLabels > 0 ||
    !mobileBefore.composerSettingsVisible ||
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
    !mobileThreadMenu.fitsViewport ||
    mobileThreadMenu.width > 200 ||
    mobileThreadMenu.labels.join(",") !== "Archive,Delete" ||
    !mobileThreadMenu.focusInside ||
    mobileThreadMenu.horizontalOverflow ||
    !mobileDeleteDialog.fitsViewport ||
    !mobileDeleteDialog.buttonsContained ||
    !mobileDeleteDialog.warnsAboutDescendants ||
    !mobileDeleteDialog.warnsCannotUndo ||
    !mobileDeleteDialog.cancelFocused ||
    mobileDeleteDialog.horizontalOverflow ||
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
    desktopRich.hiddenActivitySummaries > 0 ||
    desktopRich.reasonBlocks === 0 ||
    desktopRich.scrollingToolOutputs === 0 ||
    desktopRich.toolOutputTruncations === 0 ||
    !desktopActiveReasoning.fitsViewport ||
    !desktopActiveReasoning.nonExpandable ||
    desktopActiveReasoning.spinnerAnimation !== "spin" ||
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
    !desktopActivePlan.dismissed ||
    mobileRich.horizontalOverflow ||
    mobileRich.clipped.length > 0 ||
    mobileRich.reasoningBlocks !== 1 ||
    mobileRich.reasoningEntries !== 2 ||
    mobileRich.groupedReasoningLabels !== 1 ||
    mobileRich.hiddenActivitySummaries > 0 ||
    mobileRich.scrollingToolOutputs === 0 ||
    mobileRich.toolOutputTruncations === 0 ||
    !mobileActiveReasoning.fitsViewport ||
    !mobileActiveReasoning.nonExpandable ||
    mobileActiveReasoning.spinnerAnimation !== "spin" ||
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
