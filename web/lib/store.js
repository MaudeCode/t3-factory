// Application state and every action that changes it. Views read signals and call actions;
// nothing else talks to the API. `applyState` is the single entry point for server state: the
// event stream, the poll fallback, and every action that reloads all feed the same path.
import { signal, computed, batch } from "./h.js";
import { api, post } from "./api.js";
import { clone, uuid, moveItem, repoFromPath } from "./format.js";

// State -----------------------------------------------------------------
export const auth = signal({ mode: "pairing", loginUrl: "" });
export const authenticated = signal(null); // null while unknown
export const loginError = signal("");
export const connection = signal("connecting"); // connecting | live | polling | offline
export const config = signal(null);
export const base = signal(null);
export const status = signal({});
export const journal = signal([]);
export const history = signal(null); // every job, newest first, loaded on demand
export const providers = signal([]);
// The driver behind a provider instance, from T3's catalog once loaded; an instance named after its driver needs no catalog.
export const instanceDriver = (instanceId) => providers.value.find((p) => p.instanceId === instanceId)?.driver ?? (instanceId === "codex" ? "codex" : "claudeAgent");
export const sources = signal(null); // T3 projects, Kaneo projects with columns, and labels; loaded on demand
export const live = signal({ enabled: false, upstream: false, concurrency: { claude: 1, codex: 1 } });
export const busy = signal(false);
export const operations = signal([]);
export const readiness = signal(null);
export const blocked = signal(null); // a manual ticket waiting on other tickets: the user picks how to run it
export const notice = signal(null);
export const selectedModel = signal(0);
export const selectedProject = signal(0);
export const clock = signal(Date.now()); // ticks every second so relative times stay honest
let serverOffset = 0; // server clock minus browser clock
export const serverNow = () => clock.value + serverOffset;

export const dirty = computed(
  () => !!config.value && JSON.stringify(config.value) !== JSON.stringify(base.value),
);
export const jobs = computed(() => status.value.jobs || []);

api.onUnauthorized = () => (authenticated.value = false);

export function message(text, error = false) {
  notice.value = text ? { text, error, at: Date.now() } : null;
}

// Config editing --------------------------------------------------------
export const at = (path) => path.reduce((o, k) => o?.[k], config.value);
function assign(target, path, value) {
  const [key, ...rest] = path;
  const copy = Array.isArray(target) ? [...target] : { ...target };
  copy[key] = rest.length ? assign(target[key], rest, value) : value;
  return copy;
}
export function set(path, value) {
  config.value = assign(config.value, path, value);
}
export function update(mutate) {
  const next = clone(config.value);
  mutate(next);
  config.value = next;
}

// Server state ----------------------------------------------------------
export function applyState(data, reset = false) {
  batch(() => {
    status.value = data.status;
    journal.value = data.status.journal ?? [];
    if (data.now) serverOffset = Date.parse(data.now) - Date.now();
    // Follow the server's config unless there are local edits; those keep their baseline so a save still detects outside changes.
    if (!config.value || reset || !dirty.value) {
      config.value = clone(data.config);
      base.value = clone(data.config);
    }
    live.value = {
      enabled: data.config.enabled,
      upstream: !!data.config.upstream?.enabled,
      concurrency: data.config.concurrency,
    };
    authenticated.value = true;
    if (connection.value !== "live") connection.value = "polling";
  });
  if (history.value) loadHistory().catch(() => {});
}
// Number of settings that differ between the saved config and the edits.
export const changes = computed(() => (config.value && base.value ? diff(base.value, config.value) : 0));
function diff(a, b) {
  if (a === b) return 0;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return 1;
  if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== b.length)) return 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let n = 0;
  for (const k of keys) n += diff(a[k], b[k]);
  return n;
}
export async function load(reset = false) {
  try {
    const data = await api("/api/state");
    applyState(data, reset);
    return data;
  } catch (error) {
    if (error.status !== 401) connection.value = "offline";
    if (authenticated.value) message(error.message, true);
    throw error;
  }
}
export async function catalog() {
  providers.value = (await api("/api/models")).providers ?? [];
}
export async function loadSources() {
  sources.value = await api("/api/sources");
}
export async function loadHistory() {
  history.value = await api("/api/history");
}
export const loadRun = (id) => api(`/api/jobs/${id}/report`);

