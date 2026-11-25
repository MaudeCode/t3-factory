// Real app shell and Now page; synthetic state, dispatch, triage and confirmation endpoints only.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { confirmation, finishConfirmation } from "../../web/lib/confirmation.js";
import { App } from "../../web/views/App.js";
import { tickRenders, checkTickRendersTimesOnly } from "./search.js";

const root = document.querySelector("#root");
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const job = (n, state, extra = {}) => ({ id: `j${n}`, label: `APP-${n}`, taskId: `t${n}`, threadId: `th${n}`, projectId: "p", state, createdAt: ago(n + 5), lastExecutionAt: ago(1), providerDriver: n % 5 ? "claudeAgent" : "codex", thread: { title: `Synthetic ticket ${n}` }, ...extra });
const report = (key, outcome, data = {}) => ({ id: key, time: ago(30), kind: "triage", text: `${key} ${outcome === "triage-failed" ? "triage failed: timed out twice" : outcome === "needs-owner" ? "needs the owner: sensitive work" : outcome}`, data: { ticket: key, ticketId: `r-${key}`, inboxId: "pin", project: "Example", outcome, ...data } });
// Three active runs, two waiting on the owner, one queued run, one chain, one running Epic, and reports in both stages.
const light = () => [job(1, "running"), job(2, "running", { prUrls: ["https://github.com/example/app/pull/2"] }), job(5, "dispatching"), job(3, "waiting", { thread: { title: "Asks a question", pending: "question" } }), job(4, "waiting", { reason: "Parked for inspection" }), job(9, "complete", { completedAt: ago(2) })];
const heavy = () => [...Array.from({ length: 16 }, (_, i) => job(i + 20, "running", i % 2 ? { prUrls: [`https://github.com/example/app/pull/${i}`] } : {})), ...Array.from({ length: 11 }, (_, i) => job(i + 60, "waiting", { thread: { title: `Waiting ${i}`, pending: "approval" } }))];
const base = (jobs) => ({
  version: "v0.5.0",
  config: { enabled: true, concurrency: { claude: 16, codex: 2 }, models: [], kanvil: { url: "https://tracker.example", workspaceId: "w" }, triage: { enabled: true }, projects: [{ kanvilId: "p", key: "APP", name: "Example", enabled: true, inbox: { kanvilId: "pin" } }] },
  status: {
    jobs, journal: [{ id: 1, time: ago(3), kind: "runs", text: "Journal entry that belongs on the Activity page" }],
    decision: { reason: "no-eligible-ticket", at: ago(0.2), eligible: 0 },
    streams: [{ driver: "claudeAgent", reason: "provider-running", models: [] }, { driver: "codex", reason: "quota-budget", models: [] }],
    upNext: { at: ago(1), tickets: [{ id: "u1", key: "APP-900", title: "Automatic queue ticket", projectId: "p" }], held: [] },
    triageReports: [report("PIN-2", "triage-failed", { stage: "owner" }), report("PIN-6", "needs-owner", { stage: "owner" }), report("PIN-7", "waiting", { stage: "working" })],
    plans: [
      { id: "q1", state: "active", queued: true, target: { id: "x1", key: "APP-700", title: "Queued by the owner", blockedBy: [] }, tickets: [] },
      { id: "c1", state: "active", target: { id: "x2", key: "APP-701", title: "Chain target", done: false, blockedBy: [] }, tickets: [{ id: "x3", key: "APP-702", done: true, blockedBy: [] }, { id: "x4", key: "APP-703", done: false, blockedBy: [] }] },
      { id: "e1", state: "active", epic: { id: "ep", title: "Billing v2" }, tickets: [{ id: "x5", key: "APP-704", done: true, blockedBy: [] }, { id: "x6", key: "APP-705", done: false, blockedBy: [] }] },
      { id: "old", state: "cancelled", target: { id: "x7", key: "APP-706", blockedBy: [] }, tickets: [] },
    ],
  },
});
let state, posts = [];
window.fetch = async (url, init) => {
  if (url === "/api/history") return Response.json([]);
  if (url.startsWith("/api/tickets/")) return Response.json({ message: "Ticket not found" }, { status: 404 });
  if (init?.method === "POST") { posts.push({ url, body: init.body ? JSON.parse(init.body) : null }); return Response.json(url === "/api/dispatch" ? { id: init.headers["Idempotency-Key"], state: "running" } : state); }
  return Response.json(state);
};
async function show(jobs = light()) {
  render(null, root);
  posts = [];
  store.operations.value = [];
  state = base(jobs);
  store.applyState(state, true);
  store.auth.value = { mode: "oidc", loginUrl: "/auth/login" };
  store.authenticated.value = true;
  navigate("/", true);
  render(html`<${App} />`, root);
  await pause();
}
const sections = () => Object.fromEntries([...root.querySelectorAll(".now-section")].map((s) => [s.querySelector("h2").firstChild.textContent, s]));
const visible = (el) => el.getClientRects().length > 0;
const rows = (s) => [...s.querySelectorAll(".now-row")].filter(visible);
const keys = (s) => rows(s).map((r) => r.querySelector(".key")?.textContent ?? r.querySelector(".now-title").textContent);
const width = () => root.querySelector(".content").clientWidth;
const noOverflow = () => assert(document.documentElement.scrollWidth <= innerWidth, "Now fits the viewport");

