// Synthetic session tickets, the actual page, store and dispatch path. No live sessions, tickets or dispatches.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { applyState, operations, status, notice, blocked, serverNow } from "../../web/lib/store.js";
import { App } from "../../web/views/App.js";
import { route, match } from "../../web/lib/router.js";

const root = document.querySelector("#root");
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const at = new Date(Date.now() - 90_000).toISOString();
const row = (taskId, key, priority, extra = {}) => ({ taskId, projectId: "p", project: "Example", key, number: Number(key.split("-")[1]), title: `Ticket ${key}`, priority, status: "todo", labels: ["feat", "web"], difficulty: "med", createdAt: at, refreshedAt: at, refreshError: null,
  sources: [{ threadId: `thread-${taskId}`, messageId: `m-${taskId}`, title: `Plan ${key}`, at }], unavailable: null, ...extra });
// Rows arrive in the scheduler's order: priority, then project key and number.
const rows = [
  row("t9", "WEB-9", "urgent", { projectId: "q", project: "Other project", labels: ["bug"], difficulty: "low", unavailable: "Project not configured in Factory" }),
  row("t2", "APP-2", "high"),
  row("t5", "APP-5", "medium", { labels: ["chore"], difficulty: null, refreshError: "Kanvil get_task failed; check its authenticated connection" }),
  row("t1", "APP-1", "low", { title: "Dismissed later in the test", sources: [{ threadId: "thread-t1", messageId: "m-t1", title: "Plan APP-1", at }, { threadId: "thread-t1b", messageId: "m-t1b", title: "Second look", at }, { threadId: "thread-t1c", messageId: "m-t1c", title: "Third look", at }] }),
];
const base = {
  config: { enabled: false, kanvil: { url: "https://tracker.example", workspaceId: "w" }, models: [{ id: "preset-sol", name: "Sol", model: { instanceId: "codex", model: "sol" } }], projects: [{ kanvilId: "p", key: "APP", name: "Example", enabled: true, priorityLabels: ["agent-compat"] }] },
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
const button = (label) => [...root.querySelectorAll(`[aria-label="${label}"]`)].find(el => el.getClientRects().length);
async function more(key) {
  if (innerWidth <= 900 && !document.querySelector(`.popover[aria-label="More actions for ${key}"]`)) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause();
    button(`More actions for ${key}`).click(); await pause();
  }
}
async function show(patch = {}) {
  operations.value = [];
  notice.value = null;
  blocked.value = null;
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
  assert(first.querySelector('a[href="/api/threads/thread-t9/open"]')?.getAttribute("aria-label").includes("T3 Code"), "the source session opens through the desktop-link resolver");
  assert(first.textContent.includes("Plan WEB-9") && !first.textContent.includes("from Plan WEB-9"), "the originating session is named without a prefix");
  assert(root.querySelectorAll(".next")[2].textContent.includes("tracker read failed"), "a failed refresh is not shown as fresh");
  await more('APP-2');
  assert(!button("Run APP-2 now").closest("a") && !button("Remove APP-2 from Session tickets").closest("a"), "actions sit beside the tracker link, not inside it");
  if (innerWidth <= 900) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause(); }
  const many = [...root.querySelectorAll(".next")].find((r) => r.textContent.includes("APP-1"));
  assert(many.querySelectorAll('a[href^="/api/threads/"]').length === 1 && many.querySelector('a[href^="/api/threads/"]').title.includes("2 more"), "several sources collapse into one session action");
  assert(many.getBoundingClientRect().right <= innerWidth && many.textContent.includes("Third look"), "all sources are named without widening the row");
  const tray = () => document.querySelector('.popover[aria-label="Issues"]');
  button("Run APP-2 now").click();
  await pause();
  assert(button("Run APP-2 now").disabled, "a pending request disables its row");
  assert(!root.querySelector(".operation"), "starting a ticket adds no request row to the page");
  assert(keys().join() === "APP-2,WEB-9,APP-5,APP-1", "the ticket being started moves to the top and the others keep their order");
  assert(root.querySelector(".next .spinner") && /Queued|Waiting for scheduler progress|Checking/.test(root.querySelector(".next").textContent), "the started row shows its request progress inline");
  button("Run APP-2 now").click();
  await pause();
  assert(calls.filter((c) => c.url === "/api/dispatch").length === 1, "rapid clicks produce one request");
  release();
  for (let n = 0; n < 100 && operations.value.some((op) => op.state !== "done"); n++) await pause();
  assert(JSON.stringify(calls[0].input) === JSON.stringify({ ticket: "APP-2", model: "auto", overrideLimits: true }), "Run passes the captured key with automatic model selection");
  assert(!root.querySelector(".operation") && keys().join() === "WEB-9,APP-2,APP-5,APP-1" && !root.querySelector(".next .spinner"), "a refused start returns the row to its place without a request row");
  assert(root.querySelector("button.conn .badge")?.textContent === "1" && !tray(), "a refused start adds a notification without opening the list");
  root.querySelector("button.conn").click(); await pause();
  assert(tray()?.querySelector(".issue-title")?.textContent === "Couldn't start APP-2" && tray().textContent.includes("quota-exhausted"), "the notification names the ticket and the refusal");
  assert(!button("Run APP-2 now").disabled, "a refused start can be tried again");
  tray().querySelector('[aria-label="Dismiss APP-2"]').click(); await pause();
  assert(!operations.value.length && !root.querySelector("button.conn") && !tray(), "dismissing the notification clears the request");
  update({ jobs: [{ id: "j", taskId: "t2", state: "running" }] });
  await pause();
  assert(button("Run APP-2 now").disabled && button("Run APP-2 now").title.includes("open run"), "an open run disables the row until the list consumes it");
  assert(keys()[0] === "APP-2", "a started ticket stays on top until the list consumes it");
  update({ jobs: [] });
  await pause();
  await more('APP-1');
  button("Remove APP-1 from Session tickets").click();
  await pause();
  const dialog = document.querySelector("dialog[open]");
  assert(dialog?.textContent.includes("Remove APP-1"), "removal asks first");
  [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel").click();
  await pause();
  assert(keys().includes("APP-1") && !calls.some((c) => c.url.startsWith("/api/session-tickets")), "cancel changes nothing");
  await more('APP-1');
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
  update({ sessionTickets: { ...state.status.sessionTickets, error: { at, message: "Couldn't confirm 2 reported tickets: Kanvil live updates are reconnecting", problems: [{ title: "Couldn't confirm 2 reported tickets", cause: "Kanvil live updates are reconnecting", raw: ["Kanvil project stream is not synchronized"], subjects: ["mo00pnjvld201d3etqq5ywzm", "APP-9"] }] } } }); await pause();
  const indicator = root.querySelector("button.conn");
  assert(indicator?.querySelector(".badge")?.textContent === "1" && !root.querySelector('[role="alert"]') && keys().length === 4, "a collection failure adds a count to the top bar, without a page alert or erasing the list");
  assert(root.querySelector(".stale-list").textContent.includes("Couldn't confirm 2 reported tickets: Kanvil live updates are reconnecting"), "the page identifies the failed operation instead of claiming the whole list is stale");
  assert(!tray(), "issues never open on their own");
  root.querySelector(".stale-list button").click(); await pause();
  assert(tray()?.querySelector(".issue-title")?.textContent === "Couldn't confirm 2 reported tickets", "the page opens the issue list, problem first in plain words");
  assert(tray().textContent.includes("Last failure") && !tray().textContent.includes("first failed"), "the timestamp describes the recorded failure without claiming it was the first");
  assert(tray().querySelector("details:not([open]) .issue-subjects")?.textContent.includes("APP-9"), "affected tickets sit behind a closed disclosure");
  indicator.click(); await pause();
  assert(!tray(), "the indicator closes the list");
  update({ sessionTickets: { ...state.status.sessionTickets, error: { at, message: "T3 /api/orchestration/shell returned HTTP 503" } } }); await pause();
  root.querySelector("button.conn").click(); await pause();
  assert(tray()?.querySelector(".issue-title")?.textContent === "T3 /api/orchestration/shell returned HTTP 503", "a saved error without problems still shows its message");
  update({ sessionTickets: { ...state.status.sessionTickets, error: null } }); await pause();
  assert(!tray() && !root.querySelector("button.conn") && root.querySelector('.conn[role="status"]') && !root.querySelector(".stale-list"), "clearing the last issue closes the list and restores the plain indicator");
  for (const el of [root.querySelector(".next"), root.querySelector('[aria-label="Find a ticket"]')]) { const b = el.getBoundingClientRect(); assert(b.left >= 0 && b.right <= innerWidth, "content fits the viewport"); }
  assert(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  await show({ sessionTickets: { at, error: null, rows: [] } });
  assert(root.querySelector(".empty")?.textContent.includes("No session has reported"), "an empty list says so");
  await show({ sessionTickets: undefined });
  assert(root.querySelector(".empty")?.textContent.includes("not been read yet"), "an unread state is not an empty list");
  await controls();
  await startNotices();
  await show();
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
// Unfinished outcomes of starts from this page live in the notification area with their actions; requests from other pages keep their rows.
async function startNotices() {
  await show();
  const input = (ticket) => ({ ticket, model: "auto", overrideLimits: true });
  operations.value = [
    { id: "b", kind: "dispatch", origin: "session-tickets", state: "done", input: input("APP-5"), result: { data: { reason: "blocked-ticket-plan-required", message: "APP-5 waits on APP-1.", ticket: "APP-5", tree: { tickets: [] } } } },
    { id: "u", kind: "dispatch", origin: "session-tickets", state: "uncertain", notReceived: true, input: input("APP-2"), result: { data: { message: "The server has no record of this request." } } },
    { id: "d", kind: "dispatch", state: "done", input: input("APP-1"), result: { data: { reason: "quota-exhausted" } } },
  ];
  await pause();
  const tray = () => document.querySelector('.popover[aria-label="Issues"]');
  assert(root.querySelectorAll(".operation").length === 1 && root.querySelector(".operation").textContent.includes("APP-1"), "a request started elsewhere keeps its row");
  assert(keys().join() === "WEB-9,APP-2,APP-5,APP-1" && button("Run APP-2 now").disabled, "unfinished starts leave rows in place and keep an uncertain request held");
  assert(root.querySelector("button.conn .badge")?.textContent === "2" && !tray(), "each unfinished start from this page adds one notification");
  root.querySelector("button.conn").click(); await pause();
  const titles = [...tray().querySelectorAll(".issue-title")].map((e) => e.textContent);
  assert(titles.join() === "APP-5 waits on other tickets,Couldn't confirm APP-2 started", "notifications name each ticket and outcome");
  assert(tray().textContent.includes("Session ticket starts") && tray().textContent.includes("Not started"), "start problems have their own source heading");
  const actionsOf = (key) => [...tray().querySelectorAll(".issue")].find((e) => e.textContent.includes(key)).querySelector(".issue-actions").textContent;
  assert(actionsOf("APP-2").includes("Retry saved request") && actionsOf("APP-5").includes("Choose how to run it"), "notifications offer retry and chain choice");
  const b = tray().getBoundingClientRect();
  assert(b.left >= 0 && b.right <= innerWidth, "the notification list fits the viewport");
  [...tray().querySelectorAll("button")].find((el) => el.textContent.trim() === "Choose how to run it").click(); await pause();
  assert(document.querySelector("dialog[open]")?.textContent.includes("APP-5 waits on") && !tray(), "the chain choice opens from the notification and replaces the list");
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
async function showError() {
  const stream = "Kanvil project stream is not synchronized";
  await show({ sessionTickets: { at, error: { at, message: "Couldn't confirm 3 reported tickets: Kanvil live updates are reconnecting", problems: [
    { title: "Couldn't confirm 3 reported tickets", cause: "Kanvil live updates are reconnecting", raw: [stream], subjects: ["mo00pnjvld201d3etqq5ywzm", "cfj9ytgktl52dj5s3ndnrpoe", "aflah8jsfawxrzr3t1al9ah3"] },
    { title: "Couldn't refresh 1 listed ticket", cause: "Kanvil returned HTTP 503", raw: [], subjects: ["APP-2"] },
  ] }, rows } });
}
async function showEmpty() { await show({ sessionTickets: { at, error: null, rows: [] } }); }
async function bulk() {
  calls = [];
  await show();
  const pick = key => button(`Select ${key}`);
  const enter = async () => { button('Select tickets').click(); await pause(); };
  assert(!root.querySelector('.next input[type=checkbox]') && !root.querySelector('.selection-bar'), 'normal browsing hides selection checkboxes and bulk controls');
  assert(button('Select tickets')?.querySelector('svg') && !button('Select tickets').textContent.trim(), 'selection mode uses an icon-only library button');
  await enter();
  for (const name of ['Done selecting tickets', 'Run selected tickets', 'Remove selected tickets']) assert(button(name)?.querySelector('svg') && !button(name).textContent.trim() && button(name).title, `${name} has an icon, accessible name and tooltip without button text`);
  pick('APP-2').click(); await pause();
  button('Done selecting tickets').click(); await pause();
  assert(!root.querySelector('.next input[type=checkbox]') && !root.querySelector('.selection-bar'), 'Done restores the ordinary list');
  await enter();
  assert(!pick('APP-2').checked && root.textContent.includes('0 selected'), 'leaving selection mode clears its selection');
  assert(pick('APP-2')?.type === 'checkbox', 'tickets have accessible selection checkboxes');
  pick('APP-2').click(); pick('APP-5').click(); await pause();
  button('Run selected tickets').click(); await pause();
  assert(operations.value.length === 2 && operations.value.every(op => ['APP-2', 'APP-5'].includes(op.input.ticket)), 'bulk Run queues only selected keys through ordinary operations');
  assert(!root.querySelector('.operation') && keys().slice(0, 2).join() === 'APP-2,APP-5', 'bulk Run moves the started tickets to the top without request rows');
  button('Run selected tickets').click(); release();
  for (let n = 0; n < 100 && operations.value.some(op => op.state !== 'done'); n++) await pause();
  assert(calls.filter(c => c.url === '/api/dispatch').length === 2, 'bulk Run does not duplicate requests');
  assert(root.querySelector('button.conn .badge')?.textContent === '2' && keys().join() === 'WEB-9,APP-2,APP-5,APP-1', 'each refused bulk start returns to the list and adds its own notification');
  assert(calls.filter(c => c.url === '/api/dispatch').every(c => c.input.model === 'auto' && c.input.overrideLimits === true), 'bulk Run uses the single-row dispatch contract');
  await show();
  await enter();
  pick('WEB-9').click(); await pause();
  assert(button('Run selected tickets').disabled, 'an unavailable selected ticket blocks bulk Run with its ordinary hold');
  button('Select visible tickets').click(); await pause();
  assert([...root.querySelectorAll('.next input[type=checkbox]')].every(el => el.checked), 'Select visible selects the shown list');
  const search = root.querySelector('[aria-label="Find a ticket"]');
  search.value = 'APP-5'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(keys().join() === 'APP-5' && pick('APP-5').checked && root.textContent.includes('1 selected'), 'filter changes drop hidden selections');
  calls = [];
  button('Remove selected tickets').click(); await pause();
  let dialog = document.querySelector('dialog[open]');
  assert(dialog?.textContent.includes('APP-5') && dialog.textContent.includes('unchanged'), 'bulk Remove reviews captured keys and preserves tracker tickets');
  [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel').click(); await pause();
  assert(!calls.length && keys().includes('APP-5'), 'cancelled bulk Remove performs no writes');
  button('Remove selected tickets').click(); await pause();
  dialog = document.querySelector('dialog[open]');
  [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove').click();
  for (let n = 0; n < 100 && keys().length; n++) await pause();
  assert(calls.filter(c => c.url.includes('/dismiss')).map(c => c.url).join() === '/api/session-tickets/t5/dismiss', 'bulk Remove dismisses only the reviewed visible selection');
  assert(!root.querySelector('.selection-bar'), 'a live-empty list clears its bulk controls');
  await show();
  await enter();
  button('Select visible tickets').click(); await pause();
  button('Select visible tickets').click(); await pause();
  assert([...root.querySelectorAll('.next input[type=checkbox]')].every(el => !el.checked), 'Select visible also clears selection');
  assert(document.documentElement.scrollWidth <= innerWidth, 'selection controls fit the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function compactRows() {
  const createdAt = new Date(serverNow() - (3600 + 52 * 60 + 5) * 1000).toISOString();
  await show({ sessionTickets: { at, error: null, rows: rows.map(r => ({ ...r, createdAt, sources: r.taskId === 't1' ? [...r.sources, { ...r.sources[0], threadId: 'long', title: 'LongSessionName'.repeat(12) }] : r.sources })) } });
  const first = root.querySelector('.next');
  assert(first.textContent.includes('Plan WEB-9') && !first.textContent.includes('from Plan'), 'session names have no from prefix');
  assert(!first.textContent.includes('created ') && !first.textContent.includes('checked '), 'rows omit created and checked labels');
  assert(first.textContent.includes('1h 52m ago'), 'creation age uses compact units');
  assert(first.querySelector(`[title="${new Date(createdAt).toLocaleString()}"]`), 'creation age retains its absolute date tooltip');
  assert(root.textContent.includes('tracker read failed') && !root.querySelectorAll('.next')[2].textContent.includes('checked '), 'failed reads retain a concise warning');
  const rects = [...first.querySelectorAll('.next-run')].filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect());
  assert(rects.length === (innerWidth <= 900 ? 2 : 3), 'mobile exposes visible Start and overflow while desktop keeps all actions');
  assert(!matchMedia('(pointer: coarse)').matches || rects.every(r => r.width >= 44 && r.height >= 44), 'touch actions retain 44px targets');
  assert(rects.every(r => Math.abs(r.top - rects[0].top) < 1), 'actions never force a vertical stack');
  assert(document.documentElement.scrollWidth <= innerWidth, 'long sources and stacked actions fit the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function rowHeight() {
  await show({ sessionTickets: { at, error: null, rows: [row('t2', 'APP-2', 'high', { title: 'App: every write shows its result immediately', difficulty: 'high', labels: ['bug', 'sf', 'high', 'app'], sources: [{ threadId: 'thread-t2', title: 'Fix Immediate Action Feedback', at }] })] } });
  const entry = root.querySelector('.next'), height = entry.getBoundingClientRect().height;
  assert(button('Run APP-2 now'), 'Start stays visible before opening the mobile menu');
  assert(innerWidth > 900 || height <= entry.querySelector('.next-ticket').getBoundingClientRect().height + 1.5, `mobile row height follows its content with visible Start, got ${height}px`);
  if (innerWidth <= 900) {
    const title = entry.querySelector('.row-body > span').getBoundingClientRect(), actions = entry.querySelector('.next-actions').getBoundingClientRect(), facets = entry.querySelector('.row-body > small').getBoundingClientRect();
    assert(title.right > actions.left && title.bottom <= actions.top + 0.5, 'the title uses the full row width above the actions');
    assert(facets.bottom >= actions.bottom - 0.5, 'the actions sit beside the facet lines without adding height');
    await more('APP-2');
    const panel = document.querySelector('.popover[aria-label="More actions for APP-2"]');
    assert(panel && ['Open session', 'Remove'].every(label => panel.textContent.includes(label)) && !panel.querySelector('[aria-label="Run APP-2 now"]'), 'menu contains only secondary actions');
    assert(panel.querySelector('a').getAttribute('href') === '/api/threads/thread-t2/open', 'overflow preserves the source resolver');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause();
    assert(!document.querySelector('.popover[aria-label="More actions for APP-2"]') && document.activeElement === button('More actions for APP-2'), 'Escape closes overflow and restores focus');
  }
  return { passed: true, viewport: [innerWidth, innerHeight], rowHeight: height };
}
async function overflowEdges() {
  if (innerWidth > 900) return { passed: true, mobile: false };
  await show({ sessionTickets: { at, error: null, rows: Array.from({ length: 12 }, (_, i) => row(`t${i}`, `APP-${i}`, 'high')) } });
  const entry = button('More actions for APP-6');
  scrollBy(0, entry.getBoundingClientRect().bottom - innerHeight + 12);
  await more('APP-6');
  const panel = document.querySelector('.popover[aria-label="More actions for APP-6"]'), rect = panel.getBoundingClientRect();
  assert(rect.top >= 8 && rect.bottom <= innerHeight - 8 && panel.scrollHeight <= panel.clientHeight + 2, 'overflow remains usable at the viewport bottom');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await pause();
  assert(!document.querySelector('.popover[aria-label="More actions for APP-6"]'), 'outside click closes overflow');
  scrollTo(0, 0);
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
window.sessionTests = { unavailableProjects, readiness, run, startNotices, show, showControls, controls, bulk, compactRows, rowHeight, overflowEdges, showError, showEmpty };
await show();

async function unavailableProjects() {
  const reason = 'Project disabled in Factory settings';
  const tickets = [row('disabled', 'APP-1', 'high', { unavailable: reason }), row('missing', 'WEB-9', 'medium', { projectId: 'q', unavailable: 'Project not configured in Factory' }), row('enabled', 'APP-2', 'low')];
  await show({ sessionTickets: { at, error: null, rows: tickets } });
  for (const ticket of tickets.filter(t => t.unavailable)) {
    const entry = [...root.querySelectorAll('.next')].find(el => el.querySelector('.key').textContent === ticket.key);
    const symbol = entry.querySelector('.icon-circleSlash[role="img"]');
    assert(symbol?.getAttribute('aria-label') === ticket.unavailable, `${ticket.key} shows a named circle-slash symbol`);
    assert(symbol.closest('[title]')?.title === ticket.unavailable, `${ticket.key} retains its exact former text as the hover tooltip`);
    assert(![...symbol.parentElement.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()), 'unavailable reasons have no inline text');
    assert(symbol.getBoundingClientRect().width <= 24, 'unavailable symbols stay compact');
    assert(button(`Run ${ticket.key} now`).disabled && button(`Run ${ticket.key} now`).title === ticket.unavailable, 'Run stays disabled with its full reason');
  }
  const symbols = () => root.querySelectorAll('.next .icon-circleSlash');
  assert(symbols().length === 2, 'only unavailable projects show the symbol');
  update({ sessionTickets: { at, error: null, rows: tickets.map(t => ({ ...t, unavailable: null, projectId: 'p' })) } }); await pause();
  assert(!symbols().length && tickets.every(t => !button(`Run ${t.key} now`).disabled), 'configuring and enabling projects removes their symbols and holds on live update');
  update({ sessionTickets: { at, error: null, rows: tickets } }); await pause();
  assert(symbols().length === 2 && button('Run APP-1 now').disabled && button('Run WEB-9 now').disabled, 'unavailable projects regain their symbols and holds on live update');
  assert(document.documentElement.scrollWidth <= innerWidth, 'unavailable project symbols fit the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}


async function readiness() {
  const readyRows = [row('ready', 'APP-1', 'high', { automationReady: true, labels: [] }), row('held', 'APP-2', 'medium', { automationReady: false, labels: ['sf'] }), row('unknown', 'APP-3', 'low', { labels: ['sf'] })];
  await show({ sessionTickets: { at, error: null, rows: readyRows } });
  const icons = () => root.querySelectorAll('.next [role="img"][aria-label="Automation ready"]');
  assert(icons().length === 1 && icons()[0].closest('.next').querySelector('.key').textContent === 'APP-1', 'session tickets show native readiness only');
  update({ sessionTickets: { at, error: null, rows: readyRows.map(t => ({ ...t, automationReady: t.taskId === 'held' })) } }); await pause();
  assert(icons().length === 1 && icons()[0].closest('.next').querySelector('.key').textContent === 'APP-2', 'live session readiness moves the same shared symbol');
  assert(document.documentElement.scrollWidth <= innerWidth, 'session readiness symbols fit the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
