// Everything that can start: what the owner queued, the scheduler's Up next list, Epics, and the tickets that came
// from T3 sessions and inbox reports. The automatic queue and the owner's own stay visibly apart.
import { html, signal, useState } from "../lib/h.js";
import { config, status, jobs, clock, actions, message, startRun, pendingEpic } from "../lib/store.js";
import { providerName, isOpen, matchesRunFilters, hasRunFilters, overrideText } from "../lib/format.js";
import { Button, Segmented, Tag, Icon, Empty, Page, Section } from "../ui/index.js";
import { UpNext, Chains, Operations, StartOptions, startOptions, PlanRows, planProgress, CancelPlan, TicketRow } from "./Deck.js";
import { RunFilters } from "./Runs.js";
import { SessionTickets } from "./SessionTickets.js";
import { ReadyReports, readyReportCount } from "./Triage.js";
import { search, navigate } from "../lib/router.js";

// Every Epic the tab can list. A running Epic reads from its plan, which keeps finished members and notes;
// the rest come from status.epics with the scheduler's answer on whether they can start.
const epicLists = () => {
  const plans = (status.value.plans ?? []).filter((p) => p.epic).map((p) => ({ ...p, title: p.epic.title, restrictedCount: p.epic.restrictedCount }));
  const running = plans.filter((p) => p.state === "active");
  const open = [...running, ...(status.value.epics ?? []).filter((row) => !running.some((p) => p.epic.id === row.id))];
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
function EpicStart({ epic }) {
  const { provider, overrideLimits } = startOptions();
  const hold = epic.startBlock?.message ?? (pendingEpic(epic.id) ? "A request for this Epic is already pending." : null);
  return html`<${Button} size="sm" icon="play" class="next-run epic-run" label=${hold ?? `Run Epic ${epic.title}`} disabled=${!!hold} onClick=${() => startRun({ epic: epic.id, model: "auto", ...(provider ? { provider } : {}), overrideLimits })} />`;
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
function EpicRow({ epic, show, narrowed }) {
  // A row in status.epics and the plan it becomes on start share the Epic's ID.
  const id = epic.epic?.id ?? epic.id;
  const running = epic.state === "active", started = !!epic.state, hidden = epic.restrictedCount ?? 0;
  const model = epic.provider ? providerName(epic.provider) : epic.model === "auto" ? "Auto" : config.value.models.find((m) => m.id === epic.model)?.name ?? epic.model;
  const note = started ? running && hidden > 0 && `${hidden} ticket${hidden === 1 ? "" : "s"} in projects Factory cannot read keep this Epic open.` : epic.startBlock?.message;
  const { label, tone, progress } = epicSummary(epic);
  // The symbol means one thing: the scheduler will refuse to start this Epic.
  const block = !started && epic.startBlock?.message, opens = epic.tickets.length > 0 || !!note, open = opens && (narrowed || openEpics.value.has(id));
  return html`<div class="epic">
    <${TicketRow} ticket=${{ id, title: html`${epic.title}${block && html`<span class="epic-issue" title=${block}><${Icon} name="alert" label=${block} /></span>`}` }} plain meta=${{ project: undefined }}
      toggle=${{ expanded: opens ? open : undefined, disabled: !opens || narrowed, onClick: () => toggleEpic(id) }}
      badge=${html`<${Tag} tone=${tone}>${label}<//>`}
      actions=${!started ? html`<${EpicStart} epic=${epic} />` : running && html`<${CancelPlan} plan=${epic} title=${`Cancel Epic ${epic.title}?`} label="Cancel Epic" icon="x" class="next-run" />`}>
      ${progress && html`<span class="epic-progress">${progress}</span>`}
      ${running && html`<span class="epic-choice">${model} · ${overrideText(epic.overrideLimits)}</span>`}
    <//>
    ${open && html`<div class="epic-tickets">${note && html`<p class="hint tone-attention epic-note">${note}</p>`}<${PlanRows} plan=${epic} show=${show} /></div>`}
  </div>`;
}
function Epics({ filters, query }) {
  const { open, finished } = epicLists();
  const shown = matchEpics(open, filters, query);
  const section = (match) => html`<${EpicRow} key=${match.epic.id} ...${match} />`;
  const done = matchEpics(finished, filters, query);
  // Finished Epics stay out of the way until a search or filter could be looking for one.
  return html`<${Operations} />
    ${shown.length ? shown.map(section) : html`<${Empty}>${open.length ? "No Epics match." : "No open Epics."}<//>`}
    ${done.length > 0 && html`<${Section} collapsible class="epic-finished" title="Finished" count=${done.length} open=${!!query.trim() || hasRunFilters(filters)}>${done.map(section)}<//>`}`;
}

// The view is in the address, so each one can be linked: /queue, ?view=epics, ?origin=sessions, ?origin=reports.
const VIEWS = { next: "/queue", epics: "/queue?view=epics", sessions: "/queue?origin=sessions", reports: "/queue?origin=reports" };
export const queueView = (query) => {
  const q = new URLSearchParams(query);
  return q.get("view") === "epics" ? "epics" : q.get("origin") === "sessions" ? "sessions" : q.get("origin") === "reports" ? "reports" : "next";
};

export function Queue() {
  clock.value;
  const view = queueView(search.value);
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const start = startOptions(), epics = epicLists(), up = status.value.upNext;
  const tabs = html`<${Segmented} label="Queue view" value=${view} onChange=${(v) => navigate(VIEWS[v])}
    options=${[["next", "Up next", up?.tickets.length ?? 0], ["epics", "Epics", epics.open.length], ["sessions", "Sessions", status.value.sessionTickets?.rows?.length ?? 0], ["reports", "Reports", readyReportCount()]]} />`;
  if (view === "sessions") return html`<${SessionTickets} lead=${tabs} />`;
  if (view === "reports") return html`<${ReadyReports} lead=${tabs} />`;
  const rows = [...(up?.tickets ?? []), ...(up?.held ?? []), ...[...epics.open, ...epics.finished].flatMap((epic) => epic.tickets)];
  // Both views have a count, so the title block keeps its shape and the toolbar stays put.
  const count = view === "next" ? (up?.tickets ?? []).filter((t) => matchesRunFilters(t, filters, query)).length : matchEpics(epics.open, filters, query).length;
  return html`<${Page} class="runs queue" title="Queue" count=${count} actions=${html`<${StartOptions} />`} tools=${html`<${RunFilters} rows=${rows} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} />`}>
    ${tabs}
    ${view === "next"
      ? html`<${Chains} /><${Operations} /><${UpNext} limit=${Infinity} filters=${filters} query=${query} start=${start} />`
      : html`<${Epics} filters=${filters} query=${query} />`}
  <//>`;
}
