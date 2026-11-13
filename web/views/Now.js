// Home: what the factory and each provider are doing right now, what waits on the owner, and what the owner queued.
import { html, useState } from "../lib/h.js";
import { status, jobs, issues, launchOperations, clock, serverNow, busy } from "../lib/store.js";
import { follow } from "../lib/router.js";
import { ago, duration, PROVIDERS, PENDING_KINDS, decisionSentence, providerOf, providerName, providerIcon, threadLink, byNewest, operationText, nowSections } from "../lib/format.js";
import { Icon, Empty } from "../ui/index.js";
import { Machine, Composer, OperationActions, CancelPlan, planProgress, requestName } from "./Deck.js";
import { decide, reportRow } from "./Triage.js";

// How many rows a section shows before "N more"; a phone-width column shows two (see .now-section in style.css).
const LIMIT = 8, NARROW = 2;

// One line: a leading glyph, an optional key, the title, a note, then the time or the row's one action.
// `href` makes the text a link; the action stays outside it.
function Row({ icon, iconLabel, tone, id, title, note, end, href, external }) {
  const text = html`<span class=${`now-icon ${tone ?? ""}`}><${Icon} name=${icon} label=${iconLabel} /></span>
    ${id && html`<b class="key">${id}</b>`}<span class="now-title">${title}</span>${note && html`<span class="now-note">${note}</span>`}`;
  return html`<li class="now-row">
    ${href ? html`<a class="now-main" href=${href} onClick=${external ? undefined : follow}>${text}</a>` : html`<span class="now-main">${text}</span>`}
    ${end}
  </li>`;
}
const time = (text, title) => html`<span class="now-time" title=${title}>${text}</span>`;
const runIcon = (job) => ({ icon: providerIcon(providerOf(job)), iconLabel: providerName(providerOf(job)) });

function Run({ job, now, needs }) {
  const waited = job.lastExecutionAt ?? job.createdAt;
  // A waiting run says what it waits for; an active one, only how long it has run.
  const note = needs && (job.thread?.pending ? PENDING_KINDS[job.thread.pending] ?? `waiting: ${job.thread.pending}` : job.reason);
  return html`<${Row} ...${runIcon(job)} tone=${needs ? "attention" : "ok"} id=${job.label} title=${job.thread?.title ?? ""} note=${note} href=${`/runs/${job.id}`}
    end=${needs && job.threadId
      ? html`<a class="btn btn-sm" href=${threadLink(job)} aria-label=${`Open ${job.label} in T3 Code`} title=${`Open ${job.label} in T3 Code`}>Open</a>`
      : time(duration(needs ? waited : job.createdAt, now), needs ? `Waiting for you since ${ago(waited, now)}` : `Running for ${duration(job.createdAt, now)}`)} />`;
}
function Report({ event }) {
  const row = reportRow(event, `open-${event.data.ticketId}`);
  return html`<${Row} icon="inbox" iconLabel="Inbox report" tone="attention" id=${row.key} title=${row.title} href="/sources" end=${decide(row).actions} />`;
}
function Problem({ item }) {
  const p = item.problem;
  return html`<${Row} icon="alert" iconLabel="Problem" tone="attention" title=${p.title} note=${p.cause} href=${item.href}
    end=${p.op && html`<span class="now-actions"><${OperationActions} op=${p.op} /></span>`} />`;
}
// A request that ended without starting needs the owner; one still on its way is in the owner's queue.
function Request({ op, needs }) {
  return html`<${Row} icon=${needs ? "alert" : "play"} iconLabel=${needs ? "Not started" : "Starting"} tone=${needs ? "attention" : ""} title=${requestName(op.input) || "Next eligible ticket"} note=${operationText(op)}
    end=${needs ? html`<span class="now-actions"><${OperationActions} op=${op} /></span>` : op.state === "running" && html`<i class="spinner"></i>`} />`;
}
function Plan({ plan }) {
  const epic = !!plan.epic, key = plan.target?.key;
  const title = epic ? `Epic: ${plan.epic.title}` : plan.queued ? `Queued ${key}` : `Chain to ${key}`;
  const cancel = epic ? `Cancel Epic ${plan.epic.title}?` : plan.queued ? `Cancel the queued run for ${key}?` : `Cancel the chain to ${key}?`;
  return html`<${Row} icon="checklist" iconLabel=${epic ? "Epic" : plan.queued ? "Queued run" : "Chain"} title=${title} note=${plan.queued ? plan.target?.note ?? "starts when a slot is free" : planProgress(plan)}
    href=${epic ? "/queue?view=epics" : "/queue"}
    end=${html`<${CancelPlan} plan=${plan} title=${cancel} label=${epic ? "Cancel Epic" : plan.queued ? "Cancel queued run" : "Cancel chain"} icon="x" class="next-run" />`} />`;
}

