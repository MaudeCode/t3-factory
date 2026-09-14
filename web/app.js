const $ = (s) => document.querySelector(s);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clone = (value) => structuredClone(value);
function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const s = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const state = {
  config: null,
  base: null,
  status: {},
  providers: [],
  page: "overview",
  busy: false,
  operation: null,
  editModel: 0,
  project: 0,
};
const titles = {
  overview: "Factory",
  models: "Models",
  automation: "Automation",
  projects: "Projects",
  discovery: "Discovery",
};
const dirty = () =>
  state.config && JSON.stringify(state.config) !== JSON.stringify(state.base);
const at = (path) => path.reduce((o, k) => o?.[k], state.config);
function set(path, value) {
  let o = state.config;
  for (const key of path.slice(0, -1)) o = o[key];
  o[path.at(-1)] = value;
  saveBar();
}
const pathAttr = (path) => esc(JSON.stringify(path));
const field = (title, path, type = "text") =>
  `<div class="field"><label>${esc(title)}<input aria-label="${esc(title)}" data-path="${pathAttr(path)}" data-kind="${type}" type="${type === "number" ? "number" : "text"}" value="${esc(at(path))}" ${type === "number" ? 'min="0" step="any"' : ""}></label></div>`;
const check = (title, path) =>
  `<div class="check"><input type="checkbox" id="${esc(path.join("-"))}" data-path="${pathAttr(path)}" data-kind="boolean" ${at(path) ? "checked" : ""}><label for="${esc(path.join("-"))}">${esc(title)}</label></div>`;
