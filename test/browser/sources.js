// Real app shell and Sources page; synthetic state, toggle and decision endpoints only.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { confirmation, finishConfirmation } from "../../web/lib/confirmation.js";
import { App } from "../../web/views/App.js";

const root = document.querySelector("#root");
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString(), ahead = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const report = (key, outcome, stage) => ({ id: key, time: ago(4000), kind: "triage", text: `${key} ${outcome}`, data: { ticket: key, ticketId: `r-${key}`, inboxId: "pin", project: "Example", outcome, stage, ...(outcome === "triaged" ? { verdict: "needs-info" } : {}) } });
const base = (inbox = true) => ({
  config: {
    enabled: true, concurrency: { claude: 1, codex: 1 }, models: [], kanvil: { url: "https://tracker.example", workspaceId: "w" },
    ...(inbox ? { triage: { enabled: true, promptFile: "/triage.md" } } : {}), upstream: { enabled: true, promptFile: "/review.md", checkMinutes: 360 },
    projects: [
      { kanvilId: "p", key: "APP", name: "Example", enabled: true, upstreams: [{ repo: "example/lib", name: "Library", firstBase: "v1.0.0", prereleases: false }], scopes: ["app"], ...(inbox ? { inbox: { kanvilId: "pin", label: "intake", maxPromotionsPerDay: 10 } } : {}) },
      { kanvilId: "q", key: "LIB", name: "Resting", enabled: true, upstreams: [] },
      { kanvilId: "r", key: "OFF", name: "Excluded", enabled: false, upstreams: [] },
      { kanvilId: "n", key: "NEW", name: "Untouched", enabled: true, upstreams: [] },
    ],
  },
  status: {
    journal: [], triageEnabled: true,
    jobs: [{ id: "d1", label: "discovery", kind: "discovery", projectId: "p", state: "complete", createdAt: ago(240), completedAt: ago(230), thread: { title: "Discovery" } }, { id: "u1", label: "Library v1.2.0", kind: "upstream", projectId: "p", state: "running", createdAt: ago(20), thread: { title: "Review" } }],
    discovery: [{ projectId: "p", lastAt: ago(240) }, { projectId: "q", lastAt: ago(600), nextAt: ahead(840) }],
    upstreams: [{ repo: "example/lib", reviewed: "v1.1.0", latest: "v1.2.0", pending: true, checkedAt: ago(30) }],
    triageStreams: inbox ? [{ project: "Example", projectId: "p", inboxId: "pin", label: "intake", synchronized: true, untriaged: 1, failed: 0, running: null, oldestUntriagedAt: ago(30), promoted: 2, queued: 0, blocked: 0, needsOwner: 1, limit: 10 }] : [],
    triageResults: [], triageReports: inbox ? [report("PIN-12", "triaged", "owner"), report("PIN-6", "needs-owner", "owner"), report("PIN-13", "waiting", "working")] : [],
    sessionTickets: { at: ago(2), error: null, rows: [{ taskId: "s1", key: "APP-7", title: "From a session", projectId: "p", sources: [{ title: "Plan", at: ago(5) }], createdAt: ago(9) }, { taskId: "s2", key: "APP-8", title: "Another", projectId: "p", sources: [{ title: "Plan", at: ago(5) }], createdAt: ago(8) }] },
  },
});
let state, posts = [];
window.fetch = async (url, init) => {
  if (url === "/api/history") return Response.json([]);
  if (init?.method === "POST") {
    posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === "/api/triage/enabled") { state.config.triage.enabled = posts.at(-1).body.enabled; state.status.triageEnabled = state.config.triage.enabled; }
    if (url === "/api/upstream/enabled") state.config.upstream.enabled = posts.at(-1).body.enabled;
  }
  return Response.json(state);
};
async function show(path = "/sources", inbox = true) {
  render(null, root);
  posts = [];
  store.operations.value = [];
  state = base(inbox);
  store.applyState(state, true);
  store.auth.value = { mode: "oidc", loginUrl: "/auth/login" };
  store.authenticated.value = true;
  navigate(path, true);
  render(html`<${App} />`, root);
  await pause(150);
}
const main = () => root.querySelector("main");
const tabs = () => [...main().querySelectorAll('[aria-label="Source"] [role="radio"]')];
const tab = (name) => tabs().find((t) => t.textContent.startsWith(name));
const button = (label) => [...document.querySelectorAll(`[aria-label="${label}"]`)].find((el) => el.getClientRects().length);
const section = (title) => [...main().querySelectorAll("section.section")].find((s) => s.querySelector("h2")?.textContent.startsWith(title));
const here = () => location.pathname + location.search;
const noOverflow = () => assert(document.documentElement.scrollWidth <= innerWidth, "Sources fits the viewport");

