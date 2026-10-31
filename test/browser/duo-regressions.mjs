// Run against a static server for the repository's synthetic browser fixtures.
// PLAYWRIGHT_MODULE optionally names an installed Playwright module outside this repo.
import assert from "node:assert/strict";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.FACTORY_FIXTURE_URL ?? "http://127.0.0.1:3860";
const results = [];
for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch();
  try {
    const cases = [
      ["landscape header fits", "start", "startTests", 951, async page => {
        await page.evaluate(() => startTests.show("/"));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "landscape header stays inside the viewport");
      }],
      ["touch header controls", "start", "startTests", 382, async page => {
        await page.evaluate(() => startTests.show("/"));
        assert(await page.evaluate(() => [...document.querySelectorAll(".top .right button")].every(el => el.offsetWidth >= 44 && el.offsetHeight >= 44)), "header actions have 44px touch targets");
      }],
      ["medium provider columns", "start", "startTests", 669, async page => {
        await page.evaluate(() => startTests.show("/"));
        assert(await page.evaluate(() => { const rows = [...document.querySelectorAll(".machine")]; return rows.length === 2 && rows[0].getBoundingClientRect().top === rows[1].getBoundingClientRect().top; }), "provider meters share a row when the medium viewport fits them");
      }],
      ["compact ticket actions", "session-tickets", "sessionTests", 850, page => page.evaluate(() => sessionTests.rowHeight())],
      ["collapsed search and IME", "session-tickets", "sessionTests", 850, page => page.evaluate(() => sessionTests.density())],
      ["bounded unsaved changes", "start", "startTests", 382, async page => {
        await page.evaluate(async () => { const store = await import("/web/lib/store.js"); store.set(["pollSeconds"], 90); });
        await page.waitForSelector(".save-bar");
        await page.evaluate(() => { document.querySelector(".save-bar > span").textContent = "1200 unsaved changes"; });
        assert(await page.evaluate(() => { const r = document.querySelector(".save-bar").getBoundingClientRect(); return r.left >= 16 && r.right <= innerWidth - 16; }), "unsaved changes stay inside phone gutters");
      }],
      ["one current page", "start", "startTests", 382, async page => {
        await page.evaluate(() => startTests.show("/"));
        assert.equal(await page.locator('.top [aria-current="page"]').count(), 1, "only one navigation link is the current page");
      }],
      ["accessible connection text", "start", "startTests", 382, async page => {
        assert(await page.evaluate(() => { const live = document.querySelector('.top [role="status"]'), text = live.querySelector(".conn-label") ?? live, style = getComputedStyle(text); return !!live.textContent.trim() && style.display !== "none" && style.visibility !== "hidden"; }), "compact connection status remains readable live-region text");
      }],
      ["native Search Enter", "session-tickets", "sessionTests", 850, async page => {
        assert.equal(await page.getByRole("button", { name: "Search", exact: true }).count(), 1, "Search is available on demand");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("textbox", { name: "Find a ticket", exact: true }).fill("APP-2");
        await page.keyboard.press("Enter");
        // Match the fixture's normal effect-settlement pause, without waiting for the fix's outcome.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
        assert.equal(await page.locator("input.search").count(), 0, "Enter closes Search once without reopening it");
      }],
    ];
    // The three ticket lists share one phone head; their measured heights must agree at each width.
    const heads = {};
    for (const width of [360, 382, 594]) for (const [fixture, api] of [["queue", "queueTests"], ["session-tickets", "sessionTests"], ["triage", "triageTests"]]) {
      cases.push([`${fixture} phone header`, fixture, api, width, async page => {
        const result = await page.evaluate(api => window[api].phoneHeader(), api);
        assert(result.coarse, "phone header check ran with touch input");
        (heads[width] ??= []).push(result.height);
        assert(Math.max(...heads[width]) - Math.min(...heads[width]) <= 1, `list page heads share one height at ${width}px: ${heads[width].join(", ")}`);
      }]);
    }
    for (const [test, fixture, api, width, run] of cases) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true });
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/test/browser/${fixture}.html`);
        await page.waitForFunction(api => !!window[api], api);
        const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
        assert(coarse, "touch emulation must activate pointer: coarse");
        await run(page);
        results.push({ browser: name, test, width, coarse, passed: true });
      } catch (error) {
        results.push({ browser: name, test, width, passed: false, error: error.message });
        process.exitCode = 1;
      } finally {
        await context.close();
      }
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally {
    await browser.close();
  }
}
