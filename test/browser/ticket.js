// Real app shell, Queue page and ticket panel; synthetic state, ticket reads and dispatch only.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { App } from "../../web/views/App.js";

const root = document.querySelector("#root");
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
// The tracker's text is untrusted: this description would run script if it were ever parsed as markup.
const HOSTILE = 'First line.\n<img src=x onerror="window.__ticketXss = true">\n<script>window.__ticketXss = true</script>\nLast line.\n\n## Outcome\n\nSet `mode` to **on**, see [the guide](https://docs.example/guide) or [this](javascript:window.__ticketXss=true).\n\n```\n' + "x".repeat(400) + '\n```\n\n| Ticket | Note |\n| --- | --- |\n| APP-90 | ' + "long cell text ".repeat(20) + '|';
const detail = (key, extra = {}) => ({
  id: `id-${key}`, projectId: "p", key, title: `Synthetic ticket ${key}`, status: "todo", priority: "high", difficulty: "med", kind: "feature", labels: ["feat", "web"], scopes: ["web"],
  description: HOSTILE, acceptanceCriteria: "- first criterion\n- second criterion", automationReady: true, holdReason: null, readiness: [],
  blockedBy: [{ key: "APP-90", title: "A finished blocker", done: true }], blocks: [{ key: "APP-91", title: "A dependent", done: false }], epic: "Billing v2", createdAt: ago(600),
  url: `https://tracker.example/projects/p/tickets/id-${key}`, ...extra,
});
const ticket = (n) => ({ id: `id-APP-${n}`, key: `APP-${n}`, title: `Synthetic ticket APP-${n}`, projectId: "p", priority: "high", difficulty: "med", labels: [] });
const state = {
  config: { enabled: false, concurrency: { claude: 1, codex: 1 }, models: [], kanvil: { url: "https://tracker.example", workspaceId: "w" }, projects: [{ kanvilId: "p", key: "APP", name: "Example", enabled: true }] },
  status: {
    jobs: [{ id: "run-1", label: "APP-1", taskId: "id-APP-1", projectId: "p", state: "complete", createdAt: ago(300), completedAt: ago(200), thread: { title: "Earlier run" } }],
    journal: [], upNext: { at: ago(1), tickets: [ticket(1), ticket(2), ticket(3)], held: [{ key: "APP-4", reason: "No difficulty set" }] },
  },
};
let reads = [], dispatches = [], failing = new Set(), hang = false;
window.fetch = async (url, init) => {
  if (url === "/api/history") return Response.json([]);
  if (/^\/api\/jobs\/[\w-]+\/report$/.test(url)) return Response.json({ job: state.status.jobs[0], events: [], report: null });
  if (url === "/api/dispatch") {
    const input = JSON.parse(init.body);
    dispatches.push(input);
    // A request either stays in flight or ends refused, so a second one can follow it.
    if (hang) await new Promise(() => {});
    return Response.json({ id: init.headers["Idempotency-Key"], input, state: "done", result: { data: { reason: "quota-exhausted" } } });
  }
  const read = /^\/api\/tickets\/(.+)$/.exec(url);
  if (read) {
    reads.push(read[1]);
    if (read[1] === "APP-404") return Response.json({ message: "Ticket not found" }, { status: 404 });
    if (failing.has(read[1])) return Response.json({ message: "Could not read the ticket" }, { status: 500 });
    return Response.json(detail(read[1], read[1] === "APP-3" ? { status: "done" } : read[1] === "IN-1" ? { inbox: true, projectId: "pin" } : {}));
  }
  return Response.json(state);
};
async function show(path = "/queue") {
  render(null, root);
  reads = []; dispatches = []; failing = new Set(); hang = false;
  store.operations.value = [];
  store.applyState(state, true);
  store.auth.value = { mode: "oidc", loginUrl: "/auth/login" };
  store.authenticated.value = true;
  navigate(path, true);
  render(html`<${App} />`, root);
  await pause(120);
}
const panel = () => document.querySelector("dialog.ticket-panel[open]");
const link = (key) => [...root.querySelectorAll("a.next-ticket")].find((a) => a.querySelector(".key")?.textContent === key);
const open = async (key) => { link(key).focus(); link(key).click(); await pause(120); };
const button = (name) => [...panel().querySelectorAll("button, a.btn")].find((b) => b.textContent.trim() === name);
const tab = (name) => [...panel().querySelectorAll('[aria-label="Ticket view"] [role="radio"]')].find((t) => t.textContent === name);
const factory = async () => { tab("Factory").click(); await pause(200); };

