import { html, useEffect, useState } from "../lib/h.js";
import { config, status, live, busy, clock, serverNow, actions, launchOperations, TRIAGE_ORIGIN as ORIGIN } from "../lib/store.js";
import { ago, byNewest, kanvil, matchesRunFilters, operationText, overrideText, projectLink, promotionLimit, ticketKey, triageSummary } from "../lib/format.js";
import { Button, Toggle, Field, Input, Slots, Check, Tag, Icon, Empty, Link, Section, Page, Dialog } from "../ui/index.js";
import { TicketRow, RunNow, runNow, startHold, openRun, StartOptions, startOptions, OrderChoice } from "./Deck.js";
import { RunFilters } from "./Runs.js";

const HINT = "Untrusted inbox reports are checked against each project's tickets and code in a read-only sandbox. Actionable reports that pass the promotion checks become ready tickets in the project, written by factory code without the report's text.";
const verdictTone = { actionable: "on", "needs-info": "attention", duplicate: "ok", "already-exists": "ok", spam: "label" };
// Tags for the outcomes other than a triage verdict.
const outcomeTag = {
  "triage-failed": ["attention", "failed"], promoted: ["on", "promoted"], "promotion-queued": ["", "queued"],
  "promotion-blocked": ["label", "blocked"], "needs-owner": ["attention", "needs owner"], "promotion-failed": ["attention", "promotion failed"],
};