function select(title, path, options) {
  return `<div class="field"><label>${esc(title)}<select aria-label="${esc(title)}" data-path="${pathAttr(path)}">${options.map(([value, name]) => `<option value="${esc(value)}" ${at(path) === value ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label></div>`;
}
function message(text, error = false) {
  const el = $(error ? "#error" : "#notice");
  el.textContent = text;
  el.hidden = !text;
  if (error) {
    $("#notice").hidden = true;
  } else {
    $("#error").hidden = true;
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    const error = new Error(
      data.message || data.reason || `Request failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
function showLogin() {
  $("#login").hidden = false;
  $("#app").hidden = true;
}
async function connect(code) {
  const match = code.match(/[#&]pair=([^&]+)/);
  await api("/api/session", {
    method: "POST",
    body: JSON.stringify({
      code: match ? decodeURIComponent(match[1]) : code.trim(),
    }),
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
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#connection").textContent = "Connected";
    if (reset) render();
    else if (state.page === "overview") renderLive();
    return data;
  } catch (error) {
    $("#connection").textContent = "Offline";
    if (!$("#app").hidden) message(error.message, true);
    throw error;
  }
}
function saveBar() {
  $("#save-bar").hidden = !dirty();
}
function render() {
  $("#page-title").textContent = titles[state.page];
  $("#section-label").textContent =
    state.page === "overview" ? "CONTROL ROOM" : "SETTINGS";
  for (const el of document.querySelectorAll("nav [data-page]"))
    el.setAttribute(
      "aria-current",
      el.dataset.page === state.page ? "page" : "false",
    );
  $("#page").innerHTML = { overview, models, automation, projects, discovery }[
    state.page
  ]();
  saveBar();
  if (state.page === "overview") {
    renderLive();
    renderOperation();
  }
}
function overview() {
  return `<section class="panel flat"><div class="panel-head"><div class="status-line"><span id="status-dot" class="status-dot"></span><div><h2 id="factory-state">Factory</h2><span class="muted" id="last-check"></span></div></div><button id="enable-button" data-action="toggle-enabled"></button></div><p class="muted">One automatic run per provider. Manual runs can overlap existing work.</p></section><div id="streams" class="streams"></div><div class="overview-grid"><section class="panel"><h2>Start a run</h2><form id="run-form"><div class="field"><label for="run-ticket">Ticket</label><input id="run-ticket" placeholder="APP-8, or leave blank for next eligible" autocapitalize="characters" spellcheck="false"></div><div class="field"><label for="run-model">Model</label><select id="run-model"><option value="auto">Automatic selection</option>${state.config.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></div><div class="check"><input type="checkbox" id="run-override" checked><label for="run-override">Skip idle and reserve thresholds for this run</label></div><p class="muted">Readiness, difficulty limits, duplicate checks, and merge rules still apply.</p><button id="run-button" class="primary run-button">Start factory run</button></form><div id="operation"></div></section><section class="panel"><h2>Needs your attention</h2><div id="waiting-jobs"></div></section></div><section class="panel jobs-panel"><h2>Recent runs</h2><div id="recent-jobs"></div></section>`;
}
function providerOf(job) {
  return (
    job.providerDriver ||
    (job.modelSelection?.instanceId === "codex" ? "codex" : "claudeAgent")
  );
}
function ago(date) {
  if (!date) return "No check yet";
  const secs = Math.max(0, (Date.now() - Date.parse(date)) / 1000);
  return secs < 60
    ? `${Math.floor(secs)}s ago`
    : secs < 3600
      ? `${Math.floor(secs / 60)}m ago`
      : `${Math.floor(secs / 3600)}h ago`;
}
function renderLive() {
  const enabled = state.liveEnabled;
  $("#factory-state").textContent = enabled
    ? "Automatic factory is on"
    : "Automatic factory is paused";
  $("#status-dot").classList.toggle("paused", !enabled);
  const button = $("#enable-button");
  button.textContent = enabled ? "Pause" : "Enable";
  button.className = enabled ? "" : "primary";
  button.disabled = state.busy;
  $("#last-check").textContent = `Last check ${ago(state.status.decision?.at)}`;
  const jobs = state.status.jobs || [];
  $("#streams").innerHTML = ["claudeAgent", "codex"]
    .map((driver) => {
      const stream =
        (state.status.streams || []).find((s) => s.driver === driver) || {};
      const active = jobs.filter(
        (j) =>
          providerOf(j) === driver &&
          ["running", "dispatching"].includes(j.state),
      );
      const direct = state.status.decision?.quota;
      const quota = direct?.driver === driver ? direct : stream.quota;
      const reasons = {
        "provider-running": "Working",
        "waiting-for-idle": "Waiting for idle time",
        "quota-budget": "Waiting for budget",
        "no-eligible-model": "No automatic model available",
        "difficulty-limit": "No tickets within difficulty limits",
        "needs-classification": "Tickets need difficulty labels",
        "no-eligible-ticket": "Watching the queue",
        dispatched: "Working",
        "would-dispatch": "Ready to start",
      };
      return `<section class="stream"><h2>${driver === "codex" ? "Codex" : "Claude"}</h2><small>${esc(!enabled ? "Automatic starts paused" : reasons[stream.reason] || "Watching the queue")}</small><div class="big-number">${active.length}<small> running</small></div><p class="muted">${active.length ? active.map((j) => esc(j.ticketKey || "Discovery")).join(" · ") : "Provider slot free"}</p>${quota?.factoryRouting?.fableRemainingPercent != null ? quotaBar("Fable allowance", quota.factoryRouting.fableRemainingPercent) : ""}${(quota?.windows || []).map((w) => quotaBar(w.name === "fiveHour" ? "Five-hour" : "Weekly", w.remaining)).join("")}</section>`;
    })
    .join("");
  $("#waiting-jobs").innerHTML =
    jobs
      .filter((j) => j.state === "waiting")
      .map(jobRow)
      .join("") || '<p class="empty">Nothing waiting for you.</p>';
  $("#recent-jobs").innerHTML =
    [...jobs]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 12)
      .map(jobRow)
      .join("") || '<p class="empty">Your runs will appear here.</p>';
}
function quotaBar(label, remaining) {
  const n = Math.max(0, Math.min(100, Number(remaining) || 0));
  return `<div class="quota"><div><span>${esc(label)}</span><span>${Math.round(n)}% left</span></div><progress aria-label="${esc(label)} remaining" max="100" value="${n}"></progress></div>`;
}
function safeLink(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? esc(u.href) : "";
  } catch {
    return "";
  }
}
function jobRow(j) {
  const links = (j.prUrls || [])
    .map((url, i) => {
      const href = safeLink(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">PR${i ? " " + (i + 1) : ""}</a>`
        : "";
    })
    .join("");
  const ticketURL = j.taskId
    ? `${state.config.kaneo.url}/dashboard/workspace/${encodeURIComponent(state.config.kaneo.workspaceId)}/project/${encodeURIComponent(j.projectId)}/task/${encodeURIComponent(j.taskId)}`
    : "";
  return `<article class="list-row"><div class="grow"><div class="panel-head"><span class="job-title">${esc(j.ticketKey || "Discovery")}</span><span class="badge ${esc(j.state)}">${esc(j.state === "dispatching" ? "starting" : j.state)}</span></div><p>${esc(j.modelSelection?.model || "Factory")} · ${ago(j.createdAt)}</p><details><summary class="muted">Details</summary><p>${esc(j.reason || "No details yet.")}</p></details><div class="job-links">${ticketURL ? `<a href="${safeLink(ticketURL)}" target="_blank" rel="noopener noreferrer">Open ticket</a>` : ""}${links}</div></div></article>`;
}
function models() {
  return `<div class="toolbar"><p class="section-note">Highest priority first. Each provider picks from the same ranked list.</p><button class="primary" data-action="add-model">Add model</button></div><section class="panel">${state.config.models.map((m, i) => `<div class="list-row"><span class="rank">${i + 1}</span><div class="grow"><h3>${esc(m.name)}</h3><p>${esc(m.model.model)}</p><span class="badge">${m.automatic ? "Automatic" : "Manual only"} · max ${m.maxDifficulty === "med" ? "medium" : m.maxDifficulty}</span></div><div class="row-actions"><button aria-label="Raise ${esc(m.name)} priority" data-action="move-model" data-index="${i}" data-direction="-1" ${i === 0 ? "disabled" : ""}>↑</button><button aria-label="Lower ${esc(m.name)} priority" data-action="move-model" data-index="${i}" data-direction="1" ${i === state.config.models.length - 1 ? "disabled" : ""}>↓</button><button data-action="edit-model" data-index="${i}">Edit</button></div></div>`).join("")}</section><p class="muted">Unclassified tickets are skipped. Tickets above a model’s difficulty ceiling are not eligible.</p><button class="quiet" data-action="catalog">Refresh available models</button>`;
}
function modelEditor(index) {
  state.editModel = index;
  const p = ["models", String(index)],
    m = state.config.models[index],
    provider = state.providers.find((p) => p.instanceId === m.model.instanceId),
    available = provider?.models || [],
    chosen = available.find((p) => p.slug === m.model.model),
    descriptors = chosen?.capabilities?.optionDescriptors || [];
  const opts = m.model.options || [];
  $("#model-editor").innerHTML =
    field("Name", [...p, "name"]) +
    `<div class="field"><label>Provider<select id="edit-provider">${state.providers.some((p) => p.instanceId === m.model.instanceId) ? "" : `<option>${esc(m.model.instanceId)}</option>`}${state.providers.map((p) => `<option value="${esc(p.instanceId)}" ${p.instanceId === m.model.instanceId ? "selected" : ""}>${esc(p.driver === "codex" ? "Codex" : "Claude")}${p.instanceId === p.driver ? "" : " · " + esc(p.instanceId)}</option>`).join("")}</select></label></div><div class="field"><label>Model<select id="edit-slug">${available.some((p) => p.slug === m.model.model) ? "" : `<option value="${esc(m.model.model)}">${esc(m.model.model || "Choose a model")}</option>`}${available.map((p) => `<option value="${esc(p.slug)}" ${p.slug === m.model.model ? "selected" : ""}>${esc(p.name || p.slug)}</option>`).join("")}</select></label></div>` +
    descriptors
      .filter((d) => d.type === "select")
      .map(
        (d) =>
          `<div class="field"><label>${esc(d.label || d.id)}<select data-option="${esc(d.id)}">${d.options.map((o) => `<option value="${esc(o.id)}" ${(opts.find((o) => o.id === d.id)?.value ?? d.currentValue ?? d.options.find((choice) => choice.isDefault)?.id) == o.id ? "selected" : ""}>${esc(o.label || o.id)}</option>`).join("")}</select></label></div>`,
      )
      .join("") +
    check("Use for automatic runs", [...p, "automatic"]) +
    select(
      "Maximum ticket difficulty",
      [...p, "maxDifficulty"],
      [
        ["low", "Low"],
        ["med", "Medium"],
        ["high", "High"],
      ],
    ) +
    `<p class="muted">This ceiling also applies to manual runs.</p><button class="danger" data-action="remove-model" data-index="${index}" ${state.config.models.length === 1 ? "disabled" : ""}>Remove model</button>`;
  if (!$("#model-dialog").open) $("#model-dialog").showModal();
}
function chooseModel(index, instance, slug) {
  const m = state.config.models[index],
    available =
      state.providers.find((p) => p.instanceId === instance)?.models || [];
  const selected =
    available.find((p) => p.slug === slug) ||
    available.find((m) => m.isDefault) ||
    available[0];
  if (!selected) throw new Error("No models available for that provider");
  m.model = {
    instanceId: instance,
    model: selected.slug,
    options: (selected.capabilities?.optionDescriptors || [])
      .filter((d) => d.type === "select")
      .map((d) => ({
        id: d.id,
        value:
          d.options.find((o) => o.isDefault)?.id ??
          d.currentValue ??
          d.options[0]?.id,
      }))
      .filter((o) => o.value !== undefined),
  };
  if (selected.slug.includes("fable")) m.quotaWindowId = "seven_day_fable";
  else delete m.quotaWindowId;
  saveBar();
  modelEditor(index);
}
function automation() {
  const budget = (provider, name, windows) =>
    `<section class="panel"><h2>${name}</h2><div class="budget-row heading"><span>Allowance</span><span>Reserve at start</span><span>Start above</span></div>${windows.map(([key, label]) => `<div class="budget-row"><span>${label}</span><input aria-label="${name} ${label} reserve percent" type="number" min="0" max="100" data-kind="number" data-path="${pathAttr(["quota", provider, key, "reservePercent"])}" value="${at(["quota", provider, key, "reservePercent"])}"><input aria-label="${name} ${label} minimum percent" type="number" min="0" max="100" data-kind="number" data-path="${pathAttr(["quota", provider, key, "minRemainingPercent"])}" value="${at(["quota", provider, key, "minRemainingPercent"])}"></div>`).join("")}</section>`;
  return `<p class="section-note">Each provider has its own automatic slot. Reserves decline as reset approaches; the minimum to start stays fixed. Existing runs finish.</p><section class="panel"><h2>When to start</h2><div class="fields">${field("Provider idle time · minutes", ["idleMinutes"], "number")}${field("Check interval · seconds", ["pollSeconds"], "number")}</div></section>${budget(
    "claude",
    "Claude budgets",
    [
      ["fiveHour", "Five-hour"],
      ["weekly", "Weekly"],
      ["fable", "Fable"],
    ],
  )}${budget("codex", "Codex budget", [["weekly", "Weekly"]])}<section class="panel"><h2>Waiting & recovery</h2><div class="check"><input id="unlimited" type="checkbox" ${state.config.maxWaitingPRs === null ? "checked" : ""}><label for="unlimited">Unlimited runs awaiting input</label></div>${state.config.maxWaitingPRs === null ? "" : field("Maximum waiting runs", ["maxWaitingPRs"], "number")}${field("Park inactive monitors after · minutes", ["monitoringTimeoutMinutes"], "number")}</section>`;
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
  return `<div class="toolbar"><select id="project-select" aria-label="Project">${entries.map((p, j) => `<option value="${j}" ${j === i ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select><button data-action="add-project">Add</button></div><section class="panel"><h2>Repository</h2>${check("Include this project", [...p, "enabled"])}${field("Name", [...p, "name"])}${field("Repository folder on your Mac", [...p, "repoPath"])}<div class="fields">${field("GitHub owner/repository", [...p, "githubRepo"])}${field("Release branch", [...p, "baseBranch"])}</div></section><section class="panel"><h2>Ticket queue</h2>${field("Ticket prefix", [...p, "key"])}<details><summary>Tracker & T3 connection</summary>${field("Kaneo project ID", [...p, "kaneoId"])}${field("T3 project ID", [...p, "t3Id"])}<div class="field"><label>Ready statuses<input data-list="${pathAttr([...p, "readyStatuses"])}" value="${esc(current.readyStatuses.join(", "))}"></label></div><div class="field"><label>Done statuses<input data-list="${pathAttr([...p, "doneStatuses"])}" value="${esc(current.doneStatuses.join(", "))}"></label></div></details><p class="muted">Register the repository in T3 before enabling it here.</p><button class="danger" data-action="remove-project" ${busy || entries.length === 1 ? "disabled" : ""}>Remove project</button></section>`;
}
function discovery() {
  return `<p class="section-note">When there are no eligible tickets, each free provider can investigate a different project. Tickets waiting for classification are skipped, not replaced with discovery work.</p><section class="panel"><h2>Discovery instructions</h2>${field("Prompt file on your Mac", ["discovery", "promptFile"])}<p class="muted">The factory reads this file for each discovery run. Use the Mac app to edit the file itself.</p>${field("Wait after finding no work · hours", ["discovery", "emptyCooldownHours"], "number")}</section>`;
}
function renderOperation() {
  const op = state.operation;
  if (!$("#operation")) return;
  const busy = op?.state === "running";
  $("#run-button").disabled = busy || state.busy;
  if (!op) {
    $("#operation").innerHTML = "";
    return;
  }
  const d = op.result?.data;
  let text = busy
    ? "Checking the ticket and starting its T3 run…"
    : d?.reason === "dispatched"
      ? `Started ${d.ticket || "ticket"} with ${d.model}.`
      : d?.skipped?.[0]?.reason ||
        d?.message ||
        d?.reason ||
        "Check factory status before retrying.";
  $("#operation").innerHTML =
    `<div class="operation" role="status">${esc(text)}${op.state === "uncertain" ? '<p class="muted">The request will not be sent again automatically.</p>' : ""}${op.notReceived ? '<button data-action="retry-request">Retry saved request</button>' : ""}</div>`;
}
function restoreOperation() {
  try {
    state.operation = JSON.parse(localStorage.getItem("factoryOperation"));
  } catch {}
  renderOperation();
  pollOperation();
}
async function pollOperation() {
  if (!state.operation || state.operation.state !== "running") return;
  try {
    state.operation = await api("/api/operations/" + state.operation.id);
    localStorage.setItem("factoryOperation", JSON.stringify(state.operation));
    renderOperation();
    if (state.operation.state !== "running") await load();
  } catch (error) {
    if ($("#app").hidden) return;
    if (error.status === 404) {
      state.operation = {
        ...state.operation,
        state: "uncertain",
        notReceived: true,
        result: {
          data: {
            message:
              "The server has no record of this request. You can retry it with the same request ID.",
          },
        },
      };
      localStorage.setItem("factoryOperation", JSON.stringify(state.operation));
      renderOperation();
    }
    message("Checking dispatch status: " + error.message, true);
  }
  if (state.operation?.state === "running") setTimeout(pollOperation, 2000);
}
async function catalog() {
  const data = await api("/api/models");
  state.providers = data.providers;
}
async function action(name, button) {
  if (state.busy) return;
  try {
    switch (name) {
      case "retry-request":
        state.busy = true;
        state.operation = await api("/api/dispatch", {
          method: "POST",
          headers: { "Idempotency-Key": state.operation.id },
          body: JSON.stringify(state.operation.input),
        });
        localStorage.setItem(
          "factoryOperation",
          JSON.stringify(state.operation),
        );
        renderOperation();
        pollOperation();
        break;
      case "refresh":
        await load();
        if (state.page === "models") await catalog();
        message("Status refreshed. Unsaved settings are preserved.");
        break;
      case "logout":
        await api("/api/session", { method: "DELETE" });
        showLogin();
        break;
      case "toggle-enabled":
        state.busy = true;
        renderLive();
        await api("/api/enabled", {
          method: "POST",
          body: JSON.stringify({ enabled: !state.liveEnabled }),
        });
        {
          const latest = await load();
          state.base.enabled = latest.config.enabled;
          state.config.enabled = latest.config.enabled;
        }
        saveBar();
        break;
      case "save":
        state.busy = true;
        await api("/api/config", {
          method: "POST",
          body: JSON.stringify({ base: state.base, config: state.config }),
        });
        await load(true);
        message("Settings saved. New runs use these settings.");
        break;
      case "revert":
        await load(true);
        message("Saved settings restored.");
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
          j = i + Number(button.dataset.direction);
        [state.config.models[i], state.config.models[j]] = [
          state.config.models[j],
          state.config.models[i],
        ];
        render();
        break;
      }
      case "add-model": {
        if (!state.providers.length) await catalog();
        const provider =
          state.providers.find((p) => p.driver === "codex") ||
          state.providers[0];
        if (!provider)
          throw new Error("No supported provider is configured in T3.");
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
    }
  }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button, a[data-page]");
  if (!button) return;
  if (button.dataset.page) {
    event.preventDefault();
    state.page = button.dataset.page;
    message("");
    render();
    window.scrollTo(0, 0);
    if (state.page === "models" && !state.providers.length)
      catalog().catch((e) => message(e.message, true));
  } else if (button.dataset.action) {
    event.preventDefault();
    action(button.dataset.action, button);
  }
});
document.addEventListener("input", (event) => {
  const el = event.target;
  if (el.dataset.path) {
    set(
      JSON.parse(el.dataset.path),
      el.dataset.kind === "boolean"
        ? el.checked
        : el.dataset.kind === "number"
          ? Number(el.value)
          : el.value,
    );
  }
  if (el.dataset.list)
    set(
      JSON.parse(el.dataset.list),
      el.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
});
document.addEventListener("change", (event) => {
  const el = event.target;
  try {
    if (el.id === "project-select") {
      state.project = Number(el.value);
      render();
    } else if (el.id === "unlimited") {
      set(["maxWaitingPRs"], el.checked ? null : 5);
      render();
    } else if (el.id === "edit-provider") {
      chooseModel(state.editModel, el.value, "");
    } else if (el.id === "edit-slug") {
      chooseModel(
        state.editModel,
        state.config.models[state.editModel].model.instanceId,
        el.value,
      );
    } else if (el.dataset.option) {
      const m = state.config.models[state.editModel];
      m.model.options = m.model.options.filter(
        (o) => o.id !== el.dataset.option,
      );
      m.model.options.push({ id: el.dataset.option, value: el.value });
      saveBar();
    }
  } catch (error) {
    message(error.message, true);
  }
});
$("#model-dialog").addEventListener("close", () => {
  if (state.page === "models") render();
});
document.addEventListener("submit", async (event) => {
  if (event.target.id === "pair-form") {
    event.preventDefault();
    try {
      await connect($("#pair-code").value);
    } catch (error) {
      $("#login-error").textContent = error.message;
    }
  }
  if (event.target.id === "run-form") {
    event.preventDefault();
    if (state.busy || state.operation?.state === "running") return;
    state.busy = true;
    const id = uuid(),
      input = {
        ticket: $("#run-ticket").value.trim(),
        model: $("#run-model").value,
        overrideLimits: $("#run-override").checked,
      };
    state.operation = { id, input, state: "running" };
    localStorage.setItem("factoryOperation", JSON.stringify(state.operation));
    renderOperation();
    try {
      state.operation = await api("/api/dispatch", {
        method: "POST",
        headers: { "Idempotency-Key": id },
        body: JSON.stringify(input),
      });
      localStorage.setItem("factoryOperation", JSON.stringify(state.operation));
    } catch (error) {
      message(error.message, true);
    } finally {
      state.busy = false;
      renderOperation();
      pollOperation();
    }
  }
});
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
    $("#login-description").textContent =
      "Sign in with your authorized account to manage the factory.";
  if (new URLSearchParams(location.search).has("auth_error")) {
    $("#login-error").textContent =
      "Sign-in was not completed or your account does not have access. Try again with an authorized account.";
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
  if (error.status !== 401) $("#login-error").textContent = error.message;
});
setInterval(() => {
  if (!$("#app").hidden && !document.hidden) load().catch(() => {});
}, 5000);
