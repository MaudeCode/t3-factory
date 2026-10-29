// Pure formatting helpers and vocabulary shared by views and the store.
export const clone = (value) => structuredClone(value);

// The same ticket metadata is projected on queued tickets, held rows, and recorded runs.
export function matchesRunFilters(row, filters = {}, query = "") {
  const includes = (values, value) => !values?.length || values.includes(value);
  const tags = filters.tags ?? [], labels = row.labels ?? [];
  const text = query.trim().toLowerCase();
  return includes(filters.projects, row.projectId) &&
    includes(filters.difficulties, row.difficulty) &&
    includes(filters.priorities, row.priority) &&
    (!filters.sessions?.length || (row.sources ?? []).some(source => filters.sessions.includes(source.threadId))) &&
    (!tags.length || (filters.tagMode === "and" ? tags.every(tag => labels.includes(tag)) : tags.some(tag => labels.includes(tag)))) &&
    (!text || [row.key, row.label, row.title].some(value => value?.toLowerCase().includes(text)));
}

export function ticketKey(value) {
  const key = value?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9]+-\d+$/.test(key) ? key : "";
}

// Text typed or pasted into a ticket-number field: a key such as T3F-48 gives its own number and, when it names one of `keys`, that project; anything else keeps its digits.
export function parseTicketInput(text, keys = []) {
  const match = text.match(/([A-Za-z][A-Za-z0-9]*)-(\d+)/);
  if (!match) return { number: text.replace(/\D/g, "") };
  const project = keys.find((k) => k.toUpperCase() === match[1].toUpperCase());
  return project ? { project, number: match[2] } : { number: match[2] };
}

export const uuid = () =>
  crypto.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );

// Two units at most, and never a zero second unit: "1 h 5 min", "3 d", "41 min".
export const span = (seconds, compact = false) => {
  const units = [["d", 86400], ["h", 3600], ["min", 60], ["s", 1]];
  const parts = [];
  for (const [name, size] of units) {
    const n = Math.floor(seconds / size);
    if (n > 0 || (name === "s" && !parts.length)) parts.push(compact ? `${n}${name === "min" ? "m" : name}` : `${n} ${name}`);
    seconds -= n * size;
    if (parts.length === 2 || (parts.length === 1 && name === "min")) break;
  }
  return parts.join(" ");
};

