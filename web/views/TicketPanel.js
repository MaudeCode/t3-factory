// One ticket, or one Epic, opened in place. A ticket, from any ticket row: what it asks for, what it waits on, its runs, and Run now.
// Read-only apart from starting a run; the tracker stays one link away. Its Factory tab holds what the scheduler
// knows about the ticket: where it stands and its latest run.
import { html, useState, useEffect, useRef } from "../lib/h.js";
import { config, needSection, statusSection, jobs, history, loadHistory, busy, launchOperations, actions, pendingRun, startRun } from "../lib/store.js";
import { api } from "../lib/api.js";
import { ticketPanel, closeTicket, epicPanel, closeEpic, follow, ticketClick, navigate } from "../lib/router.js";
import { ticketKey, safeLink, stateLabel, toneOf, overrideText, byNewest, ticketStatusLabel, isOpen, threadLink, PENDING_KINDS, earlierWork, evidenceLines, blockedByEarlierWork, holdNote, modelName } from "../lib/format.js";
import { Button, Dialog, Icon, Tag, Mark, Meta, Facts, Empty, Text, Segmented, RelativeTime } from "../ui/index.js";
import { startHold, runNow, forceStart, startOptions, Investigate, PanelBar } from "./Deck.js";
import { RunDetail } from "./Runs.js";
import { decisions, outcomeText, DuplicateLink } from "./Triage.js";
import { epicById, EpicDetail } from "./Queue.js";

const CLOSED = ["done", "cancelled"];
// The tickets this one waits on or blocks: one line each, its state as the row's mark, opening in this panel.
const Related = ({ list }) => html`<ul class="ticket-related">${list.map((t) => html`<li key=${t.key}><a class=${t.done ? "done" : ""} href=${`?ticket=${encodeURIComponent(t.key)}`} onClick=${ticketClick(ticketKey(t.key))} title=${t.title}>
  <${Mark} tone=${t.done ? "ok" : ""} label=${t.done ? "Done" : "Not done"} /><b class="key">${t.key}</b><span>${t.title}</span></a></li>`)}</ul>`;

