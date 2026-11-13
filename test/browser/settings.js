// Real app shell and Settings area; only the server is synthetic.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { App } from "../../web/views/App.js";

const root = document.querySelector("#root");
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const budget = { reservePercent: 10, minRemainingPercent: 5 };
const initial = {
  enabled: false, concurrency: { claude: 2, codex: 1 }, pollSeconds: 60, idleMinutes: 30, monitoringTimeoutMinutes: 30, maxWaitingPRs: null,
  quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
  kanvil: { url: "https://tracker.example", workspaceId: "w" },
  models: [{ id: "m1", name: "Example model", automatic: true, maxDifficulty: "high", model: { instanceId: "codex", model: "example" } }],
  triage: { enabled: true, promptFile: "/prompts/triage.md" }, discovery: { promptFile: "/prompts/discovery.md", emptyCooldownHours: 24 }, upstream: { enabled: true, promptFile: "/prompts/review.md", checkMinutes: 360 },
  projects: [{ kanvilId: "p", key: "APP", name: "Example", enabled: true, githubRepo: "example/app", repoPath: "/repos/app", baseBranch: "main", readyStatuses: ["todo"], doneStatuses: ["done"], priorityLabels: [], labelLimits: {}, upstreams: [], scopes: ["app"], inbox: { kanvilId: "pin", label: "intake", maxPromotionsPerDay: 10 } }],
};
let saved, writes;
const state = () => ({ config: saved, status: { jobs: [], journal: [], triageEnabled: true, triageStreams: [{ project: "Example", projectId: "p", inboxId: "pin", label: "intake", synchronized: true, untriaged: 0, failed: 0, running: null, promoted: 0, queued: 0, blocked: 0, needsOwner: 0, limit: 10 }], triageResults: [], triageReports: [] } });
window.fetch = async (url, init) => {
  if (url === "/api/config" && init?.method === "POST") { const input = JSON.parse(init.body); writes.push(input); saved = structuredClone(input.config); return Response.json({ ok: true }); }
  if (url === "/api/sources") return Response.json({ t3: [], kanvil: { projects: [], columns: {}, labels: ["app", "web"] } });
  if (url === "/api/history") return Response.json([]);
  return Response.json(state());
};
async function show(path = "/settings") {
  render(null, root);
  saved = structuredClone(initial); writes = [];
  store.history.value = null; store.selectedProject.value = 0;
  store.providers.value = [{ instanceId: "codex", driver: "codex", status: "ready", models: [{ slug: "example", name: "Example" }] }];
  store.applyState(state(), true);
  store.auth.value = { mode: "oidc", loginUrl: "/auth/login" };
  store.authenticated.value = true;
  navigate(path, true);
  render(html`<${App} />`, root);
  await pause(150);
}
const main = () => root.querySelector("main");
const tabs = () => [...main().querySelectorAll('[aria-label="Settings"] [role="radio"]')];
const tab = (name) => tabs().find((t) => t.textContent === name);
const here = () => location.pathname + location.search;
const field = (label) => [...main().querySelectorAll(".field")].find((f) => f.querySelector(".field-label").textContent.trim().startsWith(label));
const type = async (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); await pause(); };
const sectionOf = (el) => el.closest("section.section").querySelector("h2").textContent.trim();

