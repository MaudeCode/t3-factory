// Pure formatting helpers and vocabulary shared by views and the store.
export const clone = (value) => structuredClone(value);

export const uuid = () =>
  crypto.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );

// Two units at most, and never a zero second unit: "1 h 5 min", "3 d", "41 min".
export const span = (seconds) => {
  const units = [["d", 86400], ["h", 3600], ["min", 60], ["s", 1]];
  const parts = [];
  for (const [name, size] of units) {
    const n = Math.floor(seconds / size);
    if (n > 0 || (name === "s" && !parts.length)) parts.push(`${n} ${name}`);
    seconds -= n * size;
    if (parts.length === 2 || (parts.length === 1 && name === "min")) break;
  }
  return parts.join(" ");
};

// Dates arrive as ISO strings from the server or as millisecond numbers computed here.
const ms = (date) => (typeof date === "number" ? date : Date.parse(date));
export const ago = (date, now = Date.now()) => (date ? `${span(Math.max(0, (now - ms(date)) / 1000))} ago` : "never");
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
  if (d.reason === "disabled") return `Automation is paused. Running work continues.${d.eligible ? ` ${d.eligible} ticket${d.eligible === 1 ? "" : "s"} ready to start.` : ""}`;
  if (d.reason === "error") return `The last check failed: ${d.message}`;
  if (d.reason === "dispatched") return `Started ${d.ticket ?? (d.upstream ? `a review of ${d.upstream.name} ${d.upstream.candidate}` : `discovery for ${d.project}`)} on ${d.model}.`;
  const streams = (d.streams || []).map((s) => `${s.provider} is ${streamReason(s.reason)}`).join("; ");
  const eligible = d.eligible ? `${d.eligible} ticket${d.eligible === 1 ? "" : "s"} eligible.` : "Nothing eligible to start.";
  return streams ? `${streams}. ${eligible}` : eligible;
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
export const difficultyLabel = (value) => DIFFICULTIES.find(([v]) => v === value)?.[1] ?? "High";

export const STATES = ["dispatching", "running", "waiting", "complete", "dismissed"];
export const STATE_LABELS = { dispatching: "Starting", running: "Running", waiting: "Needs you", complete: "Done", dismissed: "Settled" };
export const finishedAt = (job) => job.completedAt ?? job.dismissedAt ?? job.createdAt;
export const byFinished = (a, b) => String(finishedAt(b)).localeCompare(String(finishedAt(a)));
export const stateLabel = (state) => STATE_LABELS[state] ?? state;
// The four stops on a run's track, in order; a settled run also reaches the last stop.
export const STOPS = ["Queued", "Working", "Needs you", "Done"];
export const stopOf = (state) => ({ dispatching: 1, running: 2, waiting: 3, complete: 4, dismissed: 4 })[state] ?? 1;
export const toneOf = (state) => ({ dispatching: "on", running: "on", waiting: "attention", complete: "ok", dismissed: "" })[state] ?? "";
export const isActive = (job) => ["running", "dispatching"].includes(job.state);
export const isOpen = (job) => !["complete", "dismissed"].includes(job.state);
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
export const kaneo = (config, ...parts) =>
  safeLink(`${config.kaneo.url}/dashboard/workspace/${encodeURIComponent(config.kaneo.workspaceId)}/${parts.map(encodeURIComponent).join("/")}`);
export const ticketLink = (config, job) => (job.taskId ? kaneo(config, "project", job.projectId, "task", job.taskId) : "");
export const projectLink = (config, kaneoId) => kaneo(config, "project", kaneoId);
export const repoLink = (repo) => safeLink(`https://github.com/${repo}`);
export const releaseLink = (repo, tag) => (tag ? safeLink(`https://github.com/${repo}/releases/tag/${tag}`) : "");
export const prLabel = (url) => {
  const m = url.match(/\/pull\/(\d+)$/);
  return m ? `PR #${m[1]}` : "PR";
};
export const threadLink = (job) => (job.threadId ? `t3-thread://v1/${job.threadId}` : "");

export const projectOf = (config, job) => config.projects.find((p) => p.kaneoId === job.projectId);
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
