// Where new tickets come from: inbox triage, discovery, upstream releases and T3 sessions. One view each, in the address.
import { html } from "../lib/h.js";
import { config, status, jobs, clock, serverNow } from "../lib/store.js";
import { search, navigate, follow } from "../lib/router.js";
import { ago, until, byNewest, stateLabel, toneOf } from "../lib/format.js";
import { Segmented, Tag, Icon, Empty, Page, Section, RowBody } from "../ui/index.js";
import { Triage } from "./Triage.js";
import { Upstream } from "./Upstream.js";

const PATHS = { triage: "/sources", discovery: "/sources?view=discovery", upstream: "/sources?view=upstream", sessions: "/sources?view=sessions" };
export const sourcesView = (query) => {
  const view = new URLSearchParams(query).get("view");
  return ["discovery", "upstream", "sessions"].includes(view) ? view : "triage";
};

// One line per project: when discovery last looked there, and whether it is leaving the project alone for now.
function Discovery({ lead }) {
  const c = config.value, now = serverNow();
  const state = new Map((status.value.discovery || []).map((d) => [d.projectId, d]));
  const runs = jobs.value.filter((j) => j.kind === "discovery").sort(byNewest);
  return html`<${Page} title="Sources" hint="When no tickets are eligible, a free provider investigates one included project for new work and files tickets.">
    ${lead}
    <${Section} class="list">
      ${c.projects.length
        ? c.projects.map((p) => {
            const d = state.get(p.kanvilId), resting = d?.nextAt && Date.parse(d.nextAt) > now, last = runs.find((j) => j.projectId === p.kanvilId);
            const text = !p.enabled ? "Not included in automatic work" : resting ? `Found nothing; resting, looks again ${until(d.nextAt, now)}` : d?.lastAt ? `Last looked ${ago(d.lastAt, now)}` : "Never run";
            return html`<div class="next" key=${p.kanvilId}>
              <span class="next-ticket"><${RowBody} title=${html`<b>${p.name}</b>`}><span class=${p.enabled ? "muted" : "tone-attention"}>${text}</span><//></span>
              ${last && html`<a class="source-run" href=${`/runs/${last.id}`} onClick=${follow} title="Latest discovery run"><${Tag} tone=${toneOf(last.state)}>${stateLabel(last.state)}<//> <span class="muted">${ago(last.createdAt, now)}</span></a>`}
            </div>`;
          })
        : html`<${Empty}>No projects yet.<//>`}
    <//>
  <//>`;
}

// T3 sessions report tickets on their own; the list itself is a view of the Queue.
function Sessions({ lead }) {
  const s = status.value.sessionTickets, now = serverNow(), n = s?.rows?.length ?? 0;
  return html`<${Page} title="Sources" hint="Tickets that T3 sessions reported creating, confirmed against the tracker. Nothing here starts on its own.">
    ${lead}
    <${Section} class="list">
      ${s?.error && html`<p class="hint tone-attention stale-list"><${Icon} name="alert" />${s.error.message}</p>`}
      <div class="next">
        <span class="next-ticket"><${RowBody} title=${html`<b>${n} ${n === 1 ? "ticket" : "tickets"} not started</b>`}><span class="muted">${s?.at ? `Sessions read ${ago(s.at, now)}` : "Sessions have not been read yet"}</span><//></span>
        <a class="btn btn-sm" href="/queue?origin=sessions" onClick=${follow}>Open in Queue</a>
      </div>
    <//>
  <//>`;
}

export function Sources() {
  clock.value;
  const c = config.value, st = status.value;
  // Triage has a view only when a project has an inbox.
  const inboxes = !!c.triage || (st.triageStreams || []).length > 0;
  const requested = sourcesView(search.value), view = requested === "triage" && !inboxes ? "discovery" : requested;
  const owed = (st.triageReports || []).filter((event) => event.data.stage === "owner").length;
  const due = (st.upstreams || []).filter((r) => r.pending).length;
  const tabs = html`<${Segmented} label="Source" value=${view} onChange=${(v) => navigate(PATHS[v])}
    options=${[...(inboxes ? [["triage", "Inbox triage", owed]] : []), ["discovery", "Discovery"], ["upstream", "Upstream releases", due], ["sessions", "T3 sessions", st.sessionTickets?.rows?.length ?? 0]]} />`;
  return view === "triage" ? html`<${Triage} lead=${tabs} />`
    : view === "upstream" ? html`<${Upstream} lead=${tabs} />`
    : view === "sessions" ? html`<${Sessions} lead=${tabs} />`
    : html`<${Discovery} lead=${tabs} />`;
}
