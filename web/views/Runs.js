// Every run the factory has made, and one run in full.
import { html, useEffect, useMemo, useRef, useState } from "../lib/h.js";
import { config, status, jobs, history, busy, loadHistory, loadRun, actions, message } from "../lib/store.js";
import { follow, openTicket } from "../lib/router.js";
import { confirmAction } from "../lib/confirmation.js";
import { duration, clockTime, PROVIDERS, stateLabel, toneOf, providerOf, providerName, providerIcon, isOpen, ticketLink, factoryTicket, projectLink, safeLink, prLabel, threadLink, modelName, projectOf, difficultyLabel, PENDING_KINDS, matchesRunFilters, runsList, STOPS, stopOf, RUN_KINDS, runTitle } from "../lib/format.js";
import { Button, Select, Segmented, Field, Popover, Chips, Tag, Icon, Bars, Empty, Facts, Timeline, Page, Section, RelativeTime } from "../ui/index.js";
import { RunList, OrderChoice } from "./Deck.js";

// Search and Filter popovers for any ticket or run list. `rows` are everything the list could
// show, so project and tag choices narrow each other to combinations that exist; `providers` adds the provider facet.
// Tags are picked twice: the ones a row must carry, and the ones that hide a row.
// `order` is the list's sort control; it leads the filter panel, which stays mounted so the choice is always in the page.
export function RunFilters({ rows, filters, query, onFilters, onQuery, providers = false, sessions = false, children, order, searchLabel = "Find a ticket", filterLabel = "Filter runs", activeCount }) {
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
  // Few options get a row of named chips; projects and tags, which grow, get a multi-pick dropdown.
  const glyph = (value, icon, title) => [value, html`<${Icon} name=${icon} /> ${title}`, title];
  const chips = (key, label, options) => html`<${Field} group label=${label}><${Chips} label=${label} value=${filters[key] ?? []} options=${options} onChange=${value => change(key, value)} /><//>`;
  return html`<span ref=${searchButton}><${Button} size="sm" icon="search" label="Search" title=${query ? `${searchLabel}: ${query}` : searchLabel} aria-expanded=${searchOpen} aria-pressed=${!!query.trim()} onClick=${() => setSearchOpen(v => !v)} /></span>
    <${Popover} class="search-panel" open=${searchOpen} onClose=${() => setSearchOpen(false)} anchor=${searchButton} label=${searchLabel} width=${380}>
      <input ref=${searchInput} autofocus class="mono search" value=${query} onInput=${e => onQuery(e.target.value)} onKeyDown=${e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); setSearchOpen(false); searchButton.current.querySelector("button").focus(); } }} placeholder=${searchLabel} aria-label=${searchLabel} />
      <${Button} size="sm" variant="ghost" icon="x" label="Clear search" disabled=${!query} onClick=${() => { onQuery(""); searchInput.current.focus(); }} />
    <//>
    <span ref=${button}><${Button} size="sm" icon="filter" label=${`${filterLabel}${active ? `, ${active} active` : ""}`} aria-expanded=${open} aria-pressed=${active > 0} onClick=${() => setOpen((v) => !v)}>${active || null}<//></span>
    <${Popover} mounted=${!!order} open=${open} onClose=${() => setOpen(false)} anchor=${button} label="Filters" width=${340}>
      ${order && html`<${Field} group label="Order">${order}<//>`}
      ${children ?? html`
      ${sessions && html`<${Field} group label="Session"><${Select} multiple placeholder="Any" label="Session" value=${filters.sessions ?? []} options=${sessionOptions} onChange=${value => change("sessions", value)} /><//>`}
      <${Field} group label="Project"><${Select} multiple placeholder="Any" label="Project" value=${filters.projects ?? []} options=${projectOptions.map(p => [p.kanvilId, p.name])} onChange=${value => change("projects", value)} /><//>
      <${Field} group label="Tags">
        <div class="tags-pick">
          <${Select} multiple placeholder="Any" label="Tags" value=${filters.tags ?? []} options=${tagOptions} onChange=${value => change("tags", value)} />
          ${(filters.tags?.length ?? 0) > 1 && html`<${Segmented} label="Match tags" value=${filters.tagMode ?? "or"} onChange=${value => change("tagMode", value)} options=${[["or", "ANY"], ["and", "ALL"]]} />`}
          ${anyTags && html`<${Button} variant="ghost" size="sm" icon="x" label="Clear tags" onClick=${() => onFilters({ ...filters, tags: [], tagsNot: [] })} />`}
        </div>
        <div class="tags-pick">
          <span class="muted small" aria-hidden="true">Without</span>
          <${Select} multiple placeholder="None" label="Without" value=${filters.tagsNot ?? []} options=${tagOptions} onChange=${value => change("tagsNot", value)} />
        </div>
      <//>
      ${chips("difficulties", "Difficulty", [["low", "Low"], ["med", "Medium"], ["high", "High"]].map(([value, name]) => [value, html`<${Bars} level=${value} /> ${name}`, name]))}
      ${chips("priorities", "Priority", [glyph("urgent", "alert", "Urgent"), glyph("high", "arrowUp", "High"), glyph("medium", "dash", "Medium"), glyph("low", "arrowDown", "Low"), glyph("none", "circleSlash", "No priority")])}
      ${providers && chips("providers", "Provider", PROVIDERS.map(p => glyph(p.driver, providerIcon(p.driver), p.name)))}
      `}
      ${active > 0 && html`<${Button} variant="ghost" size="sm" icon="x" label="Clear all filters" onClick=${() => { onFilters({}); onQuery(""); }} />`}
    <//>`;
}

const RUNS_PAGE = 100;
export function Runs({ id } = {}) {
  useEffect(() => {
    loadHistory().catch((e) => message(e.message, true));
  }, []);
  const [state, setState] = useState(new URLSearchParams(location.search).get("state") ?? "open");
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("newest");
  // The list is built only when one of these inputs changes.
  const { all, counts, list } = useMemo(() => runsList(history.value, jobs.value, { state, filters, query, order }), [history.value, jobs.value, state, filters, query, order]);
  // The list renders a window of rows; a new tab, filter, search or order starts it again.
  const view = [state, filters, query, order];
  const [shown, setShown] = useState({ view, size: RUNS_PAGE });
  const same = shown.view.every((v, i) => v === view[i]);
  if (!same) setShown({ view, size: RUNS_PAGE });
  const size = same ? shown.size : RUNS_PAGE;
  // A run opened by its address beyond the window widens it to that run's page.
  const at = id ? list.findIndex((j) => j.id === id) : -1;
  const limit = Math.max(size, Math.ceil((at + 1) / RUNS_PAGE) * RUNS_PAGE);
  const rest = list.length - limit;
  // With no run named in the address, the first run listed is shown beside the list.
  const selected = id ?? list[0]?.id;
  return html`<div class=${`runs-split${id ? " has-run" : ""}`}>
  <div class="runs-list"><${Page} class="runs" title="Runs" count=${list.length} tools=${html`<${RunFilters} rows=${all} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} providers order=${html`<${OrderChoice} label="Start order" value=${order} onChange=${setOrder} />`} />`}>
    <${Segmented}
      label="State"
      value=${state}
      onChange=${setState}
      options=${[["open", "Open", counts.open], ["waiting", "Needs you", counts.waiting], ["complete", "Finished", counts.complete], ["dismissed", "Settled", counts.dismissed], ["all", "All", counts.all]]}
    />
    ${history.value === null && !jobs.value.length
        ? html`<${Empty}>Loading runs.<//>`
        : list.length
          ? html`<${RunList} list=${list} selected=${selected ?? ""} limit=${limit} more=${`Show ${Math.min(RUNS_PAGE, rest)} more of ${rest}`} onMore=${() => setShown({ view, size: limit + RUNS_PAGE })} />`
          : html`<${Empty}>No runs match.<//>`}
  <//></div>
  <div class="runs-detail">${selected ? html`<${RunDetail} id=${selected} />` : html`<${Page} narrow><${Empty}>No run to show.<//><//>`}</div>
  </div>`;
}

// `embedded` is the run inside the ticket panel: its title links to the run's own page and it offers no Ticket button.
export function RunDetail({ id, embedded }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  // A read answers for the run it was started for; a slower one for another run is dropped.
  const shown = useRef(id);
  if (shown.current !== id) { shown.current = id; setDetail(null); setError(""); }
  // The report is read again only when this run changes in a way it can show, or leaves the live list; progress times and other runs do not.
  const live = jobs.value.find((j) => j.id === id), change = live ? JSON.stringify([live.state, live.reason, live.prUrls, live.thread?.status, live.thread?.pending]) : "";
  useEffect(() => {
    loadRun(id).then((d) => shown.current === id && (d?.job ? (setError(""), setDetail(d)) : setError("Run not found")), (e) => shown.current === id && setError(e.message));
  }, [id, change]);
  if (error) return html`<${Page} narrow title=${html`<a class="crumb" href="/runs" onClick=${follow}>Runs</a> Run`} lead=${error} />`;
  if (!detail || detail.job.id !== id) return html`<${Page} narrow><${Empty}>Loading run.<//><//>`;
  const c = config.value,
    job = live ?? detail.job,
    project = projectOf(c, job),
    prs = (job.prUrls || []).map(safeLink).filter(Boolean),
    ticket = ticketLink(c, job),
    report = detail.report,
    stop = stopOf(job.state),
    // A ticket in one of Factory's projects opens in the ticket panel; anything else keeps its tracker link.
    inFactory = factoryTicket(c, job),
    kind = `${job.historyOnly ? "Archived run" : RUN_KINDS[job.kind]?.[1] ?? "Ticket run"}${project ? ` in ${project.name}` : ""}`,
    // A waiting run's callout already carries the scheduler's note, and a report often repeats it.
    waiting = job.state === "waiting";
  return html`<${Page} class="run-detail" title=${html`<a class="crumb" href=${embedded ? `/runs/${id}` : "/runs"} onClick=${follow}>${embedded ? "Run" : "Runs"}</a> ${job.label} <${Tag} tone=${toneOf(job.state)}>${stateLabel(job.state)}<//>`}
    lead=${runTitle(job) || kind}
    actions=${isOpen(job) && html`<${Button} variant="danger" size="sm" icon="circleSlash" label="Stop run" disabled=${busy.value} onClick=${() => confirmAction({ title: `Stop ${job.label}?`, message: "T3 ends the run; the worktree and any open PR stay as they are.", label: "Stop run" }, () => actions.stopJob(job.id))} />`}>
    <div class="run-actions">
      ${job.threadId && html`<a class="btn btn-sm btn-icon btn-primary" href=${threadLink(job)} aria-label="Open in T3 Code" title="Open in T3 Code"><${Icon} name="commentDiscussion" /></a>`}
      ${prs.map((href) => html`<a key=${href} class="btn btn-sm" href=${href} target="_blank" rel="noopener noreferrer" title=${prLabel(href)}><${Icon} name="pullRequest" /><span>${prLabel(href).replace(/^PR /, "")}</span></a>`)}
      ${ticket && !embedded && (inFactory ? html`<${Button} size="sm" icon="tag" label="Ticket" onClick=${() => openTicket(inFactory)} />` : html`<a class="btn btn-sm btn-icon" href=${ticket} target="_blank" rel="noopener noreferrer" aria-label="Ticket" title="Ticket"><${Icon} name="tag" /></a>`)}
      <a class="btn btn-sm btn-icon" href=${`/cleanup?query=${encodeURIComponent(job.id)}`} onClick=${follow} aria-label="Cleanup review" title="Cleanup review"><${Icon} name="trash" /></a>
    </div>
    <ol class="run-track" aria-label="Progress">${STOPS.map((name, i) => html`<li key=${name} class=${i + 1 === stop ? "now" : i + 1 < stop ? "past" : ""} aria-current=${i + 1 === stop ? "step" : undefined}>${name}</li>`)}</ol>
    <div class="run-grid">
    <div>
    ${waiting && html`<p class="callout">${job.thread?.pending ? `T3 ${PENDING_KINDS[job.thread.pending] ?? `is waiting: ${job.thread.pending}`}. ` : ""}${job.reason}</p>`}
    <${Facts}
      items=${[
        ["Run", project ? html`${kind.replace(` in ${project.name}`, "")} in <a href=${projectLink(c, project.kanvilId)} target="_blank" rel="noopener noreferrer">${project.name}</a>` : kind],
        ["Model", html`<${Icon} name=${providerIcon(providerOf(job))} label=${providerName(providerOf(job))} /> ${modelName(c, job)} <span class="muted mono">${job.modelSelection?.model}</span>`],
        ["Why this model", job.modelReason],
        ["Difficulty", job.difficulty && difficultyLabel(job.difficulty)],
        ["Started", html`${clockTime(job.createdAt)}, <${RelativeTime} at=${job.createdAt} />`],
        ["Last activity", job.lastExecutionAt && html`<${RelativeTime} at=${job.lastExecutionAt} />`],
        ["Your last reply", job.lastPersonalActivity && html`<${RelativeTime} at=${job.lastPersonalActivity} />`],
        ["Finished", job.completedAt && html`<${RelativeTime} at=${job.completedAt} />, after ${duration(job.createdAt, job.completedAt)}`],
        ["Branch", job.thread?.branch && html`<span class="mono">${job.thread.branch}</span>`],
        ["Worktree", job.thread?.worktreePath && html`<span class="mono">${job.thread.worktreePath}</span>`],
        ["T3 thread", job.thread && [job.thread.title, job.thread.status, job.thread.background?.length && `background: ${job.thread.background.join(", ")}`].filter(Boolean).join(", ")],
        ["Scheduler note", waiting ? null : job.reason],
      ]}
    />
    ${report &&
    html`<${Section} title="Report" aside=${html`<${Tag} tone=${report.status === "complete" ? "ok" : report.status === "awaiting-human" ? "attention" : ""}>${report.status}<//>`}>
      ${!(waiting && report.reason === job.reason) && html`<p class="report">${report.reason}</p>`}
      ${report.createdTaskIds?.length > 0 && html`<p class="muted small">Created ${report.createdTaskIds.length} ticket${report.createdTaskIds.length === 1 ? "" : "s"}.</p>`}
    <//>`}
    </div>
    <${Section} title="Timeline">
      ${detail.events.length ? html`<${Timeline} events=${[...detail.events].reverse()} />` : html`<${Empty}>No events recorded for this run.<//>`}
    <//>
    </div>
  <//>`;
}