async function run() {
  await show();
  const main = root.querySelector("main"), s = sections();
  assert(root.querySelector('.shell [aria-current="page"]').textContent.trim() === "Now", "the home page is Now in the navigation");
  assert(Object.keys(s).join() === "Needs you,Working,CI,Your queue", "four sections follow the provider limits");
  const strip = main.querySelector(".strip"), grid = main.querySelector(".now-grid");
  // A phone-width column lists what needs the owner first and the limits after it.
  const stacked = getComputedStyle(grid).gridTemplateColumns.split(" ").length === 1;
  assert(strip.querySelectorAll(".machine").length === 2 && (stacked ? grid.getBoundingClientRect().bottom <= strip.getBoundingClientRect().top + 1 : strip.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top + 1), "both providers' limits sit above the sections, or under them in one column");
  assert(!/Finished|Activity|Up next|Journal entry|APP-900|APP-9\b/.test(main.textContent), "no finished runs, activity log or automatic queue");
  // Needs you: two waiting runs, the two owner-stage reports. Working: active without a PR. CI: active with one.
  if (width() > 700) {
    assert(keys(s["Needs you"]).join() === "APP-3,APP-4,PIN-2,PIN-6", `Needs you lists waiting runs and owner reports: ${keys(s["Needs you"])}`);
    assert(keys(s.Working).toSorted().join() === "APP-1,APP-5" && keys(s.CI).join() === "APP-2", "active runs split on whether a pull request exists");
    assert(rows(s["Your queue"]).map((r) => `${r.querySelector(".key")?.textContent ?? "Epic"} ${r.querySelector(".now-title").textContent}`).join() === "APP-700 Queued by the owner,APP-701 Chain target,Epic Billing v2", "Your queue names the owner's queued run, chain and running Epic by key and title");
  }
  const counts = [...main.querySelectorAll(".now-counts a")].map((el) => `${el.textContent} ${el.getAttribute("href")}`);
  assert(counts.join() === "3running /runs,4need you /runs?state=waiting,3in your queue /queue", `header counts match the sections and link to their lists: ${counts}`);
  assert([...main.querySelectorAll(".now-section h2 small")].map((el) => el.textContent).join() === "4,2,1,3", "each section title carries its full count");
  // A clock tick renders only the times, and a run's time and its tooltip still move.
  await checkTickRendersTimesOnly("Now");
  const time = () => main.querySelector(".now-time"), before = [time().textContent, time().title];
  await tickRenders(60 * 60_000);
  assert(time().textContent !== before[0] && time().title !== before[1], `a run's time and tooltip follow the clock: ${before} -> ${time().textContent}, ${time().title}`);
  store.clock.value = Date.now();
  // Provider identity and state are not colour alone.
  for (const r of [...rows(s.Working), ...rows(s.CI)]) assert(["Claude", "Codex"].includes(r.querySelector(".now-icon svg").getAttribute("aria-label")), "every run row names its provider");
  const asked = rows(s["Needs you"])[0];
  assert(asked.textContent.includes("asked a question") && asked.querySelector("a.btn").getAttribute("href") === "/api/threads/th3/open" && asked.querySelector("a.btn").getAttribute("aria-label") === "Open APP-3 in T3 Code", "a waiting run says what it waits for and opens in T3 Code");
  // Held back by quota: reason beside the name, with the one way past it.
  const [claude, codex] = strip.querySelectorAll(".machine");
  assert(!claude.querySelector("header .btn") && claude.querySelector(".load").textContent.replace(/\s+/g, " ").trim() === "2 of 16 slots", "a provider that is not held back shows its slots as text and no override");
  assert(codex.querySelector(".reason").textContent.includes("waiting for budget"), "a held provider shows its reason beside its name");
  codex.querySelector("header .btn").click(); await pause();
  const dispatch = posts.find((p) => p.url === "/api/dispatch")?.body;
  assert(dispatch && dispatch.provider === "codex" && dispatch.overrideLimits === true && dispatch.model === "auto" && !dispatch.ticket, `Start anyway dispatches on that provider with limits overridden: ${JSON.stringify(dispatch)}`);
  assert(rows(sections()["Your queue"]).some((r) => r.textContent.includes("Next eligible ticket")), "the pending request joins Your queue");
  // A ticket run opens its ticket in the panel on this page; its link still names the run's page.
  await show();
  const working = rows(sections()["Working"])[0].querySelector("a.now-main"), key = working.querySelector(".key").textContent;
  working.click(); await pause(); await pause();
  assert(document.querySelector("dialog.ticket-panel[open]") && location.pathname === "/" && new URLSearchParams(location.search).get("ticket") === key && /^\/runs\/j\d+$/.test(working.getAttribute("href")), `a ticket run opens the ticket panel: ${location.pathname}${location.search}`);
  history.back(); await pause(); await pause();
  // Report decisions behave as on Triage.
  await show();
  if (width() > 700) {
    const failed = rows(sections()["Needs you"]).find((r) => r.textContent.includes("PIN-2"));
    failed.querySelector('button[aria-label="Triage PIN-2 again"]').click(); await pause();
    assert(posts.some((p) => p.url === "/api/triage/reports/r-PIN-2/retry"), "Triage again posts the retry decision");
    const owner = rows(sections()["Needs you"]).find((r) => r.textContent.includes("PIN-6"));
    owner.querySelector('button[aria-label="Make a ticket of PIN-6"]').click(); await pause();
    assert(confirmation.value && !posts.some((p) => p.url.endsWith("/promote")), "making a ticket asks before it posts");
    finishConfirmation(true); await pause();
    assert(posts.some((p) => p.url === "/api/triage/reports/r-PIN-6/promote"), "confirming posts the decision");
  }
  noOverflow();
  return { passed: true, viewport: [innerWidth, innerHeight], content: width() };
}