// Every action goes through here: one busy flag, one error path.
export async function run(fn) {
  if (busy.value) return;
  busy.value = true;
  try {
    return await fn();
  } catch (error) {
    message(error.message, true);
  } finally {
    busy.value = false;
  }
}

export const actions = {
  refresh: () =>
    run(async () => {
      await load();
      if (providers.value.length) await catalog();
    }),
  logout: () =>
    run(async () => {
      await api("/api/session", { method: "DELETE" });
      authenticated.value = false;
    }),
  // Each switch saves immediately; mirror the saved value into both copies so the save bar stays clean.
  toggle: (kind) =>
    run(async () => {
      const upstream = kind === "upstream";
      await post(upstream ? "/api/upstream/enabled" : "/api/enabled", {
        enabled: !(upstream ? live.value.upstream : live.value.enabled),
      });
      const latest = await load();
      for (const copy of [base, config])
        copy.value = upstream
          ? copy.value.upstream
            ? assign(copy.value, ["upstream", "enabled"], latest.config.upstream?.enabled)
            : copy.value
          : assign(copy.value, ["enabled"], latest.config.enabled);
    }),
  save: () =>
    run(async () => {
      await post("/api/config", { base: base.value, config: config.value });
      await load(true);
      message("Saved. New runs use these settings.");
    }),
  revert: () =>
    run(async () => {
      await load(true);
      message("Changes discarded.");
    }),
  catalog: () =>
    run(async () => {
      await catalog();
      message("Model catalog refreshed from T3.");
    }),
  ensureCatalog: () => {
    if (!providers.value.length) catalog().catch((e) => message(e.message, true));
  },
  cancelPlan: (id) =>
    run(async () => {
      await post(`/api/plans/${id}/cancel`, {});
      await load();
      message("Chain cancelled. Tickets already running finish on their own.");
    }),
  stopJob: (id) =>
    run(async () => {
      await post(`/api/jobs/${id}/stop`, {});
      await load();
      message("Stop requested. T3 confirms on the next check.");
    }),
  dismissOperation: (id) => {
    const op = operations.value.find((op) => op.id === id);
    if (!op || ["queued", "running"].includes(op.state)) return;
    operations.value = operations.value.filter((op) => op.id !== id);
    if (readiness.value?.id === id) readiness.value = null;
    if (blocked.value?.id === id) blocked.value = null;
    saveOperations();
  },
  moveModel: (from, to) => {
    update((c) => (c.models = moveItem(c.models, from, to)));
    selectedModel.value = to;
  },
  addModel: () =>
    run(async () => {
      if (!providers.value.length) await catalog();
      const provider = providers.value.find((p) => p.driver === "codex") || providers.value[0];
      if (!provider) throw new Error("No supported provider is configured in T3.");
      update((c) =>
        c.models.push({
          id: "model-" + uuid().slice(0, 8),
          name: "New model",
          automatic: false,
          maxDifficulty: "high",
          model: { instanceId: provider.instanceId, model: "", options: [] },
        }),
      );
      const index = config.value.models.length - 1;
      chooseModel(index, provider.instanceId, "");
      selectedModel.value = index;
    }),
  removeModel: (index) => {
    selectedModel.value = Math.max(0, index - 1);
    update((c) => c.models.splice(index, 1));
  },
  ensureSources: () => {
    if (!sources.value) loadSources().catch((e) => message(e.message, true));
  },
  // A project starts from what T3 and Kaneo already know about it; everything stays editable.
  addProject: (t3, kaneo) => {
    update((c) =>
      c.projects.push({
        name: t3?.title ?? kaneo?.name ?? "New project",
        enabled: false,
        key: kaneo?.slug ?? "",
        kaneoId: kaneo?.id ?? "",
        t3Id: t3?.id ?? "",
        repoPath: t3?.workspaceRoot ?? "",
        githubRepo: kaneo?.githubRepo ?? repoFromPath(t3?.workspaceRoot),
        baseBranch: "main",
        ...statusesFor(kaneo?.id),
        priorityLabels: [],
        upstreams: [],
      }),
    );
    selectedProject.value = config.value.projects.length - 1;
  },
  removeProject: (index) => {
    selectedProject.value = Math.max(0, index - 1);
    update((c) => c.projects.splice(index, 1));
  },
  linkT3: (index, id) => {
    const t3 = sources.value?.t3.find((p) => p.id === id);
    update((c) => Object.assign(c.projects[index], { t3Id: id, repoPath: t3?.workspaceRoot ?? c.projects[index].repoPath }));
  },
  linkKaneo: (index, id) => {
    const kaneo = sources.value?.kaneo.projects.find((p) => p.id === id);
    update((c) => Object.assign(c.projects[index], { kaneoId: id, key: kaneo?.slug ?? c.projects[index].key, ...statusesFor(id) }));
  },
  addUpstream: (project, entry) => update((c) => (c.projects[project].upstreams ??= []).push(entry)),
  setUpstream: (project, index, entry) => update((c) => (c.projects[project].upstreams[index] = entry)),
  removeUpstream: (project, index) => update((c) => c.projects[project].upstreams.splice(index, 1)),
};