function Detail({ ticket: t, tab }) {
  useEffect(() => { if (!history.value) loadHistory().catch(() => {}); }, []);
  const c = config.value, project = c.projects.find((p) => p.kanvilId === t.projectId);
  const row = { id: t.id, key: t.key, title: t.title, projectId: t.projectId };
  const start = startOptions();
  // Where the scheduler has this ticket right now, in its own words.
  const up = needSection("upNext").value, position = up?.tickets.findIndex((x) => x.id === t.id) ?? -1, held = up?.held.find((h) => ticketKey(h.key) === t.key);
  const line = position >= 0 ? `Up next: ${position + 1} of ${up.tickets.length} in the queue.` : held ? html`Held back: ${held.reason} <${Investigate} held=${held} quiet />` : null;
  const seen = new Set(), runs = [...jobs.value, ...(history.value ?? [])].filter((j) => j.taskId === t.id && !seen.has(j.id) && seen.add(j.id)).toSorted(byNewest);
  const tracker = safeLink(t.url);
  // A ticket with a run under way leads with that run: its state, why it waits, and the way into its session.
  const current = runs.find(isOpen);
  // Earlier work in the way: the scheduler's own hold, or the answer to the last start asked for from this browser.
  const refused = launchOperations.value.findLast((op) => !["queued", "running"].includes(op.state) && earlierWork(op)?.key === t.key);
  // A ticket of a running Epic or chain is held "with its Epic" in the queue; the plan's own row knows what stops it.
  const planned = (statusSection("plans").value ?? []).filter((p) => p.state === "active").flatMap((p) => p.target ? [...p.tickets, p.target] : p.tickets)
    .find((x) => x.id === t.id && !x.done);
  const conflict = held?.conflict === "artifacts" ? held : planned && blockedByEarlierWork(planned) ? { reason: planned.note, conflict: "artifacts" } : refused && earlierWork(refused);
  const memberOf = t.epicId ? epicById(t.epicId) : undefined;
  // A ticket its running chain or Epic keeps waiting, with nothing unfinished ahead of it, can be started by name with
  // every limit overridden; the plan stays as it is. Anything else starts through the ordinary checks.
  const force = !!planned && !current && !conflict && t.blockedBy.every((b) => b.done);
  const hold = CLOSED.includes(t.status) ? `${t.key} is ${ticketStatusLabel(t.status).toLowerCase()}.` : pendingRun(t.key) ? "A request for this ticket is already pending." : force ? null : startHold(row);
  const waits = planned && !force && t.blockedBy.filter((b) => !b.done).map((b) => b.key);
  // An inbox report still open: what triage made of it and what the owner can do about it.
  const report = t.inbox ? (statusSection("triageReports").value ?? []).find((e) => e.data.ticketId === t.id) : undefined, verdict = report?.data.outcome === "triaged" && report.data.verdict;
  const advice = { "needs-info": "The reporter cannot be asked from here. Make a ticket from what the report says, or close it.", duplicate: "Confirm it if that ticket covers this report. If not, make this a ticket of its own." }[verdict];
  // Where the ticket stands, for the panel's bar: a mark and a few words. The property list says it in full.
  const standing = t.inbox ? (report ? { tone: report.data.stage === "owner" ? "attention" : "", label: report.data.stage === "owner" ? "Needs you" : "Triaged" } : {})
    : current ? { tone: toneOf(current.state) || "on", label: stateLabel(current.state), detail: current.state === "waiting" ? holdNote(current.thread?.pending ? PENDING_KINDS[current.thread.pending] ?? current.reason : current.reason) : html`<${RelativeTime} at=${current.createdAt} form="for" />` }
    : CLOSED.includes(t.status) ? { tone: t.status === "done" ? "ok" : "", label: ticketStatusLabel(t.status) }
    : pendingRun(t.key) ? { tone: "on", label: "Starting" }
    : conflict ? { tone: "attention", label: "Held back", detail: holdNote(conflict.reason) }
    : planned ? { tone: force ? "attention" : "", label: "Waiting", detail: waits?.length ? `after ${waits.join(", ")}` : holdNote(planned.note) ?? "for a slot" }
    : held ? { label: "Held back", detail: holdNote(held.reason) }
    : position >= 0 ? { label: "Up next", detail: `${position + 1} of ${up.tickets.length}` }
    : {};
  // What can be done, least to most likely, so the main action is the last in the bar.
  const bar = html`<${PanelBar} ...${standing}>
    ${tracker && html`<a class="btn btn-icon btn-ghost" href=${tracker} target="_blank" rel="noopener noreferrer" aria-label="Open in tracker" title="Open in tracker"><${Icon} name="issueOpened" /></a>`}
    ${report?.data.stage === "owner" && decisions(report.data).toReversed().map((a, i, all) => html`<${Button} key=${a.id} variant=${i === all.length - 1 ? "primary" : ""} icon=${a.icon} label=${a.label} disabled=${busy.value} onClick=${a.run} />`)}
    ${!t.inbox && !current && conflict && !pendingRun(t.key) && html`<${Investigate} held=${{ ...conflict, key: t.key, id: t.id }} onStart=${() => refused && actions.dismissOperation(refused.id)} />`}
    ${!t.inbox && (current
      ? current.threadId && html`<a class="btn btn-icon btn-primary" href=${threadLink(current)} aria-label="Open in T3 Code" title="Open in T3 Code"><${Icon} name="commentDiscussion" /></a>`
      : html`<${Button} variant=${conflict ? undefined : "primary"} icon="play" disabled=${!!hold} aria-label="Run now" title=${hold ?? (force ? "Run now: any model, every limit overridden" : `Run now: ${overrideText(start.overrideLimits).toLowerCase()} and start this ticket`)}
          onClick=${() => force ? forceStart(t.key) : runNow(row, hold, undefined, start)} />`)}
  <//>`;
  // A run link is ordinary navigation: it leaves the panel's address, which closes the panel without a second history step.
  if (tab === "factory") return html`${bar}${line && html`<p class="ticket-line">${line}</p>`}
    ${runs.length
      ? html`<${RunDetail} id=${runs[0].id} embedded />
        ${runs.length > 1 && html`<h4>Earlier runs</h4>
          <ul class="ticket-runs">${runs.slice(1).map((j) => html`<li key=${j.id}><a href=${`/runs/${j.id}`} onClick=${follow}><${Mark} tone=${toneOf(j.state)} label=${stateLabel(j.state)} /><b>${stateLabel(j.state)}</b><span class="muted">${modelName(c, j)} · <${RelativeTime} at=${j.createdAt} /></span></a></li>`)}</ul>`}`
      : html`<${Empty}>${t.inbox ? "Inbox reports are triaged, not run." : "No runs yet."}<//>`}`;
  // Factory's side of the ticket in full: the run under way, or why it is not starting and what was found in the way.
  const factory = t.inbox ? report && html`<p class="ticket-line">${outcomeText(report)}. ${advice} <${DuplicateLink} of=${verdict === "duplicate" && report.data.duplicateOf} /></p>`
    : current ? html`<p class="ticket-state"><${Tag} state=${current.state} />${current.state === "waiting" ? html`<span>${current.thread?.pending ? PENDING_KINDS[current.thread.pending] ?? current.reason : current.reason}</span>` : html`<span>for <${RelativeTime} at=${current.createdAt} form="for" /></span>`}</p>`
    : hold && (!planned || CLOSED.includes(t.status) || pendingRun(t.key)) ? html`<p class="ticket-line">${hold}</p>`
    : conflict ? html`<div class="ticket-callout">
        <p class="ticket-line"><b>${held || planned ? "Held back" : "Not started"}:</b> ${conflict.reason}</p>
        ${evidenceLines(conflict.evidence).length > 0 && html`<ul>${evidenceLines(conflict.evidence).map(([kind, name]) => html`<li key=${kind + name}><span>${kind}</span> <code>${name}</code></li>`)}</ul>`}
      </div>`
    : planned ? html`<p class="ticket-line">${waits?.length ? `Waits in its ${memberOf ? "Epic" : "chain"} for ${waits.join(", ")}.` : `Waiting in its ${memberOf ? "Epic" : "chain"}${planned.note ? `: ${holdNote(planned.note)}` : " for a slot"}.`}</p>`
    : held ? html`<p class="ticket-line">Held back: ${held.reason}</p>`
    : line && html`<p class="ticket-line">${line}</p>`;
  return html`${bar}<h3 class="ticket-title">${t.title}</h3>
    <${Meta} all class="ticket-meta" project=${project?.name} automationReady=${t.automationReady} priority=${t.priority} difficulty=${t.difficulty || false} labels=${t.labels}><${Tag}>${ticketStatusLabel(t.status)}<//><//>
    <${Facts} items=${[
      [t.inbox ? "Triage" : "Factory", factory || null],
      ["Not ready", t.automationReady ? null : html`<span class="tone-attention">${t.holdReason || t.readiness.join("; ") || "Automation readiness is off"}</span>`],
      ["Waits on", t.blockedBy.length ? html`<${Related} list=${t.blockedBy} />` : null],
      ["Blocks", t.blocks.length ? html`<${Related} list=${t.blocks} />` : null],
      ["Epic", t.epic ? html`<ul class="ticket-related"><li>${memberOf
        ? html`<a href=${epicHref(memberOf.epic?.id ?? memberOf.id)} onClick=${(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); navigate(epicHref(memberOf.epic?.id ?? memberOf.id), false, true); }} title=${t.epic}><span>${t.epic}</span></a>`
        : html`<span class="ticket-related-plain">${t.epic}</span>`}</li></ul>` : null],
      ["Created", html`<${RelativeTime} at=${t.createdAt} />`],
    ]} />
    <h4>Description</h4><${Text}>${t.description}<//>
    <h4>Acceptance</h4><${Text}>${t.acceptanceCriteria}<//>`;
}

