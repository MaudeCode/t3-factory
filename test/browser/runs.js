// Real app shell and Runs page: the list with the selected run beside it. Synthetic state and run-detail reads only.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { confirmation, finishConfirmation } from "../../web/lib/confirmation.js";
import { App } from "../../web/views/App.js";

const root = document.querySelector("#root");
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const job = (n, state, extra = {}) => ({ id: `run-${n}`, label: `APP-${n}`, taskId: `t${n}`, threadId: `th${n}`, projectId: "p", state, createdAt: ago(n * 3 + 5), lastExecutionAt: ago(1), providerDriver: "claudeAgent", difficulty: "med", thread: { title: `Synthetic ticket ${n}`, branch: `feat/APP-${n}-factory-x`, status: "running" }, ...extra });
// Thirty runs so the list scrolls; one waits on the owner and is not the newest.
const jobs = [...Array.from({ length: 28 }, (_, i) => job(i + 1, "running", i === 0 ? { prUrls: ["https://github.com/example/app/pull/7"] } : {})), job(40, "waiting", { reason: "Parked for inspection", thread: { title: "Needs a decision", pending: "question" } }), job(50, "complete", { completedAt: ago(2) })];
const state = {
  config: { enabled: false, concurrency: { claude: 1, codex: 1 }, models: [], kanvil: { url: "https://tracker.example", workspaceId: "w" }, projects: [{ kanvilId: "p", key: "APP", name: "Example", enabled: true }] },
  status: { jobs, journal: [] },
};
let reads = [], posts = [];
window.fetch = async (url, init) => {
  if (url === "/api/history") return Response.json(jobs);
  const read = /^\/api\/jobs\/([\w-]+)\/report$/.exec(url);
  if (read) {
    reads.push(read[1]);
    const found = jobs.find((j) => j.id === read[1]);
    return found ? Response.json({ job: found, events: [{ id: 1, time: ago(4), kind: "job.created", text: `Started ${found.label}`, data: {} }], report: found.state === "complete" ? { status: "complete", reason: "Merged and verified." } : null }) : Response.json({ message: "Run not found" }, { status: 404 });
  }
  if (init?.method === "POST") { posts.push(url); return Response.json({ ok: true }); }
  if (/^\/api\/tickets\//.test(url)) return Response.json({ id: "t1", projectId: "p", key: "APP-1", title: "Synthetic ticket 1", status: "in_progress", priority: "high", difficulty: "med", kind: "feature", labels: [], scopes: [], description: "", acceptanceCriteria: "", automationReady: true, holdReason: null, readiness: [], blockedBy: [], blocks: [], epic: null, createdAt: ago(900), url: "https://tracker.example/projects/p/tickets/t1" });
  return Response.json(state);
};
async function show(path = "/runs") {
  render(null, root);
  reads = []; posts = [];
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
    rowLink("APP-5").click(); await pause(200);
    history.back(); await pause(200);
    assert(location.pathname === "/runs/run-3" && rowLink("APP-3").getAttribute("aria-current") === "true" && detail().textContent.includes("Synthetic ticket 3"), "Back returns to the previously selected run");
  } else {
    assert(visible(list()) && !visible(detail()), "below the breakpoint the list stands alone");
    rowLink("APP-3").click(); await pause(200);
    assert(location.pathname === "/runs/run-3" && !visible(list()) && visible(detail()) && scrollY === 0, "a run replaces the list and starts at its top");
    const crumb = detail().querySelector(".crumb");
    assert(visible(crumb) && crumb.getAttribute("href") === "/runs", "the detail has its way back to Runs");
    crumb.click(); await pause(200);
    assert(location.pathname === "/runs" && visible(list()) && !visible(detail()), "the crumb returns to the list");
  }
  // A run opened by its address.
  await show("/runs/run-1");
  const d = detail();
  assert(visible(d) && d.textContent.includes("APP-1") && d.textContent.includes("Synthetic ticket 1") && (!wide || rowLink("APP-1").getAttribute("aria-current") === "true"), "a run address shows that run, selected in the list when the list is beside it");
  const actions = [...d.querySelectorAll(".run-actions a, .run-actions button")].map((el) => el.textContent.trim());
  assert(actions.join() === "Open in T3 Code,PR #7,Ticket,Cleanup review,Example", `one action row: ${actions}`);
  assert(d.querySelector(".run-actions a").getAttribute("href") === "/api/threads/th1/open", "Open in T3 Code opens the run's thread");
  const track = d.querySelector(".run-track");
  assert(track.querySelector(".now").textContent === "Working" && track.querySelector('[aria-current="step"]').textContent === "Working" && [...track.children].map((li) => li.textContent).join() === "Queued,Working,Needs you,Done", "the track names the four stops and marks the current one in text");
  for (const part of ["Model", "Started", "Last activity", "Difficulty", "Branch", "feat/APP-1-factory-x", "Timeline", "Started APP-1"]) assert(d.textContent.includes(part), `the detail shows ${part}`);
  // Ticket opens the ticket panel instead of the tracker.
  [...d.querySelectorAll(".run-actions button")].find((b) => b.textContent.trim() === "Ticket").click(); await pause(200);
  assert(document.querySelector("dialog.ticket-panel[open]") && location.pathname === "/runs/run-1", "Ticket opens the ticket panel on the run");
  document.querySelector("dialog.ticket-panel[open] .dialog-head button").click(); await pause(200);
  // Stop asks first.
  [...detail().querySelectorAll("button")].find((b) => b.textContent.trim() === "Stop run").click(); await pause();
  assert(confirmation.value?.title === "Stop APP-1?" && !posts.length, "Stop run asks before it posts");
  finishConfirmation(false); await pause();
  // A run that needs the owner says so; a finished one shows its report.
  await show("/runs/run-40");
  assert(detail().querySelector(".callout").textContent.includes("asked a question") && detail().querySelector(".run-track .now").textContent === "Needs you", "a waiting run shows what it waits for");
  await show("/runs/run-50");
  assert(detail().textContent.includes("Merged and verified.") && detail().querySelector(".run-track .now").textContent === "Done", "a finished run shows its report");
  // An unknown run reports the error where the detail goes and leaves the list usable.
  await show("/runs/missing");
  assert(detail().textContent.includes("Run not found") && (!wide || (visible(list()) && keys().length === 29)), "an unknown run is reported in the detail area");
  if (wide) { rowLink("APP-2").click(); await pause(200); assert(detail().textContent.includes("Synthetic ticket 2") && !detail().textContent.includes("Run not found"), "the list still selects a run after an error"); }
  assert(document.documentElement.scrollWidth <= innerWidth, "Runs fits the viewport");
  return { passed: true, viewport: [innerWidth, innerHeight], beside: wide };
}
window.runsTests = { show, run };
await show();