async function run() {
  await show();
  const path = location.pathname;
  // A modified click keeps the link's own tracker tab; the fixture stops the tab from opening.
  const stop = (e) => { e.preventDefault(); };
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
  document.addEventListener("click", stop, { once: true });
  link("APP-1").dispatchEvent(modified); await pause();
  assert(!panel() && !reads.length && link("APP-1").getAttribute("href").startsWith("https://tracker.example/") && link("APP-1").target === "_blank", "a modified click leaves the tracker link alone");
  await open("APP-1");
  assert(panel() && location.pathname === path && new URLSearchParams(location.search).get("ticket") === "APP-1", "a ticket opens in a panel on the same page, addressed by ?ticket=");
  assert(reads.join() === "APP-1", "one read per opened ticket");
  const text = panel().textContent;
  for (const part of ["APP-1", "Synthetic ticket APP-1", "To do", "high", "med", "feat", "First line.", "Last line.", "first criterion", "APP-90", "A finished blocker", "APP-91", "A dependent", "Billing v2", "Up next: 1 of 3"]) assert(text.includes(part), `the panel shows ${part}`);
  assert(text.includes('<img src=x onerror="window.__ticketXss = true">') && !panel().querySelector("img, script") && !window.__ticketXss, "tracker text is shown as text and never parsed");
  // Its Markdown is formatted: a heading, code, bold, a list, and only the https link.
  const body = panel().querySelector(".ticket-text"), links = [...panel().querySelectorAll(".ticket-text a")];
  assert(body.querySelector("h5").textContent === "Outcome" && body.querySelector("p code").textContent === "mode" && body.querySelector("strong").textContent === "on" && !text.includes("## Outcome"), "a description's Markdown is formatted");
  assert(links.length === 1 && links[0].href === "https://docs.example/guide" && links[0].target === "_blank" && text.includes("[this](javascript:"), "only an https link becomes a link");
  assert(panel().querySelectorAll(".ticket-text li").length === 2, "criteria written as a list render as one");
  const pre = body.querySelector("pre");
  assert(pre.scrollWidth <= pre.clientWidth && pre.getBoundingClientRect().height > 60 && panel().scrollWidth <= panel().clientWidth, "a long code line wraps inside the panel");
  const table = body.querySelector("table");
  assert(table.getBoundingClientRect().right <= body.getBoundingClientRect().right + 1, "a table with long cells stays inside the panel");
  // The panel opens on the ticket; Factory's side of it, the latest run, is the second tab.
  assert(tab("Ticket").getAttribute("aria-checked") === "true" && !panel().querySelector(".run-detail"), "the panel opens on the Ticket tab");
  await factory();
  const runView = panel().querySelector(".run-detail");
  assert(runView && runView.querySelector("a.crumb").getAttribute("href") === "/runs/run-1" && runView.textContent.includes("APP-1") && panel().textContent.includes("Up next: 1 of 3"), "the Factory tab shows the scheduler's line and the ticket's latest run");
  assert(![...runView.querySelectorAll("button, a.btn")].some((b) => b.textContent.trim() === "Ticket") && !panel().querySelector(".ticket-title"), "the run inside the panel offers no Ticket button and replaces the ticket text");
  assert(runView.getBoundingClientRect().right <= panel().getBoundingClientRect().right && panel().scrollWidth <= panel().clientWidth, "the run fits the panel");
  tab("Ticket").click(); await pause();
  assert(button("Open in tracker").getAttribute("href") === "https://tracker.example/projects/p/tickets/id-APP-1", "the tracker stays one link away");
  button("Done").click(); await pause(150);
  assert(!panel() && !location.search.includes("ticket=") && document.activeElement === link("APP-1"), "Done closes the panel, clears its address and returns focus to the row");
  // Run now posts what a row's Run now posts for its own ticket.
  await open("APP-1");
  button("Run now").click(); await pause();
  const fromPanel = dispatches.at(-1);
  button("Done").click(); await pause(150);
  root.querySelector('button[aria-label="Run APP-2 now"]').click(); await pause();
  const fromRow = dispatches.at(-1);
  assert(dispatches.length === 2 && fromPanel.ticket === "APP-1" && JSON.stringify({ ...fromPanel, ticket: "" }) === JSON.stringify({ ...fromRow, ticket: "" }), `the panel starts a run with the row's payload: ${JSON.stringify(fromPanel)} vs ${JSON.stringify(fromRow)}`);
  // With a request pending for the ticket, the panel refuses for the same reason the row does.
  await show("/queue?ticket=APP-1");
  assert(panel() && reads.join() === "APP-1", "the panel is reachable by URL");
  hang = true;
  button("Run now").click(); await pause();
  assert(button("Run now").disabled && panel().querySelector(".ticket-line").textContent === "A request for this ticket is already pending.", "Run now is held for the reason the row gives");
  // Back closes it.
  await show(); await open("APP-2");
  history.back(); await pause(150);
  assert(!panel() && !location.search.includes("ticket="), "Back closes the panel");
  // A click on the backdrop closes it; a phone has no backdrop, the panel is the screen.
  if (innerWidth > 700) {
    await open("APP-2");
    panel().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 2, clientY: 2 })); await pause(150);
    assert(!panel(), "a click outside the panel closes it");
  }
  // A closed ticket cannot be started.
  await open("APP-3");
  assert(button("Run now").disabled && panel().querySelector(".ticket-line").textContent === "APP-3 is done.", "a finished ticket says why it cannot start");
  button("Done").click(); await pause(120);
  // Another ticket opens on its Ticket tab again; a ticket with no runs says so.
  await open("APP-1"); await factory(); button("Done").click(); await pause(150);
  await open("APP-2");
  assert(tab("Ticket").getAttribute("aria-checked") === "true" && panel().querySelector(".ticket-title"), "the next ticket opens on Ticket");
  await factory();
  assert(panel().textContent.includes("No runs yet.") && !panel().querySelector(".run-detail"), "a ticket with no runs says so");
  button("Done").click(); await pause(150);
  // An inbox report is read like a ticket but cannot be run.
  await show("/queue?ticket=IN-1");
  assert(panel().textContent.includes("Synthetic ticket IN-1") && !button("Run now") && button("Open in tracker"), "an inbox report shows without Run now");
  // Opening the run's own page is one navigation: the panel closes and the run stays open.
  await show(); await open("APP-1"); await factory();
  panel().querySelector(".run-detail a.crumb").click(); await pause(300);
  assert(!panel() && location.pathname === "/runs/run-1" && !location.search.includes("ticket="), `a run link closes the panel and lands on the run: ${location.pathname}${location.search}`);
  // Not found and failed reads.
  await show("/queue?ticket=APP-404");
  assert(panel().querySelector('[role="alert"]').textContent.includes("APP-404 was not found") && !button("Retry"), "an unknown ticket says so and offers no retry");
  await show(); failing.add("APP-2"); await open("APP-2");
  assert(panel().querySelector('[role="alert"]').textContent.includes("Could not read APP-2"), "a failed read is reported");
  failing.clear(); button("Retry").click(); await pause(120);
  assert(panel().textContent.includes("Synthetic ticket APP-2") && reads.filter((k) => k === "APP-2").length === 2, "Retry repeats the read");
  // Geometry.
  const box = panel().getBoundingClientRect();
  assert(innerWidth <= 700 ? box.left === 0 && box.width === innerWidth : box.right === innerWidth && box.width <= 560, `the panel is a right drawer, or the whole screen on a phone: ${box.left},${box.width}`);
  assert(box.height === innerHeight && document.documentElement.scrollWidth <= innerWidth && panel().scrollWidth <= panel().clientWidth, "the panel fills the height without sideways scroll");
  if (matchMedia("(pointer: coarse)").matches) for (const b of panel().querySelectorAll("button, a.btn")) assert(b.getBoundingClientRect().height >= 44, `panel controls are touch targets: ${b.textContent.trim()}`);
  // A home-screen app in landscape on a touch screen draws under the live-activity pill in the top right corner.
  // No browser here can be that display, so the rule is switched on to measure what it does.
  const gap = (el) => innerWidth - el.getBoundingClientRect().right;
  const corner = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((r) => r.media?.mediaText.includes("display-mode: standalone"));
  assert(corner && /orientation: landscape/.test(corner.media.mediaText) && /pointer: coarse/.test(corner.media.mediaText), "the corner clearance applies to a standalone, landscape, touch display only");
  const before = gap(button("Done")), condition = corner.media.mediaText;
  corner.media.mediaText = "all"; await pause();
  assert(gap(button("Done")) >= 76 && gap(button("Done")) > before, `the panel's Done button clears the pill: ${gap(button("Done"))}`);
  button("Done").click(); await pause(150);
  for (const el of root.querySelectorAll(".page-head > :last-child, .top > :last-child")) if (el.getClientRects().length) assert(gap(el) >= 76, `the page's top-right controls clear the pill: ${gap(el)}`);
  corner.media.mediaText = condition;
  assert(document.documentElement.scrollWidth <= innerWidth, "the clearance adds no sideways scroll");
  return { passed: true, viewport: [innerWidth, innerHeight], coarse: matchMedia("(pointer: coarse)").matches };
}
window.ticketTests = { show, run, open };
await show();