// Dates arrive as ISO strings from the server or as millisecond numbers computed here.
const ms = (date) => (typeof date === "number" ? date : Date.parse(date));
export const ago = (date, now = Date.now(), compact = false) => (date ? `${span(Math.max(0, (now - ms(date)) / 1000), compact)} ago` : "never");
// One inbox queue row from status: waiting, failed, and the oldest waiting report's age.
export const triageSummary = (row, now = Date.now()) => {
  if (!row.synchronized) return "not synchronized";
  return [`${row.untriaged} waiting`, row.failed && `${row.failed} failed`, row.promoted && `${row.promoted} promoted`, row.queued && `${row.queued} queued`,
    row.blocked && `${row.blocked} blocked`, row.needsOwner && `${row.needsOwner} need the owner`,
    row.oldestUntriagedAt && `oldest ${ago(row.oldestUntriagedAt, now)}`, row.running && `triaging ${row.running}`].filter(Boolean).join(", ");
};
// An inbox's daily promotion limit: null is unlimited and 0 pauses promotion.
export const promotionLimit = (limit) => (limit == null ? "Unlimited" : limit === 0 ? "Paused" : `${limit} per day`);
export const until = (date, now = Date.now()) => {
  const s = (ms(date) - now) / 1000;
  return s > 0 ? `in ${span(s)}` : "now";
};
export const duration = (from, to = Date.now()) => (from ? span(Math.max(0, (ms(to) - ms(from)) / 1000)) : "");
export const clockTime = (date) => new Date(date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const dayLabel = (date) => {
  const d = new Date(date),
    today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  today.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};

export const STREAM_REASONS = {
  "provider-running": "working",
  "provider-disabled": "automatic starts off",
  "waiting-for-idle": "waiting for idle time",
  "quota-exhausted": "allowance exhausted",
  "quota-budget": "waiting for budget",
  "no-eligible-model": "no automatic model available",
  "difficulty-limit": "no tickets within difficulty limits",
  "label-limit": "label limits are full",
  "needs-classification": "tickets need difficulty labels",
  "no-eligible-ticket": "watching the queue",
  dispatched: "working",
  "would-dispatch": "ready to start",
};
export const streamReason = (reason) => STREAM_REASONS[reason] ?? (reason ? reason.replaceAll("-", " ") : "watching the queue");

// One sentence for the last scheduler check.
export function decisionSentence(decision) {
  if (!decision) return "No check has run yet.";
  const d = decision;
  if (d.reason === "disabled") return "";
  if (d.reason === "error") return `The last check failed: ${d.message}`;
  if (d.reason === "dispatched") return `Started ${d.ticket ?? (d.upstream ? `a review of ${d.upstream.name} ${d.upstream.candidate}` : `discovery for ${d.project}`)} on ${d.model}.`;
  // Provider state is on the cards below; only the queue outcome is said here.
  return d.eligible ? `${d.eligible} ticket${d.eligible === 1 ? "" : "s"} eligible.` : "Nothing eligible to start.";
}

export const PROVIDERS = [
  { driver: "claudeAgent", name: "Claude", concurrency: "claude" },
  { driver: "codex", name: "Codex", concurrency: "codex" },
];
export const providerName = (driver) => PROVIDERS.find((p) => p.driver === driver)?.name ?? driver;
export const providerIcon = (driver) => (driver === "codex" ? "openai" : "claude");
export const providerOf = (job) =>
  job.providerDriver || (job.modelSelection?.instanceId === "codex" ? "codex" : "claudeAgent");

export const WINDOW_NAMES = { fiveHour: "Five-hour", weekly: "Weekly", fable: "Fable" };
export const DIFFICULTIES = [
  ["low", "Low"],
  ["med", "Medium"],
  ["high", "High"],
];
// Thresholds a manual start may override; `true` (and older saved requests) means all of them.
export const OVERRIDES = [["idle", "Idle time"], ["reserve", "Quota reserve"], ["labels", "Label limits"]];
// What a dispatch request is doing, or why it ended without starting.
export function operationText(op) {
  const d = op.result?.data, p = op.progress;
  if (op.choiceHandled) return "Choice submitted; a new check is queued below.";
  if (op.state === "queued") return "Queued";
  if (op.state === "running") return p?.phase === "queued" ? "Queued at scheduler" : p?.phase === "checking" ? `Checking · ${p.stage}` : p?.phase === "launching" ? "Starting T3 run" : "Waiting for scheduler progress";
  return d?.reason === "dispatched" ? `Started ${d.ticket || "ticket"} with ${d.model}.` : d?.skipped?.[0]?.reason || d?.message || d?.reason || "Check factory status before retrying.";
}
export const overrideText = (value) => {
  const names = OVERRIDES.filter(([v]) => value === true || (Array.isArray(value) && value.includes(v))).map(([, name]) => name.toLowerCase());
  return names.length === OVERRIDES.length ? "Override limits" : names.length ? `Override ${names.join(", ")}` : "Respect limits";
};
export const difficultyLabel = (value) => DIFFICULTIES.find(([v]) => v === value)?.[1] ?? "High";

export const STATES = ["dispatching", "running", "waiting", "complete", "dismissed"];
export const STATE_LABELS = { dispatching: "Starting", running: "Running", waiting: "Needs you", complete: "Done", dismissed: "Settled", pending: "Pending", blocked: "Blocked", active: "In use", missing: "Missing path", "stale-registration": "Stale registration", review: "Needs review", unknown: "Unknown", primary: "Primary checkout", eligible: "Eligible", confirmed: "Confirmed", failed: "Failed", uncertain: "Uncertain", requested: "Requested" };
export const finishedAt = (job) => job.completedAt ?? job.dismissedAt ?? job.createdAt;
export const byFinished = (a, b) => String(finishedAt(b)).localeCompare(String(finishedAt(a)));
export const stateLabel = (state) => STATE_LABELS[state] ?? state;
// The four stops on a run's track, in order; a settled run also reaches the last stop.
export const STOPS = ["Queued", "Working", "Needs you", "Done"];
export const stopOf = (state) => ({ dispatching: 1, running: 2, waiting: 3, complete: 4, dismissed: 4 })[state] ?? 1;
export const toneOf = (state) => ({ dispatching: "on", running: "on", waiting: "attention", complete: "ok", dismissed: "", pending: "on", active: "on", eligible: "ok", confirmed: "ok", blocked: "attention", failed: "attention", uncertain: "attention", unknown: "attention", "stale-registration": "attention" })[state] ?? "";
export const isActive = (job) => ["running", "dispatching"].includes(job.state);
export const isOpen = (job) => !job.historyOnly && !["complete", "dismissed"].includes(job.state);
export const isFinished = (job) => !isOpen(job);
export const PENDING_KINDS = { approval: "waiting for an approval", question: "asked a question", input: "waiting for input" };

export function safeLink(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}
export const kanvil = (config, ...parts) =>
  safeLink(`${config.kanvil.url}/${parts.map(encodeURIComponent).join("/")}`);
export const ticketLink = (config, job) => (job.taskId ? kanvil(config, "projects", job.projectId, "tickets", job.taskId) : "");
export const projectLink = (config, kanvilId) => kanvil(config, "projects", kanvilId);
export const repoLink = (repo) => safeLink(`https://github.com/${repo}`);
export const releaseLink = (repo, tag) => (tag ? safeLink(`https://github.com/${repo}/releases/tag/${tag}`) : "");
export const prLabel = (url) => {
  const m = url.match(/\/pull\/(\d+)$/);
  return m ? `PR #${m[1]}` : "PR";
};
export const threadLink = (job) => (job.threadId ? `/api/threads/${encodeURIComponent(job.threadId)}/open` : "");

export const projectOf = (config, job) => config.projects.find((p) => p.kanvilId === job.projectId);
export const modelName = (config, job) => {
  const slug = job.modelSelection?.model;
  return slug ? (config.models.find((m) => m.model.model === slug)?.name ?? slug) : "Factory";
};

export const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

// Convert an input's string value to the configured type.
export const coerce = (kind, el) =>
  kind === "boolean"
    ? el.checked
    : kind === "number" || kind === "integer"
      ? Number(el.value)
      : kind === "list"
        ? el.value.split(",").map((s) => s.trim()).filter(Boolean)
        : el.value;

// True when a click on a <dialog> landed on its backdrop rather than its content.
export function isBackdropClick(event, dialog) {
  if (event.target !== dialog) return false;
  const b = dialog.getBoundingClientRect();
  return event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom;
}

// Fixed top-layer menu placement in the visible viewport, including a zoomed viewport's offsets.
export function selectPosition(trigger, viewport, contentHeight, maxHeight = 280) {
  const edge = 8, gap = 4;
  const left = (viewport.offsetLeft ?? 0) + edge, top = (viewport.offsetTop ?? 0) + edge;
  const right = left + viewport.width - edge * 2, bottom = top + viewport.height - edge * 2;
  const width = Math.min(trigger.width, Math.max(0, right - left));
  const below = Math.max(0, bottom - trigger.bottom - gap), above = Math.max(0, trigger.top - gap - top);
  const desired = Math.min(maxHeight, contentHeight);
  const down = below >= desired || below >= above;
  const height = Math.min(desired, down ? below : above);
  return {
    left: Math.max(left, Math.min(trigger.left, right - width)),
    top: Math.max(top, Math.min(down ? trigger.bottom + gap : trigger.top - gap - height, bottom - height)),
    width,
    height,
  };
}

// Guess owner/repo from a checkout path like /Users/me/git/owner/repo.
export const repoFromPath = (path) => {
  const parts = (path || "").split("/").filter(Boolean);
  return parts.length >= 4 ? `${parts.at(-2)}/${parts.at(-1)}` : "";
};

// Move one item within a list, returning a new list.
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export const formatBytes = n => n == null ? "Unknown" : `${(n / 1024 ** 3).toFixed(2)} GiB`;

// A finished HTTP request is not proof that its cleanup targets were removed.
export function cleanupOperationState(result) {
  const data = result?.data, outcomes = data?.outcomes ?? [];
  if (data?.state === "uncertain" || outcomes.some(o => o.state === "uncertain")) return "uncertain";
  if (result?.code || data?.state === "failed" || outcomes.some(o => o.state === "failed")) return "failed";
  if (data?.state === "pending" || outcomes.some(o => o.state === "pending" || o.state === "requested")) return "pending";
  return "done";
}

/** @returns {{group: "attention" | "retrying" | "gone", reason: string, action: "inspect" | "retry" | "none"} | null} */
export function cleanupOutcomePresentation(outcome) {
  if (!outcome) return null;
  if (outcome.state === "failed") {
    const m = outcome.message;
    // Refusals under rules that no longer apply are retried by the next delete.
    if (/dirty or ignored|maxBuffer|requires one Factory-owned job/i.test(m)) return { group: "ready", reason: "Rechecked with the current cleanup rules", action: "remove" };
    if (/resumed/i.test(m)) return { group: "attention", reason: "Work resumed after completion", action: "force" };
    if (/tracked|untracked|dirty|workspace changes/i.test(m)) return { group: "attention", reason: "Local changes would be lost", action: "force" };
    if (/not verified merged|not part of the release|Unmerged work/i.test(m)) return { group: "attention", reason: "Not merged into the release branch", action: "force" };
    if (/terminal|running process|still using|active or pending work/i.test(m)) return { group: "protected", reason: "An open terminal or process uses this folder", action: "inspect" };
    return { group: "attention", reason: `Removal failed: ${m}`, action: "inspect" };
  }
  if (outcome.state === "uncertain") return { group: "attention", reason: "Removal result is not confirmed", action: "inspect" };
  if (outcome.state === "pending") return { group: "retrying", reason: "Cleanup advanced, but the worktree is still present", action: "retry" };
  if (outcome.state === "confirmed") return typeof outcome.physicalRemoval === "boolean" ? { group: "gone", reason: outcome.physicalRemoval ? "Removal verified" : "Already absent; records finalized", action: "none" } : { group: "attention", reason: "Removal was reported without verified absence", action: "inspect" };
  return null;
}

export function cleanupMatches(item, filters = {}) {
  return (!filters.repository || item.repository === filters.repository) && (!filters.ownership || item.ownership === filters.ownership) && (!filters.state || item.state === filters.state) && JSON.stringify([item.path, item.branch, item.repository, item.jobs, item.bindings, item.lastOutcome]).toLowerCase().includes((filters.query ?? "").toLowerCase());
}

// Keep known results visible while a slower inventory refresh is still showing an older scan.
export function projectCleanupResults(data, operations, filters = {}) {
  if (!data) return data;
  const observed = Date.parse(data.resultsCheckedAt ?? data.checkedAt ?? "");
  const patches = new Map();
  let staleResults = false;
  for (const op of operations) {
    const at = op.result?.data?.updatedAt ?? op.completedAt ?? op.createdAt;
    if (!at || Date.parse(at) <= observed) continue;
    for (const outcome of op.result?.data?.outcomes ?? []) {
      const target = (op.cleanupTargets ?? op.input.targets ?? []).find(t => t.path === outcome.path);
      if (target && cleanupOutcomePresentation(outcome)) { patches.set(`${target.projectId}:${target.path}`, { outcome, at, id: op.id }); staleResults = true; }
    }
  }
  const groups = { ...data.groups }, items = [];
  for (const item of data.items) {
    const patch = patches.get(`${item.projectId}:${item.path}`);
    if (!patch || item.lastOutcome?.actionId === patch.id && item.lastOutcome.state === patch.outcome.state) { items.push(item); continue; }
    const next = cleanupOutcomePresentation(patch.outcome);
    const updated = { ...item, next, state: next.group === "gone" ? "complete" : next.group === "retrying" ? "pending" : "blocked", lastOutcome: { ...patch.outcome, actionId: patch.id, updatedAt: patch.at }, ...(next.group === "gone" ? { present: false, registered: false } : {}) };
    if (item.next?.group && cleanupMatches(item, filters)) groups[item.next.group] = Math.max(0, (groups[item.next.group] ?? 0) - 1);
    if (cleanupMatches(updated, filters)) { groups[next.group] = (groups[next.group] ?? 0) + 1; items.push(updated); }
  }
  return { ...data, groups, items, staleResults };
}

export function cleanupResultSummary(operations) {
  const targets = new Map();
  for (const op of operations) for (const target of op.cleanupTargets ?? op.input.targets ?? []) {
    const outcome = op.result?.data?.outcomes?.find(o => o.path === target.path);
    const state = outcome?.state ?? (["queued", "running"].includes(op.state) ? op.state : cleanupOperationState(op.result));
    targets.set(`${target.projectId}:${target.path}`, { state, physicalRemoval: outcome?.physicalRemoval });
  }
  const results = [...targets.values()], count = predicate => results.filter(predicate).length;
  return { total: results.length, processed: count(o => !["queued", "running"].includes(o.state)), removed: count(o => o.state === "confirmed" && o.physicalRemoval === true), absent: count(o => o.state === "confirmed" && o.physicalRemoval === false), failed: count(o => o.state === "failed"), pending: count(o => o.state === "pending"), uncertain: count(o => o.state === "uncertain" || o.state === "confirmed" && typeof o.physicalRemoval !== "boolean"), cancelled: count(o => o.state === "cancelled") };
}
