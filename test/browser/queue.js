// Synthetic data, actual queue component and dispatch store. No live dispatches.
import { openSearch, checkPageHead } from "./search.js";
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { applyState, operations, status, history, setSessionProvider, setSessionOverrides, startRun } from "../../web/lib/store.js";
import * as Deck from "../../web/views/Deck.js";
import { Runs } from "../../web/views/Runs.js";
import { Confirmation } from "../../web/ui/index.js";

const root = document.querySelector("#root");
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ticket = (n, modelId = "preset-sol") => ({ id: `t${n}`, key: `APP-${n}`, title: `Queued ticket ${n}`, projectId: "p", difficulty: "med", priority: n === 1 ? "high" : "medium", labelRank: 0, modelId, model: modelId ? "Sol" : null });
const state = {
  config: { enabled: false, kanvil: { url: "https://tracker.example", workspaceId: "w" }, models: [{ id: "preset-sol", name: "Sol", model: { instanceId: "codex", model: "sol" } }], projects: [{ kanvilId: "p", name: "Example", priorityLabels: ["agent-compat"] }] },
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
    const first = button(1);
    try {
      first.click();
      await pause();
      assert(!button(1), "starting request replaces the clicked queue row");
      assert(root.querySelectorAll('.operation').length === 1, "one request row represents the starting ticket");
      first.click();
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
    assert(!button(1), "uncertain request replaces its queue row regardless of key casing");
    operations.value = [];
    status.value = { ...state.status, jobs: [{ taskId: "t1", state: "running" }] };
    await pause();
    assert(!button(1), "an open run replaces a stale queue row");
    status.value = { ...state.status, plans: [{ state: "active", target: { id: "t1" } }] };
    await pause();
    assert(!button(1), "an active chain replaces its target before the target has a job");
    assert(!button(2).disabled, "an active chain leaves other tickets available");
    status.value = { ...state.status, plans: [{ state: "cancelled", target: { id: "t1" } }] };
    await pause();
    assert(!button(1).disabled, "a cancelled chain does not hold its target");
    const b = button(2).getBoundingClientRect();
    assert(b.left >= 0 && b.right <= innerWidth && b.height >= (matchMedia("(pointer: coarse)").matches ? 44 : 32), "action fits viewport with usable target");
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
    assert(!rows.some(row => /Sol|no automatic model/.test(row.textContent)), "queue omits predicted models");
    assert(rows[0].querySelector(".meta-project").textContent === "Example", "project sits beside the ticket");
    assert(rows[0].querySelector('.tag[title^="Priority"]').textContent === "Phigh" && rows[0].querySelector('.tag[title^="Difficulty"]').textContent === "Dmed", "priority and difficulty tags say which field they are");
    assert(rows.every(row => {
      const link = row.querySelector(".next-ticket");
      return row.querySelector(".row-body").getBoundingClientRect().left === link.getBoundingClientRect().left + parseFloat(getComputedStyle(link).paddingLeft);
    }), "ticket text uses the former rank column");
    assert(document.documentElement.scrollWidth <= innerWidth, "compact queue fits the viewport");
  }
  return { passed: true, viewport: [innerWidth, innerHeight], contexts: ["deck", "runs"] };
}
const filterState = {
  config: { ...state.config, projects: [{ kanvilId: "p", key: "APP", name: "Alpha" }, { kanvilId: "q", key: "WEB", name: "Beta" }, { kanvilId: "empty", key: "EMPTY", name: "Empty" }] },
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
const dialog = () => document.querySelector('.popover[aria-label="Filters"]');
const picker = (group) => dialog().querySelector(`[role="combobox"][aria-label="${group}"]`);
// The names a dropdown facet offers right now; opens it if needed and leaves it open.
async function choicesOf(group) {
  const button = picker(group);
  if (button.getAttribute("aria-expanded") !== "true") { button.click(); await pause(); }
  return [...document.getElementById(button.getAttribute("aria-controls")).children].map(li => li.textContent).join();
}
const byText = (selector, text, scope = root) => [...scope.querySelectorAll(selector)].find(e => e.textContent.trim() === text);
const filterButton = () => root.querySelector('[aria-label^="Filter runs"]');
async function openFilters() {
  assert(filterButton(), "Runs exposes a Filter button");
  if (!dialog()) { filterButton().click(); await pause(); }
  assert(dialog(), "the Filter button opens the filter popover");
}
// Buttons toggle directly; dropdown facets open their picker if needed and leave it open like a user mid-pick.
async function pickFilter(group, name) {
  const row = dialog().querySelector(`[role="group"][aria-label="${group}"]`);
  if (row) { [...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()) === name).click(); await pause(); return; }
  const button = picker(group);
  if (button.getAttribute("aria-expanded") !== "true") { button.click(); await pause(); }
  byText('[role="option"]', name, document.getElementById(button.getAttribute("aria-controls"))).click();
  await pause();
}
async function closeFilters() { if (dialog()) { filterButton().click(); await pause(); } assert(!dialog(), "the filter popover closes"); }
async function clearFilters() { byText("button", "Clear all", dialog()).click(); await pause(); }
async function runProjects() {
  setSessionProvider("auto"); setSessionOverrides(["labels"]);
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
    assert([...root.querySelectorAll(".next .tag-label")].map(e => e.textContent).join() === "bug,web,bug,web", "queue rows show their tracker labels");
    assert(root.querySelector(".held .tag-label"), "held rows show their tracker labels");
    await openFilters();
    assert(!dialog().querySelector('[aria-label="Provider"]'), "queue does not filter predicted providers");
    await pickFilter("Project", "Alpha");
    assert(queueKeys() === "APP-1,APP-3", `Project Alpha must show only its queue tickets; got ${queueKeys()}`);
    assert(await choicesOf("Tags") === "bug,web", "tag choices come from the chosen projects");
    assert(heldKeys() === "APP-4", "held tickets follow project filtering");
    assert(root.querySelector("h2 small").textContent === "2", "queue count follows filters");
    await pickFilter("Project", "Beta");
    assert(queueKeys() === "APP-1,WEB-2,APP-3", "multiple projects use OR");
    await pickFilter("Project", "Beta");
    await pickFilter("Tags", "bug");
    await pickFilter("Tags", "web");
    assert(queueKeys() === "APP-1,APP-3", "tag OR matches either selected label");
    assert(await choicesOf("Project") === "Alpha,Beta", "project choices come from the chosen tags");
    byText('[role="radio"]', "ALL", dialog()).click(); await pause();
    assert(queueKeys() === "APP-1", "tag AND requires all selected labels");
    assert(await choicesOf("Project") === "Alpha", "project choices follow the tag match mode");
    await pickFilter("Difficulty", "Medium");
    await pickFilter("Priority", "High");
    assert(queueKeys() === "APP-1" && heldKeys() === "APP-4", "categories combine for queue and held tickets");
    assert(picker("Tags").textContent === "bug +1", "the tag picker summarises its picks");
    assert(dialog().querySelectorAll('[aria-pressed="true"]').length === 2, "difficulty and priority buttons show their state");
    byText("button", "×", dialog()).click(); await pause();
    assert(picker("Tags").textContent === "Any" && dialog().querySelectorAll('[aria-pressed="true"]').length === 2, "the tag clear button empties only tags");
    assert(await choicesOf("Without") === "bug,web", "excluded tags offer the same catalog as tags");
    await pickFilter("Without", "web");
    assert(queueKeys() === "" && heldKeys() === "", "an excluded tag hides queue and held rows that carry it");
    assert(filterButton().textContent.trim() === "4", "excluded tags count as their own active category");
    await pickFilter("Without", "web"); await pickFilter("Without", "bug");
    assert(queueKeys() === "" && heldKeys() === "", "any excluded tag hides a row");
    await pickFilter("Tags", "web");
    assert(queueKeys() === "" && picker("Tags").textContent === "web", "exclusion wins over an include match");
    byText("button", "×", dialog()).click(); await pause();
    assert(picker("Tags").textContent === "Any" && picker("Without").textContent === "None" && queueKeys() === "APP-1" && heldKeys() === "APP-4", "the tag clear button empties both tag pickers and nothing else");
    await pickFilter("Tags", "bug"); await pickFilter("Tags", "web");
    byText('[role="radio"]', "ALL", dialog()).click(); await pause();
    await closeFilters();
    assert(filterButton().textContent.trim() === "4", "button reports active categories");
    status.value = { ...status.value, upNext: { ...status.value.upNext, tickets: [...filterState.status.upNext.tickets, { ...filterState.status.upNext.tickets[0], id: "t6", key: "APP-6" }] } };
    await pause();
    assert(queueKeys() === "APP-1,APP-6", "live updates retain filters and order");
    const search = await openSearch();
    search.value = "uploads"; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    assert(queueKeys() === "APP-1,APP-6", "queue search matches titles");
    search.value = "APP-6"; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    assert(queueKeys() === "APP-6", "queue search matches ticket keys");
    button(6).click(); await pause();
    assert(JSON.stringify(dispatches[0]) === JSON.stringify({ ticket: "APP-6", model: "auto", overrideLimits: ["labels"] }), "filtered Run now captures header overrides");
    search.value = "APP-4"; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    assert(queueKeys() === "" && heldKeys() === "APP-4", "search can match only a held ticket");
    assert(!root.textContent.includes("No tickets match."), "matching held tickets must not be described as no matches");
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    byText('[role="radio"]', "Open3").click(); await pause();
    assert(root.querySelectorAll(".next").length === 1, "ordinary runs use the same metadata filters");
    assert([...root.querySelectorAll(".next .tag-label")].map(e => e.textContent).join() === "bug,web", "run rows show their tracker labels");
    await openFilters();
    assert(dialog().querySelector('[role="group"][aria-label="Provider"] .icon'), "recorded runs filter by provider with icon buttons");
    await clearFilters();
    await closeFilters();
    assert(root.querySelectorAll(".next").length === 3, "legacy runs stay visible with no metadata filters");
    await openFilters();
    await pickFilter("Provider", "Claude");
    await closeFilters();
    assert(root.querySelectorAll(".next").length === 1, "provider filters actual recorded runs");
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
    assert(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, "filter popover fits the viewport");
    status.value = { ...status.value, upNext: { ...status.value.upNext, tickets: [{ ...filterState.status.upNext.tickets[0], labels: Array.from({ length: 50 }, (_, i) => `scope-${i}`) }] } };
    await pause();
    await pickFilter("Tags", "scope-49");
    const menu = document.getElementById(picker("Tags").getAttribute("aria-controls")).getBoundingClientRect();
    assert(menu.right <= innerWidth && menu.bottom <= innerHeight, "a large tag catalog scrolls inside its menu");
    await clearFilters();
    await closeFilters();
    return { passed: true, viewport: [innerWidth, innerHeight], filters: ["project", "tags OR/AND", "without tags", "difficulty", "priority", "search", "provider on runs"] };
  } finally { window.fetch = oldFetch; window.history.replaceState(null, "", oldUrl); }
}
async function progress() {
  await show();
  operations.value = [
    { id: 'queued', input: { ticket: 'APP-1', model: 'auto' }, state: 'running', progress: { phase: 'queued', stage: 'queued' } },
    { id: 'checking', input: { ticket: 'APP-2', model: 'auto' }, state: 'running', progress: { phase: 'checking', stage: 't3.rpc.provider, kanvil.get_task' } },
    { id: 'expired', input: { ticket: 'APP-3', model: 'auto' }, state: 'done', result: { data: { notLaunched: true, reason: 'manual-deadline-exceeded', message: 'Not launched: manual request deadline exceeded during kanvil.connect' } } },
    { id: 'old', input: { ticket: 'APP-4', model: 'auto' }, state: 'running' },
  ];
  await pause();
  const rows = [...root.querySelectorAll('.operation')];
  assert(rows[0].textContent.includes('Queued at scheduler'), 'accepted request identifies scheduler queue wait');
  assert(rows[1].textContent.includes('t3.rpc.provider, kanvil.get_task'), 'checking row names held integrations');
  assert(rows[2].textContent.includes('Not launched') && !rows[2].querySelector('.spinner'), 'deadline outcome is terminal');
  assert(rows[3].textContent.includes('Waiting for scheduler progress'), 'older records do not claim checking without progress');
  assert(document.documentElement.scrollWidth <= innerWidth, 'request states fit the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function runsControls() {
  calls = [];
  setSessionProvider("auto"); setSessionOverrides(["labels"]);
  window.fetch = async (url, init) => {
    if (url === "/api/history") return Response.json(filterJobs);
    if (url === "/api/dispatch") {
      const input = JSON.parse(init.body), id = init.headers["Idempotency-Key"];
      calls.push(input);
      return Response.json({ id, input, state: "done", result: { data: { reason: "quota-exhausted" } } });
    }
    return Response.json({ ...filterState, status: status.value });
  };
  await showProjects();
  const providers = () => root.querySelector('[role="radiogroup"][aria-label="Start provider"]');
  const limits = () => [...root.querySelectorAll('[role="group"][aria-label="Override limits"] button')];
  assert(providers(), "Runs exposes the shared Start provider header");
  assert(limits().length === 4, "Runs exposes all shared override choices");
  button(1).click(); await pause();
  assert(JSON.stringify(calls[0]) === JSON.stringify({ ticket: "APP-1", model: "auto", overrideLimits: ["labels"] }), "Auto captures selected overrides");
  providers().querySelector('[aria-label="Codex: override all scheduler limits"]').click(); await pause();
  assert(limits().every(b => b.disabled), "explicit provider disables override editing");
  root.querySelector('[aria-label="Run WEB-2 now"]').click(); await pause();
  assert(calls[1]?.provider === "codex" && calls[1]?.overrideLimits === true, "provider choice reaches queue dispatch");
  operations.value = [{ id: "pending", input: { ticket: "APP-1" }, state: "uncertain" }]; await pause();
  assert(!button(1), "pending duplicate leaves the queue with header choices");
  assert(queueKeys() === "WEB-2,APP-3", "remaining tickets preserve scheduler order");
  assert(heldKeys() === "APP-4,WEB-5", "held rows remain visible");
  assert(document.documentElement.scrollWidth <= innerWidth, "Runs controls fit viewport");
  operations.value = []; setSessionProvider("auto"); setSessionOverrides(["idle", "reserve", "labels"]);
  return { passed: true };
}
async function showRuns() {
  await showProjects();
  byText('[role="radio"]', "Open3").click(); await pause();
}
async function runsHistory() {
  await showRuns();
  const rows = () => [...root.querySelectorAll('.next')];
  assert(rows().length === 3, "run history uses the shared ticket-list rows");
  assert(!root.querySelector('a a'), "run rows never nest links");
  assert(rows()[0].querySelector('.next-ticket').getAttribute('href') === '/runs/1', "primary row opens run details");
  assert(rows()[0].textContent.includes('Running'), "run state remains visible");
  const group = root.querySelector('[role="radiogroup"][aria-label="Start order"]');
  assert(group, "history reuses the shared order control");
  const old = { ...filterJobs[0], id: "archive", state: "complete", createdAt: "2020-01-01T00:00:00Z" };
  history.value = [old, ...filterJobs];
  status.value = { ...status.value, jobs: filterJobs.map((j, i) => ({ ...j, createdAt: `2026-01-0${i + 1}T00:00:00Z`, threadId: `thread-${j.id}`, thread: { title: `Work for ${j.label}` }, prUrls: i === 0 ? ['https://github.com/example/repo/pull/1'] : [] })) };
  await pause();
  assert(rows()[0].querySelector('.key').textContent === 'APP-old', "newest run starts first");
  group.querySelector('[aria-label="Oldest first"]').click(); await pause();
  assert(rows()[0].querySelector('.key').textContent === 'APP-1', "oldest order uses live timestamps over history");
  assert(rows()[0].textContent.includes('Work for APP-1'), "thread title identifies run work");
  assert(root.querySelector('[href="https://github.com/example/repo/pull/1"]'), "PR link is retained");
  assert(root.querySelector('[href="/api/threads/thread-1/open"]'), "T3 session link is available");
  if (innerWidth <= 900) {
    root.querySelector('[aria-label="More actions for APP-1"]').click(); await pause();
    const menu = document.querySelector('.popover[aria-label="More actions for APP-1"]');
    assert(menu?.querySelector('[aria-label="Open APP-1 in T3 Code"]'), "phone menu exposes the session link");
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause();
    assert(!document.querySelector('.popover[aria-label="More actions for APP-1"]'), "phone menu closes with Escape");
  }
  status.value = { ...status.value, jobs: Array.from({ length: 40 }, (_, i) => ({ ...filterJobs[0], id: `live-${i}`, label: `APP-${i + 10}`, state: i === 0 ? 'waiting' : 'running', reason: i === 0 ? 'Review the implementation result before continuing' : '', threadId: `thread-${i}`, thread: { title: 'A realistic run title with enough detail to wrap on a phone' } })) };
  await pause();
  assert(rows().length === 43 && root.textContent.includes('Review the implementation result before continuing'), "live additions and waiting reasons remain visible alongside history");
  assert(document.documentElement.scrollWidth <= innerWidth, "run history fits viewport");
  return { passed: true };
}
async function runsHeader() {
  await showProjects();
  const bounds = () => [...root.querySelectorAll('.page-head h1, .page-head [aria-label="Start provider"], .page-head [aria-label="Override limits"], .page-head [aria-label="Search"], .page-head [aria-label^="Filter runs"], [aria-label="State"]')].map(el => {
    const { x, y, height } = el.getBoundingClientRect();
    return [x, y, height];
  });
  const before = bounds();
  const tabs = [...root.querySelector('[aria-label="State"]').querySelectorAll('button')];
  for (const tab of [...tabs.slice(1), tabs[0]]) {
    tab.click(); await pause();
    assert(JSON.stringify(bounds()) === JSON.stringify(before), `Runs header stays in place on ${tab.textContent}`);
  }
  const order = root.querySelector('[aria-label="Start order"]');
  assert(order && [...order.querySelectorAll('button')].every(b => b.disabled), "queue retains disabled history order controls");
  const keys = queueKeys();
  order.querySelector('[aria-label="Oldest first"]').click();
  order.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await pause();
  assert(queueKeys() === keys && order.querySelector('[aria-label="Newest first"]').getAttribute('aria-checked') === 'true', "queue order ignores disabled pointer and keyboard sorting");
  assert(document.documentElement.scrollWidth <= innerWidth, "stable toolbar fits the viewport");
  return { passed: true };
}
async function queueTransitions() {
  await showProjects();
  const op = { id: 'transition', input: { ticket: 'app-1', model: 'auto' }, state: 'queued' };
  for (const state of ['queued', 'running', 'uncertain']) {
    operations.value = [{ ...op, state }]; await pause();
    assert(queueKeys() === 'WEB-2,APP-3', `${state} request replaces only its queue ticket`);
    assert(root.querySelectorAll('.operation').length === 1, `${state} request remains visible`);
    assert(root.querySelector('h2 small').textContent === '2', 'visible queue count follows removed ticket');
  }
  for (const state of ['done', 'error']) {
    operations.value = [{ ...op, state, result: { data: { reason: 'quota-exhausted' } } }]; await pause();
    assert(button(1) && !button(1).disabled, `${state} refusal restores retry availability`);
    assert(root.querySelector('.operation').textContent.includes('quota-exhausted'), 'terminal feedback remains visible');
  }
  operations.value = [];
  for (const state of ['dispatching', 'running', 'waiting']) {
    status.value = { ...filterState.status, jobs: [{ taskId: 't1', ticketKey: 'APP-1', state }, { taskId: 'held-id', ticketKey: 'APP-4', state }, { kind: 'upstream', taskId: null, state }] };
    await pause();
    assert(queueKeys() === 'WEB-2,APP-3' && heldKeys() === 'WEB-5', `${state} job replaces stale ready and held rows without hiding unrelated tickets`);
  }
  const plan = { id: 'plan', tickets: [], target: { id: 'held-id', key: 'APP-4', title: 'Held upload', blockedBy: [] } };
  status.value = { ...filterState.status, plans: [{ ...plan, state: 'active' }] }; await pause();
  assert(heldKeys() === 'WEB-5', 'active target chain replaces a stale held row by ticket key');
  status.value = { ...filterState.status, plans: [{ ...plan, state: 'cancelled' }] }; await pause();
  assert(queueKeys() === 'APP-1,WEB-2,APP-3' && heldKeys() === 'APP-4,WEB-5', 'settled jobs and cancelled chains restore queue snapshot');
  return { passed: true };
}
async function phoneHeader() { await showRuns(); return checkPageHead(); }
// The real Runs page on its Epics tab: start, block, run, cancel, search and filter, with synthetic status.
const epicTicket = (n, extra = {}) => ({ id: `e${n}`, key: `APP-${n}`, title: `Epic ticket ${n}`, projectId: "p", priority: "medium", difficulty: "med", labels: [], blockedBy: [], done: false, runnable: true, automationReady: true, ...extra });
const notIncluded = "Epic Paused has unfinished tickets in projects the factory does not run: OTHER-5 (Other).";
const cannotRead = "Epic Hidden has 2 tickets in projects the factory cannot read.";
const epicRows = () => [
  { id: "launch", title: "Launch", restrictedCount: 0, planId: null, startBlock: null, tickets: [
    epicTicket(1, { labels: ["bug"], priority: "high" }),
    epicTicket(2, { blockedBy: ["e1"] }),
    epicTicket(3, { outside: true }),
    epicTicket(4),
  ] },
  { id: "paused", title: "Paused", restrictedCount: 0, planId: null, startBlock: { reason: "epic-project-not-included", message: notIncluded, tickets: [{ key: "OTHER-5", project: "Other" }], restrictedCount: 0 }, tickets: [epicTicket(5, { key: "OTHER-5", projectId: "other", runnable: false }), epicTicket(6, { hold: "Ticket is on hold: waiting on legal" })] },
  { id: "hidden", title: "Hidden", restrictedCount: 2, planId: null, startBlock: { reason: "epic-restricted-tickets", message: cannotRead, tickets: [], restrictedCount: 2 }, tickets: [] },
  { id: "moving", title: "Moving", restrictedCount: 2, planId: "moving-plan", startBlock: { reason: "epic-already-running", message: "Epic Moving is already running." }, tickets: [] },
];
const epicPlans = () => [
  { id: "moving-old", state: "cancelled", model: "auto", overrideLimits: true, createdAt: "2026-01-01T00:00:00Z", finishedAt: new Date().toISOString(), epic: { id: "moving", title: "Moving" }, tickets: [epicTicket(7)] },
  { id: "over-old", state: "cancelled", model: "auto", overrideLimits: true, createdAt: "2026-01-01T00:00:00Z", finishedAt: new Date().toISOString(), epic: { id: "over", title: "Shipped" }, tickets: [epicTicket(11)] },
  { id: "launch-old", state: "done", model: "auto", overrideLimits: true, createdAt: "2026-01-01T00:00:00Z", finishedAt: new Date().toISOString(), epic: { id: "launch", title: "Launch" }, tickets: [epicTicket(1, { done: true })] },
  { id: "moving-plan", state: "active", createdAt: "2026-01-02T00:00:00Z", model: "preset-sol", overrideLimits: ["labels"], epic: { id: "moving", title: "Moving", restrictedCount: 2 }, tickets: [epicTicket(7, { done: true }), epicTicket(8), epicTicket(9, { blockedBy: ["e8"], automationReady: false, readiness: { ready: false, reasons: [{ code: "automation_disabled", message: "Automation is off for this ticket" }] } }), epicTicket(10, { outside: true, note: "Waiting for a free Codex slot" })] },
  { id: "over-plan", state: "done", createdAt: "2026-01-02T00:00:00Z", model: "auto", overrideLimits: true, finishedAt: new Date().toISOString(), epic: { id: "over", title: "Shipped" }, tickets: [epicTicket(11, { done: true })] },
  { id: "stopped-plan", state: "cancelled", model: "auto", overrideLimits: true, finishedAt: new Date().toISOString(), epic: { id: "stopped", title: "Stopped" }, tickets: [epicTicket(12, { done: true }), epicTicket(13)] },
  { id: "chain", state: "active", model: "auto", overrideLimits: true, tickets: [epicTicket(14)], target: epicTicket(15, { blockedBy: ["e14"] }) },
];
const epicsStatus = (extra = {}) => ({ ...filterState.status, jobs: [], epics: epicRows(), plans: epicPlans(), ...extra });
// `extra` replaces parts of the status, so a screenshot can show any state.
async function showEpics(extra) {
  const oldFetch = window.fetch;
  window.fetch = (url, init) => url === "/api/history" ? Promise.resolve(Response.json([])) : oldFetch(url, init);
  operations.value = [];
  history.value = [];
  applyState({ ...filterState, status: epicsStatus(extra) }, true);
  window.history.replaceState(null, "", "?state=epics");
  render(null, root);
  render(html`<${Runs} /><${Confirmation} />`, root);
  await pause();
  window.fetch = oldFetch;
}
const epicTitleOf = (row) => row.querySelector(".next-toggle .row-body > span").firstChild.textContent;
const epicSection = (title) => [...root.querySelectorAll(".epic")].find(row => epicTitleOf(row) === title);
const epicTitles = () => [...root.querySelectorAll(".epic")].map(epicTitleOf).join();
const epicTag = (title) => epicSection(title).querySelector(".next-toggle .tag").textContent;
const epicIssue = (title) => epicSection(title).querySelector(".next-toggle .epic-issue")?.getAttribute("title");
const epicCount = (title) => epicSection(title).querySelector(".epic-progress")?.textContent;
const epicKeys = (title) => [...epicSection(title).querySelectorAll(".chain-row .key")].map(e => e.textContent).join();
const stateTab = (name) => [...root.querySelectorAll('[aria-label="State"] [role="radio"]')].find(b => b.textContent.startsWith(name));
const runEpic = (title) => epicSection(title).querySelector('button.epic-run');
const epicToggle = (title) => epicSection(title).querySelector("button.next-toggle");
async function setEpicOpen(title, open) {
  if ((epicToggle(title).getAttribute("aria-expanded") === "true") !== open) { epicToggle(title).click(); await pause(); }
}
const modelPicker = (title) => epicSection(title).querySelector('[role="combobox"]');
async function pickEpicModel(title, name) {
  modelPicker(title).click(); await pause();
  byText('[role="option"]', name, epicSection(title)).click(); await pause();
}
async function epicSearch(value) {
  const input = await openSearch();
  input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await pause();
}
async function epics() {
  setSessionProvider("auto"); setSessionOverrides(["labels"]);
  const oldFetch = window.fetch, oldUrl = location.href, dispatches = [], cancels = [];
  let hold = Promise.resolve();
  window.fetch = async (url, init) => {
    if (url === "/api/history") return Response.json([]);
    if (url === "/api/dispatch") {
      const input = JSON.parse(init.body), id = init.headers["Idempotency-Key"];
      dispatches.push(input);
      await hold;
      return Response.json({ id, input, state: "done", result: { data: { reason: "epic-project-not-included", message: "Epic Launch changed: OTHER-9 is in a project the factory does not run." } } });
    }
    if (url.startsWith?.("/api/plans/")) { cancels.push(url); return Response.json({ ok: true }); }
    return Response.json({ ...filterState, status: status.value });
  };
  const settled = async () => { for (let n = 0; n < 100 && operations.value.some(op => ["queued", "running"].includes(op.state)); n++) await pause(); };
  try {
    await showEpics();
    // The tab, its count, and the controls that stay put.
    assert(stateTab("Epics"), "Runs has an Epics tab");
    assert(stateTab("Epics").textContent === "Epics4", `the tab counts open Epics: ${stateTab("Epics").textContent}`);
    assert(stateTab("Epics").getAttribute("aria-checked") === "true", "the state link opens the tab");
    assert([...root.querySelectorAll('[aria-label="Start order"] button')].every(b => b.disabled), "order stays visible and disabled");
    await openFilters();
    assert(!dialog().querySelector('[aria-label="Provider"]'), "Epics do not filter by provider");
    await closeFilters();
    // One row per Epic, latest run first; finished Epics wait in a collapsed group.
    const finishedGroup = () => root.querySelector("details.epic-finished");
    assert(epicTitles() === "Moving,Launch,Paused,Hidden,Shipped,Stopped", `older runs of an Epic are not listed: ${epicTitles()}`);
    assert(finishedGroup() && !finishedGroup().open, "finished Epics start in a collapsed group");
    assert(finishedGroup().querySelector("summary").textContent === "Finished2", `the group counts finished Epics: ${finishedGroup().querySelector("summary").textContent}`);
    assert([...finishedGroup().querySelectorAll(".epic")].map(epicTitleOf).join() === "Shipped,Stopped", "only finished Epics are in the group");
    assert(!matchMedia("(pointer: coarse)").matches || finishedGroup().querySelector("summary").offsetHeight >= 44, "the Finished header is a full touch target");
    assert(epicSection("Shipped").querySelector(".tag").textContent === "Done", "a cancelled run that was run again shows its later result");
    // Collapsed by default: the summary and anything that needs attention stay, the tickets wait to be opened.
    assert(!root.querySelector(".epic .chain-row"), "every Epic starts collapsed");
    const launch = epicSection("Launch");
    assert(epicTitles() === "Moving,Launch,Paused,Hidden,Shipped,Stopped", `Epics list open then finished: ${epicTitles()}`);
    assert(epicCount("Launch") === "0 of 4 done", "each Epic counts its tickets");
    assert(epicTag("Launch") === "Ready" && epicTag("Paused") === "Can't start" && epicTag("Moving") === "Running" && epicTag("Shipped") === "Done" && epicTag("Stopped") === "Cancelled", "each Epic has one state tag");
    const rowHeight = launch.querySelector(".next").offsetHeight, controls = matchMedia("(pointer: coarse)").matches ? 44 : 32;
    assert(innerWidth < 500 || rowHeight <= controls + 22, `a collapsed Epic is one list row, not a section: ${rowHeight}px`);
    assert(epicToggle("Launch").getAttribute("aria-expanded") === "false", "the title reports its collapsed state");
    assert(runEpic("Launch") && modelPicker("Launch"), "a collapsed Epic can still start");
    assert(!root.querySelector(".epic-note"), "a collapsed Epic has no explanatory text");
    assert(epicIssue("Paused") === notIncluded && epicIssue("Hidden") === cannotRead, "a blocked Epic's symbol carries its reason");
    assert(!epicIssue("Launch") && !epicIssue("Moving") && !epicIssue("Shipped") && !epicIssue("Stopped"), "only an Epic that cannot start has the symbol");
    assert(runEpic("Paused").disabled && runEpic("Paused").title === notIncluded, "a blocked Run is unclickable and says why on hover");
    assert(epicSection("Moving").querySelector('button[aria-label="Cancel Epic"]'), "a collapsed running Epic can still be cancelled");
    for (const title of ["Launch", "Paused", "Hidden", "Moving", "Stopped"]) await setEpicOpen(title, true);
    assert(!epicSection("Shipped").querySelector(".chain-row"), "opening one Epic leaves the others collapsed");
    // Rows through the shared renderer.
    assert(launch.querySelectorAll(".chain-row").length === 4, "one row per ticket");
    assert(launch.textContent.includes("after APP-1"), "a blocked member names what it waits for");
    assert(launch.textContent.includes("outside this Epic"), "a blocker outside the Epic is marked");
    assert(epicSection("Moving").textContent.includes("Automation is off for this ticket"), "a member without readiness says why");
    assert(epicSection("Paused").textContent.includes("waiting on legal"), "a member on hold says why");
    assert(!launch.textContent.includes("starts when a slot is free"), "an Epic that has not started promises nothing");
    assert(Deck.openRun({ id: "e2", key: "APP-2" }) === false, "a target-less plan does not read as a ticket's open run");
    // Start: exact payload, duplicate protection, refusal feedback.
    assert(modelPicker("Launch").getAttribute("aria-label").endsWith("Auto"), "the model defaults to Auto");
    assert(runEpic("Launch").getAttribute("aria-label") === "Run Epic Launch" && !runEpic("Launch").textContent.trim() && runEpic("Launch").querySelector(".icon-play"), "Run is an icon-only button named for the Epic");
    await pickEpicModel("Launch", "Sol");
    let release; hold = new Promise(resolve => { release = resolve; });
    const run = runEpic("Launch");
    run.click(); await pause();
    assert(JSON.stringify(dispatches[0]) === JSON.stringify({ epic: "launch", model: "preset-sol", overrideLimits: ["labels"] }), `Run submits the choices: ${JSON.stringify(dispatches[0])}`);
    assert(root.querySelector(".operation")?.textContent.includes("Epic Launch"), "the request row names the Epic");
    assert(runEpic("Launch").disabled, "a pending start disables Run");
    run.click(); await pause();
    assert(startRun({ epic: "launch", model: "auto" }) === null, "a pending start refuses a second submission");
    release(); hold = Promise.resolve(); await settled();
    assert(dispatches.length === 1, "one request reached the server");
    assert(root.querySelector(".operation")?.textContent.includes("OTHER-9"), "a refusal is ordinary request feedback");
    assert(epicSection("Launch") && !runEpic("Launch").disabled && epicTitles().startsWith("Moving,Launch"), "a refusal does not change the Epic");
    operations.value = [{ id: "unknown", input: { epic: "launch" }, state: "uncertain" }]; await pause();
    assert(runEpic("Launch").disabled, "an uncertain start disables Run");
    assert(startRun({ epic: "launch", model: "auto" }) === null, "an uncertain start cannot be resubmitted");
    assert(startRun({ epic: "paused", model: "auto" }) !== null, "another Epic stays available"); await settled();
    operations.value = []; dispatches.length = 0;
    // A provider means automatic model selection.
    setSessionProvider("codex"); await pause();
    assert(modelPicker("Launch").disabled, "the model Select is disabled while a provider is forced");
    assert(modelPicker("Launch").getAttribute("aria-label").endsWith("Auto"), "a forced provider shows Auto");
    runEpic("Launch").click(); await pause(); await settled();
    assert(JSON.stringify(dispatches[0]) === JSON.stringify({ epic: "launch", model: "auto", provider: "codex", overrideLimits: true }), `a provider sends no pinned model: ${JSON.stringify(dispatches[0])}`);
    operations.value = [];
    setSessionProvider("auto"); await pause();
    assert(!modelPicker("Launch").disabled && modelPicker("Launch").getAttribute("aria-label").endsWith("Sol"), "Auto restores the picked model");
    // A start block is the scheduler's answer, and it lifts on a status update.
    const paused = () => epicSection("Paused");
    assert(runEpic("Paused").disabled && runEpic("Paused").getAttribute("aria-label").includes(notIncluded) && runEpic("Paused").title.includes(notIncluded), "a blocked Run states the reason");
    assert(paused().querySelector(".epic-note")?.textContent === notIncluded, "the line names the missing project");
    assert(paused().querySelectorAll(".chain-row")[0].textContent.includes("Its project is not included in the factory"), "the affected row says so");
    assert(!paused().querySelectorAll(".chain-row")[1].textContent.includes("not included"), "other rows do not");
    assert(epicSection("Hidden").querySelector(".epic-note")?.textContent === cannotRead && runEpic("Hidden").disabled, "unreadable tickets block too, with their number");
    setSessionOverrides(["idle", "reserve", "labels", "providers"]); await pause();
    assert(runEpic("Paused").disabled, "overrides do not enable a blocked Run");
    setSessionProvider("codex"); await pause();
    assert(runEpic("Paused").disabled, "a forced provider does not enable a blocked Run");
    setSessionProvider("auto"); setSessionOverrides(["labels"]);
    status.value = { ...status.value, epics: status.value.epics.map(row => row.id === "paused" ? { ...row, startBlock: null, tickets: [epicTicket(6)] } : row) }; await pause();
    assert(!runEpic("Paused").disabled && runEpic("Paused").getAttribute("aria-label") === "Run Epic Paused" && !paused().querySelector(".epic-note") && !epicIssue("Paused"), "a cleared block enables Run and drops the symbol without a reload");
    // Running and finished.
    const moving = epicSection("Moving");
    assert(!runEpic("Moving"), "a running Epic has no Run");
    assert(epicCount("Moving") === "1 of 4 done", "a running Epic counts its plan's tickets");
    status.value = { ...status.value, jobs: [{ id: "j1", taskId: "e8", state: "waiting" }, { id: "j2", taskId: "e9", state: "running" }] }; await pause();
    assert(epicTag("Moving") === "Needs you" && epicCount("Moving") === "1 of 4 done · 1 running · 1 waiting for you", `a running Epic says what its runs are doing: ${epicCount("Moving")}`);
    status.value = { ...status.value, jobs: [] }; await pause();
    assert(moving.querySelector(".epic-choice")?.textContent === "Sol · Override label limits", `the recorded choices show: ${moving.querySelector(".epic-choice")?.textContent}`);
    assert(moving.querySelector(".epic-note")?.textContent.includes("2 tickets"), "hidden tickets keep a running Epic open");
    assert(moving.textContent.includes("Waiting for a free Codex slot"), "scheduler notes reach the row");
    moving.querySelector('button[aria-label="Cancel Epic"]').click(); await pause();
    assert(document.querySelector("dialog[open]")?.textContent.includes("Tickets already running finish on their own."), "cancelling asks through the shared confirmation");
    byText("button", "Cancel Epic", document.querySelector("dialog[open]")).click(); await pause();
    assert(cancels.join() === "/api/plans/moving-plan/cancel", `cancelling posts the plan: ${cancels.join()}`);
    assert(epicSection("Stopped").querySelectorAll(".chain-row")[1].textContent.includes("Not run"), "a cancelled plan does not promise its remaining tickets");
    assert(!epicCount("Hidden"), "an Epic with no readable tickets has nothing to count");
    assert([...root.querySelectorAll(".chain-row small")].every(s => s.scrollWidth <= s.clientWidth), "a row's reason is never clipped");
    // An open Epic stays open across live updates and leaving the tab, including when its start turns its row into a plan.
    status.value = { ...status.value }; await pause();
    assert(epicSection("Launch").querySelectorAll(".chain-row").length === 4, "a status update keeps an Epic open");
    stateTab("Up next").click(); await pause();
    stateTab("Epics").click(); await pause();
    assert(epicSection("Launch").querySelectorAll(".chain-row").length === 4, "leaving the tab keeps an Epic open");
    const launchRow = status.value.epics.find(row => row.id === "launch");
    status.value = { ...status.value, epics: status.value.epics.filter(row => row !== launchRow), plans: [...status.value.plans, { ...launchRow, id: "launch-plan", state: "active", model: "auto", overrideLimits: true, epic: { id: "launch", title: "Launch", restrictedCount: 0 } }] }; await pause();
    assert(epicSection("Launch").querySelectorAll(".chain-row").length === 4, "starting an Epic keeps it open");
    status.value = { ...status.value, epics: [launchRow, ...status.value.epics], plans: status.value.plans.filter(plan => plan.id !== "launch-plan") }; await pause();
    for (const title of ["Launch", "Paused", "Hidden", "Moving", "Stopped"]) await setEpicOpen(title, false);
    assert(!root.querySelector(".epic .chain-row"), "the title closes an open Epic");
    // Search and filters. A title match keeps the choice to open; a narrowed Epic has to show why it matched.
    await epicSearch("launch");
    assert(epicTitles() === "Launch" && !epicKeys("Launch"), `an Epic title match stays collapsed: ${epicTitles()}`);
    await setEpicOpen("Launch", true);
    assert(epicKeys("Launch") === "APP-1,APP-2,APP-3,APP-4", "an Epic title matches the whole Epic");
    await setEpicOpen("Launch", false);
    await epicSearch("ship");
    assert(finishedGroup().open && epicTitles() === "Shipped", "a search opens the finished group to show its matches");
    await epicSearch("APP-2");
    assert(epicTitles() === "Launch" && epicKeys("Launch") === "APP-2", `a ticket key narrows to its row: ${epicTitles()}`);
    assert(epicToggle("Launch").getAttribute("aria-expanded") === "true" && epicToggle("Launch").disabled, "a narrowed Epic stays open until the search clears");
    assert(root.querySelector(".page-head h1 small").textContent === "1", "the title counts the Epics a search leaves");
    await epicSearch("nothing here");
    assert(!epicTitles() && root.textContent.includes("No Epics match.") && !root.textContent.includes("No open Epics."), "a search with no match says so");
    await epicSearch("");
    await openFilters();
    await pickFilter("Tags", "bug");
    assert(epicTitles() === "Launch" && epicKeys("Launch") === "APP-1", `Filter narrows rows and hides Epics with none: ${epicTitles()}`);
    await clearFilters();
    await pickFilter("Priority", "High");
    assert(epicTitles() === "Launch" && epicKeys("Launch") === "APP-1" && !epicSection("Hidden"), "an Epic with no rows hides while a filter is on");
    await clearFilters();
    await closeFilters();
    assert(epicTitles() === "Moving,Launch,Paused,Hidden,Shipped,Stopped", "clearing restores every Epic");
    assert(!finishedGroup().open, "clearing closes the finished group again");
    assert(!root.querySelector(".epic .chain-row"), "clearing a search or filter collapses what it opened");
    // Up next keeps chains only.
    stateTab("Up next").click(); await pause();
    assert(!root.textContent.includes("Epic Moving") && !root.textContent.includes("Moving"), "a running Epic is gone from Up next's chains");
    assert(root.textContent.includes("Chain to APP-15") && root.textContent.includes("Last") && byText("button", "Cancel chain"), "a chain keeps its title, target row and action");
    stateTab("Epics").click(); await pause();
    // Nothing to show.
    status.value = { ...status.value, epics: [], plans: [] }; await pause();
    assert(root.querySelector(".empty")?.textContent === "No open Epics." && stateTab("Epics").textContent === "Epics0", "no Epics reads as empty");
    status.value = { ...status.value, plans: epicPlans().filter(p => p.id === "over-plan") }; await pause();
    assert(root.querySelector(".empty")?.textContent === "No open Epics." && epicTitles() === "Shipped", "finished plans stay listed below the empty line");
    // A long catalog with long names and three-digit counts.
    const long = "A realistic Epic title with enough detail to wrap on a folded phone display";
    status.value = { ...status.value, plans: [], epics: Array.from({ length: 149 }, (_, i) => ({ id: `e-${i}`, title: `${long} ${i}`, restrictedCount: 0, planId: null, startBlock: null, tickets: Array.from({ length: i ? 2 : 149 }, (_, n) => epicTicket(1000 + n, { title: long, done: n < 12 })) })) }; await pause();
    assert(stateTab("Epics").textContent === "Epics149", "three-digit tab count");
    assert(root.querySelector(".epic-progress").textContent === "12 of 149 done", "three-digit Epic count");
    const inside = el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; };
    const coarse = matchMedia("(pointer: coarse)").matches, first = root.querySelector(".epic");
    assert(inside(first.querySelector(".next-actions")) && inside(first.querySelector(".next-toggle")), "title and start controls stay inside the viewport");
    assert(!coarse || (first.querySelector(".epic-run").offsetHeight >= 44 && first.querySelector(".epic-run").offsetWidth >= 44), "Run is a full touch target");
    assert(!coarse || first.querySelector(".next-toggle").offsetHeight >= 44, "the title is a full touch target");
    first.querySelector(".next-toggle").click(); await pause();
    assert(first.querySelectorAll(".chain-row").length === 149, "a long Epic opens");
    assert(document.documentElement.scrollWidth <= innerWidth, "the Epics tab has no horizontal overflow");
    first.querySelector(".next-toggle").click(); await pause();
    return { passed: true, viewport: [innerWidth, innerHeight], coarse };
  } finally { window.fetch = oldFetch; window.history.replaceState(null, "", oldUrl); operations.value = []; setSessionProvider("auto"); setSessionOverrides(["idle", "reserve", "labels"]); }
}
window.queueTests = { epics, showEpics, phoneHeader, readiness, run, layout, show, showProjects, runProjects, openFilters, pickFilter, closeFilters, progress, runsControls, showRuns, runsHistory, runsHeader, queueTransitions };
await show();


async function readiness() {
  await show(Infinity);
  const tickets = [
    { ...ticket(1), automationReady: true, labels: [] },
    { ...ticket(2), automationReady: false, labels: ['sf'] },
    { ...ticket(3), labels: ['sf'] },
  ];
  const update = rows => { status.value = { ...state.status, upNext: { ...state.status.upNext, tickets: rows } }; };
  update(tickets); await pause();
  const rows = () => [...root.querySelectorAll('.next')];
  const icon = row => row.querySelector('[role="img"][aria-label="Automation ready"]');
  assert(icon(rows()[0])?.closest('[title="Automation ready"]'), 'native ready ticket has one named icon and tooltip');
  assert(!icon(rows()[1]) && !icon(rows()[2]), 'false or missing native readiness is not inferred from labels');
  update(tickets.map(t => ({ ...t, automationReady: t.id !== 't1' }))); await pause();
  assert(!icon(rows()[0]) && icon(rows()[1]) && icon(rows()[2]), 'live native updates replace readiness symbols');
  assert(document.documentElement.scrollWidth <= innerWidth, 'readiness symbols fit the viewport');
  update(tickets); await pause();
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