// A section shows its first rows and expands in place, so every counted item and its action stays reachable here:
// no other page lists reports, problems, requests and runs together.
function Section({ title, tone, items, row, empty }) {
  const [open, setOpen] = useState(false);
  const n = items.length;
  const more = (limit) => n > limit && html`<button type="button" class=${`now-more ${limit === LIMIT ? "wide" : "narrow"}`} aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? "Show fewer" : `${n - limit} more`}</button>`;
  return html`<section class=${`now-section ${tone ?? ""}${open ? " open" : ""}`}>
    <h2>${title}<small>${n}</small></h2>
    ${n ? html`<ul>${(open ? items : items.slice(0, LIMIT)).map(row)}</ul>${more(LIMIT)}${more(NARROW)}` : html`<${Empty}>${empty}<//>`}
  </section>`;
}

export function Now({ initialTicket } = {}) {
  clock.value; // re-render every second for relative times
  busy.value;
  const now = serverNow();
  const s = nowSections({ jobs: jobs.value, plans: status.value.plans ?? [], operations: launchOperations.value, reports: status.value.triageReports ?? [], issues: issues.value });
  const newest = (list) => list.toSorted((a, b) => byNewest(a.job, b.job));
  const needsRow = (item) => item.kind === "run" ? html`<${Run} key=${item.id} job=${item.job} now=${now} needs />`
    : item.kind === "report" ? html`<${Report} key=${item.id} event=${item.event} />`
    : item.kind === "request" ? html`<${Request} key=${item.id} op=${item.op} needs />`
    : html`<${Problem} key=${item.id} item=${item} />`;
  const run = (item) => html`<${Run} key=${item.id} job=${item.job} now=${now} />`;
  const queued = (item) => item.kind === "request" ? html`<${Request} key=${item.id} op=${item.op} />` : html`<${Plan} key=${item.id} plan=${item.plan} />`;
  const sentence = decisionSentence(status.value.decision);
  const count = (n, label, tone) => html`<span class=${tone && n ? tone : ""}><b>${n}</b>${label}</span>`;
  return html`<div class="now">
    <header class="now-head">
      <h1>Now</h1>
      <p class="now-counts">${count(s.working.length + s.ci.length, "running")}${count(s.needs.length, s.needs.length === 1 ? "needs you" : "need you", "tone-attention")}${count(s.queue.length, "in your queue")}</p>
    </header>
    ${initialTicket !== undefined && html`<${Composer} initialTicket=${initialTicket} />`}
    ${sentence && html`<p class="now-decision">${sentence}</p>`}
    <div class="strip">${PROVIDERS.map((p) => html`<${Machine} key=${p.driver} provider=${p} />`)}</div>
    <div class="now-grid">
      <${Section} title="Needs you" tone="attention" items=${s.needs} row=${needsRow} empty="Nothing needs you." />
      <${Section} title="Working" items=${newest(s.working)} row=${run} empty="Nothing is working." />
      <${Section} title="CI" items=${newest(s.ci)} row=${run} empty="Nothing is in CI." />
      <${Section} title="Your queue" items=${s.queue} row=${queued} empty="You have nothing queued." />
    </div>
  </div>`;
}
