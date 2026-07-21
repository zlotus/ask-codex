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

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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

  const result = {
    desktop,
    mobile: {
      ...mobileBefore,
      sidebarVisible: Boolean(sidebarBox && sidebarBox.x >= 0 && sidebarBox.width <= 390),
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
    consoleErrors.length > 0 ||
    pageErrors.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
