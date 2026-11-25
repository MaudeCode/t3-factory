// Everything that can start: what the owner queued, the scheduler's Up next list, Epics, and the tickets that came
// from T3 sessions and inbox reports. The automatic queue and the owner's own stay visibly apart.
import { html, signal, useState } from "../lib/h.js";
import { config, statusSection, needSection, sessionTicketCount, live, jobs, actions, busy, message, startRun, pendingEpic, pendingRun } from "../lib/store.js";
import { providerName, isOpen, matchesRunFilters, hasRunFilters, overrideText, ticketStatusLabel, safeLink } from "../lib/format.js";
import { Button, Segmented, Tag, Mark, Icon, Empty, Facts, Page, Section, RowBody, Meta, Text, SortableList, RelativeTime } from "../ui/index.js";
import { UpNext, Operations, StartOptions, OverrideChips, startOptions, forceStart, PlanRows, planProgress, CancelPlan, TicketRow, RowActions, SectionSwitch, PanelBar } from "./Deck.js";
// How far through its tickets an Epic is, for its progress ring.
const percentDone = (epic) => (epic?.tickets.length ? Math.round((100 * epic.tickets.filter((t) => t.done).length) / epic.tickets.length) : 0);
import { RunFilters } from "./Runs.js";
import { SessionTickets } from "./SessionTickets.js";
import { ReadyReports, readyReportCount } from "./Triage.js";
import { search, navigate, epicClick } from "../lib/router.js";