// Ready is the first column, done is every final column, when the Kaneo catalog knows the project.
export function statusesFor(kaneoId) {
  const columns = sources.value?.kaneo.columns[kaneoId];
  if (!columns?.length) return { readyStatuses: ["to-do"], doneStatuses: ["done"] };
  const done = columns.filter((c) => c.isFinal).map((c) => c.slug);
  return { readyStatuses: [columns.find((c) => !c.isFinal)?.slug ?? columns[0].slug], doneStatuses: done.length ? done : [columns.at(-1).slug] };
}

export function chooseModel(index, instance, slug) {
  const available = providers.value.find((p) => p.instanceId === instance)?.models || [];
  const selected =
    available.find((x) => x.slug === slug) || available.find((x) => x.isDefault) || available[0];
  if (!selected) throw new Error("No models available for that provider");
  update((c) => {
    const m = c.models[index];
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
  });
}
export function setModelOption(index, id, value) {
  update((c) => {
    const m = c.models[index];
    m.model.options = [...m.model.options.filter((o) => o.id !== id), { id, value }];
  });
}

// Dispatch --------------------------------------------------------------
const storage = globalThis.localStorage;
const saveOperations = () => storage?.setItem("factoryOperations", JSON.stringify(operations.value));
const request = (id) => operations.value.find((op) => op.id === id);
const needsOperation = (op) => !op.choiceHandled && !(op.state === "done" && ["dispatched", "plan-started"].includes(op.result?.data?.reason));
function updateOperation(id, patch) {
  operations.value = operations.value.map((op) => op.id === id ? { ...op, ...patch, id, input: op.input } : op).filter(needsOperation);
  saveOperations();
}
export function restoreOperation() {
  try {
    const saved = storage?.getItem("factoryOperations");
    const legacy = saved ? null : JSON.parse(storage?.getItem("factoryOperation") ?? "null");
    const restored = saved ? JSON.parse(saved) : legacy ? [legacy] : [];
    if (Array.isArray(restored)) operations.value = restored.filter(needsOperation);
    saveOperations();
    storage?.removeItem("factoryOperation");
  } catch {}
  return drainOperations();
}
// One drain owns both sending and reconciliation. A running request is never re-sent on recovery.
let draining = false;
async function drainOperations() {
  if (draining) return;
  draining = true;
  try {
    while (authenticated.value) {
      const op = operations.value.find((op) => ["queued", "running"].includes(op.state));
      if (!op) break;
      if (op.state === "queued") {
        // Persist the send intent first: an interrupted write must be reconciled, never replayed.
        updateOperation(op.id, { state: "running", notReceived: false });
        try {
          updateOperation(op.id, await post("/api/dispatch", op.input, { "Idempotency-Key": op.id }));
        } catch (error) {
          message(error.message, true);
        }
      }
      if (request(op.id)?.state === "running") await pollOperation(op.id);
      if (request(op.id)?.state === "running") {
        if (!authenticated.value) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      showReadinessConfirmation(op.id);
      showBlockedChoice(op.id);
      void load().catch(() => {});
    }
  } finally { draining = false; }
}
export async function pollOperation(id) {
  if (request(id)?.state !== "running") return;
  try {
    updateOperation(id, await api("/api/operations/" + id));
  } catch (error) {
    if (error.status === 404) {
      updateOperation(id, {
        state: "uncertain", notReceived: true,
        result: { data: { message: "The server has no record of this request. You can retry it with the same request ID." } },
      });
    }
    message("Checking dispatch status: " + error.message, true);
  }
}
export function startRun(input) {
  const id = uuid();
  operations.value = [...operations.value, { id, input: clone(input), state: "queued" }];
  saveOperations();
  void drainOperations();
  return id;
}
export function retryRequest(id) {
  const op = request(id);
  if (!op?.notReceived || op.state !== "uncertain") return;
  operations.value = [...operations.value.filter((op) => op.id !== id), { ...op, state: "queued", notReceived: false }];
  saveOperations();
  void drainOperations();
}
export function showReadinessConfirmation(id) {
  const op = request(id);
  if (readiness.value || blocked.value || op?.choiceHandled || op?.result?.data?.reason !== "ready-label-confirmation-required" || !op.input?.ticket || op.input.allowMissingReadyLabel) return;
  readiness.value = { id: op.id, input: clone(op.input), label: op.result.data.requiredLabel };
}
export function showBlockedChoice(id) {
  const op = request(id), d = op?.result?.data;
  if (readiness.value || blocked.value || op?.choiceHandled || d?.reason !== "blocked-ticket-plan-required" || !op.input?.ticket || op.input.chain) return;
  blocked.value = { id: op.id, input: clone(op.input), ticket: d.ticket, tree: d.tree, message: d.message };
}
function answerRequest(choice, reason, extra) {
  const op = request(choice?.id);
  if (!op || op.choiceHandled || op.result?.data?.reason !== reason) return;
  updateOperation(op.id, { choiceHandled: true });
  return startRun({ ...op.input, ...extra });
}
export function runChain(mode) {
  const choice = blocked.value;
  blocked.value = null;
  if (!["first", "all"].includes(mode)) return;
  return answerRequest(choice, "blocked-ticket-plan-required", { chain: mode });
}
export function runWithoutReadyLabel() {
  const choice = readiness.value;
  readiness.value = null;
  return answerRequest(choice, "ready-label-confirmation-required", { allowMissingReadyLabel: true });
}

// Session ---------------------------------------------------------------
export async function connect(code) {
  const match = code.match(/[#&]pair=([^&]+)/);
  await post("/api/session", { code: match ? decodeURIComponent(match[1]) : code.trim() });
  globalThis.history.replaceState(null, "", location.pathname);
  await load(true);
  restoreOperation();
}
export async function initialize() {
  try {
    auth.value = await api("/api/auth");
    const sso = auth.value.mode === "oidc";
    if (new URLSearchParams(location.search).has("auth_error")) {
      loginError.value = "Sign-in was not completed or your account does not have access.";
      globalThis.history.replaceState(null, "", "/");
    }
    const pair = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (pair) globalThis.history.replaceState(null, "", location.pathname);
    if (pair && !sso) await connect(pair);
    else {
      await load(true);
      restoreOperation();
    }
  } catch (error) {
    authenticated.value = false;
    if (error.status !== 401) loginError.value = error.message;
  }
}

// Live updates: the server pushes full state over an event stream whenever the factory
// writes it. If the stream is unavailable, a slow poll keeps the page honest.
export function subscribe() {
  let source = null;
  const open = () => {
    if (source || !authenticated.value || typeof EventSource === "undefined") return;
    source = new EventSource("/api/events");
    source.addEventListener("state", (e) => {
      connection.value = "live";
      applyState(JSON.parse(e.data));
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        connection.value = "offline";
        source = null;
        load().catch(() => {}); // a closed stream after sign-out surfaces the 401 here
      } else connection.value = "polling";
    };
  };
  const tick = () => {
    clock.value = Date.now();
    if (!authenticated.value) {
      source?.close();
      source = null;
      return;
    }
    if (document.hidden) return;
    open();
    if (connection.value !== "live" && Math.floor(clock.value / 1000) % 15 === 0) load().catch(() => {});
  };
  const timer = setInterval(tick, 1000);
  document.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(timer);
    source?.close();
    document.removeEventListener("visibilitychange", tick);
  };
}
