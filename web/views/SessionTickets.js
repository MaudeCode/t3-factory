// Tickets that T3 sessions reported creating: start one through the ordinary checks, or take it off the list.
import { html, useState } from "../lib/h.js";
import { config, status, busy, clock, serverNow, actions } from "../lib/store.js";
import { confirmAction } from "../lib/confirmation.js";
import { ago, matchesRunFilters } from "../lib/format.js";
import { Button, Icon, Empty, Page, Section } from "../ui/index.js";
import { TicketRow, RunNow, startHold, Operations } from "./Deck.js";
import { RunFilters } from "./Runs.js";

const HINT = "Tickets that T3 sessions reported creating, confirmed against the tracker. This list is separate from the automatic queue: a ticket here still needs its readiness checks to start, and nothing starts on its own.";

export function SessionTickets() {
  clock.value;
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const c = config.value,
    s = status.value.sessionTickets,
    now = serverNow();
  const rows = (s?.rows ?? []).filter((t) => matchesRunFilters(t, filters, query));
  const narrowed = query.trim() || ["projects", "tags", "difficulties", "priorities"].some((key) => filters[key]?.length);
  const project = (id) => c.projects.find((p) => p.kaneoId === id);
  const dismiss = (t) => confirmAction({ title: `Remove ${t.key} from Session tickets?`, message: "The ticket itself, its runs and automatic scheduling are unchanged. It does not come back when a session reports it again.", label: "Remove" }, () => actions.dismissSessionTicket(t.taskId));
  return html`<${Page} title="Session tickets" hint=${HINT} actions=${html`<${RunFilters} rows=${s?.rows ?? []} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} />`}>
    ${s?.error && html`<p class="alert" role="alert">Collection failed ${ago(s.error.at, now)}: ${s.error.message}. Showing the last known list.</p>`}
    <${Operations} />
    <${Section} title="Reported by sessions" count=${s ? rows.length : null}>
      ${!s
        ? html`<${Empty}>Sessions have not been read yet.<//>`
        : rows.length
          ? rows.map((t) => {
              const ticket = { ...t, id: t.taskId }, hold = startHold(ticket) ?? t.unavailable;
              return html`<${TicketRow} key=${t.taskId} ticket=${ticket} project=${project(t.projectId)}
                actions=${html`${t.sources.map((src) => html`<a key=${src.threadId} class="btn btn-sm btn-icon next-run" href=${`t3-thread://v1/${src.threadId}`} aria-label=${`Open the session that reported ${t.key} in T3 Code`} title=${`Open in T3 Code: ${src.title || "session"}, reported ${ago(src.at, now)}`}><${Icon} name="commentDiscussion" /></a>`)}
                  <${RunNow} ticket=${ticket} hold=${hold} />
                  <${Button} size="sm" icon class="next-run" aria-label=${`Remove ${t.key} from Session tickets`} title="Remove from this list. The ticket is unchanged." disabled=${busy.value} onClick=${() => dismiss(t)}>×<//>`}>
                <span title="The T3 session that reported creating this ticket">from ${t.sources.map((src) => src.title || "a T3 session").join(", ")}</span>
                <span class="muted" title=${t.refreshError ? `Last read failed: ${t.refreshError}` : "When the tracker was last read for this ticket"}>${t.refreshError ? "tracker read failed, " : ""}checked ${ago(t.refreshedAt, now)}</span>
                ${t.unavailable && html`<b class="tone-attention">${t.unavailable}</b>`}
              <//>`;
            })
          : html`<${Empty}>${narrowed ? "No session tickets match." : "No session has reported creating a ticket that is still open."}<//>`}
      ${s?.at && html`<p class="hint">Sessions read ${ago(s.at, now)}.</p>`}
    <//>
  <//>`;
}
