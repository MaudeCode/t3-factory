import { html, useEffect, useState } from "../lib/h.js";
import { config, status, live, busy, clock, serverNow, actions, launchOperations, TRIAGE_ORIGIN as ORIGIN } from "../lib/store.js";
import { confirmAction } from "../lib/confirmation.js";
import { ago, byNewest, kanvil, matchesRunFilters, operationText, overrideText, projectLink, promotionLimit, ticketKey, triageSummary } from "../lib/format.js";
import { Button, Field, Input, Slots, Check, Tag, Icon, Empty, Link, Section, Page, Switch } from "../ui/index.js";
import { TicketRow, RunNow, runNow, startHold, openRun, StartOptions, startOptions, OrderChoice } from "./Deck.js";
import { RunFilters } from "./Runs.js";
import { follow, ticketClick } from "../lib/router.js";

const HINT = "Untrusted inbox reports are checked against each project's tickets and code in a read-only sandbox. Actionable reports that pass the promotion checks become ready tickets in the project, written by factory code without the report's text. Every open report is listed once by what it waits on: under Needs you until you send it through triage again or close it, and under In progress while triage or promotion will act on it.";
const verdictTone = { actionable: "on", "needs-info": "attention", duplicate: "ok", "already-exists": "ok", spam: "label" };
// Tags for the outcomes other than a triage verdict.
const outcomeTag = {
  "triage-failed": ["attention", "failed"], promoted: ["on", "promoted"], "promotion-queued": ["", "queued"],
  "promotion-blocked": ["label", "blocked"], "needs-owner": ["attention", "needs owner"], "promotion-failed": ["attention", "promotion failed"],
  closed: ["label", "closed"], waiting: ["", "waiting"], triaging: ["on", "triaging"], "awaiting-promotion": ["", "to promote"], held: ["attention", "on hold"],
};
// A verdict in the owner's words; the journal's own wording covers the rest.
const verdictTitle = { "needs-info": () => "Needs more information", duplicate: (d) => (d.duplicateOf ? `Duplicate of ${d.duplicateOf}` : "Duplicate"), "already-exists": () => "Already in the code" };
// The outcomes a second triage can change. The others repeat until the owner acts in the tracker.
const RETRY = ["triaged", "triage-failed", "promotion-blocked"];

