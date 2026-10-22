// Every run the factory has made, and one run in full.
import { html, useEffect, useRef, useState } from "../lib/h.js";
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
  matchesRunFilters,
} from "../lib/format.js";
import { Button, Select, Segmented, Field, Popover, Chips, Tag, Icon, Link, Empty, Facts, Timeline, Page, Section } from "../ui/index.js";
import { RunList, UpNext, Chains, Operations } from "./Deck.js";

// Search box, Filter button and its popover for any ticket or run list. `rows` are everything the list could
// show, so project and tag choices narrow each other to combinations that exist; `providers` adds the provider facet.
export function RunFilters({ rows, filters, query, onFilters, onQuery, providers = false, sessions = false, children, searchLabel = "Find a ticket", filterLabel = "Filter runs", activeCount }) {
  const [open, setOpen] = useState(false);
  const button = useRef();
  const change = (key, value) => onFilters({ ...filters, [key]: value });
  const active = activeCount ?? ["projects", "tags", "difficulties", "priorities", ...(providers ? ["providers"] : []), ...(sessions ? ["sessions"] : [])].filter(key => filters[key]?.length).length;
  const sessionNames = new Map(sessions ? rows.flatMap(row => row.sources ?? []).map(source => [source.threadId, source.title || "Untitled session"]) : []);
  for (const id of sessions ? filters.sessions ?? [] : []) if (!sessionNames.has(id)) sessionNames.set(id, "Session no longer listed");
  const sessionOptions = [...sessionNames].sort((a, b) => a[1].localeCompare(b[1]));
  // Project and tag choices narrow each other: only tags seen in the chosen projects, only projects that have the chosen tags.
  const picked = (key) => filters[key] ?? [];
  const tags = [...new Set([...picked("tags"), ...rows.filter(row => matchesRunFilters(row, { projects: picked("projects") })).flatMap(row => row.labels ?? [])])].sort();
  const projectOptions = config.value.projects.filter(p => !picked("tags").length || picked("projects").includes(p.kaneoId) || rows.some(row => row.projectId === p.kaneoId && matchesRunFilters(row, { tags: picked("tags"), tagMode: filters.tagMode })));
  // Few options get a row of icon buttons; projects and tags, which grow, get a multi-pick dropdown.
  const glyph = (value, icon, title) => [value, html`<${Icon} name=${icon} />`, title];
  const chips = (key, label, options) => html`<${Field} group label=${label}><${Chips} label=${label} value=${filters[key] ?? []} options=${options} onChange=${value => change(key, value)} /><//>`;
  return html`<input class="mono search" value=${query} onInput=${(e) => onQuery(e.target.value)} placeholder=${searchLabel} aria-label=${searchLabel} />
    <span ref=${button}><${Button} size="sm" icon="filter" label=${`${filterLabel}${active ? `, ${active} active` : ""}`} aria-expanded=${open} aria-pressed=${active > 0} onClick=${() => setOpen((v) => !v)}>${active || null}<//></span>
    <${Popover} open=${open} onClose=${() => setOpen(false)} anchor=${button} label="Filters" width=${340}>
      ${children ?? html`
      ${sessions && html`<${Field} group label="Session"><${Select} multiple placeholder="Any" label="Session" value=${filters.sessions ?? []} options=${sessionOptions} onChange=${value => change("sessions", value)} /><//>`}
      <${Field} group label="Project"><${Select} multiple placeholder="Any" label="Project" value=${filters.projects ?? []} options=${projectOptions.map(p => [p.kaneoId, p.name])} onChange=${value => change("projects", value)} /><//>
      <${Field} group label="Tags">
        <div class="tags-pick">
          <${Select} multiple placeholder="Any" label="Tags" value=${filters.tags ?? []} options=${tags.map(tag => [tag, tag])} onChange=${value => change("tags", value)} />
          ${(filters.tags?.length ?? 0) > 1 && html`<${Segmented} label="Match tags" value=${filters.tagMode ?? "or"} onChange=${value => change("tagMode", value)} options=${[["or", "ANY"], ["and", "ALL"]]} />`}
          ${(filters.tags?.length ?? 0) > 0 && html`<${Button} variant="ghost" size="sm" icon label="Clear tags" onClick=${() => change("tags", [])}>×<//>`}
        </div>
      <//>
      ${chips("difficulties", "Difficulty", [glyph("low", "bars1", "Low"), glyph("med", "bars2", "Medium"), glyph("high", "bars3", "High")])}
      ${chips("priorities", "Priority", [glyph("urgent", "alert", "Urgent"), glyph("high", "arrowUp", "High"), glyph("medium", "dash", "Medium"), glyph("low", "arrowDown", "Low"), glyph("no-priority", "circleSlash", "No priority")])}
      ${providers && chips("providers", "Provider", PROVIDERS.map(p => glyph(p.driver, providerIcon(p.driver), p.name)))}
      `}
      ${active > 0 && html`<${Button} variant="ghost" size="sm" onClick=${() => { onFilters({}); onQuery(""); }}>Clear all<//>`}
    <//>`;
}

