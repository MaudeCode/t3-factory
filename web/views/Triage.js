import { html } from "../lib/h.js";
import { config, status, live, busy, clock, serverNow, actions } from "../lib/store.js";
import { ago, kanvil, projectLink, triageSummary } from "../lib/format.js";
import { Switch, Field, Input, Tag, Empty, Link, Section, Page, RowBody } from "../ui/index.js";

const verdictTone = { actionable: "on", "needs-info": "attention", duplicate: "ok", "already-exists": "ok", spam: "label" };

// One inbox: its target project, trigger label, and the queue the scheduler publishes from the live tracker projections.
function Queue({ row, now }) {
  const c = config.value;
  return html`<div class="release" key=${row.inboxId}>
    <span><${RowBody} title=${html`<b>${row.project}</b>`}><${Link} href=${projectLink(c, row.inboxId)}>Inbox<//>, ${row.label} label<//></span>
    <span class="release-state">${row.running ? html`<${Tag} tone="on">triaging<//>` : row.untriaged ? html`<${Tag} tone="attention">${row.untriaged} waiting<//>` : row.synchronized ? html`<${Tag} tone="ok">clear<//>` : html`<${Tag}>not synchronized<//>`}</span>
    <span class="release-versions"><span>${triageSummary(row, now)}</span></span>
  </div>`;
}

// One finished report from the journal, linked to its inbox ticket.
function Result({ event, now }) {
  const d = event.data, c = config.value;
  const tag = d.outcome === "triaged" ? html`<${Tag} tone=${verdictTone[d.verdict] ?? ""}>${d.verdict}<//>` : html`<${Tag} tone="attention">${d.outcome === "triage-failed" ? "failed" : "error"}<//>`;
  const detail = d.outcome === "triaged" ? (d.duplicateOf ? `duplicate of ${d.duplicateOf}` : "") : d.reason;
  return html`<div class="release" key=${event.id}>
    <span><${RowBody} title=${html`<${Link} href=${kanvil(c, "projects", d.inboxId, "tickets", d.ticketId)} class="mono">${d.ticket}<//>`}>${d.project}${detail ? `, ${detail}` : ""}<//></span>
    <span class="release-state">${tag}</span>
    <span class="release-versions"><span class="muted">${ago(event.time, now)}</span></span>
  </div>`;
}

export function Triage() {
  clock.value;
  const now = serverNow(), c = config.value;
  const rows = status.value.triageStreams || [], results = status.value.triageResults || [];
  if (!c.triage && !rows.length)
    return html`<${Page} narrow title="Triage">
      <${Empty}>No inboxes. Add <code>inbox</code> and <code>scopes</code> to a project and a <code>triage</code> section to the config file to turn triage on.<//>
    <//>`;
  return html`<${Page} title="Triage" hint="Untrusted inbox reports are checked against each project's tickets and code in a read-only sandbox. Only validated fields are written, and only to the inbox ticket."
    actions=${c.triage && html`<label class="automation"><${Switch} label="Inbox triage" checked=${live.value.triage} disabled=${busy.value} onChange=${() => actions.toggle("triage")} /><b>${live.value.triage ? "Triage on" : "Triage paused"}</b></label>`}>
    <div class="cols">
      <div>
        <${Section} title="Inboxes">
          ${rows.length ? rows.map((row) => html`<${Queue} row=${row} now=${now} />`) : html`<${Empty}>No project has an inbox.<//>`}
        <//>
        <${Section} title="Recent results" count=${results.length || null}>
          ${results.length ? results.map((event) => html`<${Result} event=${event} now=${now} />`) : html`<${Empty}>No reports triaged yet.<//>`}
        <//>
      </div>
      <div>
        <${Section} title="Settings">
          <${Field} label="Prompt file on your Mac" hint="Read for each triage run. The project name, scopes, ticket key and report are filled in."><${Input} mono path=${["triage", "promptFile"]} /><//>
        <//>
      </div>
    </div>
  <//>`;
}