async function run() {
  // The old addresses land on their tabs; the bare address opens Projects.
  for (const [old, now, name] of [["/projects", "/settings/projects", "Projects"], ["/models", "/settings/models", "Models"], ["/capacity", "/settings/limits", "Limits"], ["/settings", "/settings", "Projects"], ["/settings/sources", "/settings/sources", "Sources"]]) {
    await show(old);
    assert(here() === now && main().querySelector("h1").textContent.includes("Settings") && tab(name).getAttribute("aria-checked") === "true", `${old} opens the ${name} tab at ${now}: ${here()}`);
  }
  assert(tabs().map((t) => t.textContent).join() === "Projects,Models,Limits,Sources", "four tabs");
  // Navigation: work first, then upkeep, Settings last.
  const names = [...root.querySelectorAll(".side nav a span")].map((el) => el.textContent.trim());
  if (names.length) assert(names.join() === "Now,Queue,Runs,Sources,Log,Storage,Settings", `the sidebar reads work, then upkeep: ${names}`);
  assert(root.querySelector('.shell [aria-current="page"]')?.textContent.trim().replace(/^More$/, "Settings") === "Settings", "navigation marks Settings");
  // Sources tab: each source's settings, once, bound to the paths they always had.
  const prompts = [...main().querySelectorAll(".field")].filter((f) => f.textContent.includes("Prompt file on your Mac"));
  assert(prompts.map(sectionOf).join() === "Inbox triage,Discovery,Upstream releases", `one prompt file per source: ${prompts.map(sectionOf)}`);
  await type(prompts[0].querySelector("input"), "/prompts/triage-2.md");
  await type(prompts[1].querySelector("input"), "/prompts/discovery-2.md");
  await type(prompts[2].querySelector("input"), "/prompts/review-2.md");
  const c = () => store.config.value;
  assert(c().triage.promptFile === "/prompts/triage-2.md" && c().discovery.promptFile === "/prompts/discovery-2.md" && c().upstream.promptFile === "/prompts/review-2.md", "the prompt files edit triage, discovery and upstream");
  assert(field("After finding nothing")?.querySelector('input[type="range"]') && field("Check for releases every")?.querySelector('input[type="range"]') && main().querySelector('[role="radiogroup"][aria-label="Example promotions per day"]'), "the cooldown, the check interval and each inbox's promotion limit are here");
  [...main().querySelectorAll('[aria-label="Example promotions per day"] button')].find((b) => b.textContent === "20").click(); await pause();
  assert(c().projects[0].inbox.maxPromotionsPerDay === 20, "the promotion limit edits its inbox");
  // A setting is a row: its name beside its control, stacked in a narrow column.
  const row = prompts[0], label = row.querySelector(".field-label").getBoundingClientRect(), input = row.querySelector("input").getBoundingClientRect();
  const wide = root.querySelector(".content").clientWidth > 700;
  assert(wide ? Math.abs(label.top + label.height / 2 - (input.top + input.height / 2)) < 12 && label.right <= input.left + 1 : label.bottom <= input.top + 1, `a setting row puts its name ${wide ? "beside" : "above"} its control`);
  // Unsaved edits survive a change of tab and save together.
  assert(root.querySelector(".save-bar").textContent.includes("4 unsaved changes"), `edits are counted: ${root.querySelector(".save-bar").textContent}`);
  tab("Models").click(); await pause(150);
  assert(here() === "/settings/models" && root.querySelector(".save-bar").textContent.includes("4 unsaved changes"), "switching tabs keeps unsaved edits");
  await type(main().querySelector('.detail input[type="text"]'), "Renamed model");
  tab("Limits").click(); await pause(150);
  assert(here() === "/settings/limits" && main().textContent.includes("Runs at once") && root.querySelector(".save-bar").textContent.includes("5 unsaved changes"), "Limits is the capacity page, with the edits still pending");
  [...root.querySelectorAll(".save-bar button")].find((b) => b.textContent.trim() === "Save changes").click(); await pause(200);
  const w = writes.at(-1)?.config;
  assert(writes.length === 1 && w.triage.promptFile === "/prompts/triage-2.md" && w.discovery.promptFile === "/prompts/discovery-2.md" && w.upstream.promptFile === "/prompts/review-2.md" && w.projects[0].inbox.maxPromotionsPerDay === 20 && w.models[0].name === "Renamed model", "one save carries the edits from every tab");
  assert(!root.querySelector(".save-bar"), "saving clears the unsaved bar");
  // Projects no longer carries discovery's settings, and Discard reverts an edit.
  tab("Projects").click(); await pause(150);
  assert(!main().textContent.includes("leave a project alone") && [...main().querySelectorAll("section.section h2")].every((h) => !h.textContent.startsWith("Discovery")), "discovery's settings left the Projects tab");
  const name = [...main().querySelectorAll('.detail input[type="text"]')][0];
  if (name) { await type(name, "Changed"); [...root.querySelectorAll(".save-bar button")].find((b) => b.textContent.trim() === "Discard").click(); await pause(150); assert(c().projects[0].name === "Example" && !root.querySelector(".save-bar"), "Discard reverts the edit"); }
  // Log and Storage keep their addresses under their new names.
  navigate("/activity"); await pause(150);
  assert(main().querySelector("h1").textContent.includes("Log"), "Activity is the Log");
  navigate("/cleanup"); await pause(150);
  assert(main().querySelector("h1").textContent.includes("Storage"), "Cleanup is Storage");
  assert(document.documentElement.scrollWidth <= innerWidth, "Settings fits the viewport");
  return { passed: true, viewport: [innerWidth, innerHeight], writes: writes.length };
}
window.settingsTests = { show, run };
await show();