// Every Epic the tab can list. A running Epic reads from its plan, which keeps finished members and notes;
// the rest come from status.epics with the scheduler's answer on whether they can start.
const epicLists = () => {
  const plans = (statusSection("plans").value ?? []).filter((p) => p.epic).map((p) => ({ ...p, title: p.epic.title, restrictedCount: p.epic.restrictedCount }));
  const running = plans.filter((p) => p.state === "active");
  const open = [...running, ...(needSection("epics").value ?? []).filter((row) => !running.some((p) => p.epic.id === row.id))];
  // One row per Epic: its open row, else its newest finished run. A run cancelled and then run again is not listed.
  const listed = new Set(open.map((e) => e.epic?.id ?? e.id)), latest = new Map();
  for (const p of plans) if (p.state !== "active" && !listed.has(p.epic.id) && !(latest.get(p.epic.id)?.createdAt > p.createdAt)) latest.set(p.epic.id, p);
  return { open, finished: [...latest.values()] };
};
// Epics opened on this page. They stay open through live updates, a change of tab and a start, until a reload.
const openEpics = signal(new Set());
const toggleEpic = (id) => {
  const next = new Set(openEpics.value);
  if (!next.delete(id)) next.add(id);
  openEpics.value = next;
};
// An Epic title matches the whole Epic; otherwise search and filters narrow its rows, and `narrowed` keeps the Epic
// open so the rows that matched are visible. Hidden tickets are no rows, so an Epic made only of them stays until
// something narrows the list.
function matchEpics(list, filters, query) {
  const text = query.trim().toLowerCase();
  return list.flatMap((epic) => {
    const titled = text && epic.title.toLowerCase().includes(text);
    const show = (t) => matchesRunFilters(t, filters, titled ? "" : query);
    const narrowed = hasRunFilters(filters) || (!!text && !titled);
    return epic.tickets.some(show) || !narrowed ? [{ epic, show, narrowed }] : [];
  });
}
// The page's provider and override controls decide how an Epic starts; its model is automatic.
// `panel` is the side panel's labelled button; a list row has the icon.
function EpicStart({ epic, panel }) {
  const { provider, overrideLimits } = startOptions();
  const hold = epic.startBlock?.message ?? (pendingEpic(epic.id) ? "A request for this Epic is already pending." : null);
  const run = () => startRun({ epic: epic.id, model: "auto", ...(provider ? { provider } : {}), overrideLimits });
  return panel
    ? html`<${Button} variant="primary" icon="play" label=${hold ?? `Run Epic: ${overrideText(overrideLimits).toLowerCase()} and start it`} disabled=${!!hold} onClick=${run} />`
    : html`<${Button} size="sm" icon="play" class="next-run epic-run" label=${hold ?? `Run Epic ${epic.title}`} disabled=${!!hold} onClick=${run} />`;
}
// What an Epic's row says about it: one state tag, then how far along it is and, while it runs, what its runs are doing.
function epicSummary(epic) {
  const running = epic.state === "active", states = jobs.value.filter((j) => isOpen(j) && epic.tickets.some((t) => t.id === j.taskId)).map((j) => j.state);
  const active = states.filter((s) => s !== "waiting").length, waiting = states.length - active;
  const [label, tone] = !epic.state ? (epic.startBlock ? ["Can't start", "attention"] : ["Ready", ""])
    : running ? (waiting ? ["Needs you", "attention"] : ["Running", "on"])
    : epic.state === "done" ? ["Done", "ok"] : ["Cancelled", ""];
  const progress = [epic.tickets.length && planProgress(epic), running && active && `${active} running`, running && waiting && `${waiting} waiting for you`].filter(Boolean).join(" · ");
  return { label, tone, progress };
}
// A row in status.epics and the plan it becomes on start share the Epic's ID.
const epicId = (epic) => epic.epic?.id ?? epic.id;
// What a started Epic runs on, and what keeps an Epic from starting or finishing.
const epicModel = (epic) => epic.provider ? providerName(epic.provider) : epic.model === "auto" ? "Auto" : config.value.models.find((m) => m.id === epic.model)?.name ?? epic.model;
const epicNote = (epic) => {
  const hidden = epic.restrictedCount ?? 0;
  return epic.state ? epic.state === "active" && hidden > 0 && `${hidden} ticket${hidden === 1 ? "" : "s"} in projects Factory cannot read keep this Epic open.` : epic.startBlock?.message;
};
// `extra` adds actions beside a running Epic's Cancel, such as its place in the Queued list.
function EpicRow({ epic, show, narrowed, extra }) {
  const id = epicId(epic);
  const running = epic.state === "active", started = !!epic.state;
  const note = epicNote(epic);
  const { label, tone, progress } = epicSummary(epic);
  // The symbol means one thing: the scheduler will refuse to start this Epic.
  const block = !started && epic.startBlock?.message, opens = epic.tickets.length > 0 || !!note, open = opens && (narrowed || openEpics.value.has(id));
  return html`<div class="epic">
    <${TicketRow} ticket=${{ id, title: html`${epic.title}${block && html`<span class="epic-issue" title=${block}><${Icon} name="alert" label=${block} /></span>`}` }} plain meta=${{ project: undefined }}
      toggle=${{ expanded: opens ? open : undefined, disabled: !opens || narrowed, onClick: () => toggleEpic(id), label: `${open ? "Hide" : "Show"} the tickets of ${epic.title}` }}
      link=${{ href: `?epic=${encodeURIComponent(id)}`, onClick: epicClick(id) }}
      mark=${html`<${Mark} tone=${tone} progress=${percentDone(epic)} label=${`${label}${progress ? `, ${progress}` : ""}`} />`}
      badge=${html`<${Tag} tone=${tone}>${label}<//>`}
      actions=${!started && html`<${EpicStart} epic=${epic} />`}
      secondaryActions=${running && html`<${CancelPlan} plan=${epic} title=${`Cancel Epic ${epic.title}?`} label="Cancel Epic" icon="x" class="next-run" />${extra}`}>
      ${progress && html`<span class="epic-progress">${progress}</span>`}
      ${running && html`<span class="epic-choice">${epicModel(epic)} · ${overrideText(epic.overrideLimits)}</span>`}
    <//>
    ${open && html`<div class="epic-tickets">${note && html`<p class="hint tone-attention epic-note">${note}</p>`}<${PlanRows} plan=${epic} show=${show} /></div>`}
  </div>`;
}
// One Epic in the side panel: its state, its start or the controls of its run, and its tickets, which open over it.
// A running Epic's overrides are its plan's own and can be changed; one not started uses the page's start choices.
export const epicById = (id) => { const { open, finished } = epicLists(); return [...open, ...finished].find((epic) => epicId(epic) === id); };
export const epicByTitle = (title) => { const { open, finished } = epicLists(); return [...open, ...finished].find((epic) => epic.title === title); };
export function EpicDetail({ epic, detail }) {
  const running = epic?.state === "active", note = epic && epicNote(epic);
  const { label, tone, progress } = epic ? epicSummary(epic) : {};
  const tracker = safeLink(detail?.url), done = percentDone(epic);
  return html`<${PanelBar} tone=${tone} progress=${epic ? done : undefined} label=${label} detail=${progress}>
      ${tracker && html`<a class="btn btn-icon btn-ghost" href=${tracker} target="_blank" rel="noopener noreferrer" aria-label="Open in tracker" title="Open in tracker"><${Icon} name="issueOpened" /></a>`}
      ${epic && !epic.state && html`<${StartOptions} /><${EpicStart} epic=${epic} panel />`}
      ${running && html`<${CancelPlan} plan=${epic} title=${`Cancel Epic ${epic.title}?`} label="Cancel Epic" danger />`}
    <//>
    <h3 class="ticket-title">${detail?.title ?? epic.title}</h3>
    ${detail && html`<${Meta} all class="ticket-meta" priority=${detail.priority}><${Tag} title="Epic status">${ticketStatusLabel(detail.status)}<//><${Tag} wrap title=${`Assignee: ${detail.assignee ?? "Unassigned"}`}>${detail.assignee ?? "Unassigned"}<//>${detail.archived && html`<${Tag}>Archived<//>`}<//>`}
    ${epic && html`<${Facts} items=${[
      ["Factory", html`<p class="ticket-meta epic-state"><${Tag} tone=${tone}>${label}<//>${progress && html`<span class="muted">${progress}</span>`}</p>
        ${note && html`<p class="ticket-line tone-attention">${note}</p>`}`],
      ["Runs on", running ? epicModel(epic) : null],
      ["Overrides", running ? html`<${OverrideChips} value=${epic.overrideLimits} disabled=${busy.value} onChange=${(limits) => actions.planOverrides(epic.id, limits)} />
        <p class="hint">A change applies to the tickets this Epic starts next.</p>` : null],
    ]} />`}
    <h4>Tickets</h4>
    ${epic?.tickets.length ? html`<div class="epic-tickets"><${PlanRows} plan=${epic} /></div>` : html`<${Empty}>No tickets Factory can read.<//>`}
    ${detail && html`<h4>Description</h4><${Text}>${detail.description}<//><h4>Acceptance</h4><${Text}>${detail.acceptanceCriteria}<//>`}
    ${detail && html`<h4>Discussion</h4>${detail.comments.length ? detail.comments.map((comment) => html`<article key=${comment.id}>
      <p class="ticket-line"><strong>${comment.author}</strong> · <${RelativeTime} at=${comment.createdAt} /></p><${Text}>${comment.body}<//>
    </article>`) : html`<${Empty}>No comments yet.<//>`}`}`;
}

function Epics({ filters, query }) {
  const { open, finished } = epicLists();
  const shown = matchEpics(open, filters, query);
  const section = (match) => html`<${EpicRow} key=${match.epic.id} ...${match} />`;
  const done = matchEpics(finished, filters, query);
  // Finished Epics stay out of the way until a search or filter could be looking for one.
  // Open Epics in three groups, in the order they ask for attention: running, ready to start, and those that cannot start.
  const groups = Object.entries(Object.groupBy(shown, ({ epic }) => epic.state ? "Running" : epic.startBlock ? "Can't start" : "Ready"));
  const order = ["Running", "Ready", "Can't start"];
  return html`<${Operations} />
    ${shown.length ? groups.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([name, list]) => html`<${Section} key=${name} class="epic-group" title=${name} count=${list.length}>${list.map(section)}<//>`) : html`<${Empty}>${open.length ? "No Epics match." : "No open Epics."}<//>`}
    ${done.length > 0 && html`<${Section} collapsible class="epic-finished" title="Finished" count=${done.length} open=${!!query.trim() || hasRunFilters(filters)}>${done.map(section)}<//>`}`;
}

// What the owner started that waits for or holds slots: queued runs, chains and running Epics, in the order the
// scheduler offers them free slots. Dragging a row's handle, or the arrow keys on it, changes that order.
const planName = (p) => p.epic ? `Epic ${p.epic.title}` : p.queued ? p.target.key : `chain to ${p.target.key}`;
function Queued() {
  const plans = (statusSection("plans").value ?? []).filter((p) => p.state === "active");
  // A held queue keeps its switch on the page even when empty, so the hold can be seen and released.
  if (!plans.length && live.value.queue) return null;
  const { onAt, offAt } = live.value.schedule;
  const epics = epicLists().open;
  const move = (from, to) => { const ids = plans.map((p) => p.id); ids.splice(to, 0, ...ids.splice(from, 1)); actions.orderPlans(ids); };
  // A queued run waits on a limit or on its model's allowance. Starting it now asks again with every limit overridden and
  // any model the page's provider choice allows; the scheduler replaces the queued run with that request.
  const startNow = (p) => forceStart(p.target.key);
  // Any item but the first can jump the line; a drag or the arrow keys on its handle place it exactly.
  const top = (p, i) => i > 0 && html`<${Button} variant="ghost" size="sm" icon="arrowUp" class="btn-icon next-run" label=${`Move ${planName(p)} to the top`} onClick=${() => move(i, 0)}><span class="next-action-label">Move to the top</span><//>`;
  const item = (p, i) => p.epic ? html`<${EpicRow} epic=${epics.find((e) => e.id === p.id)} show=${() => true} extra=${top(p, i)} />`
    : p.queued ? html`<div class="queued-run"><${PlanRows} plan=${p} /><div class="next-actions"><${Button} size="sm" icon="play" class="next-run" label=${`Start ${p.target.key} now: any model, every limit overridden`} disabled=${busy.value || pendingRun(p.target.key)} onClick=${() => startNow(p)} />
        <${RowActions} label=${`More actions for ${p.target.key}`}><${CancelPlan} plan=${p} title=${`Cancel the queued run for ${p.target.key}?`} label="Cancel queued run" icon="x" class="next-run" />${top(p, i)}<//></div></div>`
    : html`<div class="queued-run"><div class="chain-row"><${Mark} label="Chain" /><${RowBody} title=${html`Chain to <b class="key">${p.target.key}</b>`}><${Meta}>${planProgress(p)}<//><//></div>
        <div class="next-actions"><${RowActions} label=${`More actions for the chain to ${p.target.key}`}><${CancelPlan} plan=${p} title=${`Cancel the chain to ${p.target.key}?`} label="Cancel chain" icon="x" class="next-run" />${top(p, i)}<//></div></div>
      <div class="epic-tickets"><${PlanRows} plan=${p} /></div>`;
  return html`<${Section} class="queued" title="Queued" count=${plans.length} hint=${plans.length > 1 && "The top row gets the next free slot. Drag a handle to reorder, or focus it and press the arrow keys."}
    aside=${html`<${SectionSwitch} kind="queue" label="Queued runs" on=${offAt ? html`Holds <${RelativeTime} at=${offAt} form="in" />` : "Queue on"} off=${onAt ? html`Starts <${RelativeTime} at=${onAt} form="in" />` : "Queue held"} />`}>
    <${SortableList} label="Queued, in the order they start" items=${plans} keyOf=${planName} onMove=${move}
      render=${(p, i, grip) => html`<div class="queued-item">${plans.length > 1 && grip}<div class="queued-body">${item(p, i)}</div></div>`} />
  <//>`;
}

// The view is in the address, so each one can be linked: /queue, ?view=epics, ?origin=sessions, ?origin=reports.
const VIEWS = { next: "/queue", epics: "/queue?view=epics", sessions: "/queue?origin=sessions", reports: "/queue?origin=reports" };
export const queueView = (query) => {
  const q = new URLSearchParams(query);
  return q.get("view") === "epics" ? "epics" : q.get("origin") === "sessions" ? "sessions" : q.get("origin") === "reports" ? "reports" : "next";
};

export function Queue() {
  const view = queueView(search.value);
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const start = startOptions(), epics = epicLists(), up = needSection("upNext").value;
  const tabs = html`<${Segmented} label="Queue view" value=${view} onChange=${(v) => navigate(VIEWS[v])}
    options=${[["next", "Up next", up?.tickets.length ?? 0], ["epics", "Epics", epics.open.length], ["sessions", "Sessions", sessionTicketCount()], ["reports", "Reports", readyReportCount()]]} />`;
  if (view === "sessions") return html`<${SessionTickets} lead=${tabs} />`;
  if (view === "reports") return html`<${ReadyReports} lead=${tabs} />`;
  const rows = [...(up?.tickets ?? []), ...(up?.held ?? []), ...[...epics.open, ...epics.finished].flatMap((epic) => epic.tickets)];
  // Both views have a count, so the title block keeps its shape and the toolbar stays put.
  const count = view === "next" ? (up?.tickets ?? []).filter((t) => matchesRunFilters(t, filters, query)).length : matchEpics(epics.open, filters, query).length;
  return html`<${Page} class="runs queue" title="Queue" count=${count} tools=${html`<${RunFilters} rows=${rows} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} /><${StartOptions} />`}>
    ${tabs}
    ${view === "next"
      ? html`<${Queued} /><${Operations} /><${UpNext} limit=${Infinity} filters=${filters} query=${query} start=${start} />`
      : html`<${Epics} filters=${filters} query=${query} />`}
  <//>`;
}
