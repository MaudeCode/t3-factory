// Every run the factory has made, and one run in full.
import { html, useEffect, useState } from "../lib/h.js";
import { config, status, jobs, history, busy, clock, serverNow, loadHistory, loadRun, actions, message } from "../lib/store.js";
import { follow } from "../lib/router.js";
import { confirmAction } from "../lib/confirmation.js";
import {
  ago,
  duration,
  clockTime,
  PROVIDERS,
  STATES,
  stateLabel,
  toneOf,
  providerOf,
  providerName,
  providerIcon,
  isOpen,
  ticketLink,
  projectLink,
  safeLink,
  prLabel,
  threadLink,
  modelName,
  projectOf,
  difficultyLabel,
  PENDING_KINDS,
} from "../lib/format.js";
import { Button, Select, Segmented, Tag, Icon, Link, Empty, Facts, Timeline, Help } from "../ui/index.js";
import { RunList, UpNext, Chains } from "./Deck.js";

export function Runs() {
  clock.value;
  useEffect(() => {
    loadHistory().catch((e) => message(e.message, true));
  }, []);
  const [state, setState] = useState(new URLSearchParams(location.search).get("state") ?? "open");
  const [project, setProject] = useState("all");
  const [provider, setProvider] = useState("all");
  const [query, setQuery] = useState("");
  // Live jobs win over the history snapshot for anything still open.
  const liveById = new Map(jobs.value.map((j) => [j.id, j]));
  const all = (history.value ?? jobs.value).map((j) => liveById.get(j.id) ?? j);
  for (const j of jobs.value) if (!all.some((x) => x.id === j.id)) all.unshift(j);
  const counts = Object.fromEntries(STATES.map((s) => [s, all.filter((j) => j.state === s).length]));
  const list = all.filter(
    (j) =>
      (state === "all" || (state === "open" ? isOpen(j) : j.state === state)) &&
      (project === "all" || j.projectId === project) &&
      (provider === "all" || providerOf(j) === provider) &&
      (!query || j.label.toLowerCase().includes(query.toLowerCase())),
  );
  return html`<div class="page">
    <div class="page-head">
      <div><h1>Runs<${Help} text="Every run the factory has started, newest first." /></h1></div>
      <input class="mono search" value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder="Find a ticket" aria-label="Find a ticket" />
      <${Select} label="Project" size="sm" value=${project} onChange=${setProject} options=${[["all", "All projects"], ...config.value.projects.map((p) => [p.kaneoId, p.name])]} />
      <${Select} label="Provider" size="sm" value=${provider} onChange=${setProvider} options=${[["all", "Both providers"], ...PROVIDERS.map((p) => [p.driver, p.name])]} />
    </div>
    <${Segmented}
      label="State"
      value=${state}
      onChange=${setState}
      options=${[["next", "Up next", status.value.upNext?.tickets.length ?? 0], ["open", "Open", counts.running + counts.dispatching + counts.waiting], ["waiting", "Needs you", counts.waiting], ["complete", "Done", counts.complete], ["dismissed", "Settled", counts.dismissed], ["all", "All", all.length]]}
    />
    ${state === "next"
      ? html`<${Chains} /><${UpNext} limit=${Infinity} />`
      : history.value === null && !jobs.value.length
        ? html`<${Empty}>Loading runs.<//>`
        : list.length
          ? html`<${RunList} list=${list} />`
          : html`<${Empty}>No runs match.<//>`}
  </div>`;
}

export function RunDetail({ id }) {
  clock.value;
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadRun(id).then(setDetail, (e) => setError(e.message));
  }, [id, jobs.value]);
  if (error) return html`<div class="page narrow"><div class="page-head"><div><h1>Run</h1><p>${error}</p></div></div></div>`;
  if (!detail) return html`<div class="page narrow"><${Empty}>Loading run.<//></div>`;
  const c = config.value,
    job = jobs.value.find((j) => j.id === id) ?? detail.job,
    project = projectOf(c, job),
    now = serverNow(),
    prs = (job.prUrls || []).map(safeLink).filter(Boolean),
    ticket = ticketLink(c, job),
    report = detail.report;
  return html`<div class="page run-detail">
    <p class="crumbs"><a href="/runs" onClick=${follow}>Runs</a></p>
    <div class="page-head">
      <div>
        <h1>${job.label} <${Tag} tone=${toneOf(job.state)}>${stateLabel(job.state)}<//></h1>
        <p>${job.kind === "upstream" ? "Upstream review" : job.kind === "discovery" ? "Discovery run" : "Ticket run"}${project ? ` in ${project.name}` : ""}</p>
      </div>
      ${isOpen(job) && html`<${Button} variant="danger" disabled=${busy.value} onClick=${() => confirmAction({ title: `Stop ${job.label}?`, message: "T3 ends the run; the worktree and any open PR stay as they are.", label: "Stop run" }, () => actions.stopJob(job.id))}>Stop run<//>`}
    </div>
    <div class="links-row">
      ${ticket && html`<${Link} href=${ticket}>Ticket in Kaneo<//>`}
      ${prs.map((href) => html`<${Link} key=${href} href=${href}>${prLabel(href)}<//>`)}
      ${job.threadId && html`<a href=${threadLink(job)}>Open in T3 Code</a>`}
      ${project && html`<${Link} href=${projectLink(c, project.kaneoId)}>${project.name}<//>`}
    </div>
    <div class="run-grid">
    <div>
    ${job.state === "waiting" && html`<p class="callout">${job.thread?.pending ? `T3 ${PENDING_KINDS[job.thread.pending] ?? `is waiting: ${job.thread.pending}`}. ` : ""}${job.reason}</p>`}
    <${Facts}
      items=${[
        ["Model", html`<${Icon} name=${providerIcon(providerOf(job))} label=${providerName(providerOf(job))} /> ${modelName(c, job)} <span class="muted mono">${job.modelSelection?.model}</span>`],
        ["Why this model", job.modelReason],
        ["Difficulty", job.difficulty && difficultyLabel(job.difficulty)],
        ["Started", `${clockTime(job.createdAt)}, ${ago(job.createdAt, now)}`],
        ["Last activity", job.lastExecutionAt && ago(job.lastExecutionAt, now)],
        ["Your last reply", job.lastPersonalActivity && ago(job.lastPersonalActivity, now)],
        ["Finished", job.completedAt && `${ago(job.completedAt, now)}, after ${duration(job.createdAt, job.completedAt)}`],
        ["Branch", job.thread?.branch && html`<span class="mono">${job.thread.branch}</span>`],
        ["Worktree", job.thread?.worktreePath && html`<span class="mono">${job.thread.worktreePath}</span>`],
        ["T3 thread", job.thread && `${job.thread.title ? `${job.thread.title}, ` : ""}${job.thread.status}${job.thread.background?.length ? `, background: ${job.thread.background.join(", ")}` : ""}`],
        ["Scheduler note", job.reason],
      ]}
    />
    ${report &&
    html`<section class="group">
      <header><h2>Report from the run</h2><${Tag} tone=${report.status === "complete" ? "ok" : report.status === "awaiting-human" ? "attention" : ""}>${report.status}<//></header>
      <p class="report">${report.reason}</p>
      ${report.createdTaskIds?.length > 0 && html`<p class="muted small">Created ${report.createdTaskIds.length} ticket${report.createdTaskIds.length === 1 ? "" : "s"}.</p>`}
    </section>`}
    </div>
    <section class="group">
      <header><h2>Timeline</h2></header>
      ${detail.events.length ? html`<${Timeline} events=${[...detail.events].reverse()} />` : html`<${Empty}>No events recorded for this run.<//>`}
    </section>
    </div>
  </div>`;
}
