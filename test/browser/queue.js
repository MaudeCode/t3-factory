// Synthetic data, actual queue component and dispatch store. No live dispatches.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { applyState, operations, status } from "../../web/lib/store.js";
import * as Deck from "../../web/views/Deck.js";

const root = document.querySelector("#root");
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ticket = (n, modelId = "preset-sol") => ({ id: `t${n}`, key: `APP-${n}`, title: `Queued ticket ${n}`, projectId: "p", difficulty: "med", priority: "medium", modelId, model: modelId ? "Sol" : null });
const state = {
  config: { enabled: false, kaneo: { url: "https://tracker.example", workspaceId: "w" }, models: [{ id: "preset-sol", name: "Sol", model: { instanceId: "codex", model: "sol" } }], projects: [{ kaneoId: "p", name: "Example" }] },
  status: { jobs: [], upNext: { at: new Date().toISOString(), tickets: [ticket(1), ticket(2), ticket(3, null)], held: [] } },
};
let calls = [], release;
function button(n) { return root.querySelector(`[aria-label="Run APP-${n} now"]`); }
async function show(limit = 5) {
  operations.value = [];
  applyState(state, true);
  render(html`${Deck.Operations && html`<${Deck.Operations} />`}<${Deck.UpNext} limit=${limit} />`, root);
  await pause();
}
async function run() {
  for (const limit of [5, Infinity]) {
    calls = [];
    const held = new Promise(resolve => { release = resolve; });
    window.fetch = async (url, init) => {
      if (url !== "/api/dispatch") return Response.json(state);
      const input = JSON.parse(init.body), id = init.headers["Idempotency-Key"];
      calls.push({ input, id });
      if (input.ticket === "APP-1") await held;
      return Response.json({ id, input, state: "done", result: { data: { reason: "quota-exhausted" } } });
    };
    await show(limit);
    assert(button(1), "queue row exposes Run now");
    assert(!button(1).closest("a"), "Run now is separate from the tracker link");
    const href = location.href;
    try {
      button(1).click();
      await pause();
      assert(button(1).disabled, "pending request disables its row");
      button(1).click();
      assert(!button(2).disabled, "other tickets remain usable");
      button(2).click();
      await pause();
      assert(calls.length === 1, "checks serialize and double clicks do not resend");
      assert(JSON.stringify(calls[0].input) === JSON.stringify({ ticket: "APP-1", model: "preset-sol", overrideLimits: true }), "Run now dispatches row key, configured model ID and override");
      assert(location.href === href, "Run now does not navigate");
    } finally { release(); }
    for (let n = 0; n < 100 && operations.value.some(op => op.state !== "done"); n++) await pause();
    assert(calls.length === 2 && calls[1].input.ticket === "APP-2", "later request drains");
    assert(calls[0].id !== calls[1].id, "each row has its own idempotency key");
    assert(!button(1).disabled, "refused request can be retried");
    assert(root.querySelector(".operation")?.textContent.includes("quota-exhausted"), "existing request rows expose refusal feedback");
    assert(button(3).disabled && button(3).title.includes("model"), "missing model is explained");
    operations.value = [{ id: "unknown", input: { ticket: "app-1" }, state: "uncertain" }];
    await pause();
    assert(button(1).disabled, "uncertain request blocks a duplicate regardless of key casing");
    operations.value = [];
    status.value = { ...state.status, jobs: [{ taskId: "t1", state: "running" }] };
    await pause();
    assert(button(1).disabled, "an open run disables a stale queue row");
    status.value = { ...state.status, plans: [{ state: "active", target: { id: "t1" } }] };
    await pause();
    assert(button(1).disabled, "an active chain disables its target before the target has a job");
    assert(!button(2).disabled, "an active chain leaves other tickets available");
    status.value = { ...state.status, plans: [{ state: "cancelled", target: { id: "t1" } }] };
    await pause();
    assert(!button(1).disabled, "a cancelled chain does not hold its target");
    const b = button(2).getBoundingClientRect();
    assert(b.left >= 0 && b.right <= innerWidth && b.height >= 44, "action fits viewport with usable target");
    assert(document.documentElement.scrollWidth <= innerWidth, "queue has no horizontal overflow");
  }
  await show();
  return { passed: true, viewport: [innerWidth, innerHeight], contexts: ["deck", "runs"] };
}
window.queueTests = { run, show };
await show();
