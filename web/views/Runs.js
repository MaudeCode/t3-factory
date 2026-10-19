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
  DIFFICULTIES,
  matchesRunFilters,
} from "../lib/format.js";
import { Button, Chips, Field, Dialog, Segmented, Tag, Icon, Link, Empty, Facts, Timeline, Help } from "../ui/index.js";
import { RunList, UpNext, Chains, Operations } from "./Deck.js";

export function Runs() {
  clock.value;
  useEffect(() => {
    loadHistory().catch((e) => message(e.message, true));
  }, []);
  const [state, setState] = useState(new URLSearchParams(location.search).get("state") ?? "open");
  const [filters, setFilters] = useState({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const next = state === "next";
  const change = (key, value) => setFilters(previous => ({ ...previous, [key]: value }));
  const active = ["projects", "tags", "difficulties", "priorities", ...(!next ? ["providers"] : [])].filter(key => filters[key]?.length).length;
  // Live jobs win over the history snapshot for anything still open.
  const liveById = new Map(jobs.value.map((j) => [j.id, j]));
  const all = (history.value ?? jobs.value).map((j) => liveById.get(j.id) ?? j);
  for (const j of jobs.value) if (!all.some((x) => x.id === j.id)) all.unshift(j);
  const counts = Object.fromEntries(STATES.map((s) => [s, all.filter((j) => j.state === s).length]));
  const list = all.filter(
    (j) =>
      (state === "all" || (state === "open" ? isOpen(j) : j.state === state)) &&
      matchesRunFilters(j, filters, query) &&
      (!filters.providers?.length || filters.providers.includes(providerOf(j))),
  );
  const tags = [...new Set([...all, ...(status.value.upNext?.tickets ?? []), ...(status.value.upNext?.held ?? [])].flatMap(row => row.labels ?? []))].sort();
  const choices = (key, label, options) => html`<${Field} group label=${label}><${Chips} label=${label} value=${filters[key] ?? []} options=${options} onChange=${value => change(key, value)} /><//>`;
  return html`<div class="page">
    <div class="page-head">
      <div><h1>Runs<${Help} text="Every run the factory has started, newest first." /></h1></div>
      <input class="mono search" value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder="Find a ticket" aria-label="Find a ticket" />
      <${Button} size="sm" aria-label=${`Filter runs${active ? `, ${active} active` : ""}`} aria-haspopup="dialog" aria-expanded=${filterOpen} onClick=${() => setFilterOpen(true)}>Filter${active ? ` · ${active}` : ""}<//>
    </div>
    <${Dialog} open=${filterOpen} onClose=${() => setFilterOpen(false)} title="Filters"
      actions=${html`<${Button} variant="ghost" onClick=${() => { setFilters({}); setQuery(""); }}>Clear filters<//><${Button} onClick=${() => setFilterOpen(false)}>Done<//>`}>
      ${choices("projects", "Project", config.value.projects.map(p => [p.kaneoId, p.name]))}
      ${choices("tags", "Tags", tags.map(tag => [tag, tag]))}
      <${Field} group label="Match tags"><${Segmented} label="Match tags" value=${filters.tagMode ?? "or"} onChange=${value => change("tagMode", value)} options=${[["or", "OR"], ["and", "AND"]]} /><//>
      ${choices("difficulties", "Difficulty", DIFFICULTIES)}
      ${choices("priorities", "Priority", [["urgent", "Urgent"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["no-priority", "No priority"]])}
      ${!next && choices("providers", "Provider", PROVIDERS.map(p => [p.driver, p.name]))}
    <//>
    <${Segmented}
      label="State"
      value=${state}
      onChange=${setState}
      options=${[["next", "Up next", status.value.upNext?.tickets.length ?? 0], ["open", "Open", counts.running + counts.dispatching + counts.waiting], ["waiting", "Needs you", counts.waiting], ["complete", "Done", counts.complete], ["dismissed", "Settled", counts.dismissed], ["all", "All", all.length]]}
    />
    ${state === "next"
      ? html`<${Chains} /><${Operations} /><${UpNext} limit=${Infinity} filters=${filters} query=${query} />`
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
