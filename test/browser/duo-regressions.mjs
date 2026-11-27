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
      ["Controls content uses the available width", "start", "startTests", 1280, async page => {
        await page.evaluate(() => startTests.show("/controls"));
        const size = await page.locator(".content > main").evaluate(main =>
          [main.clientWidth, main.querySelector(".page").getBoundingClientRect().width]);
        assert(size[0] > 760 && Math.abs(size[1] - size[0]) < 1);
      }],
      ["native dashboard leaves global controls to the Controls destination", "start", "startTests", 951, async page => {
        await page.evaluate(() => startTests.show("/"));
        const shortcut = page.locator('.side-foot a[href="/controls"]');
        assert(await shortcut.isVisible(), "website sidebar keeps its shortcut");
        await page.evaluate(() => document.documentElement.classList.add("factory-rail"));
        assert(!await page.locator(".side").isVisible());
        assert.equal(await page.locator(".content").evaluate(el => el.getBoundingClientRect().top), 0);
        await page.evaluate(() => startTests.show("/controls"));
        assert(await page.getByRole("switch", { name: "Automation" }).isVisible());
        assert(await page.getByRole("button", { name: "Start a run" }).isVisible());
      }],
      ["disconnected Controls resumes in place", "start", "startTests", 382, async page => {
        await page.evaluate(async () => {
          await startTests.show("/controls");
          const store = await import("/web/lib/store.js");
          store.subscribe();
          window.dispatchEvent(new Event("offline"));
        });
        const outage = page.getByRole("dialog", { name: "Factory is unreachable" });
        await outage.waitFor();
        await page.keyboard.press("Escape");
        assert(await outage.isVisible());
        await outage.getByRole("button", { name: "Retry connection" }).click();
        await outage.waitFor({ state: "hidden" });
        assert.equal(new URL(page.url()).pathname, "/controls");
      }],
      ["compact Runs states fit the list", "runs", "runsTests", 382, async page => {
        await page.evaluate(() => runsTests.show("/runs"));
        const group = page.getByRole("radiogroup", { name: "State" });
        assert(await group.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        await group.getByRole("radio", { name: /^All/ }).tap();
        assert.equal(await group.getByRole("radio", { checked: true }).innerText().then(t => t.split(/\s/)[0]), "All");
      }],
      ["touch navigation through Controls", "start", "startTests", 382, async page => {
        await page.locator(".tabbar").getByRole("link", { name: "Controls" }).tap();
        await page.getByRole("navigation", { name: "Factory controls" }).getByRole("link", { name: "Log" }).tap();
        await page.waitForURL("**/activity");
        assert.match(await page.locator("main h1").innerText(), /^Log/);
        assert.equal(await page.locator('.tabbar a[aria-current="location"]').textContent(), "Controls");
      }],
      ["fold with a selected ticket", "ticket", "ticketTests", 382, async page => {
        await page.evaluate(async () => { await ticketTests.show("/queue"); await ticketTests.open("APP-1"); });
        const panel = page.locator("dialog.ticket-panel[open]");
        for (const [width, height, split] of [[669, 867, true], [385, 571, false], [951, 585, true]]) {
          await page.setViewportSize({ width, height });
          await page.waitForFunction(split => {
            const d = document.querySelector("dialog.ticket-panel[open]");
            return d && d.matches(":modal") !== split && (split === d.classList.contains("split-panel"));
          }, split);
          assert.equal(await panel.getAttribute("aria-label"), "APP-1");
          if (split) {
            const row = page.locator(".next:has(.next-ticket[aria-current=true])");
            const bounds = await row.boundingBox();
            assert(bounds.x + bounds.width <= (await panel.boundingBox()).x + 1,
              "the entire selected row, including its actions, fits beside detail");
          }
        }
      }],
      ["landscape header fits", "start", "startTests", 951, async page => {
        await page.evaluate(() => startTests.show("/"));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "landscape header stays inside the viewport");
      }],
      ["touch header controls", "start", "startTests", 382, async page => {
        await page.evaluate(() => startTests.show("/"));
        assert(await page.evaluate(() => { const controls = [...document.querySelectorAll(".top .right button, .tabbar a, .tabbar button")]; return controls.length >= 6 && controls.every(el => el.offsetWidth >= 44 && el.offsetHeight >= 44); }), "top bar and tab bar controls have 44px touch targets");
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
        assert.equal(await page.locator('.shell [aria-current="page"]').count(), 1, "only one navigation link is the current page");
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
    // The Queue page's three ticket views share one head; at each width, heads with the same layout must agree in height.
    // At 951px only the Session tickets fixture mounts the sidebar, which narrows its page to the phone head.
    const heads = {};
    for (const width of [360, 382, 385, 594, 669, 951]) for (const [fixture, api] of [["queue", "queueTests"], ["session-tickets", "sessionTests"], ["triage", "triageTests"]]) {
      cases.push([`${fixture} phone header`, fixture, api, width, async page => {
        const result = await page.evaluate(api => window[api].phoneHeader(), api);
        assert(result.coarse, "phone header check ran with touch input");
        const same = heads[`${width} ${result.narrow}`] ??= [];
        same.push(result.height);
        assert(Math.max(...same) - Math.min(...same) <= 1, `list page heads share one height at ${width}px: ${same.join(", ")}`);
      }]);
    }
    // Foldable poses with touch input; the fixture itself checks three-digit counts and overflow.
    for (const width of [360, 382, 385, 594, 669, 951]) cases.push(["Epics tab", "queue", "queueTests", width, async page => {
      assert((await page.evaluate(() => queueTests.epics())).coarse, "Epics check ran with touch input");
    }]);
    // Held rows and the ticket panel keep their icon-only Investigate in T3 button usable at every pose.
    for (const width of [360, 382, 385, 594, 669, 951]) cases.push(["Investigate in T3", "queue", "queueTests", width, async page => {
      assert((await page.evaluate(() => queueTests.investigate())).coarse, "Investigate check ran with touch input");
    }]);
    for (const [width, height] of [[382, 580], [594, 368], [385, 571], [669, 867], [951, 585]]) cases.push([
      "workspace project selection", "projects", "projectsTests", width, page => page.evaluate(() => projectsTests.workspaces()), height,
    ]);
    for (const [test, fixture, api, width, run, height = 800] of cases) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true });
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
