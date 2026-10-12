const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const clone = (v) => structuredClone(v);
const uuid = () =>
  crypto.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );

const state = {
  config: null,
  base: null,
  status: {},
  providers: [],
  page: "overview",
  busy: false,
  operation: null,
  readinessConfirmation: null,
  editModel: 0,
  project: 0,
  liveEnabled: false,
  liveUpstream: false,
  liveConcurrency: { claude: 1, codex: 1 },
};
const titles = {
  overview: "Overview",
  runs: "Runs",
  models: "Models",
  automation: "Automation",
  projects: "Projects",
  discovery: "Discovery",
  upstream: "Upstream",
};
const STREAM_REASONS = {
  "provider-running": "Working",
  "provider-disabled": "Automatic starts off",
  "waiting-for-idle": "Waiting for idle time",
  "quota-exhausted": "Allowance exhausted",
  "quota-budget": "Waiting for budget",
  "no-eligible-model": "No automatic model available",
  "difficulty-limit": "No tickets within difficulty limits",
  "needs-classification": "Tickets need difficulty labels",
  "no-eligible-ticket": "Watching the queue",
  dispatched: "Working",
  "would-dispatch": "Ready to start",
};

// Config editing -----------------------------------------------------------
const dirty = () =>
  state.config && JSON.stringify(state.config) !== JSON.stringify(state.base);
const at = (path) => path.reduce((o, k) => o?.[k], state.config);
function set(path, value) {
  let o = state.config;
  for (const key of path.slice(0, -1)) o = o[key];
  o[path.at(-1)] = value;
  saveBar();
}
const saveBar = () => ($("#save-bar").hidden = !dirty());
const pathAttr = (path) => esc(JSON.stringify(path));
const field = (title, path, type = "text", extra = "") =>
  `<label class="field"><span>${esc(title)}</span><input data-path="${pathAttr(path)}" data-kind="${type === "integer" ? "number" : type}" type="${["number", "integer"].includes(type) ? "number" : "text"}" value="${esc(at(path))}" ${type === "integer" ? 'min="0" step="1"' : type === "number" ? 'min="0" step="any"' : ""} ${extra}></label>`;
const check = (title, path) =>
  `<label class="check"><input type="checkbox" data-path="${pathAttr(path)}" data-kind="boolean" ${at(path) ? "checked" : ""}><span>${esc(title)}</span></label>`;
