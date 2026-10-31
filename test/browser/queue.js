// Synthetic data, actual queue component and dispatch store. No live dispatches.
import { openSearch } from "./search.js";
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { applyState, operations, status, history, setSessionProvider, setSessionOverrides } from "../../web/lib/store.js";
import * as Deck from "../../web/views/Deck.js";
import { Runs } from "../../web/views/Runs.js";

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
    return { passed: true, viewport: [innerWidth, innerHeight], filters: ["project", "tags OR/AND", "difficulty", "priority", "search", "provider on runs"] };
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
  assert(button(1).disabled, "pending duplicate remains held with header choices");
  assert(queueKeys() === "APP-1,WEB-2,APP-3", "header choices preserve scheduler order");
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
window.queueTests = { readiness, run, layout, show, showProjects, runProjects, openFilters, pickFilter, closeFilters, progress, runsControls, showRuns, runsHistory };
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