async function run() {
  // The old addresses land on their view.
  await show("/triage");
  assert(here() === "/sources" && main().querySelector("h1").textContent.includes("Sources") && tab("Inbox triage").getAttribute("aria-checked") === "true", "the old Triage address lands on Sources' Inbox triage view");
  assert(tabs().map((t) => t.textContent).join() === "Inbox triage2,Discovery,Upstream releases1,T3 sessions2", `one view per source, counting what needs attention: ${tabs().map((t) => t.textContent)}`);
  const current = [...root.querySelectorAll('.shell [aria-current="page"]')].map((a) => a.textContent.trim());
  assert(current.join() === "Sources", `navigation marks Sources: ${current}`);
  const names = [...root.querySelectorAll(".side nav a span, .tabbar a, .tabbar button")].map((el) => el.textContent.trim());
  assert(!names.includes("Triage") && !names.includes("Upstream") && names.includes("Sources"), "Triage and Upstream are no longer pages of their own");
  if (root.querySelector(".tabbar")) assert([...root.querySelectorAll(".tabbar a, .tabbar button")].map((el) => el.textContent.trim().replace(/\d+$/, "")).join() === "Now,Queue,Runs,Sources,More", "the phone tab bar reads Now, Queue, Runs, Sources, More");
  // Inbox triage: the inboxes, what waits on the owner, and the same decisions as before.
  assert(main().querySelector(".triage-inbox").textContent.includes("2 need you") && [...section("Needs you").querySelectorAll(".key")].map((k) => k.textContent).join() === "PIN-12,PIN-6", "a needs-info report older than the recent results stays under Needs you");
  button("Triage PIN-12 again").click(); await pause();
  assert(posts.some((p) => p.url === "/api/triage/reports/r-PIN-12/retry"), "Triage again posts the retry decision");
  button("Close PIN-6").click(); await pause();
  assert(confirmation.value?.title === "Close PIN-6?" && !posts.some((p) => p.url.endsWith("/close")), "Close asks first");
  finishConfirmation(true); await pause();
  assert(posts.some((p) => p.url === "/api/triage/reports/r-PIN-6/close"), "confirming posts the close decision");
  button("Triage waiting reports now").click(); await pause();
  assert(posts.some((p) => p.url === "/api/triage/run"), "Triage now asks for a pass");
  button("Triage settings").click(); await pause();
  const toggle = document.querySelector('dialog[open] input[role="switch"][aria-label="Inbox triage"]');
  toggle.click(); await pause(150);
  assert(posts.some((p) => p.url === "/api/triage/enabled" && p.body.enabled === false), "the triage switch posts triage.enabled = false");
  document.querySelector("dialog[open]").close(); await pause();
  // Discovery: every project, with its last look, its rest, or why it is skipped.
  tab("Discovery").click(); await pause(150);
  assert(here() === "/sources?view=discovery", "each view has its address");
  const lines = Object.fromEntries([...main().querySelectorAll(".next")].map((r) => [r.querySelector("b").textContent, r.textContent]));
  assert(/Last looked [34] h/.test(lines.Example) && lines.Example.includes("Done") && main().querySelector(".source-run").getAttribute("href") === "/runs/d1", `an included project shows its last look and its latest run: ${lines.Example}`);
  assert(/Found nothing; resting, looks again in 1[34] h/.test(lines.Resting), `a resting project says until when: ${lines.Resting}`);
  assert(lines.Excluded.includes("Not included in automatic work") && lines.Untouched.includes("Never run"), "an excluded project and one never looked at say so");
  // Upstream releases: the switch, the watched repository, a due review and the review runs.
  await show("/upstream");
  assert(here() === "/sources?view=upstream" && tab("Upstream releases").getAttribute("aria-checked") === "true", "the old Upstream address lands on its view");
  assert(main().textContent.includes("Library") && main().textContent.includes("review due") && main().textContent.includes("v1.2.0") && section("Reviews").querySelectorAll(".next").length === 1, "the watched repository, its due review and the review runs are listed");
  main().querySelector('input[role="switch"][aria-label="Upstream reviews"]').click(); await pause(150);
  assert(posts.some((p) => p.url === "/api/upstream/enabled" && p.body.enabled === false), "the reviews switch posts upstream.enabled = false");
  [...main().querySelectorAll("button")].find((b) => b.textContent.trim() === "Watch a repository").click(); await pause();
  assert(document.querySelector('dialog[open][aria-label="Watch a repository"]'), "Watch a repository opens its dialog");
  document.querySelector("dialog[open]").close(); await pause();
  button("Edit Library watch").click(); await pause();
  assert(document.querySelector('dialog[open][aria-label="Watching Library"]'), "a watched repository can be edited");
  document.querySelector("dialog[open]").close(); await pause();
  // T3 sessions: how many wait, and the way to them.
  tab("T3 sessions").click(); await pause(150);
  const link = main().querySelector('a.btn[href="/queue?origin=sessions"]');
  assert(here() === "/sources?view=sessions" && main().textContent.includes("2 tickets not started") && link, "T3 sessions counts the unstarted tickets and links to them");
  store.status.value = { ...store.status.value, sessionTickets: { ...store.status.value.sessionTickets, error: { message: "T3 could not be read" } } }; await pause();
  assert(main().textContent.includes("T3 could not be read"), "a session read error is shown with the source");
  link.click(); await pause(150);
  assert(here() === "/queue?origin=sessions", "the link opens the Queue's Sessions view");
  // Without an inbox there is no triage view; the page opens on Discovery.
  await show("/sources", false);
  assert(!tab("Inbox triage") && tab("Discovery").getAttribute("aria-checked") === "true" && main().textContent.includes("Example"), "with no inbox configured the triage view is absent");
  noOverflow();
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
window.sourcesTests = { show, run };
await show();
