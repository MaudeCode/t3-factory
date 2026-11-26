// Real app shell and Runs page: the list with the selected run beside it. Synthetic state and run-detail reads only.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { confirmation, finishConfirmation } from "../../web/lib/confirmation.js";
import { App } from "../../web/views/App.js";
import { until, openSearch, tickRenders, checkTickRendersTimesOnly } from "./search.js";

const root = document.querySelector("#root");
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const job = (n, state, extra = {}) => ({ id: `run-${n}`, label: `APP-${n}`, taskId: `t${n}`, threadId: `th${n}`, projectId: "p", state, createdAt: ago(n * 3 + 5), lastExecutionAt: ago(1), providerDriver: "claudeAgent", difficulty: "med", thread: { title: `Synthetic ticket ${n}`, branch: `feat/APP-${n}-factory-x`, status: "running" }, ...extra });
// Thirty runs so the list scrolls; one waits on the owner and is not the newest.
const jobs = [...Array.from({ length: 28 }, (_, i) => job(i + 1, "running", i === 0 ? { prUrls: ["https://github.com/example/app/pull/7"] } : {})), job(40, "waiting", { reason: "Parked for inspection", thread: { title: "Needs a decision", pending: "question" } }), job(50, "complete", { completedAt: ago(2), kind: "repair", label: "ci.yml run 812", taskId: null, thread: { title: "CI repair: Example ci.yml run 812", status: "completed" } })];
const state = {
  config: { enabled: false, concurrency: { claude: 1, codex: 1 }, models: [], kanvil: { url: "https://tracker.example", workspaceId: "w" }, projects: [{ kanvilId: "p", key: "APP", name: "Example", enabled: true }] },
  status: { jobs, journal: [] },
};
let reads = [], posts = [], historyRows = jobs, step = 0, readSteps = [];
window.fetch = async (url, init) => {
  if (url === "/api/history") return Response.json(historyRows);
  const read = /^\/api\/jobs\/([\w-]+)\/report$/.exec(url);
  if (read) {
    reads.push(read[1]); readSteps.push(step);
    const found = jobs.find((j) => j.id === read[1]) ?? historyRows.find((j) => j.id === read[1]);
    return found ? Response.json({ job: found, events: [{ id: 1, time: ago(4), kind: "job.created", text: `Started ${found.label}`, data: {} }], report: found.state === "complete" ? { status: "complete", reason: "Merged and verified." } : null }) : Response.json({ message: "Run not found" }, { status: 404 });
  }
  if (init?.method === "POST") { posts.push(url); return Response.json({ ok: true }); }
  if (/^\/api\/tickets\//.test(url)) return Response.json({ id: "t1", projectId: "p", key: "APP-1", title: "Synthetic ticket 1", status: "in_progress", priority: "high", difficulty: "med", kind: "feature", labels: [], scopes: [], description: "", acceptanceCriteria: "", automationReady: true, holdReason: null, readiness: [], blockedBy: [], blocks: [], epic: null, createdAt: ago(900), url: "https://tracker.example/projects/p/tickets/t1" });
  return Response.json(state);
};
async function show(path = "/runs", rows = jobs) {
  render(null, root);
  reads = []; posts = []; historyRows = rows;
  store.operations.value = [];
  store.history.value = null;
  store.applyState(state, true);
  store.auth.value = { mode: "oidc", loginUrl: "/auth/login" };
  store.authenticated.value = true;
  navigate(path, true);
  render(html`<${App} />`, root);
  await pause(200);
}
const visible = (el) => !!el && el.getClientRects().length > 0;
const list = () => root.querySelector(".runs-list"), detail = () => root.querySelector(".runs-detail");
const rowLink = (key) => [...list().querySelectorAll("a.next-ticket")].find((a) => a.querySelector(".key")?.textContent === key);
const keys = () => [...list().querySelectorAll(".next .key")].map((k) => k.textContent);
const beside = () => { const split = root.querySelector(".runs-split"); return !!split && getComputedStyle(split).display === "grid"; };

async function run() {
  await show();
  const wide = beside();
  // Open lists what waits on the owner first, then the rest newest first; the tab counts match.
  const tabs = [...root.querySelectorAll('[aria-label="State"] [role="radio"]')].map((t) => t.textContent);
  assert(tabs.join() === "Open29,Needs you1,Finished1,Settled0,All30", `tabs name and count the lists: ${tabs}`);
  assert(keys()[0] === "APP-40" && keys().length === 29, `Open lists the waiting run first: ${keys().slice(0, 3)}`);
  if (wide) {
    // With no run in the address, the first open run is shown beside the list.
    assert(visible(list()) && visible(detail()) && detail().textContent.includes("APP-40") && rowLink("APP-40").getAttribute("aria-current") === "true", "the first open run is shown beside the list and marked");
    assert(!visible(detail().querySelector(".crumb")), "beside the list the detail needs no way back");
    // Select a run far down the list: the address changes, the list stays where it was scrolled, filters stay.
    root.querySelector('[aria-label="Start order"] [aria-label="Oldest first"]').click(); await pause();
    const target = rowLink("APP-3");
    target.scrollIntoView({ block: "center" }); await pause();
    const scrolled = scrollY;
    assert(scrolled > 0, "the fixture list is long enough to scroll");
    target.click(); await pause(200);
    assert(location.pathname === "/runs/run-3" && Math.abs(scrollY - scrolled) < 2, `selecting a run keeps the list where it was scrolled: ${scrolled} -> ${scrollY}`);
    assert(rowLink("APP-3").getAttribute("aria-current") === "true" && [...list().querySelectorAll('[aria-current="true"]')].length === 1 && detail().textContent.includes("Synthetic ticket 3"), "the selected row is marked and its run is shown");
    assert(root.querySelector('[aria-label="Start order"] [aria-checked="true"]').getAttribute("aria-label") === "Oldest first", "selecting a run keeps the list's order and filters");
    // Another row opens the same way: in place, with the list where it was. The row is the only way in; it has no arrow.
    const before = scrollY;
    assert(!list().querySelector('a[aria-label^="Open run"]'), "a row offers no second link to its own run");
    rowLink("APP-5").click(); await pause(200);
    assert(location.pathname === "/runs/run-5" && Math.abs(scrollY - before) < 2 && rowLink("APP-5").getAttribute("aria-current") === "true", `a second row keeps the list where it was scrolled: ${before} -> ${scrollY}`);
    history.back(); await pause(200);
    assert(location.pathname === "/runs/run-3" && rowLink("APP-3").getAttribute("aria-current") === "true" && detail().textContent.includes("Synthetic ticket 3"), "Back returns to the previously selected run");
  } else {
    assert(visible(list()) && !visible(detail()), "below the breakpoint the list stands alone");
    await show("/runs?state=all");
    const target = rowLink("APP-24");
    target.scrollIntoView({ block: "center" });
    const rowTop = target.getBoundingClientRect().top;
    assert(scrollY > 0, "the selected run is below the first screen");
    target.click(); await pause(200);
    assert(location.pathname === "/runs/run-24" && !visible(list()) && visible(detail()) && scrollY === 0, "a run replaces the list and starts at its top");
    const crumb = detail().querySelector(".crumb");
    assert(visible(crumb) && crumb.getAttribute("href") === "/runs?state=all", "the detail links to the originating list");
    store.status.value = { ...store.status.value, jobs: [job(99, "running", { createdAt: ago(0) }), ...jobs] };
    crumb.click();
    await until(() => visible(list()) && Math.abs(rowLink("APP-24").getBoundingClientRect().top - rowTop) <= 1,
      "Back restores the same row even when a newer run arrives above it");
    assert(location.pathname + location.search === "/runs?state=all" && visible(list()) && !visible(detail()), "Back returns to the original list address");
  }
  // A run opened by its address.
  await show("/runs/run-1");
  const d = detail();
  assert(visible(d) && d.textContent.includes("APP-1") && d.textContent.includes("Synthetic ticket 1") && (!wide || rowLink("APP-1").getAttribute("aria-current") === "true"), "a run address shows that run, selected in the list when the list is beside it");
  const actions = [...d.querySelectorAll(".run-actions a, .run-actions button")].map((el) => el.getAttribute("aria-label") ?? el.textContent.trim());
  assert(actions.join() === "Open in T3 Code,#7,Ticket,Cleanup review" && d.querySelector('.run-actions a[title="PR #7"]'), `one row of icon actions, a pull request by its number: ${actions}`);
  assert([...d.querySelectorAll(".facts a")].some((a) => a.textContent === "Example"), "the run's project links from its facts");
  assert(d.querySelector(".run-actions a").getAttribute("href") === "/api/threads/th1/open", "Open in T3 Code opens the run's thread");
  const track = d.querySelector(".run-track");
  assert(track.querySelector(".now").textContent === "Working" && track.querySelector('[aria-current="step"]').textContent === "Working" && [...track.children].map((li) => li.textContent).join() === "Queued,Working,Needs you,Done", "the track names the four stops and marks the current one in text");
  for (const part of ["Model", "Started", "Last activity", "Difficulty", "Branch", "feat/APP-1-factory-x", "Timeline", "Started APP-1"]) assert(d.textContent.includes(part), `the detail shows ${part}`);
  // Ticket opens the ticket panel instead of the tracker.
  d.querySelector('.run-actions button[aria-label="Ticket"]').click(); await pause(200);
  assert(document.querySelector("dialog.ticket-panel[open]") && location.pathname === "/runs/run-1", "Ticket opens the ticket panel on the run");
  document.querySelector("dialog.ticket-panel[open] .dialog-close").click(); await pause(200);
  // Stop asks first.
  detail().querySelector('button[aria-label="Stop run"]').click(); await pause();
  assert(confirmation.value?.title === "Stop APP-1?" && !posts.length, "Stop run asks before it posts");
  finishConfirmation(false); await pause();
  // A run that needs the owner says so; a finished one shows its report.
  await show("/runs/run-40");
  assert(detail().querySelector(".callout").textContent.includes("asked a question") && detail().querySelector(".run-track .now").textContent === "Needs you", "a waiting run shows what it waits for");
  await show("/runs/run-50");
  assert(detail().textContent.includes("Merged and verified.") && detail().querySelector(".run-track .now").textContent === "Done", "a finished run shows its report");
  assert(detail().textContent.includes("CI repair in Example"), "a repair run is named as its own kind");
  // An unknown run reports the error where the detail goes and leaves the list usable.
  await show("/runs/missing");
  assert(detail().textContent.includes("Run not found") && (!wide || (visible(list()) && keys().length === 29)), "an unknown run is reported in the detail area");
  if (wide) { rowLink("APP-2").click(); await pause(200); assert(detail().textContent.includes("Synthetic ticket 2") && !detail().textContent.includes("Run not found"), "the list still selects a run after an error"); }
  assert(document.documentElement.scrollWidth <= innerWidth, "Runs fits the viewport");
  await windowed(wide);
  await reportReads();
  return { passed: true, viewport: [innerWidth, innerHeight], beside: wide };
}

// 500 finished runs in history: the list renders a window of 100 rows and counts all of them.
// History also holds a stale copy of the live APP-1; the live job wins and appears once.
const finished = Array.from({ length: 500 }, (_, i) => job(1000 + i, "complete", { completedAt: ago(3000 + i) }));
const longHistory = [{ ...jobs[0], state: "complete", completedAt: ago(2) }, ...finished];
const more = () => [...list().querySelectorAll("button")].find((b) => /^Show \d+ more of \d+$/.test(b.textContent.trim()));
async function windowed(wide) {
  await show("/runs?state=all", longHistory);
  const tabs = [...root.querySelectorAll('[aria-label="State"] [role="radio"]')].map((t) => t.textContent);
  assert(tabs.join() === "Open29,Needs you1,Finished501,Settled0,All530", `tab counts count every row, live state winning: ${tabs}`);
  assert(list().querySelector(".page-head h1 small").textContent === "530", "the title counts every matching row");
  assert(keys().length === 100 && keys().filter((k) => k === "APP-1").length === 1, `All renders a window of 100 rows with APP-1 once: ${keys().length}`);
  assert(more()?.textContent.trim() === "Show 100 more of 430", `the expand control names what remains: ${more()?.textContent}`);
  if (matchMedia("(pointer: coarse)").matches) assert(more().getBoundingClientRect().height >= 44, "the expand control is a 44px touch target");
  // A clock tick renders only the times, so the list is neither rendered nor rebuilt, and a row's time still moves.
  await checkTickRendersTimesOnly("Runs");
  const timing = () => list().querySelector(".next .muted[title]"), shownAt = [timing().textContent, timing().title];
  await tickRenders(60 * 60_000);
  assert(timing().textContent !== shownAt[0] && timing().title !== shownAt[1], `a row's time and tooltip follow the clock: ${shownAt} -> ${timing().textContent}, ${timing().title}`);
  store.clock.value = Date.now();
  // The control adds 100 rows and leaves the list where it was scrolled.
  {
    more().scrollIntoView({ block: "center" }); await pause();
    const before = scrollY;
    more().click(); await pause();
    assert(keys().length === 200 && Math.abs(scrollY - before) < 2 && more().textContent.trim() === "Show 100 more of 330", `the control adds 100 rows in place: ${keys().length}, ${before} -> ${scrollY}`);
    // A new tab, order, search or filter starts again at 100.
    const reset = async (change, what) => { more().click(); await pause(); assert(keys().length > 100, `expanded before changing the ${what}`); await change(); assert(keys().length === 100, `changing the ${what} returns to 100 rows: ${keys().length}`); };
    const tab = async (name) => { [...root.querySelectorAll('[aria-label="State"] [role="radio"]')].find((t) => t.textContent.startsWith(name)).click(); await pause(); };
    await reset(() => tab("Finished"), "tab");
    await reset(() => tab("All"), "tab");
    // Coming back to a view expanded earlier starts at 100 again, not at its old window.
    await reset(async () => { await tab("Finished"); await tab("All"); }, "tab and back");
    await reset(async () => { root.querySelector('[aria-label="Start order"] [aria-label="Oldest first"]').click(); await pause(); }, "order");
    await reset(async () => { const search = await openSearch(); search.value = "APP-1"; search.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }, "search");
    await reset(async () => { root.querySelector('[aria-label^="Filter runs"]').click(); await pause(); [...document.querySelectorAll('.popover [role="group"][aria-label="Difficulty"] button')].find((b) => b.getAttribute("aria-label") === "Medium").click(); await pause(); }, "filter");
  }
  // A run opened by its address beyond the window widens it: its row is shown and marked.
  await show("/runs/run-1400?state=all", longHistory);
  const target = rowLink("APP-1400");
  assert(target?.getAttribute("aria-current") === "true" && detail().textContent.includes("Synthetic ticket 1400") && keys().length > 100, `a run beyond the window is listed and marked: ${keys().length}`);
  if (wide) assert(visible(target) && visible(detail()), "the widened row sits beside its run");
}
// The open run's report is read again only when that run changes in a way the report can show.
// Each read records the change it followed, so a read a change should not cause is caught even when it arrives late.
async function reportReads() {
  await show("/runs/run-1");
  await until(() => detail().textContent.includes("Synthetic ticket 1"));
  readSteps = [];
  const live = (id, change) => { step++; store.applyState({ delta: true, status: { jobs: store.jobs.value.map((j) => (j.id === id ? { ...j, ...change(j) } : j)) } }); return step; };
  const activity = () => [...detail().querySelectorAll("dt")].find((dt) => dt.textContent === "Last activity").nextElementSibling.textContent;
  const before = activity(), quiet = [live("run-2", () => ({ state: "waiting", reason: "Another run", lastExecutionAt: new Date().toISOString() })), live("run-1", () => ({ lastExecutionAt: new Date().toISOString(), lastPersonalActivity: new Date().toISOString() }))];
  // Rendered before the next change, so these changes are not folded into it.
  await until(() => activity() !== before);
  const loud = [];
  for (const change of [() => ({ reason: "Now reviewing" }), (j) => ({ prUrls: [...j.prUrls, "https://github.com/example/app/pull/8"] }), (j) => ({ thread: { ...j.thread, pending: "approval" } }), () => ({ state: "waiting" })]) {
    loud.push(live("run-1", change));
    await until(() => readSteps.includes(step));
  }
  step++; store.applyState({ delta: true, status: { jobs: store.jobs.value.filter((j) => j.id !== "run-1") } }); loud.push(step);
  await until(() => readSteps.includes(step));
  assert(!quiet.some((s) => readSteps.includes(s)), `another run and the open run's progress times read nothing: ${readSteps} after ${quiet}`);
  assert(readSteps.join() === loud.join(), `the open run's reason, pull requests, pending request, state and leaving the live list each read its report once: ${readSteps} after ${loud}`);
}

window.runsTests = { show, run, reportReads, showLong: () => show("/runs?state=all", longHistory) };
await show();
