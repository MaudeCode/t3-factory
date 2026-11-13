// One ticket, opened in place from any ticket row: what it asks for, what it waits on, its runs, and Run now.
// Read-only apart from starting a run; the tracker stays one link away.
import { html, useState, useEffect } from "../lib/h.js";
import { config, status, jobs, history, loadHistory, clock, serverNow } from "../lib/store.js";
import { api } from "../lib/api.js";
import { ticketPanel, closeTicket, follow } from "../lib/router.js";
import { ago, ticketKey, safeLink, stateLabel, toneOf, overrideText } from "../lib/format.js";
import { Button, Dialog, Icon, Tag, Meta, Facts, Empty } from "../ui/index.js";
import { startHold, runNow, startOptions } from "./Deck.js";

const CLOSED = ["done", "cancelled"];
const STATUS = { backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", cancelled: "Cancelled" };
// The tracker's text is untrusted: it is shown as text, with its line breaks, and never parsed as markup.
const Text = ({ children }) => (children?.trim() ? html`<p class="ticket-text">${children}</p>` : html`<${Empty}>None written.<//>`);
const Related = ({ list }) => html`<span class="ticket-related">${list.map((t) => html`<span key=${t.key} class=${t.done ? "done" : ""}><b class="key">${t.key}</b> ${t.title}${t.done && html` <${Tag} tone="ok">done<//>`}</span>`)}</span>`;

function Detail({ ticket: t }) {
  clock.value;
  useEffect(() => { if (!history.value) loadHistory().catch(() => {}); }, []);
  const c = config.value, now = serverNow(), project = c.projects.find((p) => p.kanvilId === t.projectId);
  const row = { id: t.id, key: t.key, title: t.title, projectId: t.projectId };
  const hold = CLOSED.includes(t.status) ? `${t.key} is ${STATUS[t.status].toLowerCase()}.` : startHold(row);
  const start = startOptions();
  // Where the scheduler has this ticket right now, in its own words.
  const up = status.value.upNext, position = up?.tickets.findIndex((x) => x.id === t.id) ?? -1, held = up?.held.find((h) => ticketKey(h.key) === t.key);
  const line = position >= 0 ? `Up next: ${position + 1} of ${up.tickets.length} in the queue.` : held ? `Held back: ${held.reason}` : null;
  const seen = new Set(), runs = [...jobs.value, ...(history.value ?? [])].filter((j) => j.taskId === t.id && !seen.has(j.id) && seen.add(j.id));
  const tracker = safeLink(t.url);
  return html`<h3 class="ticket-title">${t.title}</h3>
    <${Meta} class="ticket-meta" project=${project?.name} automationReady=${t.automationReady} priority=${t.priority} difficulty=${t.difficulty || false} labels=${t.labels}><${Tag}>${STATUS[t.status] ?? t.status}<//><//>
    <div class="ticket-actions">
      <${Button} variant="primary" icon="play" disabled=${!!hold} title=${hold ?? `${overrideText(start.overrideLimits)} and start this ticket now.`} onClick=${() => runNow(row, hold, undefined, start)}>Run now<//>
      ${tracker && html`<a class="btn btn-ghost" href=${tracker} target="_blank" rel="noopener noreferrer">Open in tracker</a>`}
    </div>
    ${(hold || line) && html`<p class="ticket-line">${hold ?? line}</p>`}
    <h4>Description</h4><${Text}>${t.description}<//>
    <h4>Acceptance</h4><${Text}>${t.acceptanceCriteria}<//>
    <h4>Details</h4>
    <${Facts} items=${[
      ["Waits on", t.blockedBy.length ? html`<${Related} list=${t.blockedBy} />` : null],
      ["Blocks", t.blocks.length ? html`<${Related} list=${t.blocks} />` : null],
      ["Epic", t.epic],
      ["Not ready", t.automationReady ? null : t.holdReason || t.readiness.join("; ") || "Automation readiness is off"],
      ["Created", ago(t.createdAt, now)],
    ]} />
    <h4>Runs</h4>
    ${runs.length
      ? html`<ul class="ticket-runs">${runs.map((j) => html`<li key=${j.id}><a href=${`/runs/${j.id}`} onClick=${(e) => { closeTicket(); follow(e); }}><${Tag} tone=${toneOf(j.state)}>${stateLabel(j.state)}<//> started ${ago(j.createdAt, now)}</a></li>`)}</ul>`
      : html`<${Empty}>No runs yet.<//>`}`;
}

export function TicketPanel() {
  const key = ticketPanel.value;
  const [read, setRead] = useState({ key: "" });
  const load = (k) => {
    setRead({ key: k, loading: true });
    const settle = (patch) => setRead((s) => (s.key === k ? { key: k, ...patch } : s));
    api(`/api/tickets/${encodeURIComponent(k)}`).then((ticket) => settle({ ticket }), (error) => settle({ error }));
  };
  useEffect(() => { if (key) load(key); }, [key]);
  const mine = read.key === key ? read : { loading: true };
  return html`<${Dialog} class="ticket-panel" open=${!!key} onClose=${closeTicket} title=${key}>
    ${mine.ticket
      ? html`<${Detail} ticket=${mine.ticket} />`
      : mine.error
        ? html`<div class="ticket-state" role="alert">
            <p><${Icon} name="alert" /> ${mine.error.status === 404 ? `${key} was not found in a project Factory is set up for.` : `Could not read ${key}. ${mine.error.message}`}</p>
            ${mine.error.status !== 404 && html`<${Button} size="sm" icon="sync" onClick=${() => load(key)}>Retry<//>`}
          </div>`
        : html`<p class="ticket-state" role="status"><i class="spinner"></i> Reading ${key}</p>`}
  <//>`;
}
