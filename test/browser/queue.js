// Synthetic data, actual queue component and dispatch store. No live dispatches.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { applyState, operations, status, history } from "../../web/lib/store.js";
import * as Deck from "../../web/views/Deck.js";
import { Runs } from "../../web/views/Runs.js";

const root = document.querySelector("#root");
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ticket = (n, modelId = "preset-sol") => ({ id: `t${n}`, key: `APP-${n}`, title: `Queued ticket ${n}`, projectId: "p", difficulty: "med", priority: n === 1 ? "high" : "medium", labelRank: 0, modelId, model: modelId ? "Sol" : null });
const state = {
  config: { enabled: false, kaneo: { url: "https://tracker.example", workspaceId: "w" }, models: [{ id: "preset-sol", name: "Sol", model: { instanceId: "codex", model: "sol" } }], projects: [{ kaneoId: "p", name: "Example", priorityLabels: ["agent-compat"] }] },
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
    assert(button(1).textContent.trim() === "" && button(1).querySelector(".icon-play"), "Run now is an icon-only play button");
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
      assert(JSON.stringify(calls[0].input) === JSON.stringify({ ticket: "APP-1", model: "auto", overrideLimits: true }), "Run now chooses the model at dispatch with the named ticket and override");
      assert(location.href === href, "Run now does not navigate");
    } finally { release(); }
    for (let n = 0; n < 100 && operations.value.some(op => op.state !== "done"); n++) await pause();
    assert(calls.length === 2 && calls[1].input.ticket === "APP-2", "later request drains");
    assert(calls[0].id !== calls[1].id, "each row has its own idempotency key");
    assert(!button(1).disabled, "refused request can be retried");
    assert(root.querySelector(".operation")?.textContent.includes("quota-exhausted"), "existing request rows expose refusal feedback");
    assert(!button(3).disabled, "missing predicted model does not prevent automatic dispatch");
    button(3).click();
    await pause();
    assert(calls[2]?.input.ticket === "APP-3" && calls[2].input.model === "auto", "a row without a predicted model dispatches automatically");
    status.value = { ...state.status, upNext: { ...state.status.upNext, tickets: [ticket(1), { ...ticket(2), modelId: "removed", model: "Retired model" }, ticket(3, null)] } };
    await pause();
    assert(!button(2).disabled, "a removed predicted model does not prevent automatic dispatch");
    button(2).click();
    await pause();
    assert(calls[3]?.input.ticket === "APP-2" && calls[3].input.model === "auto", "stale model metadata is never pinned to a request");
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
  await layout();
  await show();
  return { passed: true, viewport: [innerWidth, innerHeight], contexts: ["deck", "runs"] };
}
async function layout() {
  for (const limit of [5, Infinity]) {
    await show(limit);
    const rows = [...root.querySelectorAll(".next")];
    assert(rows.map(row => row.querySelector(".key").textContent).join() === "APP-1,APP-2,APP-3", "queue order is preserved");
    assert(root.querySelector("h2 small").textContent === "3", "queue total is retained");
    assert(!rows.some(row => row.querySelector(".rank")), "queue order needs no row numbers");
    assert(!rows.some(row => /Sol|no automatic model|priority/.test(row.textContent)), "queue omits predicted models and the priority suffix");
    assert(rows[0].querySelector("small").textContent.includes("Example · high"), "priority stays concise beside the project");
    assert(rows[0].querySelectorAll(".tag").length === 2, "difficulty and routing tags remain visible");
    assert(rows.every(row => {
      const link = row.querySelector(".next-ticket");
      return row.querySelector(".next-body").getBoundingClientRect().left === link.getBoundingClientRect().left + parseFloat(getComputedStyle(link).paddingLeft);
    }), "ticket text uses the former rank column");
    assert(document.documentElement.scrollWidth <= innerWidth, "compact queue fits the viewport");
  }
  return { passed: true, viewport: [innerWidth, innerHeight], contexts: ["deck", "runs"] };
}
const filterState = {
  config: { ...state.config, projects: [{ kaneoId: "p", key: "APP", name: "Alpha" }, { kaneoId: "q", key: "WEB", name: "Beta" }, { kaneoId: "empty", key: "EMPTY", name: "Empty" }] },
  status: { jobs: [], upNext: { at: new Date().toISOString(), tickets: [
    { ...ticket(1), title: "Fix uploads", labels: ["bug", "web"], difficulty: "med", priority: "high" },
    { ...ticket(2), projectId: "q", key: "WEB-2", labels: ["bug"], difficulty: "low", priority: "low" },
    { ...ticket(3), labels: ["web"], difficulty: "high", priority: "urgent" },
  ], held: [
    { key: "APP-4", projectId: "p", title: "Held upload", labels: ["bug", "web"], difficulty: "med", priority: "high", reason: "Already owned" },
    { key: "WEB-5", projectId: "q", labels: ["bug"], difficulty: "low", priority: "low", reason: "Needs classification" },
  ] } },
};
const runFixture = (id, projectId, labels, difficulty, priority, providerDriver = "codex") => ({ id, kind: "ticket", label: `APP-${id}`, projectId, labels, difficulty, priority, providerDriver, state: "running", createdAt: new Date().toISOString(), prUrls: [] });
const filterJobs = [runFixture("1", "p", ["bug", "web"], "med", "high"), runFixture("2", "q", ["bug"], "low", "low", "claudeAgent"), runFixture("old", "p")];
async function showProjects() {
  const oldFetch = window.fetch;
  window.fetch = (url, init) => url === "/api/history" ? Promise.resolve(Response.json(filterJobs)) : oldFetch(url, init);
  operations.value = [];
  history.value = filterJobs;
  applyState({ ...filterState, status: { ...filterState.status, jobs: filterJobs } }, true);
  window.history.replaceState(null, "", "?state=next");
  render(null, root);
  render(html`<${Runs} />`, root);
  await pause();
  window.fetch = oldFetch;
}
const queueKeys = () => [...root.querySelectorAll(".next .key")].map(e => e.textContent).join();
const heldKeys = () => [...root.querySelectorAll(".held .key")].map(e => e.textContent).join();
const dialog = () => root.querySelector('dialog[aria-label="Filters"]');
const byText = (selector, text, scope = root) => [...scope.querySelectorAll(selector)].find(e => e.textContent.trim() === text);
async function openFilters() {
  const button = root.querySelector('[aria-label^="Filter runs"]');
  assert(button, "Runs exposes a Filter button");
  button.click(); await pause();
}
async function pickFilter(group, name) {
  byText("button", name, dialog().querySelector(`[role="group"][aria-label="${group}"]`)).click();
  await pause();
}
async function closeFilters() { byText("button", "Done", dialog()).click(); await pause(); }
async function clearFilters() { byText("button", "Clear filters", dialog()).click(); await pause(); }
async function runProjects() {
  const oldFetch = window.fetch, oldUrl = location.href;
  const dispatches = [];
  window.fetch = async (url, init) => {
    if (url === "/api/history") return Response.json(filterJobs);
    if (url === "/api/dispatch") {
      const input = JSON.parse(init.body), id = init.headers["Idempotency-Key"];
      dispatches.push(input);
      return Response.json({ id, input, state: "done", result: { data: { reason: "quota-exhausted" } } });
    }
    return Response.json({ ...filterState, status: status.value });
  };
  try {
    await showProjects();
    assert(queueKeys() === "APP-1,WEB-2,APP-3", "all projects preserve scheduler order");
    await openFilters();
    assert(!dialog().querySelector('[aria-label="Provider"]'), "queue does not filter predicted providers");
    await pickFilter("Project", "Alpha");
    assert(queueKeys() === "APP-1,APP-3", `Project Alpha must show only its queue tickets; got ${queueKeys()}`);
    assert(heldKeys() === "APP-4", "held tickets follow project filtering");
    assert(root.querySelector("h2 small").textContent === "2", "queue count follows filters");
    await pickFilter("Project", "Beta");
    assert(queueKeys() === "APP-1,WEB-2,APP-3", "multiple projects use OR");
    await pickFilter("Project", "Beta");
    await pickFilter("Tags", "bug");
    await pickFilter("Tags", "web");
    assert(queueKeys() === "APP-1,APP-3", "tag OR matches either selected label");
    byText('[role="radio"]', "AND", dialog()).click(); await pause();
    assert(queueKeys() === "APP-1", "tag AND requires all selected labels");
    await pickFilter("Difficulty", "Medium");
    await pickFilter("Priority", "High");
    assert(queueKeys() === "APP-1" && heldKeys() === "APP-4", "categories combine for queue and held tickets");
    await closeFilters();
    assert(root.querySelector('[aria-label="Filter runs, 4 active"]').textContent.includes("4"), "button reports active categories");
    status.value = { ...status.value, upNext: { ...status.value.upNext, tickets: [...filterState.status.upNext.tickets, { ...filterState.status.upNext.tickets[0], id: "t6", key: "APP-6" }] } };
    await pause();
    assert(queueKeys() === "APP-1,APP-6", "live updates retain filters and order");
    const search = root.querySelector('[aria-label="Find a ticket"]');
    search.value = "uploads"; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    assert(queueKeys() === "APP-1,APP-6", "queue search matches titles");
    search.value = "APP-6"; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    assert(queueKeys() === "APP-6", "queue search matches ticket keys");
    button(6).click(); await pause();
    assert(JSON.stringify(dispatches[0]) === JSON.stringify({ ticket: "APP-6", model: "auto", overrideLimits: true }), "filtered Run now retains the original dispatch input");
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    byText('[role="radio"]', "Open3").click(); await pause();
    assert(root.querySelectorAll(".run").length === 1, "ordinary runs use the same metadata filters");
    await openFilters();
    assert(dialog().querySelector('[aria-label="Provider"]'), "recorded runs retain provider filtering");
    await clearFilters();
    await closeFilters();
    assert(root.querySelectorAll(".run").length === 3, "legacy runs stay visible with no metadata filters");
    await openFilters();
    await pickFilter("Provider", "Claude");
    await closeFilters();
    assert(root.querySelectorAll(".run").length === 1, "provider filters actual recorded runs");
    byText('[role="radio"]', "Up next4").click(); await pause();
    await openFilters();
    await pickFilter("Project", "Empty");
    assert(queueKeys() === "" && heldKeys() === "" && root.textContent.includes("No tickets match."), "no matching project has an empty result");
    await clearFilters();
    await closeFilters();
    assert(queueKeys() === "APP-1,WEB-2,APP-3,APP-6", "clear restores the complete ordered queue");
    assert(document.documentElement.scrollWidth <= innerWidth, "Runs fits the viewport");
    await openFilters();
    const bounds = dialog().getBoundingClientRect();
    assert(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, "filter dialog fits the viewport");
    status.value = { ...status.value, upNext: { ...status.value.upNext, tickets: [{ ...filterState.status.upNext.tickets[0], labels: Array.from({ length: 50 }, (_, i) => `scope-${i}`) }] } };
    await pause();
    dialog().scrollTop = dialog().scrollHeight;
    assert(dialog().scrollWidth <= dialog().clientWidth, "large tag catalogs do not overflow the dialog");
    const done = byText("button", "Done", dialog()).getBoundingClientRect();
    assert(done.bottom <= innerHeight && done.top >= 0, "dialog scrolling reaches its actions with many tags");
    await closeFilters();
    return { passed: true, viewport: [innerWidth, innerHeight], filters: ["project", "tags OR/AND", "difficulty", "priority", "search", "provider on runs"] };
  } finally { window.fetch = oldFetch; window.history.replaceState(null, "", oldUrl); }
}
window.queueTests = { run, layout, show, showProjects, runProjects, openFilters, pickFilter, closeFilters };
await show();
