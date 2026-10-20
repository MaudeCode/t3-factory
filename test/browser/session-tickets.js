// Synthetic session tickets, the actual page, store and dispatch path. No live sessions, tickets or dispatches.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { applyState, operations, status } from "../../web/lib/store.js";
import { App } from "../../web/views/App.js";
import { route, match } from "../../web/lib/router.js";

const root = document.querySelector("#root");
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const at = new Date(Date.now() - 90_000).toISOString();
const row = (taskId, key, priority, extra = {}) => ({ taskId, projectId: "p", project: "Example", key, number: Number(key.split("-")[1]), title: `Ticket ${key}`, priority, status: "to-do", labels: ["feat", "web"], difficulty: "med", createdAt: at, refreshedAt: at, refreshError: null,
  sources: [{ threadId: `thread-${taskId}`, messageId: `m-${taskId}`, title: `Plan ${key}`, at }], unavailable: null, ...extra });
// Rows arrive in the scheduler's order: priority, then project key and number.
const rows = [
  row("t9", "WEB-9", "urgent", { projectId: "q", project: "Other project", labels: ["bug"], difficulty: "low", unavailable: "Project not configured in Factory" }),
  row("t2", "APP-2", "high"),
  row("t5", "APP-5", "medium", { labels: ["chore"], difficulty: null, refreshError: "Kaneo get_task failed; check its authenticated connection" }),
  row("t1", "APP-1", "low", { title: "Dismissed later in the test", sources: [{ threadId: "thread-t1", messageId: "m-t1", title: "Plan APP-1", at }, { threadId: "thread-t1b", messageId: "m-t1b", title: "Second look", at }, { threadId: "thread-t1c", messageId: "m-t1c", title: "Third look", at }] }),
];
const base = {
  config: { enabled: false, kaneo: { url: "https://tracker.example", workspaceId: "w" }, models: [{ id: "preset-sol", name: "Sol", model: { instanceId: "codex", model: "sol" } }], projects: [{ kaneoId: "p", key: "APP", name: "Example", enabled: true, priorityLabels: ["agent-compat"] }] },
  status: { jobs: [], sessionTickets: { at, error: null, rows } },
};
let state = structuredClone(base), calls = [], release = () => {};
window.fetch = async (url, init) => {
  if (url === "/api/dispatch") {
    const input = JSON.parse(init.body), id = init.headers["Idempotency-Key"];
    calls.push({ url, input, id });
    if (input.ticket === "APP-2") await new Promise((resolve) => { release = resolve; });
    return Response.json({ id, input, state: "done", result: { data: { reason: "quota-exhausted" } } });
  }
  if (init?.method === "POST") {
    calls.push({ url });
    if (url.startsWith("/api/session-tickets/")) state = { ...state, status: { ...state.status, sessionTickets: { ...state.status.sessionTickets, rows: state.status.sessionTickets.rows.filter((r) => !url.includes(`/${r.taskId}/`)) } } };
    return Response.json({ ok: true });
  }
  return Response.json(state);
};
// Signals compare by identity, so a live update is a new status object, as the event stream delivers one.
const update = (patch) => { state = { ...state, status: { ...state.status, ...patch } }; applyState(state); };
const keys = () => [...root.querySelectorAll(".next .key")].map((e) => e.textContent);
const button = (label) => root.querySelector(`[aria-label="${label}"]`);
async function show(patch = {}) {
  operations.value = [];
  state = structuredClone(base);
  Object.assign(state.status, patch);
  render(null, root);
  applyState(state, true);
  route.value = match("/session-tickets");
  render(html`<${App} />`, root);
  await pause();
}
async function run() {
  calls = [];
  await show();
  assert(root.querySelector("h1")?.textContent.includes("Session tickets"), "the page is reachable by its path");
  assert(root.querySelector('nav a[aria-current="page"]')?.textContent.trim() === "Session tickets", "navigation marks the page");
  assert(keys().join() === "WEB-9,APP-2,APP-5,APP-1", "rows keep the scheduler's priority order");
  const first = root.querySelector(".next");
  assert(first.querySelector(".meta-project").textContent === "Other project" && first.textContent.includes("not configured in Factory"), "an unmapped project says why it cannot start");
  assert(button("Run WEB-9 now").disabled && button("Run WEB-9 now").title.includes("not configured"), "Run is disabled with the reason as its tooltip");
  assert(root.querySelectorAll(".next .tag-label").length === 6, "rows show their attached labels");
  assert(first.querySelector('a[href="t3-thread://v1/thread-t9"]')?.getAttribute("aria-label").includes("T3 Code"), "the source session opens in T3");
  assert(first.textContent.includes("from Plan WEB-9"), "the originating session is named");
  assert(root.querySelector(".next:nth-of-type(3)").textContent.includes("tracker read failed"), "a failed refresh is not shown as fresh");
  assert(!button("Run APP-2 now").closest("a") && !button("Remove APP-2 from Session tickets").closest("a"), "actions sit beside the tracker link, not inside it");
  const many = [...root.querySelectorAll(".next")].find((r) => r.textContent.includes("APP-1"));
  assert(many.querySelectorAll('a[href^="t3-thread://"]').length === 1 && many.querySelector('a[href^="t3-thread://"]').title.includes("2 more"), "several sources collapse into one session action");
  assert(many.getBoundingClientRect().right <= innerWidth && many.textContent.includes("Third look"), "all sources are named without widening the row");
  button("Run APP-2 now").click();
  await pause();
  assert(button("Run APP-2 now").disabled, "a pending request disables its row");
  button("Run APP-2 now").click();
  await pause();
  assert(calls.filter((c) => c.url === "/api/dispatch").length === 1, "rapid clicks produce one request");
  release();
  for (let n = 0; n < 100 && operations.value.some((op) => op.state !== "done"); n++) await pause();
  assert(JSON.stringify(calls[0].input) === JSON.stringify({ ticket: "APP-2", model: "auto", overrideLimits: true }), "Run passes the captured key with automatic model selection");
  assert(root.querySelector(".operation")?.textContent.includes("quota-exhausted"), "a refused start keeps its outcome visible");
  assert(!button("Run APP-2 now").disabled, "a refused start can be tried again");
  update({ jobs: [{ id: "j", taskId: "t2", state: "running" }] });
  await pause();
  assert(button("Run APP-2 now").disabled && button("Run APP-2 now").title.includes("open run"), "an open run disables the row until the list consumes it");
  button("Remove APP-1 from Session tickets").click();
  await pause();
  const dialog = document.querySelector("dialog[open]");
  assert(dialog?.textContent.includes("Remove APP-1"), "removal asks first");
  [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel").click();
  await pause();
  assert(keys().includes("APP-1") && !calls.some((c) => c.url.startsWith("/api/session-tickets")), "cancel changes nothing");
  button("Remove APP-1 from Session tickets").click();
  await pause();
  [...document.querySelector("dialog[open]").querySelectorAll("button")].find((b) => b.textContent.trim() === "Remove").click();
  for (let n = 0; n < 50 && keys().includes("APP-1"); n++) await pause();
  assert(calls.some((c) => c.url === "/api/session-tickets/t1/dismiss"), "removal posts the task identity");
  assert(keys().join() === "WEB-9,APP-2,APP-5", "the removed entry leaves the list");
  const search = root.querySelector('[aria-label="Find a ticket"]');
  search.value = "app-5"; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  assert(keys().join() === "APP-5", "search matches ticket keys");
  search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  root.querySelector('[aria-label^="Filter runs"]').click(); await pause();
  const popover = document.querySelector('.popover[aria-label="Filters"]');
  assert(popover && !popover.querySelector('[aria-label="Provider"]'), "filters open without a provider facet");
  [...popover.querySelectorAll('[role="group"][aria-label="Priority"] button')].find((b) => b.getAttribute("aria-label") === "Urgent").click(); await pause();
  assert(keys().join() === "WEB-9", "priority filters narrow the list");
  [...popover.querySelectorAll("button")].find((b) => b.textContent.trim() === "Clear all").click(); await pause();
  root.querySelector('[aria-label^="Filter runs"]').click(); await pause();
  assert(keys().join() === "WEB-9,APP-2,APP-5", "clearing restores the list");
  update({ sessionTickets: { ...state.status.sessionTickets, rows: [row("t7", "APP-7", "urgent"), ...state.status.sessionTickets.rows] } }); await pause();
  assert(keys().join() === "APP-7,WEB-9,APP-2,APP-5", "live updates replace the list in place");
  update({ sessionTickets: { ...state.status.sessionTickets, error: { at, message: "T3 /api/orchestration/shell returned HTTP 503" } } }); await pause();
  assert(root.querySelector('[role="alert"]')?.textContent.includes("Showing the last known list") && keys().length === 4, "a collection failure is shown without erasing the list");
  for (const el of [root.querySelector(".next"), root.querySelector('[aria-label="Find a ticket"]')]) { const b = el.getBoundingClientRect(); assert(b.left >= 0 && b.right <= innerWidth, "content fits the viewport"); }
  assert(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  await show({ sessionTickets: { at, error: null, rows: [] } });
  assert(root.querySelector(".empty")?.textContent.includes("No session has reported"), "an empty list says so");
  await show({ sessionTickets: undefined });
  assert(root.querySelector(".empty")?.textContent.includes("not been read yet"), "an unread state is not an empty list");
  await controls();
  await show();
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function showControls() {
  const dates = ['2026-03-01T10:00:00Z', '2026-03-01T13:00:00Z', '2026-03-01T11:00:00Z', '2026-03-01T12:00:00Z'];
  await show({ sessionTickets: { at, error: null, rows: rows.map((r, i) => ({ ...r, createdAt: dates[i] })) } });
}
async function choose(label, text) {
  const trigger = root.querySelector(`button[aria-label^="${label}"]`);
  assert(trigger, `${label} control exists`);
  trigger.click(); await pause();
  const list = document.getElementById(trigger.getAttribute('aria-controls'));
  const option = [...list.querySelectorAll('[role="option"]')].find(o => o.textContent.trim() === text);
  assert(option, `${text} is an available ${label} choice`);
  option.click(); await pause();
  if (trigger.getAttribute('aria-expanded') === 'true') { trigger.click(); await pause(); }
}
async function controls() {
  await showControls();
  assert(keys().join() === 'APP-2,APP-1,APP-5,WEB-9', 'default ordering follows ticket creation, not priority or report time');
  await choose('Creation order', 'Oldest first');
  assert(keys().join() === 'WEB-9,APP-5,APP-1,APP-2', 'oldest-first reverses ticket creation order');
  root.querySelector('[aria-label^="Filter runs"]').click(); await pause();
  await choose('Session', 'Second look');
  assert(keys().join() === 'APP-1', 'a secondary reporting session matches its ticket');
  await choose('Session', 'Plan APP-2');
  assert(keys().join() === 'APP-1,APP-2', 'selected sessions match any source and retain the chosen order');
  assert(root.querySelector('[aria-label^="Filter runs"]').getAttribute('aria-label').includes('1 active'), 'session picks count as one active facet');
  const search = root.querySelector('[aria-label="Find a ticket"]');
  search.value = 'APP-2'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(keys().join() === 'APP-2', 'session filters combine with search');
  search.value = 'absent'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(root.querySelector('.empty')?.textContent.includes('No session tickets match'), 'an unmatched session/search combination says so');
  [...document.querySelector('.popover[aria-label="Filters"]').querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear all').click(); await pause();
  assert(keys().join() === 'WEB-9,APP-5,APP-1,APP-2', 'Clear all resets session picks and search while preserving sort');
  root.querySelector('[aria-label^="Filter runs"]').click(); await pause();
  update({ sessionTickets: { ...state.status.sessionTickets, rows: [row('t7', 'APP-7', 'urgent', { createdAt: '2026-03-01T14:00:00Z' }), ...state.status.sessionTickets.rows] } }); await pause();
  assert(keys().join() === 'WEB-9,APP-5,APP-1,APP-2,APP-7', 'live additions respect oldest-first order');
  await choose('Creation order', 'Newest first');
  assert(keys()[0] === 'APP-7', 'newest-first puts the live addition first');
  root.querySelector('[aria-label^="Filter runs"]').click(); await pause();
  await choose('Session', 'Plan APP-2');
  update({ sessionTickets: { ...state.status.sessionTickets, rows: state.status.sessionTickets.rows.filter(r => r.taskId !== 't2') } }); await pause();
  assert(!keys().length && root.querySelector('button[aria-label="Session"]').textContent.includes('Session no longer listed'), 'a disappearing session retains an honest active constraint');
  update({ sessionTickets: { ...state.status.sessionTickets, rows: [row('t8', 'APP-8', 'low', { sources: rows[1].sources }), ...state.status.sessionTickets.rows] } }); await pause();
  assert(keys().join() === 'APP-8', 'new tickets from the selected source appear without widening the filter');
  root.querySelector('[aria-label^="Filter runs"]').click(); await pause();
  assert(document.documentElement.scrollWidth <= innerWidth, 'sorting and filtering controls fit the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function showError() { await show({ sessionTickets: { at, error: { at, message: "T3 /api/orchestration/shell returned HTTP 503" }, rows } }); }
async function showEmpty() { await show({ sessionTickets: { at, error: null, rows: [] } }); }
window.sessionTests = { run, show, showControls, controls, showError, showEmpty };
await show();
