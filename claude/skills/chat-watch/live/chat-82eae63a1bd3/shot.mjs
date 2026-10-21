// Screenshot a daemon-served rooms URL at desktop (1440x900) and mobile
// (390x844, touch, DPR 2) widths, dark scheme:
//   node shot.mjs <url> <out-prefix> [wait-ms]   -> <out>-desktop.png, <out>-mobile.png
// Or one full-page shot of any page (used for rendered TUI captures):
//   node shot.mjs --page <url> <out-prefix>      -> <out>.png
// Playwright resolves from the shared openmarket-chat install; the browser is
// ~/.cache/ms-playwright/chromium_headless_shell-1228.
import { createRequire } from "node:module";

const require = createRequire(
  `${process.env.OM_CHAT_REPO ?? `${process.env.HOME}/repos/openmarket-chat`}/package.json`,
);
const { chromium, devices } = require("@playwright/test");

const args = process.argv.slice(2);
const pageMode = args[0] === "--page";
if (pageMode) args.shift();
const [url, out, waitArg] = args;
if (!url || !out) {
  console.error("usage: node shot.mjs [--page] <url> <out-prefix> [wait-ms]");
  process.exit(2);
}
const waitMs = Number(waitArg ?? 6000);

const browser = await chromium.launch();
try {
  if (pageMode) {
    const page = await browser.newPage({ viewport: { width: 800, height: 200 } });
    await page.goto(url);
    const box = await page.locator("pre").boundingBox();
    await page.setViewportSize({
      width: Math.ceil(box?.width ?? 800),
      height: Math.ceil(box?.height ?? 200),
    });
    await page.screenshot({ path: `${out}.png`, fullPage: true });
    console.log(`${out}.png`);
  } else {
    const variants = [
      ["desktop", { viewport: { width: 1440, height: 900 } }],
      [
        "mobile",
        { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
      ],
    ];
    for (const [name, options] of variants) {
      const context = await browser.newContext({ ...options, colorScheme: "dark" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(waitMs);
      const file = `${out}-${name}.png`;
      await page.screenshot({ path: file });
      console.log(`${file}  title=${JSON.stringify(await page.title())}  url=${page.url()}`);
      for (const error of errors.slice(0, 5)) console.log(`  pageerror: ${error.slice(0, 200)}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
