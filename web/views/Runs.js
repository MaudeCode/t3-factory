// Every run the factory has made, and one run in full.
import { html, useEffect, useRef, useState } from "../lib/h.js";
import { config, status, jobs, history, busy, clock, serverNow, loadHistory, loadRun, actions, message, startRun, pendingEpic } from "../lib/store.js";
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
  hasRunFilters,
  overrideText,
  byNewest,
} from "../lib/format.js";
import { Button, Select, Segmented, Field, Popover, Chips, Tag, Icon, Link, Empty, Facts, Timeline, Page, Section } from "../ui/index.js";
import { RunList, UpNext, Chains, Operations, StartOptions, startOptions, OrderChoice, PlanRows, planProgress, CancelPlan, modelOptions } from "./Deck.js";

// Search and Filter popovers for any ticket or run list. `rows` are everything the list could
// show, so project and tag choices narrow each other to combinations that exist; `providers` adds the provider facet.
// Tags are picked twice: the ones a row must carry, and the ones that hide a row.
export function RunFilters({ rows, filters, query, onFilters, onQuery, providers = false, sessions = false, children, searchLabel = "Find a ticket", filterLabel = "Filter runs", activeCount }) {
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const button = useRef();
  const searchButton = useRef(), searchInput = useRef();
  const change = (key, value) => onFilters({ ...filters, [key]: value });
  const active = activeCount ?? ["projects", "tags", "tagsNot", "difficulties", "priorities", ...(providers ? ["providers"] : []), ...(sessions ? ["sessions"] : [])].filter(key => filters[key]?.length).length;
  const sessionNames = new Map(sessions ? rows.flatMap(row => row.sources ?? []).map(source => [source.threadId, source.title || "Untitled session"]) : []);
  for (const id of sessions ? filters.sessions ?? [] : []) if (!sessionNames.has(id)) sessionNames.set(id, "Session no longer listed");
  const sessionOptions = [...sessionNames].sort((a, b) => a[1].localeCompare(b[1]));
  // Project and tag choices narrow each other: only tags seen in the chosen projects, only projects that have the chosen tags.
  const picked = (key) => filters[key] ?? [];
  const tags = [...new Set([...picked("tags"), ...picked("tagsNot"), ...rows.filter(row => matchesRunFilters(row, { projects: picked("projects") })).flatMap(row => row.labels ?? [])])].sort();
  const tagOptions = tags.map(tag => [tag, tag]), anyTags = picked("tags").length + picked("tagsNot").length > 0;
  const projectOptions = config.value.projects.filter(p => !picked("tags").length || picked("projects").includes(p.kanvilId) || rows.some(row => row.projectId === p.kanvilId && matchesRunFilters(row, { tags: picked("tags"), tagMode: filters.tagMode, tagsNot: picked("tagsNot") })));
  // Few options get a row of icon buttons; projects and tags, which grow, get a multi-pick dropdown.
  const glyph = (value, icon, title) => [value, html`<${Icon} name=${icon} />`, title];
  const chips = (key, label, options) => html`<${Field} group label=${label}><${Chips} label=${label} value=${filters[key] ?? []} options=${options} onChange=${value => change(key, value)} /><//>`;
  return html`<span ref=${searchButton}><${Button} size="sm" icon="search" label="Search" title=${query ? `${searchLabel}: ${query}` : searchLabel} aria-expanded=${searchOpen} aria-pressed=${!!query.trim()} onClick=${() => setSearchOpen(v => !v)} /></span>
    <${Popover} class="search-panel" open=${searchOpen} onClose=${() => setSearchOpen(false)} anchor=${searchButton} label=${searchLabel} width=${380}>
      <input ref=${searchInput} autofocus class="mono search" value=${query} onInput=${e => onQuery(e.target.value)} onKeyDown=${e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); setSearchOpen(false); searchButton.current.querySelector("button").focus(); } }} placeholder=${searchLabel} aria-label=${searchLabel} />
      <${Button} size="sm" variant="ghost" icon="x" label="Clear search" disabled=${!query} onClick=${() => { onQuery(""); searchInput.current.focus(); }} />
    <//>
    <span ref=${button}><${Button} size="sm" icon="filter" label=${`${filterLabel}${active ? `, ${active} active` : ""}`} aria-expanded=${open} aria-pressed=${active > 0} onClick=${() => setOpen((v) => !v)}>${active || null}<//></span>
    <${Popover} open=${open} onClose=${() => setOpen(false)} anchor=${button} label="Filters" width=${340}>
      ${children ?? html`
      ${sessions && html`<${Field} group label="Session"><${Select} multiple placeholder="Any" label="Session" value=${filters.sessions ?? []} options=${sessionOptions} onChange=${value => change("sessions", value)} /><//>`}
      <${Field} group label="Project"><${Select} multiple placeholder="Any" label="Project" value=${filters.projects ?? []} options=${projectOptions.map(p => [p.kanvilId, p.name])} onChange=${value => change("projects", value)} /><//>
      <${Field} group label="Tags">
        <div class="tags-pick">
          <${Select} multiple placeholder="Any" label="Tags" value=${filters.tags ?? []} options=${tagOptions} onChange=${value => change("tags", value)} />
          ${(filters.tags?.length ?? 0) > 1 && html`<${Segmented} label="Match tags" value=${filters.tagMode ?? "or"} onChange=${value => change("tagMode", value)} options=${[["or", "ANY"], ["and", "ALL"]]} />`}
          ${anyTags && html`<${Button} variant="ghost" size="sm" icon label="Clear tags" onClick=${() => onFilters({ ...filters, tags: [], tagsNot: [] })}>×<//>`}
        </div>
        <div class="tags-pick">
          <span class="muted small" aria-hidden="true">Without</span>
          <${Select} multiple placeholder="None" label="Without" value=${filters.tagsNot ?? []} options=${tagOptions} onChange=${value => change("tagsNot", value)} />
        </div>
      <//>
      ${chips("difficulties", "Difficulty", [glyph("low", "bars1", "Low"), glyph("med", "bars2", "Medium"), glyph("high", "bars3", "High")])}
      ${chips("priorities", "Priority", [glyph("urgent", "alert", "Urgent"), glyph("high", "arrowUp", "High"), glyph("medium", "dash", "Medium"), glyph("low", "arrowDown", "Low"), glyph("none", "circleSlash", "No priority")])}
      ${providers && chips("providers", "Provider", PROVIDERS.map(p => glyph(p.driver, providerIcon(p.driver), p.name)))}
      `}
      ${active > 0 && html`<${Button} variant="ghost" size="sm" onClick=${() => { onFilters({}); onQuery(""); }}>Clear all<//>`}
    <//>`;
}

