// Tickets that T3 sessions reported creating: start one through the ordinary checks, or take it off the list.
import { html, useEffect, useState } from "../lib/h.js";
import { config, status, busy, clock, serverNow, actions } from "../lib/store.js";
import { confirmAction } from "../lib/confirmation.js";
import { ago, byNewest, matchesRunFilters, threadLink } from "../lib/format.js";
import { Button, Check, Select, Icon, Empty, Page, Section } from "../ui/index.js";
import { TicketRow, RunNow, runNow, startHold, Operations } from "./Deck.js";
import { RunFilters } from "./Runs.js";

const HINT = "Tickets that T3 sessions reported creating, confirmed against the tracker. Factory discovery and upstream release-review sessions are excluded. A ticket here still needs its readiness checks to start, and nothing starts on its own.";

export function SessionTickets() {
  clock.value;
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("newest");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState([]);
  const c = config.value,
    s = status.value.sessionTickets,
    now = serverNow();
  const rows = (s?.rows ?? []).filter((t) => matchesRunFilters(t, filters, query)).toSorted((a, b) => order === "oldest" ? byNewest(b, a) : byNewest(a, b));
  const visibleIds = JSON.stringify(rows.map(t => t.taskId).toSorted());
  useEffect(() => {
    const visible = new Set(JSON.parse(visibleIds));
    setSelected(previous => previous.every(id => visible.has(id)) ? previous : previous.filter(id => visible.has(id)));
  }, [visibleIds]);
  const picked = rows.filter(t => selected.includes(t.taskId));
  const held = picked.map(t => startHold({ ...t, id: t.taskId }) ?? t.unavailable).find(Boolean);
  const narrowed = query.trim() || Object.values(filters).some(value => Array.isArray(value) && value.length);
  const project = (id) => c.projects.find((p) => p.kaneoId === id);
  const dismiss = (tickets) => {
    const ids = tickets.map(t => t.taskId), keys = tickets.map(t => t.key).join(", ");
    confirmAction({ title: `Remove ${tickets.length === 1 ? keys : `${tickets.length} tickets`} from Session tickets?`, message: `${keys}. Kaneo tickets, their runs and automatic scheduling are unchanged. Removed entries do not come back when a session reports them again.`, label: "Remove" }, () => actions.dismissSessionTicket(ids));
  };
  return html`<${Page} title="Session tickets" hint=${HINT} actions=${html`<${Select} size="sm" class="creation-order" label="Creation order" value=${order} options=${[["newest", "Newest first"], ["oldest", "Oldest first"]]} onChange=${setOrder} /><${RunFilters} rows=${s?.rows ?? []} filters=${filters} query=${query} onFilters=${setFilters} onQuery=${setQuery} sessions /><${Button} size="sm" icon=${selecting ? "check" : "checklist"} label=${selecting ? "Done selecting tickets" : "Select tickets"} aria-pressed=${selecting} disabled=${busy.value} onClick=${() => { setSelecting(!selecting); setSelected([]); }} />`}>
    ${s?.error && html`<p class="alert" role="alert">Collection failed ${ago(s.error.at, now)}: ${s.error.message}. Showing the last known list.</p>`}
    <${Operations} />
    <${Section} title="Reported by sessions" count=${s ? rows.length : null}>
      ${selecting && !!rows.length && html`<div class="selection-bar">
        <${Check} label="Select visible" aria-label="Select visible tickets" checked=${picked.length === rows.length} indeterminate=${picked.length > 0 && picked.length < rows.length} disabled=${busy.value} onChange=${() => setSelected(picked.length === rows.length ? [] : rows.map(t => t.taskId))} />
        <span class="muted">${picked.length} selected</span>
        <${Button} size="sm" icon="play" label="Run selected tickets" disabled=${!picked.length || !!held} title=${held ?? "Run selected tickets through the ordinary checks, overriding limits."} onClick=${() => { for (const t of picked) runNow({ ...t, id: t.taskId }, t.unavailable); setSelected([]); }} />
        <${Button} size="sm" icon="x" label="Remove selected tickets" disabled=${!picked.length || busy.value} onClick=${() => dismiss(picked)} />
      </div>`}
      ${!s
        ? html`<${Empty}>Sessions have not been read yet.<//>`
        : rows.length
          ? rows.map((t) => {
              // One session action per row, for the latest report; the facet line names every session.
              const ticket = { ...t, id: t.taskId }, hold = startHold(ticket) ?? t.unavailable, latest = t.sources.reduce((a, b) => (b.at > a.at ? b : a));
              return html`<${TicketRow} key=${t.taskId} ticket=${ticket} project=${project(t.projectId)}
                selection=${selecting && html`<${Check} aria-label=${`Select ${t.key}`} checked=${selected.includes(t.taskId)} disabled=${busy.value} onChange=${e => setSelected(previous => e.target.checked ? [...previous, t.taskId] : previous.filter(id => id !== t.taskId))} />`}
                actions=${html`<a class="btn btn-sm btn-icon next-run" href=${threadLink(latest)} aria-label=${`Open the session that reported ${t.key} in T3 Code`} title=${`Open in T3 Code: ${latest.title || "session"}, reported ${ago(latest.at, now)}${t.sources.length > 1 ? `; ${t.sources.length - 1} more ${t.sources.length === 2 ? "session" : "sessions"} reported it` : ""}`}><${Icon} name="commentDiscussion" /></a>
                  <${RunNow} ticket=${ticket} hold=${hold} />
                  <${Button} size="sm" icon class="next-run" aria-label=${`Remove ${t.key} from Session tickets`} title="Remove from this list. The ticket is unchanged." disabled=${busy.value} onClick=${() => dismiss([t])}>×<//>`}>
                <span class="session-sources" title="The T3 session that reported creating this ticket">${t.sources.map((src) => src.title || "a T3 session").join(", ")}</span>
                <span class="muted" title=${new Date(t.createdAt).toLocaleString()}>${ago(t.createdAt, now, true)}</span>
                ${t.refreshError && html`<span class="tone-attention" title=${`Last read failed: ${t.refreshError}`}>tracker read failed</span>`}
                ${t.unavailable && html`<b class="tone-attention">${t.unavailable}</b>`}
              <//>`;
            })
          : html`<${Empty}>${narrowed ? "No session tickets match." : "No session has reported creating a ticket that is still open."}<//>`}
      ${s?.at && html`<p class="hint">Sessions read ${ago(s.at, now)}.</p>`}
    <//>
  <//>`;
}
