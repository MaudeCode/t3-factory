import { html } from "../lib/h.js";
import { config, status, live, busy, clock, serverNow, actions } from "../lib/store.js";
import { ago, kanvil, projectLink, promotionLimit, triageSummary } from "../lib/format.js";
import { Switch, Field, Input, Slots, Tag, Empty, Link, Section, Page, RowBody } from "../ui/index.js";

const verdictTone = { actionable: "on", "needs-info": "attention", duplicate: "ok", "already-exists": "ok", spam: "label" };
// Tags for the outcomes other than a triage verdict.
const outcomeTag = {
  "triage-failed": ["attention", "failed"], promoted: ["on", "promoted"], "promotion-queued": ["", "queued"],
  "promotion-blocked": ["label", "blocked"], "needs-owner": ["attention", "needs owner"], "promotion-failed": ["attention", "promotion failed"],
};

// One inbox: its target project, trigger label, the queue the scheduler publishes from the live tracker projections,
// and its daily promotion limit, saved with the other settings.
function Queue({ row, now }) {
  const c = config.value, index = c.projects.findIndex((p) => p.kanvilId === row.projectId && p.inbox?.kanvilId === row.inboxId);
  const limit = index >= 0 ? c.projects[index].inbox.maxPromotionsPerDay : row.limit;
  return html`<div class="release" key=${row.inboxId}>
    <span><${RowBody} title=${html`<b>${row.project}</b>`}><${Link} href=${projectLink(c, row.inboxId)}>Inbox<//>, ${row.label} label<//></span>
    <span class="release-state">${row.running ? html`<${Tag} tone="on">triaging<//>` : row.untriaged ? html`<${Tag} tone="attention">${row.untriaged} waiting<//>` : row.synchronized ? html`<${Tag} tone="ok">clear<//>` : html`<${Tag}>not synchronized<//>`}${" "}<${Tag} tone=${limit === 0 ? "attention" : ""}>${promotionLimit(limit)}<//></span>
    <span class="release-versions"><span>${triageSummary(row, now)}</span></span>
    ${index >= 0 && html`<div class="promotion-limit"><${Field} group label="Promotions per day" hint="Paused stops promotion; eligible reports wait and promote oldest first once allowed.">
      <${Slots} label=${`${row.project} promotions per day`} path=${["projects", index, "inbox", "maxPromotionsPerDay"]} max=${3} unit="per day" offLabel="Paused" unlimited="Unlimited" /><//></div>`}
  </div>`;
}

// One finished report from the journal, linked to its inbox ticket.
function Result({ event, now }) {
  const d = event.data, c = config.value;
  const [tone, label] = d.outcome === "triaged" ? [verdictTone[d.verdict] ?? "", d.verdict] : outcomeTag[d.outcome] ?? ["attention", "error"];
  const detail = d.outcome === "triaged" ? (d.duplicateOf ? `duplicate of ${d.duplicateOf}` : "") : d.outcome === "promoted" ? `promoted to ${d.promoted}` : d.reason;
  const tag = html`<${Tag} tone=${tone}>${label}<//>`;
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
  return html`<${Page} title="Triage" hint="Untrusted inbox reports are checked against each project's tickets and code in a read-only sandbox. Actionable reports that pass the promotion checks become ready tickets in the project, written by factory code without the report's text."
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