const select = (title, path, options) =>
  `<label class="field"><span>${esc(title)}</span><select data-path="${pathAttr(path)}">${options.map(([v, n]) => `<option value="${esc(v)}" ${at(path) === v ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`;

// Messaging & API ----------------------------------------------------------
function message(text, error = false) {
  $("#error").hidden = true;
  $("#notice").hidden = true;
  if (!text) return;
  const el = $(error ? "#error" : "#notice");
  el.textContent = text;
  el.hidden = false;
}
async function api(path, options = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data !== null) return data;
    // A proxy can return an empty/HTML error. Retry reads only; dispatches keep their saved request ID.
    if (attempt === 0 && (options.method || "GET").toUpperCase() === "GET" && [502, 503, 504].includes(response.status)) continue;
    if (response.status === 401) showLogin();
    const error = new Error(data?.message || data?.reason || (response.ok
      ? "Factory returned an empty or invalid response. Check request status before retrying."
      : `Factory request failed (HTTP ${response.status}).`));
    error.status = response.status;
    throw error;
  }
}
function showLogin() {
  $("#login").hidden = false;
  $("#app").hidden = true;
}
function loginError(text) {
  $("#login-error").textContent = text;
  $("#login-error").hidden = !text;
}
function connection(text, cls) {
  const el = $("#connection");
  el.textContent = text;
  el.className = `conn ${cls}`;
}
async function connect(code) {
  const match = code.match(/[#&]pair=([^&]+)/);
  await api("/api/session", {
    method: "POST",
    body: JSON.stringify({ code: match ? decodeURIComponent(match[1]) : code.trim() }),
  });
  history.replaceState(null, "", "/");
  await load(true);
  restoreOperation();
}
async function load(reset = false) {
  try {
    const data = await api("/api/state");
    state.status = data.status;
    if (!state.config || reset) {
      state.config = clone(data.config);
      state.base = clone(data.config);
    }
    state.liveEnabled = data.config.enabled;
    state.liveUpstream = !!data.config.upstream?.enabled;
    state.liveConcurrency = data.config.concurrency;
    $("#login").hidden = true;
    $("#app").hidden = false;
    connection("Connected", "online");
    if (reset) render();
    else if (state.page === "overview") renderLive();
    else if (state.page === "runs") renderRuns();
    else if (state.page === "upstream") renderUpstream();
    return data;
  } catch (error) {
    connection("Offline", "offline");
    if (!$("#app").hidden) message(error.message, true);
    throw error;
  }
}

// Rendering ----------------------------------------------------------------
function render() {
  $("#page-title").textContent = titles[state.page];
  for (const el of document.querySelectorAll("nav [data-page]"))
    el.setAttribute("aria-current", el.dataset.page === state.page ? "page" : "false");
  $("#page").innerHTML = { overview, runs, models, automation, projects, discovery, upstream }[state.page]();
  saveBar();
  if (state.page === "overview") {
    renderLive();
    renderOperation();
  } else if (state.page === "runs") renderRuns();
  else if (state.page === "upstream") renderUpstream();
}
const ago = (date) => {
  if (!date) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(date)) / 1000);
  return s < 60
    ? `${Math.floor(s)}s ago`
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : s < 86400
        ? `${Math.floor(s / 3600)}h ago`
        : `${Math.floor(s / 86400)}d ago`;
};
const providerOf = (job) =>
  job.providerDriver || (job.modelSelection?.instanceId === "codex" ? "codex" : "claudeAgent");
function safeLink(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? esc(u.href) : "";
  } catch {
    return "";
  }
}

function overview() {
  return `
<div class="status">
  <span id="status-dot" class="dot"></span>
  <div class="grow"><strong id="factory-state"></strong><small id="last-check"></small></div>
  <input type="checkbox" role="switch" id="enable-toggle" class="switch" aria-labelledby="factory-state">
</div>
<section class="section"><div id="streams" class="cols"></div></section>
<section class="section">
  <div class="section-head"><h2>Start a run</h2></div>
  <form id="run-form">
    <div class="run-form">
      <label class="field"><span>Ticket</span><input id="run-ticket" placeholder="APP-8, blank for next eligible" autocapitalize="characters" spellcheck="false" class="mono"></label>
      <label class="field"><span>Model</span><select id="run-model"><option value="auto">Automatic</option>${state.config.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></label>
      <button id="run-button" class="btn btn-primary">Start run</button>
    </div>
    <label class="check"><input type="checkbox" id="run-override" checked><span>Skip idle and reserve thresholds</span></label>
    <p class="hint">Readiness, difficulty limits, duplicate checks, and merge rules still apply.</p>
  </form>
  <div id="operation"></div>
</section>
<section class="section">
  <div class="section-head"><h2>Runs</h2><a href="#runs" data-page="runs">View all</a></div>
  <p id="run-summary" class="hint"></p>
</section>`;
}
function renderLive() {
  const enabled = state.liveEnabled;
  $("#factory-state").textContent = enabled ? "Automation on" : "Automation paused";
  $("#status-dot").classList.toggle("paused", !enabled);
  const toggle = $("#enable-toggle");
  toggle.checked = enabled;
  toggle.disabled = state.busy;
  $("#last-check").textContent = `Last check ${ago(state.status.decision?.at)}`;
  const jobs = state.status.jobs || [];
  $("#streams").innerHTML = ["claudeAgent", "codex"]
    .map((driver) => {
      const stream = (state.status.streams || []).find((s) => s.driver === driver) || {};
      const active = jobs.filter(
        (j) => providerOf(j) === driver && ["running", "dispatching"].includes(j.state),
      );
      const limit = state.liveConcurrency?.[driver === "codex" ? "codex" : "claude"] ?? 1;
      const direct = state.status.decision?.quota;
      const quota = direct?.driver === driver ? direct : stream.quota;
      const fable = quota?.factoryRouting?.fableRemainingPercent;
      return `<div>
  <div class="section-head"><h2>${driver === "codex" ? "Codex" : "Claude"}</h2><span class="hint">${esc(!enabled && !active.length ? "Paused" : STREAM_REASONS[stream.reason] || "Watching the queue")}</span></div>
  <div class="stat-num">${active.length}<small>running · automatic limit ${limit}</small></div>
  <p class="hint mono">${active.length ? active.map((j) => esc(j.label)).join(", ") : "Slot free"}</p>
  ${fable != null ? meter("Fable allowance", fable) : ""}
  ${(quota?.windows || []).map((w) => meter(w.name === "fiveHour" ? "Five-hour window" : "Weekly window", w.remaining)).join("")}
  ${quota?.capturedAt ? `<p class="hint" style="margin-top:8px">Quota checked ${ago(quota.capturedAt)}</p>` : ""}
</div>`;
    })
    .join("");
  const waiting = jobs.filter((j) => j.state === "waiting").length,
    running = jobs.filter((j) => ["running", "dispatching"].includes(j.state)).length;
  $("#run-summary").textContent = waiting
    ? `${running} running · ${waiting} waiting for you`
    : `${running} running · nothing waiting on you`;
}
function renderRuns() {
  const jobs = state.status.jobs || [];
  $("#waiting-jobs").innerHTML = jobTable(
    jobs.filter((j) => j.state === "waiting"),
    "Nothing waiting on you.",
    Infinity,
  );
  $("#recent-jobs").innerHTML = jobTable(
    jobs
      .filter((j) => j.state !== "waiting")
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    "No runs yet.",
    10,
  );
}
function runs() {
  return `
<section class="section">
  <div class="section-head"><h2>Needs attention</h2></div>
  <div id="waiting-jobs"></div>
</section>
<section class="section">
  <div class="section-head"><h2>Recent</h2></div>
  <div id="recent-jobs"></div>
</section>`;
}
function jobTable(jobs, empty, limit) {
  if (!jobs.length) return `<p class="empty">${empty}</p>`;
  const table = (rows) =>
    `<table class="table jobs stack"><thead><tr><th>Run</th><th>Model</th><th>Links</th><th></th></tr></thead><tbody>${rows.map(jobRow).join("")}</tbody></table>`;
  const rest = jobs.slice(limit);
  return (
    table(jobs.slice(0, limit)) +
    (rest.length ? `<details class="more"><summary>Show ${rest.length} more</summary>${table(rest)}</details>` : "")
  );
}
function meter(label, remaining) {
  const n = Math.max(0, Math.min(100, Number(remaining) || 0));
  return `<div class="meter ${n < 20 ? "low" : ""}"><div class="meter-label"><span>${esc(label)}</span><span>${Math.round(n)}% left</span></div><progress aria-label="${esc(label)} remaining" max="100" value="${n}"></progress></div>`;
}
function jobRow(j) {
  const prs = (j.prUrls || [])
    .map((url, i) => {
      const href = safeLink(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">PR${i ? " " + (i + 1) : ""}</a>`
        : "";
    })
    .join("");
  const ticket = j.taskId
    ? safeLink(
        `${state.config.kaneo.url}/dashboard/workspace/${encodeURIComponent(state.config.kaneo.workspaceId)}/project/${encodeURIComponent(j.projectId)}/task/${encodeURIComponent(j.taskId)}`,
      )
    : "";
  return `<tr>
  <td><strong class="mono">${esc(j.label)}</strong> <span class="tag ${esc(j.state)}">${esc(j.state === "dispatching" ? "starting" : j.state)}</span></td>
  <td><span class="mono">${esc(j.modelSelection?.model || "Factory")}</span> <span class="sub">${ago(j.createdAt)}</span></td>
  <td class="links">${ticket ? `<a href="${ticket}" target="_blank" rel="noopener noreferrer">Ticket</a>` : ""}${prs}</td>
  <td><details><summary>Details</summary><p>${esc(j.reason || "No details yet.")}</p></details></td>
</tr>`;
}

