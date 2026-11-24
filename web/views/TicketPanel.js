// One ticket, or one Epic, opened in place. A ticket, from any ticket row: what it asks for, what it waits on, its runs, and Run now.
// Read-only apart from starting a run; the tracker stays one link away. Its Factory tab holds what the scheduler
// knows about the ticket: where it stands and its latest run.
import { html, useState, useEffect, useRef } from "../lib/h.js";
import { config, needSection, statusSection, jobs, history, loadHistory, clock, serverNow, busy } from "../lib/store.js";
import { api } from "../lib/api.js";
import { ticketPanel, closeTicket, epicPanel, closeEpic, follow } from "../lib/router.js";
import { ago, ticketKey, safeLink, stateLabel, toneOf, overrideText, byNewest, ticketStatusLabel } from "../lib/format.js";
import { Button, Dialog, Icon, Tag, Meta, Facts, Empty, Text, Segmented } from "../ui/index.js";
import { startHold, runNow, startOptions, Investigate } from "./Deck.js";
import { RunDetail } from "./Runs.js";
import { decisions, outcomeText, DuplicateLink } from "./Triage.js";
import { epicById, EpicDetail } from "./Queue.js";

const CLOSED = ["done", "cancelled"];
const Related = ({ list }) => html`<span class="ticket-related">${list.map((t) => html`<span key=${t.key} class=${t.done ? "done" : ""}><b class="key">${t.key}</b> ${t.title}${t.done && html` <${Tag} tone="ok">done<//>`}</span>`)}</span>`;