export function Runs() {
  clock.value;
  useEffect(() => {
    loadHistory().catch((e) => message(e.message, true));
  }, []);
  const [state, setState] = useState(new URLSearchParams(location.search).get("state") ?? "open");
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const next = state === "next";
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
  const rows = [...all, ...(status.value.upNext?.tickets ?? []), ...(status.value.upNext?.held ?? [])];
  return html`<${Page} title="Runs" actions=${html`<${RunFilters} rows=${rows} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} providers=${!next} />`}>
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
  <//>`;
}

export function RunDetail({ id }) {
  clock.value;
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadRun(id).then(setDetail, (e) => setError(e.message));
  }, [id, jobs.value]);
  if (error) return html`<${Page} narrow title="Run" lead=${error} />`;
  if (!detail) return html`<${Page} narrow><${Empty}>Loading run.<//><//>`;
  const c = config.value,
    job = jobs.value.find((j) => j.id === id) ?? detail.job,
    project = projectOf(c, job),
    now = serverNow(),
    prs = (job.prUrls || []).map(safeLink).filter(Boolean),
    ticket = ticketLink(c, job),
    report = detail.report;
  return html`<${Page} class="run-detail" title=${html`<a class="crumb" href="/runs" onClick=${follow}>Runs</a> ${job.label} <${Tag} tone=${toneOf(job.state)}>${stateLabel(job.state)}<//>`}
    lead=${`${job.kind === "upstream" ? "Upstream review" : job.kind === "discovery" ? "Discovery run" : "Ticket run"}${project ? ` in ${project.name}` : ""}`}
    actions=${isOpen(job) && html`<${Button} variant="danger" size="sm" disabled=${busy.value} onClick=${() => confirmAction({ title: `Stop ${job.label}?`, message: "T3 ends the run; the worktree and any open PR stay as they are.", label: "Stop run" }, () => actions.stopJob(job.id))}>Stop run<//>`}>
    <div class="links-row">
      <a href=${`/cleanup?query=${encodeURIComponent(job.id)}`} onClick=${follow}>Cleanup review</a>
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
    html`<${Section} title="Report" aside=${html`<${Tag} tone=${report.status === "complete" ? "ok" : report.status === "awaiting-human" ? "attention" : ""}>${report.status}<//>`}>
      <p class="report">${report.reason}</p>
      ${report.createdTaskIds?.length > 0 && html`<p class="muted small">Created ${report.createdTaskIds.length} ticket${report.createdTaskIds.length === 1 ? "" : "s"}.</p>`}
    <//>`}
    </div>
    <${Section} title="Timeline">
      ${detail.events.length ? html`<${Timeline} events=${[...detail.events].reverse()} />` : html`<${Empty}>No events recorded for this run.<//>`}
    <//>
    </div>
  <//>`;
}