function models() {
  const list = state.config.models;
  return `
<div class="toolbar"><p class="hint">Highest priority first. Both providers pick from this list.</p><button class="btn btn-primary btn-sm" data-action="add-model">Add model</button></div>
<section class="section">
<table class="table stack">
  <thead><tr><th class="num">#</th><th>Name</th><th>Model</th><th>Mode</th><th>Max difficulty</th><th></th></tr></thead>
  <tbody>${list
    .map(
      (m, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td><strong>${esc(m.name)}</strong></td>
  <td class="mono">${esc(m.model.instanceId)} · ${esc(m.model.model)}</td>
  <td><span class="tag">${m.automatic ? "Automatic" : "Manual"}</span></td>
  <td data-label="Max difficulty">${m.maxDifficulty === "med" ? "Medium" : m.maxDifficulty === "low" ? "Low" : "High"}</td>
  <td><div class="actions">
    <button class="btn btn-sm btn-icon" aria-label="Raise ${esc(m.name)}" data-action="move-model" data-index="${i}" data-direction="-1" ${i === 0 ? "disabled" : ""}>↑</button>
    <button class="btn btn-sm btn-icon" aria-label="Lower ${esc(m.name)}" data-action="move-model" data-index="${i}" data-direction="1" ${i === list.length - 1 ? "disabled" : ""}>↓</button>
    <button class="btn btn-sm" data-action="edit-model" data-index="${i}">Edit</button>
  </div></td>
</tr>`,
    )
    .join("")}</tbody>