// The docked panel's width is the owner's: dragged by its left edge, or stepped with the arrow keys, and kept in this
// browser. A double click returns it to the default. The stylesheet clamps whatever is stored to the window.
// The page as it is, showing an Epic in the panel in place of this ticket.
const epicHref = (id) => { const url = new URL(location.href); url.searchParams.delete("ticket"); url.searchParams.set("epic", id); return url.pathname + url.search; };
const WIDTH = "factoryPanelWidth";
const setWidth = (px) => { const root = document.documentElement.style; if (px) root.setProperty("--panel-width", `${px}px`); else root.removeProperty("--panel-width"); };
const keepWidth = (px) => { setWidth(px); try { if (px) localStorage.setItem(WIDTH, String(px)); else localStorage.removeItem(WIDTH); } catch { /* private window: the width lasts until reload */ } };
if (typeof document !== "undefined") { try { setWidth(Number(localStorage.getItem(WIDTH)) || 0); } catch { /* no stored width */ } }
function PanelGrip() {
  const ref = useRef(), [width, setShown] = useState();
  // The width the stylesheet settled on, which is what gets stored and announced; nothing once the panel has gone.
  const measure = () => { const d = ref.current?.closest("dialog"); return d ? Math.round(d.getBoundingClientRect().width) : 0; };
  const settle = (keep = true) => { const px = measure(); if (!px) return; if (keep) keepWidth(px); setShown(px); };
  const drag = (e) => {
    if (e.button) return;
    e.preventDefault();
    const el = e.currentTarget;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => { moved = true; setWidth(Math.round(innerWidth - ev.clientX)); };
    const end = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", end); el.removeEventListener("pointercancel", end); if (moved) settle(); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  };
  const key = (e) => { const step = { ArrowLeft: 32, ArrowRight: -32 }[e.key]; if (step) { e.preventDefault(); setWidth(measure() + step); settle(); } };
  return html`<div ref=${ref} class="panel-grip" role="separator" tabindex="0" aria-orientation="vertical" aria-valuenow=${width} aria-valuemin="340" aria-valuemax=${Math.max(340, (globalThis.innerWidth ?? 0) - 280)}
    aria-label="Panel width in pixels: drag, or use the arrow keys" title="Drag to resize; double-click to reset"
    onPointerDown=${drag} onKeyDown=${key} onFocus=${() => settle(false)} onDblClick=${() => { setWidth(0); try { localStorage.removeItem(WIDTH); } catch { /* nothing stored */ } settle(false); }}></div>`;
}

// A window with room for two columns docks the panel beside the page, so the list it was opened from stays in use.
// The Duo's inner screen is the case that matters: 951 px, where a panel over the page hides the queue it came from.
const docks = () => !!globalThis.matchMedia?.("(min-width: 820px)").matches;

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
    ${(mine.error.status !== 404 || !key) && html`<${Button} size="sm" icon="sync" label="Retry" onClick=${() => setRetry((value) => value + 1)} />`}
  </div>` : !mine.data && html`<p class="ticket-state" role="status"><i class="spinner"></i> Reading ${noun}</p>`;
  const epic = epicKey ? epicById(epicKey) : undefined;
  // A member ticket opens over its Epic; closing it remounts the Epic with a fresh tracker read.
  const side = docks(), shape = `ticket-panel${side ? " docked" : ""}`;
  if (epicKey) return html`<${Dialog} key="epic" class=${shape} modal=${!side} open onClose=${closeEpic} title="Epic" head=${side && html`<${PanelGrip} />`}>
    ${state}
    ${mine.error?.status !== 404 && (mine.data || epic) && html`<${EpicDetail} epic=${epic} detail=${mine.data} />`}
  <//>`;
  return html`<${Dialog} key="ticket" class=${shape} modal=${!side} open=${!!key} onClose=${closeTicket} title=${key}
    head=${html`${side && html`<${PanelGrip} />`}${mine.data && html`<${Segmented} label="Ticket view" value=${tab} onChange=${setTab} options=${[["ticket", "Ticket"], ["factory", "Runs"]]} />`}`}>
    ${state}
    ${mine.data && html`<${Detail} ticket=${mine.data} tab=${tab} />`}
  <//>`;
}