function Detail({ ticket: t, tab }) {
  clock.value;
  useEffect(() => { if (!history.value) loadHistory().catch(() => {}); }, []);
  const c = config.value, now = serverNow(), project = c.projects.find((p) => p.kanvilId === t.projectId);
  const row = { id: t.id, key: t.key, title: t.title, projectId: t.projectId };
  const hold = CLOSED.includes(t.status) ? `${t.key} is ${ticketStatusLabel(t.status).toLowerCase()}.` : startHold(row);
  const start = startOptions();
  // Where the scheduler has this ticket right now, in its own words.
  const up = needSection("upNext").value, position = up?.tickets.findIndex((x) => x.id === t.id) ?? -1, held = up?.held.find((h) => ticketKey(h.key) === t.key);
  const line = position >= 0 ? `Up next: ${position + 1} of ${up.tickets.length} in the queue.` : held ? html`Held back: ${held.reason} <${Investigate} held=${held} />` : null;
  const seen = new Set(), runs = [...jobs.value, ...(history.value ?? [])].filter((j) => j.taskId === t.id && !seen.has(j.id) && seen.add(j.id)).toSorted(byNewest);
  const tracker = safeLink(t.url);
  // An inbox report still open: what triage made of it and what the owner can do about it.
  const report = t.inbox ? (statusSection("triageReports").value ?? []).find((e) => e.data.ticketId === t.id) : undefined, verdict = report?.data.outcome === "triaged" && report.data.verdict;
  const advice = { "needs-info": "The reporter cannot be asked from here. Make a ticket from what the report says, or close it.", duplicate: "Confirm it if that ticket covers this report. If not, make this a ticket of its own." }[verdict];
  // A run link is ordinary navigation: it leaves the panel's address, which closes the panel without a second history step.
  if (tab === "factory") return html`${line && html`<p class="ticket-line">${line}</p>`}
    ${runs.length
      ? html`<${RunDetail} id=${runs[0].id} embedded />
        ${runs.length > 1 && html`<h4>Earlier runs</h4>
          <ul class="ticket-runs">${runs.slice(1).map((j) => html`<li key=${j.id}><a href=${`/runs/${j.id}`} onClick=${follow}><${Tag} tone=${toneOf(j.state)}>${stateLabel(j.state)}<//> started ${ago(j.createdAt, now)}</a></li>`)}</ul>`}`
      : html`<${Empty}>${t.inbox ? "Inbox reports are triaged, not run." : "No runs yet."}<//>`}`;
  return html`<h3 class="ticket-title">${t.title}</h3>
    <${Meta} class="ticket-meta" project=${project?.name} automationReady=${t.automationReady} priority=${t.priority} difficulty=${t.difficulty || false} labels=${t.labels}><${Tag}>${ticketStatusLabel(t.status)}<//><//>
    <div class="ticket-actions">
      ${!t.inbox && html`<${Button} variant="primary" icon="play" disabled=${!!hold} title=${hold ?? `${overrideText(start.overrideLimits)} and start this ticket now.`} onClick=${() => runNow(row, hold, undefined, start)}>Run now<//>`}
      ${report?.data.stage === "owner" && decisions(report.data).map((a, i) => html`<${Button} key=${a.id} variant=${i ? "" : "primary"} icon=${a.icon} disabled=${busy.value} onClick=${a.run}>${a.label}<//>`)}
      ${tracker && html`<a class="btn btn-ghost" href=${tracker} target="_blank" rel="noopener noreferrer">Open in tracker</a>`}
    </div>
    ${!t.inbox && (hold || line) && html`<p class="ticket-line">${hold ?? line}</p>`}
    ${report && html`<p class="ticket-line">${outcomeText(report)}. ${advice} <${DuplicateLink} of=${verdict === "duplicate" && report.data.duplicateOf} /></p>`}
    <h4>Description</h4><${Text}>${t.description}<//>
    <h4>Acceptance</h4><${Text}>${t.acceptanceCriteria}<//>
    <h4>Details</h4>
    <${Facts} items=${[
      ["Waits on", t.blockedBy.length ? html`<${Related} list=${t.blockedBy} />` : null],
      ["Blocks", t.blocks.length ? html`<${Related} list=${t.blocks} />` : null],
      ["Epic", t.epic],
      ["Not ready", t.automationReady ? null : t.holdReason || t.readiness.join("; ") || "Automation readiness is off"],
      ["Created", ago(t.createdAt, now)],
    ]} />`;
}

export function TicketPanel() {
  const key = ticketPanel.value, epicKey = !key && epicPanel.value;
  const path = key ? `/api/tickets/${encodeURIComponent(key)}` : epicKey ? `/api/epics/${encodeURIComponent(epicKey)}` : null;
  const [read, setRead] = useState({ path: null }), [retry, setRetry] = useState(0);
  const [tab, setTab] = useState("ticket"), resource = useRef(null);
  // Inventory checks refresh open Epic panels even when the ticket queue is unchanged.
  const refreshed = epicKey ? statusSection("epicDetailsRevision").value : null;
  useEffect(() => {
    if (!path) return;
    let current = true, queued = false, running = false;
    const abort = new AbortController();
    const load = async () => {
      queued = true;
      if (running) return;
      running = true;
      while (current && queued) {
        queued = false;
        setRead((previous) => ({ path, data: previous.path === path ? previous.data : undefined, loading: true }));
        try {
          const data = await api(path, { signal: abort.signal });
          if (current) setRead({ path, data });
        } catch (error) { if (current) setRead((previous) => ({ ...previous, loading: false, error })); }
      }
      running = false;
    };
    const scope = { path, refreshed, retry, load };
    resource.current = scope;
    load();
    return () => { current = false; abort.abort(); if (resource.current === scope) resource.current = null; };
  }, [path]);
  useEffect(() => {
    const scope = resource.current;
    if (!scope || scope.path !== path || scope.refreshed === refreshed && scope.retry === retry) return;
    scope.refreshed = refreshed; scope.retry = retry;
    scope.load();
  }, [path, refreshed, retry]);
  useEffect(() => { if (key) setTab("ticket"); }, [key]);
  const mine = read.path === path ? read : { loading: true };
  const noun = key ? key : "Epic";
  const state = mine.error ? html`<div class="ticket-state" role="alert">
    <p><${Icon} name="alert" /> ${mine.error.status === 404 ? `${noun} was not found in Factory's configured ${key ? "projects" : "workspaces"}.` : key ? `Could not read ${key}. ${mine.error.message}` : mine.error.message}</p>
    ${(mine.error.status !== 404 || !key) && html`<${Button} size="sm" icon="sync" onClick=${() => setRetry((value) => value + 1)}>Retry<//>`}
  </div>` : !mine.data && html`<p class="ticket-state" role="status"><i class="spinner"></i> Reading ${noun}</p>`;
  const epic = epicKey ? epicById(epicKey) : undefined;
  // A member ticket opens over its Epic; closing it remounts the Epic with a fresh tracker read.
  if (epicKey) return html`<${Dialog} key="epic" class="ticket-panel" open onClose=${closeEpic} title="Epic">
    ${state}
    ${mine.error?.status !== 404 && (mine.data || epic) && html`<${EpicDetail} epic=${epic} detail=${mine.data} />`}
  <//>`;
  return html`<${Dialog} key="ticket" class="ticket-panel" open=${!!key} onClose=${closeTicket} title=${key}>
    ${state}
    ${mine.data && html`<${Segmented} label="Ticket view" value=${tab} onChange=${setTab} options=${[["ticket", "Ticket"], ["factory", "Factory"]]} />
      <${Detail} ticket=${mine.data} tab=${tab} />`}
  <//>`;
}