</table>
</section>
<p class="hint">Unclassified tickets are skipped. Tickets above a model's difficulty ceiling are not eligible.</p>
<button class="btn btn-ghost btn-sm" data-action="catalog">Refresh model catalog</button>`;
}
function modelEditor(index) {
  state.editModel = index;
  const p = ["models", String(index)],
    m = state.config.models[index],
    provider = state.providers.find((x) => x.instanceId === m.model.instanceId),
    available = provider?.models || [],
    chosen = available.find((x) => x.slug === m.model.model),
    descriptors = (chosen?.capabilities?.optionDescriptors || []).filter((d) => d.type === "select"),
    opts = m.model.options || [];
  const providerOptions =
    (provider ? "" : `<option>${esc(m.model.instanceId)}</option>`) +
    state.providers
      .map(
        (x) =>
          `<option value="${esc(x.instanceId)}" ${x.instanceId === m.model.instanceId ? "selected" : ""}>${x.driver === "codex" ? "Codex" : "Claude"}${x.instanceId === x.driver ? "" : " · " + esc(x.instanceId)}</option>`,
      )
      .join("");
  const slugOptions =
    (chosen ? "" : `<option value="${esc(m.model.model)}">${esc(m.model.model || "Choose a model")}</option>`) +
    available
      .map((x) => `<option value="${esc(x.slug)}" ${x.slug === m.model.model ? "selected" : ""}>${esc(x.name || x.slug)}</option>`)
      .join("");
  $("#model-editor").innerHTML =
    field("Name", [...p, "name"]) +
    `<label class="field"><span>Provider</span><select id="edit-provider">${providerOptions}</select></label>` +
    `<label class="field"><span>Model</span><select id="edit-slug">${slugOptions}</select></label>` +
    descriptors
      .map((d) => {
        const current = opts.find((o) => o.id === d.id)?.value ?? d.currentValue ?? d.options.find((o) => o.isDefault)?.id;
        return `<label class="field"><span>${esc(d.label || d.id)}</span><select data-option="${esc(d.id)}">${d.options.map((o) => `<option value="${esc(o.id)}" ${current == o.id ? "selected" : ""}>${esc(o.label || o.id)}</option>`).join("")}</select></label>`;
      })
      .join("") +
    check("Use for automatic runs", [...p, "automatic"]) +
    select("Maximum ticket difficulty", [...p, "maxDifficulty"], [["low", "Low"], ["med", "Medium"], ["high", "High"]]) +
    `<p class="hint">The ceiling also applies to manual runs.</p>
<button class="btn btn-danger btn-sm" style="margin-top:12px" data-action="remove-model" data-index="${index}" ${state.config.models.length === 1 ? "disabled" : ""}>Remove model</button>`;
  if (!$("#model-dialog").open) $("#model-dialog").showModal();
}
function chooseModel(index, instance, slug) {
  const m = state.config.models[index],
    available = state.providers.find((p) => p.instanceId === instance)?.models || [];
  const selected =
    available.find((x) => x.slug === slug) || available.find((x) => x.isDefault) || available[0];
  if (!selected) throw new Error("No models available for that provider");
  m.model = {
    instanceId: instance,
    model: selected.slug,
    options: (selected.capabilities?.optionDescriptors || [])
      .filter((d) => d.type === "select")
      .map((d) => ({
        id: d.id,
        value: d.options.find((o) => o.isDefault)?.id ?? d.currentValue ?? d.options[0]?.id,
      }))
      .filter((o) => o.value !== undefined),
  };
  if (selected.slug.includes("fable")) m.quotaWindowId = "seven_day_fable";
  else delete m.quotaWindowId;
  saveBar();
  modelEditor(index);
}

function automation() {
  const budget = (provider, title, windows) => `<section class="section">
  <div class="section-head"><h2>${title}</h2></div>
  <table class="table">
    <thead><tr><th>Window</th><th>Reserve at start (%)</th><th>Minimum to start (%)</th></tr></thead>
    <tbody>${windows
      .map(
        ([key, label]) => `<tr><td>${label}</td>
      <td><input aria-label="${title} ${label} reserve percent" type="number" min="0" max="100" data-kind="number" data-path="${pathAttr(["quota", provider, key, "reservePercent"])}" value="${at(["quota", provider, key, "reservePercent"])}"></td>
      <td><input aria-label="${title} ${label} minimum percent" type="number" min="0" max="100" data-kind="number" data-path="${pathAttr(["quota", provider, key, "minRemainingPercent"])}" value="${at(["quota", provider, key, "minRemainingPercent"])}"></td></tr>`,
      )
      .join("")}</tbody>
  </table>
</section>`;
  return `
<p class="lead">Choose how much work each provider can run at once. Running jobs always finish.</p>
<section class="section">
  <div class="section-head"><h2>Simultaneous runs</h2></div>
  <div class="form-grid">${field("Claude run limit", ["concurrency", "claude"], "integer")}${field("Codex run limit", ["concurrency", "codex"], "integer")}</div>
  <p class="hint">Set 0 to turn off automatic starts for that provider. Runs waiting for your input free a slot. Manual runs can exceed the limit and count toward it while active. Lowering a limit does not stop running work.</p>
</section>
<section class="section">
  <div class="section-head"><h2>Timing</h2></div>
  <div class="form-grid">${field("Provider idle time (minutes)", ["idleMinutes"], "number")}${field("Check interval (seconds)", ["pollSeconds"], "number")}</div>