// One inbox's queue on one line: its project, label, state and daily limit.
function InboxLine({ row, now }) {
  const c = config.value, p = c.projects.find((p) => p.kanvilId === row.projectId && p.inbox?.kanvilId === row.inboxId);
  const limit = p ? p.inbox.maxPromotionsPerDay : row.limit;
  return html`<div class="triage-inbox">
    <b>${row.project}</b>
    ${row.running ? html`<${Tag} tone="on">triaging<//>` : row.untriaged ? html`<${Tag} tone="attention">${row.untriaged} waiting<//>` : row.synchronized ? html`<${Tag} tone="ok">clear<//>` : html`<${Tag}>not synchronized<//>`}
    <${Tag} tone=${limit === 0 ? "attention" : ""}>${promotionLimit(limit)}<//>
    <span class="muted">${triageSummary(row, now)}</span>
  </div>`;
}

// The settings behind the cog: the triage switch, each inbox's daily promotion limit, and the prompt file.
function Settings({ open, onClose, rows }) {
  const c = config.value;
  return html`<${Dialog} open=${open} onClose=${onClose} title="Triage settings">
    ${c.triage && html`<${Toggle} label="Inbox triage" hint="Paused leaves new reports waiting; promotion and the results below are unchanged." checked=${live.value.triage} disabled=${busy.value} onChange=${() => actions.toggle("triage")} />`}
    ${rows.map((row) => {
      const index = c.projects.findIndex((p) => p.kanvilId === row.projectId && p.inbox?.kanvilId === row.inboxId);
      return html`<div class="triage-inbox-settings" key=${row.inboxId}>
        <h3>${row.project} <span class="muted"><${Link} href=${projectLink(c, row.inboxId)}>Inbox<//>, ${row.label} label</span></h3>
        ${index >= 0 && html`<${Field} group label="Promotions per day" hint="Paused stops promotion; eligible reports wait and promote oldest first once allowed.">
          <${Slots} label=${`${row.project} promotions per day`} path=${["projects", index, "inbox", "maxPromotionsPerDay"]} picks=${[5, 10, 20, 40]} unit="per day" offLabel="Paused" unlimited="Unlimited" /><//>`}
      </div>`;
    })}
    <${Field} label="Prompt file on your Mac" hint="Read for each triage run. The project name, scopes, ticket key and report are filled in."><${Input} mono path=${["triage", "promptFile"]} /><//>
  <//>`;
}

// The report's own title is untrusted, so a report row is titled with its journal outcome instead.
const outcomeText = (event) => {
  const key = event.data.ticket, raw = event.text.startsWith(`${key} `) ? event.text.slice(key.length + 1) : event.text;
  return raw[0].toUpperCase() + raw.slice(1);
};

// A finished report as a list row: the promoted ticket, which can be started, or the report with its outcome.
function Result({ row, now, selection, start, progress }) {
  const c = config.value, d = row.event.data;
  const [tone, label] = d.outcome === "triaged" ? [verdictTone[d.verdict] ?? "", d.verdict] : outcomeTag[d.outcome] ?? ["attention", "error"];
  const tag = html`<${Tag} tone=${tone}>${label}<//>`;
  const report = kanvil(c, "projects", d.inboxId, "tickets", d.ticketId), when = html`<span class="muted" title=${new Date(row.event.time).toLocaleString()}>${ago(row.event.time, now)}</span>`;
  if (row.promoted) {
    const hold = startHold(row) ?? row.unavailable;
    // Labels stay searchable and filterable but are not listed; the tag, priority and difficulty say enough.
    return html`<${TicketRow} ticket=${{ ...row, labels: [] }} project=${row.project} badge=${tag} selection=${selection}
      actions=${html`<${RunNow} ticket=${row} hold=${hold} origin=${ORIGIN} ...${start} />`}
      secondaryActions=${html`<a class="btn btn-sm btn-icon next-run" href=${report} target="_blank" rel="noopener noreferrer" aria-label=${`Open the report ${d.ticket}`} title=${`Open the report ${d.ticket}`}><${Icon} name="arrowRight" /><span class="next-action-label">Open report</span></a>`}>
      ${progress && html`<span class="row-progress" role="status"><i class="spinner"></i>${operationText(progress)}</span>`}
      <span>from ${d.ticket}</span>${when}
    <//>`;
  }
  // A promoted result the scheduler could not read back links its tag to the promoted key in the inbox's project.
  const promoted = d.promoted && row.projectId && kanvil(c, "projects", row.projectId, "tickets", d.promotedId ?? d.promoted);
  const badge = promoted ? html`<${Tag} tone=${tone} href=${promoted} title=${`Open ${d.promoted} in Kanvil`}>${label}<//>` : tag;
  return html`<${TicketRow} ticket=${{ id: d.ticketId, projectId: d.inboxId, key: d.ticket, title: row.title }} project=${{ name: d.project }} badge=${badge} selection=${selection} plain>${when}<//>`;
}

export function Triage() {
  clock.value;
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("newest");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState([]);
  const [settings, setSettings] = useState(false);
  const now = serverNow(), c = config.value;
  const streams = status.value.triageStreams || [], results = status.value.triageResults || [];
  const start = startOptions();
  const requests = launchOperations.value;
  const progress = (t) => requests.find((op) => ["queued", "running"].includes(op.state) && ticketKey(op.input.ticket) === ticketKey(t.key));
  // Tickets: each promoted ticket the scheduler still lists, until a run launches or it leaves the ready statuses.
  // Activity: every result as its report, titled with its outcome. A report row keeps the project its journal entry
  // recorded; older entries use the inbox's current project.
  const inboxProject = (id) => c.projects.find((p) => p.inbox?.kanvilId === id);
  const tickets = [...new Map(results.filter((event) => event.promotedTicket?.listed).map((event) => {
    const t = event.promotedTicket;
    return [t.taskId, { ...t, id: t.taskId, promoted: true, project: c.projects.find((p) => p.kanvilId === t.projectId), event, createdAt: event.time }];
  })).values()];
  const activity = results.map((event) => ({ id: `report-${event.id}`, event, key: event.data.ticket, title: outcomeText(event), projectId: event.data.projectId ?? inboxProject(event.data.inboxId)?.kanvilId, createdAt: event.time }));
  const starting = (row) => row.promoted && (!!progress(row) || openRun(row));
  const shown = (list) => list.filter((row) => matchesRunFilters(row, filters, query)).toSorted((a, b) => starting(b) - starting(a) || (order === "oldest" ? byNewest(b, a) : byNewest(a, b)));
  const rows = shown(tickets), history = shown(activity);
  const visibleIds = JSON.stringify(rows.map((r) => r.id).toSorted());
  useEffect(() => {
    const visible = new Set(JSON.parse(visibleIds));
    setSelected((previous) => previous.every((id) => visible.has(id)) ? previous : previous.filter((id) => visible.has(id)));
  }, [visibleIds]);
  if (!c.triage && !streams.length)
    return html`<${Page} narrow title="Triage">
      <${Empty}>No inboxes. Add <code>inbox</code> and <code>scopes</code> to a project and a <code>triage</code> section to the config file to turn triage on.<//>
    <//>`;
  const startable = rows, picked = startable.filter((r) => selected.includes(r.id));
  const held = picked.map((r) => startHold(r) ?? r.unavailable).find(Boolean);
  const narrowed = query.trim() || Object.values(filters).some((value) => Array.isArray(value) && value.length);
  return html`<${Page} title="Triage" hint=${HINT}
    actions=${html`<${StartOptions} /><${OrderChoice} label="Result order" value=${order} onChange=${setOrder} />`} tools=${html`<${RunFilters} rows=${[...tickets, ...activity]} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} /><${Button} size="sm" icon=${selecting ? "check" : "checklist"} label=${selecting ? "Done selecting tickets" : "Select tickets"} aria-pressed=${selecting} disabled=${busy.value} onClick=${() => { setSelecting(!selecting); setSelected([]); }} />`}>
    <${Section} title="Inboxes" class="triage-inboxes" aside=${html`<${Button} size="sm" icon="gear" label="Triage settings" onClick=${() => setSettings(true)} />`}>
      ${c.triage && !live.value.triage && html`<p class="hint tone-attention"><${Icon} name="alert" /> Triage is paused. New reports wait until it is turned on in settings.</p>`}
      ${streams.length ? streams.map((row) => html`<${InboxLine} key=${row.inboxId} row=${row} now=${now} />`) : html`<p class="muted">No project has an inbox.</p>`}
    <//>
    <${Section} title="Tickets" count=${rows.length || null}>
      ${selecting && !!startable.length && html`<div class="selection-bar">
        <${Check} label="Select visible" aria-label="Select visible promoted tickets" checked=${picked.length === startable.length} indeterminate=${picked.length > 0 && picked.length < startable.length} disabled=${busy.value} onChange=${() => setSelected(picked.length === startable.length ? [] : startable.map((r) => r.id))} />
        <span class="muted">${picked.length} selected</span>
        <${Button} size="sm" icon="play" label="Run selected tickets" disabled=${!picked.length || !!held} title=${held ?? `${overrideText(start.overrideLimits)} and start selected tickets.`} onClick=${() => { for (const r of picked) runNow(r, r.unavailable, ORIGIN, start); setSelected([]); }} />
      </div>`}
      ${rows.length
        ? rows.map((row) => html`<${Result} key=${row.id} row=${row} now=${now} start=${start} progress=${progress(row)}
            selection=${selecting && html`<${Check} aria-label=${`Select ${row.key}`} checked=${selected.includes(row.id)} disabled=${busy.value} onChange=${(e) => setSelected((previous) => e.target.checked ? [...previous, row.id] : previous.filter((id) => id !== row.id))} />`} />`)
        : html`<${Empty}>${narrowed ? "No tickets match." : "No promoted tickets waiting to start."}<//>`}
    <//>
    <${Section} title="Activity" count=${history.length || null}>
      ${history.length
        ? history.map((row) => html`<${Result} key=${row.id} row=${row} now=${now} />`)
        : html`<${Empty}>${narrowed ? "No activity matches." : "No reports triaged yet."}<//>`}
    <//>
    <${Settings} open=${settings} onClose=${() => setSettings(false)} rows=${streams} />
  <//>`;
}