// One inbox's queue on one line: its project, label, state and daily limit.
function InboxLine({ row, now, owed }) {
  const c = config.value, p = c.projects.find((p) => p.kanvilId === row.projectId && p.inbox?.kanvilId === row.inboxId);
  const limit = p ? p.inbox.maxPromotionsPerDay : row.limit;
  return html`<div class="triage-inbox">
    <b>${row.project}</b>
    ${row.running ? html`<${Tag} tone="on">triaging<//>` : row.untriaged ? html`<${Tag} tone="attention">${row.untriaged} waiting<//>` : row.synchronized ? html`<${Tag} tone="ok">clear<//>` : html`<${Tag}>not synchronized<//>`}
    ${owed > 0 && html`<${Tag} tone="attention">${owed} ${owed === 1 ? "needs" : "need"} you<//>`}
    <${Tag} tone=${limit === 0 ? "attention" : ""}>${promotionLimit(limit)}<//>
    <span class="muted">${triageSummary(row, now)}</span>
  </div>`;
}

// Triage's settings, for the Settings area: each inbox's daily promotion limit and the prompt file.
export function TriageSettings() {
  const c = config.value, rows = status.value.triageStreams || [];
  return html`${rows.map((row) => {
      const index = c.projects.findIndex((p) => p.kanvilId === row.projectId && p.inbox?.kanvilId === row.inboxId);
      return html`<div class="triage-inbox-settings" key=${row.inboxId}>
        <h3>${row.project} <span class="muted"><${Link} href=${projectLink(c, row.inboxId)}>Inbox<//>, ${row.label} label</span></h3>
        ${index >= 0 && html`<${Field} group label="Promotions per day" hint="Paused stops promotion; eligible reports wait and promote oldest first once allowed.">
          <${Slots} label=${`${row.project} promotions per day`} path=${["projects", index, "inbox", "maxPromotionsPerDay"]} picks=${[5, 10, 20, 40]} unit="per day" offLabel="Paused" unlimited="Unlimited" /><//>`}
      </div>`;
    })}
    <${Field} label="Prompt file on your Mac" hint="Read for each triage run. The project name, scopes, ticket key and report are filled in."><${Input} mono path=${["triage", "promptFile"]} /><//>`;
}

// The report's own title is untrusted, so a report row is titled with its journal outcome instead.
const outcomeText = (event) => {
  const verdict = event.data.outcome === "triaged" && verdictTitle[event.data.verdict];
  if (verdict) return verdict(event.data);
  const key = event.data.ticket, raw = event.text.startsWith(`${key} `) ? event.text.slice(key.length + 1) : event.text;
  return raw[0].toUpperCase() + raw.slice(1);
};

// The owner's two decisions on an open report, as a row's action props. Closing cancels the tracker ticket, so it asks
// first. With both on offer, Close is the secondary action, which folds into the row menu on a phone.
export function decide(row) {
  const d = row.event.data, key = d.ticket;
  const ask = () => confirmAction({ title: `Close ${key}?`, message: `${key} is cancelled in its inbox and leaves this page. Nothing is created from it.`, label: "Close report" }, () => actions.triageReport(d.ticketId, key, "close"));
  const close = html`<${Button} size="sm" icon class="next-run" aria-label=${`Close ${key}`} title="Close the report" disabled=${busy.value} onClick=${ask}><${Icon} name="x" /><span class="next-action-label">Close report</span><//>`;
  if (!RETRY.includes(d.outcome)) return { actions: close };
  return { secondaryActions: close, actions: html`<${Button} size="sm" icon class="next-run" aria-label=${`Triage ${key} again`} title="Triage again: clears this result so the next pass reads the report afresh" disabled=${busy.value} onClick=${() => actions.triageReport(d.ticketId, key, "retry")}><${Icon} name="sync" /><//>` };
}

// A report as a row's data. It keeps the project its journal entry recorded; older entries use the inbox's current project.
export const reportRow = (event, id, c = config.value) => ({ id, event, key: event.data.ticket, title: outcomeText(event), projectId: event.data.projectId ?? c.projects.find((p) => p.inbox?.kanvilId === event.data.inboxId)?.kanvilId, createdAt: event.time });

// A report as a list row: the promoted ticket, which can be started, or the report with its outcome.
function Result({ row, now, selection, start, progress, decision }) {
  const c = config.value, d = row.event.data;
  const [tone, label] = d.outcome === "triaged" ? [verdictTone[d.verdict] ?? "", d.verdict] : outcomeTag[d.outcome] ?? ["attention", "error"];
  const tag = html`<${Tag} tone=${tone}>${label}<//>`;
  const report = kanvil(c, "projects", d.inboxId, "tickets", d.ticketId), when = html`<span class="muted" title=${new Date(row.event.time).toLocaleString()}>${ago(row.event.time, now)}</span>`;
  if (row.promoted) {
    const hold = startHold(row) ?? row.unavailable;
    // Labels stay searchable and filterable but are not listed; the tag, priority and difficulty say enough.
    return html`<${TicketRow} ticket=${{ ...row, labels: [] }} project=${row.project} badge=${tag} selection=${selection}
      actions=${html`<${RunNow} ticket=${row} hold=${hold} origin=${ORIGIN} ...${start} />`}
      secondaryActions=${html`<a class="btn btn-sm btn-icon next-run" href=${report} target="_blank" rel="noopener noreferrer" onClick=${ticketClick(ticketKey(d.ticket))} aria-label=${`Open the report ${d.ticket}`} title=${`Open the report ${d.ticket}`}><${Icon} name="arrowRight" /><span class="next-action-label">Open report</span></a>`}>
      ${progress && html`<span class="row-progress" role="status"><i class="spinner"></i>${operationText(progress)}</span>`}
      <span>from ${d.ticket}</span>${when}
    <//>`;
  }
  // A promoted result the scheduler could not read back links its tag to the promoted ticket.
  const promoted = d.promoted && row.projectId && kanvil(c, "projects", row.projectId, "tickets", d.promotedId ?? d.promoted);
  const badge = promoted ? html`<${Tag} tone=${tone} href=${promoted} onClick=${ticketClick(ticketKey(d.promoted))} title=${`Open ${d.promoted}`}>${label}<//>` : tag;
  return html`<${TicketRow} ticket=${{ id: d.ticketId, projectId: d.inboxId, key: d.ticket, title: row.title }} project=${{ name: d.project }} badge=${badge} selection=${selection} ...${decision} plain>${when}<//>`;
}

// Promoted tickets the scheduler still lists, each with the journal entry that created it.
const promotedTickets = (c) => [...new Map((status.value.triageResults || []).filter((event) => event.promotedTicket?.listed).map((event) => {
  const t = event.promotedTicket;
  return [t.taskId, { ...t, id: t.taskId, promoted: true, project: c.projects.find((p) => p.kanvilId === t.projectId), event, createdAt: event.time }];
})).values()];
const pendingFor = (t) => launchOperations.value.find((op) => ["queued", "running"].includes(op.state) && ticketKey(op.input.ticket) === ticketKey(t.key));
const narrowedBy = (filters, query) => query.trim() || Object.values(filters).some((value) => Array.isArray(value) && value.length);

// Tickets promoted from inbox reports that have not started: the Queue page's Reports view. Each stays until a run
// launches or it leaves the ready statuses. `lead` is the Queue's view switch.
export function ReadyReports({ lead }) {
  clock.value;
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("newest");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState([]);
  const now = serverNow(), start = startOptions(), tickets = promotedTickets(config.value);
  const starting = (row) => !!pendingFor(row) || openRun(row);
  const rows = tickets.filter((row) => matchesRunFilters(row, filters, query)).toSorted((a, b) => starting(b) - starting(a) || (order === "oldest" ? byNewest(b, a) : byNewest(a, b)));
  const visibleIds = JSON.stringify(rows.map((r) => r.id).toSorted());
  useEffect(() => {
    const visible = new Set(JSON.parse(visibleIds));
    setSelected((previous) => previous.every((id) => visible.has(id)) ? previous : previous.filter((id) => visible.has(id)));
  }, [visibleIds]);
  const picked = rows.filter((r) => selected.includes(r.id));
  const held = picked.map((r) => startHold(r) ?? r.unavailable).find(Boolean);
  return html`<${Page} class="queue" title="Queue" count=${rows.length}
    actions=${html`<${StartOptions} /><${OrderChoice} label="Promotion order" value=${order} onChange=${setOrder} />`} tools=${html`<${RunFilters} rows=${tickets} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} /><${Button} size="sm" icon=${selecting ? "check" : "checklist"} label=${selecting ? "Done selecting tickets" : "Select tickets"} aria-pressed=${selecting} disabled=${busy.value} onClick=${() => { setSelecting(!selecting); setSelected([]); }} />`}>
    ${lead}
    <${Section} class="list">
      ${selecting && !!rows.length && html`<div class="selection-bar">
        <${Check} label="Select visible" aria-label="Select visible promoted tickets" checked=${picked.length === rows.length} indeterminate=${picked.length > 0 && picked.length < rows.length} disabled=${busy.value} onChange=${() => setSelected(picked.length === rows.length ? [] : rows.map((r) => r.id))} />
        <span class="muted">${picked.length} selected</span>
        <${Button} size="sm" icon="play" label="Run selected tickets" disabled=${!picked.length || !!held} title=${held ?? `${overrideText(start.overrideLimits)} and start selected tickets.`} onClick=${() => { for (const r of picked) runNow(r, r.unavailable, ORIGIN, start); setSelected([]); }} />
      </div>`}
      ${rows.length
        ? rows.map((row) => html`<${Result} key=${row.id} row=${row} now=${now} start=${start} progress=${pendingFor(row)}
            selection=${selecting && html`<${Check} aria-label=${`Select ${row.key}`} checked=${selected.includes(row.id)} disabled=${busy.value} onChange=${(e) => setSelected((previous) => e.target.checked ? [...previous, row.id] : previous.filter((id) => id !== row.id))} />`} />`)
        : html`<${Empty}>${narrowedBy(filters, query) ? "No tickets match." : "No promoted tickets waiting to start."}<//>`}
    <//>
  <//>`;
}
export const readyReportCount = () => promotedTickets(config.value).length;

// The Sources page's Inbox triage view; `lead` is its view switch.
export function Triage({ lead } = {}) {
  clock.value;
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("newest");
  const now = serverNow(), c = config.value;
  const streams = status.value.triageStreams || [], results = status.value.triageResults || [];
  // Each open report is listed once from the inbox's live state, so newer results never push it out. Needs you: the
  // reports no later pass acts on. In progress: the ones triage or promotion still will.
  // History: the recent results as their reports, titled with their outcome. Promoted tickets waiting to start are
  // on the Queue page.
  const report = (event, id) => reportRow(event, id, c);
  const open = (status.value.triageReports || []).map((event) => ({ ...report(event, `open-${event.data.ticketId}`), stage: event.data.stage }));
  const attention = open.filter((row) => row.stage === "owner"), working = open.filter((row) => row.stage === "working");
  const triagingNow = (row) => row.event.data.outcome === "triaging";
  const activity = results.map((event) => report(event, `report-${event.id}`));
  const shown = (list) => list.filter((row) => matchesRunFilters(row, filters, query)).toSorted((a, b) => order === "oldest" ? byNewest(b, a) : byNewest(a, b));
  const history = shown(activity), owed = shown(attention), moving = shown(working).toSorted((a, b) => triagingNow(b) - triagingNow(a));
  if (!c.triage && !streams.length)
    return html`<${Page} narrow title="Sources">
      ${lead}
      <${Empty}>No inboxes. Add <code>inbox</code> and <code>scopes</code> to a project and a <code>triage</code> section to the config file to turn triage on.<//>
    <//>`;
  const narrowed = narrowedBy(filters, query);
  const waiting = streams.some((row) => row.untriaged), triaging = streams.some((row) => row.running);
  return html`<${Page} title="Sources" hint=${HINT}
    actions=${html`${c.triage && html`<label class="automation"><${Switch} label="Inbox triage" checked=${live.value.triage} disabled=${busy.value} onChange=${() => actions.toggle("triage")} /><b>${live.value.triage ? "Triage on" : "Triage paused"}</b></label>`}<${OrderChoice} label="Result order" value=${order} onChange=${setOrder} />`} tools=${html`<${RunFilters} rows=${[...open, ...activity]} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} />`}>
    ${lead}
    <${Section} title="Inboxes" class="triage-inboxes" aside=${html`<${Button} size="sm" icon="play" label="Triage waiting reports now" title=${triaging ? "Triage is running" : waiting ? "Triage waiting reports now, once past the pause and the quota reserve" : "No reports are waiting"} disabled=${busy.value || !waiting || triaging} onClick=${actions.triageNow} /><a class="btn btn-sm btn-icon" href="/settings/sources" onClick=${follow} aria-label="Triage settings" title="Triage settings"><${Icon} name="gear" /></a>`}>
      ${c.triage && !live.value.triage && html`<p class="hint tone-attention"><${Icon} name="alert" /> Triage is paused. New reports wait until it is turned on.</p>`}
      ${streams.length ? streams.map((row) => html`<${InboxLine} key=${row.inboxId} row=${row} now=${now} owed=${attention.filter((r) => r.event.data.inboxId === row.inboxId).length} />`) : html`<p class="muted">No project has an inbox.</p>`}
    <//>
    <${Section} title="Needs you" count=${owed.length || null}>
      ${owed.length
        ? owed.map((row) => html`<${Result} key=${row.id} row=${row} now=${now} decision=${decide(row)} />`)
        : html`<${Empty}>${narrowed ? "No reports match." : "No open report needs you."}<//>`}
    <//>
    ${moving.length > 0 && html`<${Section} title="In progress" count=${moving.length}>
      ${moving.map((row) => html`<${Result} key=${row.id} row=${row} now=${now} />`)}
    <//>`}
    <${Section} title="History" count=${history.length || null}>
      ${history.length
        ? history.map((row) => html`<${Result} key=${row.id} row=${row} now=${now} />`)
        : html`<${Empty}>${narrowed ? "No results match." : "No reports triaged yet."}<//>`}
    <//>
  <//>`;
}