</section>
${budget("claude", "Claude budgets", [["fiveHour", "Five-hour"], ["weekly", "Weekly"], ["fable", "Fable"]])}
${budget("codex", "Codex budget", [["weekly", "Weekly"]])}
<section class="section">
  <div class="section-head"><h2>Waiting and recovery</h2></div>
  <label class="check"><input id="unlimited" type="checkbox" ${state.config.maxWaitingPRs === null ? "checked" : ""}><span>Unlimited runs awaiting input</span></label>
  ${state.config.maxWaitingPRs === null ? "" : field("Maximum waiting runs", ["maxWaitingPRs"], "number")}
  ${field("Park inactive monitors after (minutes)", ["monitoringTimeoutMinutes"], "number")}
</section>`;
}
function projects() {
  const entries = state.config.projects;
  state.project = Math.min(state.project, entries.length - 1);
  const i = state.project,
    p = ["projects", String(i)],
    current = entries[i];
  const busy = (state.status.jobs || []).some(
    (j) => j.projectId === current.kaneoId && j.state !== "complete",
  );
  return `
<div class="toolbar">
  <select id="project-select" aria-label="Project">${entries.map((x, j) => `<option value="${j}" ${j === i ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
  <button class="btn btn-sm" data-action="add-project">Add project</button>
</div>
<section class="section">
  <div class="section-head"><h2>Repository</h2></div>
  ${check("Include this project", [...p, "enabled"])}
  ${field("Name", [...p, "name"])}
  ${field("Repository path on your Mac", [...p, "repoPath"], "text", 'class="mono"')}
  <div class="form-grid">${field("GitHub owner/repo", [...p, "githubRepo"], "text", 'class="mono"')}${field("Base branch", [...p, "baseBranch"], "text", 'class="mono"')}</div>
</section>
<section class="section">
  <div class="section-head"><h2>Tickets</h2></div>
  ${field("Ticket prefix", [...p, "key"], "text", 'class="mono"')}
  <label class="field"><span>Priority labels</span><input data-list="${pathAttr([...p, "priorityLabels"])}" value="${esc((current.priorityLabels || []).join(", "))}" aria-describedby="priority-labels-hint"></label>
  <p class="hint" id="priority-labels-hint">Comma-separated, highest first. Matching tickets come before unmatched tickets, then urgency decides. Leave empty to use urgency alone.</p>
  <details class="group"><summary>Tracker and T3 identifiers</summary>
    ${field("Kaneo project ID", [...p, "kaneoId"], "text", 'class="mono"')}
    ${field("T3 project ID", [...p, "t3Id"], "text", 'class="mono"')}
    <label class="field"><span>Ready statuses</span><input data-list="${pathAttr([...p, "readyStatuses"])}" value="${esc(current.readyStatuses.join(", "))}"></label>
    <label class="field"><span>Done statuses</span><input data-list="${pathAttr([...p, "doneStatuses"])}" value="${esc(current.doneStatuses.join(", "))}"></label>
  </details>
  <p class="hint">Register the repository in T3 before enabling it here.</p>
  <button class="btn btn-danger btn-sm" style="margin-top:12px" data-action="remove-project" ${busy || entries.length === 1 ? "disabled" : ""}>Remove project</button>
</section>`;
}
function discovery() {
  return `
<p class="lead">When no tickets are eligible, each free provider can investigate a project for new work. Tickets waiting for classification are skipped, not replaced.</p>
<section class="section">
  <div class="section-head"><h2>Prompt</h2></div>
  ${field("Prompt file on your Mac", ["discovery", "promptFile"], "text", 'class="mono"')}
  <p class="hint" style="margin:-6px 0 14px">Read for each discovery run. Edit the file itself from the Mac app.</p>
  ${field("Wait after finding no work (hours)", ["discovery", "emptyCooldownHours"], "number")}
</section>`;
}
const NO_UPSTREAMS = `<p class="empty">No watched repositories. Add <code>upstream</code> and a project's <code>upstreams</code> to the config file.</p>`;
function upstream() {
  if (!state.config.upstream) return NO_UPSTREAMS;
  return `
<div class="status">
  <span id="upstream-dot" class="dot"></span>
  <div class="grow"><strong id="upstream-state"></strong></div>
  <input type="checkbox" role="switch" id="upstream-toggle" class="switch" aria-labelledby="upstream-state">
</div>
<p class="hint">Runs independently of ticket automation. Quota and idle gates still apply.</p>
<section class="section">
  <div class="section-head"><h2>Watched releases</h2></div>
  <div id="upstream-repos"></div>
</section>
<section class="section">
  <div class="section-head"><h2>Reviews</h2></div>
  <div id="upstream-jobs"></div>
</section>
<section class="section">
  <div class="section-head"><h2>Settings</h2></div>
  ${field("Prompt file on your Mac", ["upstream", "promptFile"], "text", 'class="mono"')}
  ${field("Check interval (minutes)", ["upstream", "checkMinutes"], "number")}
</section>`;
}
function renderUpstream() {
  const toggle = $("#upstream-toggle");
  if (!toggle) return;
  const on = state.liveUpstream,
    rows = state.status.upstreams || [];
  $("#upstream-state").textContent = on ? "Reviews on" : "Reviews paused";
  $("#upstream-dot").classList.toggle("paused", !on);
  toggle.checked = on;
  toggle.disabled = state.busy;
  $("#upstream-repos").innerHTML = rows.length
    ? `<table class="table stack"><thead><tr><th>Repository</th><th>Reviewed through</th><th>Latest release</th><th>Checked</th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr>
  <td><strong>${esc(r.name)}</strong> <span class="sub mono">${esc(r.repo)}${r.prereleases ? " · pre-releases" : ""}</span></td>
  <td data-label="Reviewed through"><span class="mono">${esc(r.reviewed)}</span></td>
  <td data-label="Latest release"><span class="mono">${esc(r.latest || "Not checked")}</span>${r.reviewing ? ' <span class="tag running">reviewing</span>' : r.pending ? ' <span class="tag waiting">review due</span>' : ""}</td>
  <td data-label="Checked">${ago(r.checkedAt)}${r.checkError ? ` <details><summary>Failed</summary><p>${esc(r.checkError)}</p></details>` : ""}</td>
</tr>`,
        )
        .join("")}</tbody></table>`
    : NO_UPSTREAMS;
  $("#upstream-jobs").innerHTML = jobTable(
    (state.status.jobs || [])
      .filter((j) => j.kind === "upstream")
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    "No reviews yet.",
    10,
  );
}

// Dispatch operations ------------------------------------------------------
const saveOperation = () =>
  localStorage.setItem("factoryOperation", JSON.stringify(state.operation));
function renderOperation() {
  const el = $("#operation");
  if (!el) return;
  const op = state.operation,
    running = op?.state === "running";
  $("#run-button").disabled = running || state.busy;
  if (!op) return (el.innerHTML = "");
  const d = op.result?.data;
  const text = running
    ? "Checking the ticket and starting its T3 run…"
    : d?.reason === "dispatched"
      ? `Started ${d.ticket || "ticket"} with ${d.model}.`
      : d?.skipped?.[0]?.reason || d?.message || d?.reason || "Check factory status before retrying.";
  el.innerHTML = `<div class="operation" role="status">${esc(text)}${d?.reason === "ready-label-confirmation-required" ? '<button class="btn btn-sm" data-action="review-ready-label">Review and run anyway</button>' : ""}${op.state === "uncertain" ? '<p class="hint">This request will not be resent automatically.</p>' : ""}${op.notReceived ? '<button class="btn btn-sm" data-action="retry-request">Retry saved request</button>' : ""}</div>`;
}
function restoreOperation() {
  try {
    state.operation = JSON.parse(localStorage.getItem("factoryOperation"));
  } catch {}
  renderOperation();
  pollOperation();
}
async function pollOperation() {
  if (state.operation?.state !== "running") return;
  try {
    state.operation = await api("/api/operations/" + state.operation.id);
    saveOperation();
    renderOperation();
    if (state.operation.state !== "running") {
      await load();
      showReadinessConfirmation();
    }
  } catch (error) {
    if ($("#app").hidden) return;
    if (error.status === 404) {
      state.operation = {
        ...state.operation,
        state: "uncertain",
        notReceived: true,
        result: {
          data: {
            message: "The server has no record of this request. You can retry it with the same request ID.",
          },
        },
      };
      saveOperation();
      renderOperation();
    }
    message("Checking dispatch status: " + error.message, true);
  }
  if (state.operation?.state === "running") setTimeout(pollOperation, 2000);
}
async function dispatch(id, input) {
  state.operation = await api("/api/dispatch", {
    method: "POST",
    headers: { "Idempotency-Key": id },
    body: JSON.stringify(input),
  });
  saveOperation();
}
function showReadinessConfirmation() {
  const op = state.operation;
  if (op?.result?.data?.reason !== "ready-label-confirmation-required" || !op.input?.ticket || op.input.allowMissingReadyLabel) return;
  const label = op.result.data.requiredLabel;
  state.readinessConfirmation = { id: op.id, input: clone(op.input) };
  $("#readiness-title").textContent = `Run ${op.input.ticket.toUpperCase()} without ${label}?`;
  $("#readiness-description").textContent = `This ticket is not marked ${label}. Run it anyway? This skips only the readiness-label requirement for this run. Dependency, difficulty, quota, and duplicate-run checks still apply.`;
  if (!$("#readiness-dialog").open) $("#readiness-dialog").showModal();
}
async function startRun(input) {
  if (state.busy || state.operation?.state === "running") return;
  state.busy = true;
  const id = uuid();
  state.operation = { id, input, state: "running" };
  saveOperation();
  renderOperation();
  try {
    await dispatch(id, input);
  } catch (error) {
    message(error.message, true);
  } finally {
    state.busy = false;
    renderOperation();
    pollOperation();
  }
}
async function catalog() {
  state.providers = (await api("/api/models")).providers;
}

// Actions ------------------------------------------------------------------
async function action(name, button) {
  if (state.busy) return;
  try {
    switch (name) {
      case "review-ready-label":
        showReadinessConfirmation();
        break;
      case "run-without-ready-label": {
        const confirmation = state.readinessConfirmation;
        if (!confirmation || confirmation.id !== state.operation?.id) return;
        $("#readiness-dialog").close();
        state.readinessConfirmation = null;
        await startRun({ ...confirmation.input, allowMissingReadyLabel: true });
        break;
      }
      case "retry-request":
        state.busy = true;
        await dispatch(state.operation.id, state.operation.input);
        renderOperation();
        pollOperation();
        break;
      case "refresh":
        await load();
        if (state.page === "models") await catalog();
        break;
      case "logout":
        await api("/api/session", { method: "DELETE" });
        showLogin();
        break;
      case "toggle-enabled":
      case "toggle-upstream": {
        // Each switch saves immediately; mirror the saved value into both copies so the save bar stays clean.
        const upstream = name === "toggle-upstream";
        state.busy = true;
        upstream ? renderUpstream() : renderLive();
        await api(upstream ? "/api/upstream/enabled" : "/api/enabled", {
          method: "POST",
          body: JSON.stringify({ enabled: !(upstream ? state.liveUpstream : state.liveEnabled) }),
        });
        const latest = await load();
        for (const copy of [state.base, state.config]) {
          if (!upstream) copy.enabled = latest.config.enabled;
          else if (copy.upstream) copy.upstream.enabled = latest.config.upstream?.enabled;
        }
        saveBar();
        break;
      }
      case "save":
        state.busy = true;
        await api("/api/config", {
          method: "POST",
          body: JSON.stringify({ base: state.base, config: state.config }),
        });
        await load(true);
        message("Saved. New runs use these settings.");
        break;
      case "revert":
        await load(true);
        message("Changes discarded.");
        break;
      case "catalog":
        await catalog();
        message("Model catalog refreshed from T3.");
        break;
      case "edit-model":
        if (!state.providers.length) await catalog();
        modelEditor(Number(button.dataset.index));
        break;
      case "move-model": {
        const i = Number(button.dataset.index),
          j = i + Number(button.dataset.direction),
          list = state.config.models;
        [list[i], list[j]] = [list[j], list[i]];
        render();
        break;
      }
      case "add-model": {
        if (!state.providers.length) await catalog();
        const provider = state.providers.find((p) => p.driver === "codex") || state.providers[0];
        if (!provider) throw new Error("No supported provider is configured in T3.");
        const index = state.config.models.length;
        state.config.models.push({
          id: "model-" + uuid().slice(0, 8),
          name: "New model",
          automatic: false,
          maxDifficulty: "high",
          model: { instanceId: provider.instanceId, model: "", options: [] },
        });
        chooseModel(index, provider.instanceId, "");
        render();
        break;
      }
      case "remove-model":
        state.config.models.splice(Number(button.dataset.index), 1);
        $("#model-dialog").close();
        render();
        break;
      case "add-project":
        state.config.projects.push({
          name: "New project",
          enabled: false,
          key: "",
          kaneoId: "",
          t3Id: "",
          repoPath: "",
          githubRepo: "",
          baseBranch: "main",
          readyStatuses: ["to-do"],
          doneStatuses: ["done"],
        });
        state.project = state.config.projects.length - 1;
        render();
        break;
      case "remove-project":
        state.config.projects.splice(state.project, 1);
        state.project = 0;
        render();
        break;
    }
  } catch (error) {
    message(error.message, true);
  } finally {
    state.busy = false;
    if (state.page === "overview" && !$("#app").hidden) {
      renderLive();
      renderOperation();
    } else if (state.page === "upstream" && !$("#app").hidden) renderUpstream();
  }
}

// Events -------------------------------------------------------------------
document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-page], [data-action]");
  if (!el) return;
  event.preventDefault();
  if (el.dataset.page) {
    state.page = el.dataset.page;
    message("");
    render();
    window.scrollTo(0, 0);
    if (state.page === "models" && !state.providers.length)
      catalog().catch((e) => message(e.message, true));
  } else action(el.dataset.action, el);
});
document.addEventListener("input", (event) => {
  const el = event.target;
  if (el.dataset.path)
    set(
      JSON.parse(el.dataset.path),
      el.dataset.kind === "boolean" ? el.checked : el.dataset.kind === "number" ? Number(el.value) : el.value,
    );
  if (el.dataset.list)
    set(
      JSON.parse(el.dataset.list),
      el.value.split(",").map((s) => s.trim()).filter(Boolean),
    );
});
document.addEventListener("change", (event) => {
  const el = event.target;
  try {
    if (el.id === "enable-toggle") {
      action("toggle-enabled");
    } else if (el.id === "upstream-toggle") {
      action("toggle-upstream");
    } else if (el.id === "project-select") {
      state.project = Number(el.value);
      render();
    } else if (el.id === "unlimited") {
      set(["maxWaitingPRs"], el.checked ? null : 5);
      render();
    } else if (el.id === "edit-provider") {
      chooseModel(state.editModel, el.value, "");
    } else if (el.id === "edit-slug") {
      chooseModel(state.editModel, state.config.models[state.editModel].model.instanceId, el.value);
    } else if (el.dataset.option) {
      const m = state.config.models[state.editModel];
      m.model.options = m.model.options.filter((o) => o.id !== el.dataset.option);
      m.model.options.push({ id: el.dataset.option, value: el.value });
      saveBar();
    }
  } catch (error) {
    message(error.message, true);
  }
});
for (const selector of ["#model-dialog", "#readiness-dialog"]) $(selector).addEventListener("click", (event) => {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom)
    dialog.close();
});
$("#readiness-dialog").addEventListener("close", () => { state.readinessConfirmation = null; });
$("#model-dialog").addEventListener("close", () => {
  if (state.page === "models") render();
});
document.addEventListener("submit", async (event) => {
  // Leave native forms, including method="dialog", to the browser.
  if (!["pair-form", "run-form"].includes(event.target.id)) return;
  event.preventDefault();
  if (event.target.id === "pair-form") {
    try {
      loginError("");
      await connect($("#pair-code").value);
    } catch (error) {
      loginError(error.message);
    }
  }
  if (event.target.id === "run-form") {
    if (state.busy || state.operation?.state === "running") return;
    await startRun({
      ticket: $("#run-ticket").value.trim(),
      model: $("#run-model").value,
      overrideLimits: $("#run-override").checked,
    });
  }
});

// Pull to refresh ----------------------------------------------------------
const PULL = 60;
let pullStart = null;
const ptr = $("#ptr");
document.addEventListener(
  "touchstart",
  (e) => {
    pullStart = window.scrollY === 0 && !$("#app").hidden ? e.touches[0].clientY : null;
    ptr.classList.remove("settle");
  },
  { passive: true },
);
document.addEventListener(
  "touchmove",
  (e) => {
    if (pullStart === null) return;
    const dy = e.touches[0].clientY - pullStart;
    if (dy <= 0) {
      pullStart = null;
      ptr.style.height = "0px";
      return;
    }
    if (e.cancelable) e.preventDefault(); // keep the document still; only the indicator moves
    const d = Math.min(dy / 2, PULL);
    ptr.style.height = d + "px";
    ptr.textContent = d >= PULL ? "Release to refresh" : "Pull to refresh";
  },
  { passive: false },
);
document.addEventListener(
  "touchend",
  async () => {
    if (pullStart === null) return;
    pullStart = null;
    ptr.classList.add("settle");
    if (parseFloat(ptr.style.height) >= PULL) {
      ptr.textContent = "Refreshing…";
      await action("refresh");
    }
    ptr.style.height = "0px";
  },
  { passive: true },
);

// Boot ---------------------------------------------------------------------
async function initialize() {
  const auth = await api("/api/auth");
  const sso = auth.mode === "oidc";
  $("#sso-login").hidden = !sso;
  $("#sso-login").onclick = () => {
    location.href = auth.loginUrl;
  };
  $('[data-action="logout"]').textContent = sso ? "Sign out" : "Disconnect";
  $("#pair-form").hidden = sso;
  $("#pair-help").hidden = sso;
  if (sso)
    $("#login-description").textContent = "Sign in with an authorized account to control the factory.";
  if (new URLSearchParams(location.search).has("auth_error")) {
    loginError("Sign-in was not completed or your account does not have access.");
    history.replaceState(null, "", "/");
  }
  const pair = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (pair) history.replaceState(null, "", "/");
  if (pair && !sso) await connect(pair);
  else {
    await load(true);
    restoreOperation();
  }
}
initialize().catch((error) => {
  showLogin();
  if (error.status !== 401) loginError(error.message);
});
setInterval(() => {
  if (!$("#app").hidden && !document.hidden) load().catch(() => {});
}, 5000);
