// Run against a static server for the repository's synthetic browser fixtures.
import assert from "node:assert/strict";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:8769";
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  try {
    for (const width of [1280, 390]) {
      for (const test of ["runsControls", "runsHistory", "runProjects", "run", "readiness"]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390 });
        try {
          await page.goto(`${origin}/test/browser/queue.html`);
          await page.waitForFunction(() => !!window.queueTests);
          if (process.env.SCREENSHOT_DIR && name === "chromium" && test === "runsHistory") {
            await page.evaluate(() => queueTests.showRuns());
            await page.evaluate(() => document.activeElement.blur());
            await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/runs-${process.env.PROOF_STAGE}-${width}.png`, fullPage: true });
          }
          const result = await page.evaluate(test => queueTests[test](), test);
          assert(result.passed);
          console.log(JSON.stringify({ browser: name, width, test, passed: true }));
        } catch (error) {
          process.exitCode = 1;
          console.log(JSON.stringify({ browser: name, width, test, passed: false, error: error.message }));
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
}
