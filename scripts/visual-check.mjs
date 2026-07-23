import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.ASK_CODEX_VISUAL_URL ?? "http://127.0.0.1:4173";
const browserPath = process.env.CHROME_BIN ?? "/usr/bin/chromium";
const outputDirectory = process.env.ASK_CODEX_VISUAL_OUTPUT ?? "/tmp/ask-codex-visual";

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
        aggregatedOutput: "TypeScript: passed\nTests: 12 files, 92 passed\nBuild artifacts verified",
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
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Thorough" },
            ],
          }],
          nextCursor: null,
        };
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
      }
      socket.send(JSON.stringify({ type: "rpcResult", id: message.id, result }));
    });
  });
}

async function selectFixture(page) {
  await page.getByRole("button", { name: /Renderer fixture/ }).click();
  await page.getByText("The bounded renderer is in place.", { exact: false }).waitFor();
  await page.waitForTimeout(250);
}

async function openRichDetails(page) {
  await page.locator(".command-block, .inline-details, .turn-diff").evaluateAll((elements) => {
    for (const element of elements) element.open = true;
  });
}

async function inspectRichLayout(page) {
  return page.evaluate(() => {
    const selectors = [".code-block", ".diff-viewer", ".command-block"];
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
    };
  });
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
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      toolbarVisible: Boolean(toolbar && toolbar.top >= 0 && toolbar.right <= window.innerWidth),
      composerVisible: Boolean(composer && composer.bottom <= window.innerHeight && composer.left >= 0),
      connection: document.querySelector(".sidebar-footer span:nth-child(2)")?.textContent,
    };
  });
  await page.screenshot({ path: `${outputDirectory}/desktop.png`, fullPage: true });
  await selectFixture(page);
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
    toolbarControlsVisible: [...document.querySelectorAll(".toolbar-control")].every((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    }),
  }));
  await page.screenshot({ path: `${outputDirectory}/mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "Open threads" }).click();
  await page.waitForTimeout(250);
  const sidebarBox = await page.locator(".sidebar--open").boundingBox();
  await page.screenshot({ path: `${outputDirectory}/mobile-sidebar.png`, fullPage: true });
  await selectFixture(page);
  await openRichDetails(page);
  await page.locator(".file-change-entry").scrollIntoViewIfNeeded();
  const mobileRich = await inspectRichLayout(page);
  const splitActionHidden = await page.locator(".diff-split-action").first().evaluate((element) => (
    window.getComputedStyle(element).display === "none"
  ));
  await page.screenshot({ path: `${outputDirectory}/mobile-rich.png`, fullPage: true });

  const result = {
    desktop: { ...desktop, rich: desktopRich },
    mobile: {
      ...mobileBefore,
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
    !desktop.composerVisible ||
    desktop.connection === "error" ||
    mobileBefore.horizontalOverflow ||
    !mobileBefore.sidebarHidden ||
    !mobileBefore.toolbarControlsVisible ||
    !result.mobile.sidebarVisible ||
    desktopRich.horizontalOverflow ||
    desktopRich.clipped.length > 0 ||
    desktopRich.codeBlocks === 0 ||
    desktopRich.diffViewers === 0 ||
    desktopRich.commands === 0 ||
    mobileRich.horizontalOverflow ||
    mobileRich.clipped.length > 0 ||
    !splitActionHidden ||
    consoleErrors.length > 0 ||
    pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
