// Serve the repository root, then call await toastTests.run() in a browser.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { Toast } from "../../web/ui/overlay.js";
import { Button } from "../../web/ui/controls.js";

const root = document.querySelector("#root");
const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const texts = {
  short: "Could not stop the run. Please try again.",
  token: "x".repeat(800),
  long: `${"Could not stop the run.\nDiagnostic: request rejected. ".repeat(180)}END OF ERROR`,
};
let sequence = 0, dismissed = 0;
const toast = () => root.querySelector(".toast");

async function show(kind = "long", save = false, error = true, ttl) {
  const notice = { text: texts[kind] ?? kind, error, at: ++sequence };
  render(html`${save && html`<div class="save-bar" role="region" aria-label="Unsaved changes">
    <span>1 unsaved change</span><${Button}>Discard<//><${Button} variant="primary">Save changes<//>
  </div>`}<${Toast} notice=${notice} ttl=${ttl} onDone=${() => { dismissed++; render(null, root); }} />`, root);
  await pause();
  return notice;
}

function geometry() {
  const box = toast().getBoundingClientRect();
  assert(box.left >= 16 && box.right <= innerWidth - 16 + 1 && box.top >= 16 && box.bottom <= innerHeight - 16 + 1,
    `notification stays within viewport gutters: ${JSON.stringify(box.toJSON())}`);
  assert(document.documentElement.scrollWidth <= innerWidth, "no document horizontal overflow");
  const button = toast().querySelector("button");
  assert(button?.textContent.includes("Dismiss"), "explicit labelled dismiss button");
  const b = button.getBoundingClientRect();
  assert(b.width >= 44 && b.height >= 44 && b.top >= box.top && b.bottom <= box.bottom, "dismiss target stays inside notification");
  assert(button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)), "dismiss button receives pointer input");
  const save = root.querySelector(".save-bar")?.getBoundingClientRect();
  assert(!save || box.bottom < save.top, "notification clears save bar");
  return box.toJSON();
}

async function runGeometry() {
  const boxes = [];
  for (const save of [false, true]) {
    for (const kind of ["token", "long", "short"]) {
      await show(kind, save);
      boxes.push({ kind, save, box: geometry() });
      assert(toast().getAttribute("role") === "alert", "error retains alert role");
      const content = toast().querySelector(".toast-content");
      assert(content?.tabIndex === 0, "text region supports keyboard scrolling");
      assert(content.scrollWidth <= content.clientWidth + 1, "diagnostics wrap without horizontal overflow");
      assert(getComputedStyle(content).whiteSpace === "pre-wrap", "diagnostic line breaks are preserved");
      if (kind === "long") {
        assert(content.scrollHeight > content.clientHeight, "long text scrolls internally");
        content.scrollTop = content.scrollHeight;
        await pause();
        const end = document.createRange();
        end.setStart(content.firstChild, content.textContent.length - 12);
        end.setEnd(content.firstChild, content.textContent.length);
        const r = end.getBoundingClientRect(), c = content.getBoundingClientRect();
        assert(r.top >= c.top - 1 && r.bottom <= c.bottom + 1, "scrolling reaches full error ending");
      }
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(content);
      selection.removeAllRanges(); selection.addRange(range);
      assert(selection.toString() === texts[kind], "full error text is selectable");
      const before = dismissed;
      content.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      content.dispatchEvent(new Event("scroll", { bubbles: true }));
      content.click();
      await pause();
      assert(toast() && dismissed === before, "touch, selection and text click do not dismiss error");
      selection.removeAllRanges();
      toast().querySelector("button").click();
      await pause();
      assert(!toast() && dismissed === before + 1, "explicit dismissal fires once");
    }
  }
  await show("Saved", false, false);
  geometry();
  assert(toast().getAttribute("role") === "status", "success retains status role");
  render(null, root);
  return { passed: true, viewport: [innerWidth, innerHeight], boxes };
}

async function runLifetime() {
  render(null, root);
  await pause();
  // Capture only notice lifetimes; Preact scheduling and fixture pauses keep real timers.
  const nativeSet = window.setTimeout, nativeClear = window.clearTimeout;
  const timers = new Map();
  let id = -1;
  window.setTimeout = (fn, delay, ...args) => delay >= 4000
    ? (timers.set(--id, { fn: () => fn(...args), delay }), id)
    : nativeSet(fn, delay, ...args);
  window.clearTimeout = (timer) => timers.delete(timer) || nativeClear(timer);
  const advance = async (ms) => {
    for (const [key, timer] of [...timers]) {
      timer.delay -= ms;
      if (timer.delay <= 0) { timers.delete(key); timer.fn(); }
    }
    await pause();
  };
  try {
    await show("short");
    await advance(60000);
    assert(toast(), "errors persist until explicitly dismissed");
    assert(timers.size === 0, "errors schedule no expiry");
    await show("Saved", false, false);
    await advance(3999);
    assert(toast(), "success remains before ordinary lifetime");
    await advance(1);
    assert(!toast(), "success expires at ordinary lifetime");
    await show("Saved", false, false);
    await advance(2000);
    await show("short");
    await advance(60000);
    assert(toast()?.textContent.includes(texts.short) && timers.size === 0, "replacement cancels old success timer");
    await show("Saved", false, false, 5000);
    await advance(4999);
    assert(toast(), "custom success lifetime remains supported");
    await advance(1);
    assert(!toast(), "custom success lifetime expires");
    await show("Saved", false, false);
    render(null, root);
    await pause();
    assert(timers.size === 0, "unmount clears pending expiry");
    return { passed: true };
  } finally {
    render(null, root);
    await pause();
    window.setTimeout = nativeSet; window.clearTimeout = nativeClear;
  }
}

window.toastTests = { show, runGeometry, runLifetime, run: async () => ({ geometry: await runGeometry(), lifetime: await runLifetime() }) };
await show("token");
