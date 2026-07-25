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

async function installFixture(page) {
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
    globalThis.setTimeout(() => socket.send(JSON.stringify({
      type: "status",
      status: "ready",
      defaultCwd: "/workspace/ask-codex",
      version: "codex-cli/visual-fixture",
    })), 0);
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "rpc") return;
      let result = {};
      if (message.method === "thread/list") {
        result = { data: [fixtureThread], nextCursor: null };
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
            data: fixtureTurns,
            nextCursor: "older-page",
            backwardsCursor: null,
          },
        };
      } else if (message.method === "thread/turns/list") {
        result = { data: [], nextCursor: null, backwardsCursor: null };
      } else if (message.method === "turn/start") {
        result = {
          turn: {
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
          },
        };
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
}

async function selectFixture(page) {
  await page.getByRole("button", { name: /Renderer fixture/ }).click();
  await page.getByText("The bounded renderer is in place.", { exact: false }).waitFor();
  await page.waitForTimeout(250);
}

async function openRichDetails(page) {
  for (const selector of [".activity-group", ".tool-activity", ".inline-details, .turn-diff"]) {
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
    const selectors = [".code-block", ".diff-viewer", ".command-block", ".activity-group"];
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

async function addFixtureImage(page) {
  await page.locator('[aria-label="Choose images"]').setInputFiles({
    name: "visual-fixture.png",
    mimeType: "image/png",
    buffer: fixtureImage,
  });
  await page.getByRole("button", { name: "Remove visual-fixture.png" }).waitFor();
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

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await installFixture(page);
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
  await addFixtureImage(page);
  const desktopComposerImage = await inspectComposerImage(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-attachment.png`, fullPage: true });
  await page.getByRole("button", { name: "Remove visual-fixture.png" }).click();
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  const desktopDialog = await inspectThreadDialog(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-new-thread.png`, fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await selectFixture(page);
  const desktopSentImage = await sendAndInspectFixtureImage(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-sent-image.png`, fullPage: true });
  await page.locator(".conversation-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: `${outputDirectory}/desktop-code.png`, fullPage: true });
  await openRichDetails(page);
  await page.locator(".file-change-entry").scrollIntoViewIfNeeded();
  const desktopRich = await inspectRichLayout(page);
  await page.screenshot({ path: `${outputDirectory}/desktop-rich.png`, fullPage: true });

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
  await selectFixture(page);
  const mobileSentImage = await sendAndInspectFixtureImage(page);
  await page.screenshot({ path: `${outputDirectory}/mobile-sent-image.png`, fullPage: true });
  await openRichDetails(page);
  await page.locator(".file-change-entry").scrollIntoViewIfNeeded();
  const mobileRich = await inspectRichLayout(page);
  const splitActionHidden = await page.locator(".diff-split-action").first().evaluate((element) => (
    window.getComputedStyle(element).display === "none"
  ));
  await page.screenshot({ path: `${outputDirectory}/mobile-rich.png`, fullPage: true });

  const result = {
    desktop: {
      ...desktop,
      composerImage: desktopComposerImage,
      sentImage: desktopSentImage,
      dialog: desktopDialog,
      rich: desktopRich,
    },
    mobile: {
      ...mobileBefore,
      composerImage: mobileComposerImage,
      sentImage: mobileSentImage,
      dialog: mobileDialog,
      sidebarVisible: Boolean(sidebarBox && sidebarBox.x >= 0 && sidebarBox.width <= 390),
      rich: mobileRich,
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
    desktop.connection === "error" ||
    !desktopDialog.fitsViewport ||
    !desktopDialog.cwdEditable ||
    !desktopDialog.sandboxEnabled ||
    desktopDialog.sandbox !== "workspace-write" ||
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
    !mobileDialog.fitsViewport ||
    !mobileDialog.cwdEditable ||
    !mobileDialog.sandboxEnabled ||
    mobileDialog.sandbox !== "workspace-write" ||
    !result.mobile.sidebarVisible ||
    desktopRich.horizontalOverflow ||
    desktopRich.clipped.length > 0 ||
    desktopRich.codeBlocks === 0 ||
    desktopRich.diffViewers === 0 ||
    desktopRich.commands === 0 ||
    desktopRich.activityGroups === 0 ||
    desktopRich.hiddenActivitySummaries > 0 ||
    desktopRich.reasonBlocks === 0 ||
    desktopRich.scrollingToolOutputs === 0 ||
    desktopRich.toolOutputTruncations === 0 ||
    mobileRich.horizontalOverflow ||
    mobileRich.clipped.length > 0 ||
    mobileRich.hiddenActivitySummaries > 0 ||
    mobileRich.scrollingToolOutputs === 0 ||
    mobileRich.toolOutputTruncations === 0 ||
    !splitActionHidden ||
    consoleErrors.length > 0 ||
    pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