// Every Epic the tab can list. A running Epic reads from its plan, which keeps finished members and notes;
// the rest come from status.epics with the scheduler's answer on whether they can start.
const epicLists = () => {
  const plans = (status.value.plans ?? []).filter((p) => p.epic).map((p) => ({ ...p, title: p.epic.title, restrictedCount: p.epic.restrictedCount }));
  const running = plans.filter((p) => p.state === "active");
  return {
    open: [...running, ...(status.value.epics ?? []).filter((row) => !running.some((p) => p.epic.id === row.id))],
    finished: plans.filter((p) => p.state !== "active"),
  };
};
// An Epic title matches the whole Epic; otherwise search and filters narrow its rows. Hidden tickets are no rows, so
// an Epic made only of them stays until something narrows the list.
function matchEpics(list, filters, query) {
  const text = query.trim().toLowerCase();
  return list.flatMap((epic) => {
    const titled = text && epic.title.toLowerCase().includes(text);
    const show = (t) => matchesRunFilters(t, filters, titled ? "" : query);
    return epic.tickets.some(show) || !(hasRunFilters(filters) || (text && !titled)) ? [{ epic, show }] : [];
  });
}
function EpicStart({ epic }) {
  const [model, setModel] = useState("auto");
  const { provider, overrideLimits } = startOptions();
  const hold = epic.startBlock?.message ?? (pendingEpic(epic.id) ? "A request for this Epic is already pending." : null);
  // /api/dispatch refuses a provider with a pinned model. The pick comes back with Auto.
  const chosen = provider ? "auto" : model;
  return html`<div class="epic-start">
    <${Select} label=${`Model for ${epic.title}`} value=${chosen} onChange=${setModel} options=${modelOptions()} disabled=${!!provider} />
    <${Button} size="sm" icon="play" class="epic-run" label=${hold ?? `Run Epic ${epic.title}`} disabled=${!!hold} onClick=${() => startRun({ epic: epic.id, model: chosen, ...(provider ? { provider } : {}), overrideLimits })} />
  </div>`;
}
function EpicSection({ epic, show }) {
  const running = epic.state === "active", started = !!epic.state, hidden = epic.restrictedCount ?? 0;
  const model = epic.provider ? providerName(epic.provider) : epic.model === "auto" ? "Auto" : config.value.models.find((m) => m.id === epic.model)?.name ?? epic.model;
  const note = started ? running && hidden > 0 && `${hidden} ticket${hidden === 1 ? "" : "s"} in projects Factory cannot read keep this Epic open.` : epic.startBlock?.message;
  return html`<${Section} class="epic" title=${epic.title} count=${epic.tickets.length ? planProgress(epic) : null} aside=${!started
    ? html`<${EpicStart} epic=${epic} />`
    : running
      ? html`<div class="epic-start"><span class="muted small epic-choice">${model} · ${overrideText(epic.overrideLimits)}</span><${CancelPlan} plan=${epic} title=${`Cancel Epic ${epic.title}?`} label="Cancel Epic" /></div>`
      : html`<${Tag} tone=${epic.state === "done" ? "ok" : ""}>${epic.state === "done" ? "Done" : "Cancelled"}<//>`}>
    ${note && html`<p class="hint tone-attention epic-note">${note}</p>`}
    <${PlanRows} plan=${epic} show=${show} />
  <//>`;
}
function Epics({ filters, query }) {
  const { open, finished } = epicLists();
  const shown = matchEpics(open, filters, query);
  return html`<${Operations} />
    ${shown.length ? shown.map(({ epic, show }) => html`<${EpicSection} key=${epic.id} epic=${epic} show=${show} />`) : html`<${Empty}>${open.length ? "No Epics match." : "No open Epics."}<//>`}
    ${matchEpics(finished, filters, query).map(({ epic, show }) => html`<${EpicSection} key=${epic.id} epic=${epic} show=${show} />`)}`;
}

export function Runs() {
  clock.value;
  useEffect(() => {
    loadHistory().catch((e) => message(e.message, true));
  }, []);
  const [state, setState] = useState(new URLSearchParams(location.search).get("state") ?? "open");
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("newest");
  const start = startOptions();
  // Up next and Epics list tickets that have not run: nothing to sort, no recorded provider.
  const next = state === "next" || state === "epics";
  const epics = epicLists();
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
  ).toSorted((a, b) => order === "oldest" ? byNewest(b, a) : byNewest(a, b));
  const rows = [...all, ...(status.value.upNext?.tickets ?? []), ...(status.value.upNext?.held ?? []), ...[...epics.open, ...epics.finished].flatMap((epic) => epic.tickets)];
  // Every tab has a count, so the title block keeps its shape and the toolbar stays put.
  const count = state === "next" ? (status.value.upNext?.tickets ?? []).filter((t) => matchesRunFilters(t, filters, query)).length : state === "epics" ? matchEpics(epics.open, filters, query).length : list.length;
  return html`<${Page} class="runs" title="Runs" count=${count} actions=${html`<${StartOptions} /><${OrderChoice} label="Start order" value=${order} onChange=${setOrder} disabled=${next} />`} tools=${html`<${RunFilters} rows=${rows} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} providers=${!next} />`}>
    <${Segmented}
      label="State"
      value=${state}
      onChange=${setState}
      options=${[["next", "Up next", status.value.upNext?.tickets.length ?? 0], ["epics", "Epics", epics.open.length], ["open", "Open", all.filter(isOpen).length], ["waiting", "Needs you", counts.waiting], ["complete", "Done", counts.complete], ["dismissed", "Settled", counts.dismissed], ["all", "All", all.length]]}
    />
    ${state === "next"
      ? html`<${Chains} /><${Operations} /><${UpNext} limit=${Infinity} filters=${filters} query=${query} start=${start} />`
      : state === "epics"
        ? html`<${Epics} filters=${filters} query=${query} />`
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
    lead=${`${job.historyOnly ? "Archived run" : job.kind === "upstream" ? "Upstream review" : job.kind === "discovery" ? "Discovery run" : "Ticket run"}${project ? ` in ${project.name}` : ""}`}
    actions=${isOpen(job) && html`<${Button} variant="danger" size="sm" disabled=${busy.value} onClick=${() => confirmAction({ title: `Stop ${job.label}?`, message: "T3 ends the run; the worktree and any open PR stay as they are.", label: "Stop run" }, () => actions.stopJob(job.id))}>Stop run<//>`}>
    <div class="links-row">
      <a href=${`/cleanup?query=${encodeURIComponent(job.id)}`} onClick=${follow}>Cleanup review</a>
      ${ticket && html`<${Link} href=${ticket}>Ticket in Kanvil<//>`}
      ${prs.map((href) => html`<${Link} key=${href} href=${href}>${prLabel(href)}<//>`)}
      ${job.threadId && html`<a href=${threadLink(job)}>Open in T3 Code</a>`}
      ${project && html`<${Link} href=${projectLink(c, project.kanvilId)}>${project.name}<//>`}
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