// Sixteen active runs and eleven waiting: every section stays bounded and the counts stay whole.
async function load() {
  await show(heavy());
  const s = sections(), limit = width() > 700 ? 8 : 2;
  for (const [name, total] of [["Needs you", 13], ["Working", 8], ["CI", 8]]) {
    const shown = rows(s[name]).length, more = [...s[name].querySelectorAll(".now-more")].filter(visible);
    assert(shown === Math.min(limit, total), `${name} shows at most ${limit} rows, got ${shown}`);
    assert(total > limit ? more.length === 1 && more[0].textContent === `${total - limit} more` : !more.length, `${name} links to the rest: ${more.map((m) => m.textContent)}`);
    assert(s[name].querySelector("h2 small").textContent === String(total), `${name} counts hidden rows too`);
  }
  // Every counted item stays reachable here: the section expands in place, reports and their actions included.
  const needs = s["Needs you"], expand = () => [...needs.querySelectorAll(".now-more")].find(visible);
  expand().click(); await pause();
  assert(rows(needs).length === 13 && expand().getAttribute("aria-expanded") === "true", `expanding Needs you shows every item: ${rows(needs).length}`);
  assert(needs.querySelector('button[aria-label="Triage PIN-2 again"]') && needs.querySelector('button[aria-label="Close PIN-6"]'), "reports hidden behind the limit keep their actions once expanded");
  expand().click(); await pause();
  assert(rows(needs).length === limit, "the section collapses again");
  assert([...root.querySelectorAll(".now-counts span")].map((el) => el.textContent).join() === "16running,13need you,3in your queue", "header counts include rows behind N more");
  const grid = root.querySelector(".now-grid"), tops = new Set([...grid.children].map((el) => Math.round(el.getBoundingClientRect().top)));
  assert(tops.size === (width() > 1060 ? 1 : width() > 700 ? 2 : 4), `sections use four, two or one column by content width: ${tops.size} rows at ${width()}px`);
  if (matchMedia("(pointer: coarse)").matches) assert(rows(s.Working).every((r) => r.getBoundingClientRect().height >= 44), "rows are touch targets");
  noOverflow();
  return { passed: true, viewport: [innerWidth, innerHeight], content: width(), coarse: matchMedia("(pointer: coarse)").matches };
}
// Two running Epics in Your queue, for the link check below and for screenshots.
async function showEpics() {
  await show();
  state = { ...state, status: { ...state.status, plans: [...state.status.plans, { id: "e2", state: "active", epic: { id: "ep2", title: "Search" }, tickets: [{ id: "x8", key: "APP-707", done: false, blockedBy: [] }] }] } };
  store.applyState(state); await pause();
}
// A running Epic's row opens the Queue's Epics view with that Epic's tickets showing, and no other Epic's.
async function epicLink() {
  await showEpics();
  const title = (epic) => epic.querySelector(".row-body > span").textContent;
  const open = () => [...root.querySelectorAll(".epic")].filter((epic) => epic.querySelector(".epic-tickets")).map(title).join();
  const until = async (ok) => { for (let n = 0; n < 100 && !ok(); n++) await pause(); };
  const follow = async (name) => {
    const more = [...sections()["Your queue"].querySelectorAll('.now-more[aria-expanded="false"]')].find(visible);
    if (more) { more.click(); await pause(); }
    rows(sections()["Your queue"]).find((r) => r.querySelector(".now-title").textContent === name).querySelector("a.now-main").click();
  };
  await follow("Search"); await until(() => open() === "Search");
  assert(location.pathname + location.search === "/queue?view=epics" && open() === "Search", `the Epic's row lands on Epics with that Epic open: ${location.pathname}${location.search} [${open()}]`);
  history.back(); await until(() => location.pathname === "/" && sections()["Your queue"]);
  await follow("Billing v2"); await until(() => open() === "Billing v2");
  assert(open() === "Billing v2", `the Epic chosen next is the only one open: [${open()}]`);
  [...root.querySelectorAll(".epic")].find((epic) => title(epic) === "Billing v2").querySelector("button.next-toggle").click(); await until(() => open() === "");
  assert(open() === "", "its toggle still closes it");
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
window.nowTests = { show, run, load, epicLink, showEpics, heavy, light };
await show();
