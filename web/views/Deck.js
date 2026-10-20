// Home: what the factory is doing right now, why, and what needs you.
import { html, useEffect, useState } from "../lib/h.js";
import { config, status, live, busy, jobs, journal, history, operations, clock, serverNow, actions, startRun, pendingRun, retryRequest, showReadinessConfirmation, showBlockedChoice, loadHistory } from "../lib/store.js";
import { follow } from "../lib/router.js";
import { confirmAction } from "../lib/confirmation.js";
import {
  ago,
  until,
  duration,
  PROVIDERS,
  WINDOW_NAMES,
  PENDING_KINDS,
  streamReason,
  decisionSentence,
  providerOf,
  providerName,
  providerIcon,
  isActive,
  stateLabel,
  toneOf,
  ticketLink,
  ticketKey,
  safeLink,
  prLabel,
  threadLink,
  modelName,
  projectOf,
  matchesRunFilters,
  byNewest,
  byFinished,
  isFinished,
  isOpen,
  STOPS,
  stopOf,
} from "../lib/format.js";
import { Button, Switch, Select, Meter, Stops, Icon, Tag, Link, Empty, Timeline, Help, Meta, RowBody, Section, More } from "../ui/index.js";

// Top bar: the automation switch, the start bar, and when the scheduler last looked.
function Status({ initialTicket }) {
  const on = live.value.enabled,
    d = status.value.decision,
    now = serverNow();
  const next = d?.at ? Date.parse(d.at) + (config.value.pollSeconds ?? 60) * 1000 : null;
  return html`<section class="status">
    <div class="status-main">
      <${Switch} label="Automation" checked=${on} disabled=${busy.value} onChange=${() => actions.toggle("enabled")} />
      <h1>${on ? "Automation on" : "Automation paused"}</h1>
    </div>
    <${Composer} initialTicket=${initialTicket} />
    <div class="status-meta">
      ${decisionSentence(d) && html`<p>${decisionSentence(d)}</p>`}
      <span>Last check ${ago(d?.at, now)}</span>
      ${next && on && html`<span title="Sooner when a T3 thread or the config changes">Next check ${next > now + 1000 ? until(next, now) : "due now"} at the latest</span>`}
    </div>
  </section>`;
}

function Machine({ provider }) {
  const now = serverNow();
  const stream = (status.value.streams || []).find((s) => s.driver === provider.driver) || {};
  const active = jobs.value.filter((j) => providerOf(j) === provider.driver && isActive(j)).length;
  const limit = live.value.concurrency?.[provider.concurrency] ?? 1;
  const direct = status.value.decision?.quota;
  const quota = direct?.driver === provider.driver ? direct : stream.quota;
  const windows = (quota?.windows || []).map((w) => ({ label: WINDOW_NAMES[w.name] || w.name, value: w.remaining, marker: w.reserved, reset: w.resetsAt }));
  const fable = quota?.factoryRouting?.fableRemainingPercent;
  if (fable != null) windows.push({ label: "Fable", value: fable, marker: config.value.quota?.claude?.fable?.minRemainingPercent });
  const reason = !live.value.enabled && !active ? "paused" : streamReason(stream.reason);
  const assigned = quota?.factoryRouting?.modelId && config.value.models.find((m) => m.id === quota.factoryRouting.modelId)?.name;
  return html`<section class="machine ready">
    <header>
      <h2><${Icon} name=${providerIcon(provider.driver)} /> ${provider.name} <span class="load" title="Running now of the automatic limit"><b>${active}</b>${limit ? ` / ${limit}` : ""}</span></h2>
      <span class="reason">${reason}${quota?.capturedAt && html`<span class="muted" title=${`Allowance read ${ago(quota.capturedAt, now)}`}> · ${ago(quota.capturedAt, now)}</span>`}</span>
    </header>
    ${windows.length
      ? windows.map((w) => html`<${Meter} key=${w.label} label=${w.label} value=${w.value} marker=${w.marker} note=${w.reset ? until(w.reset, now) : ""} noteTitle=${w.reset ? `Resets ${until(w.reset, now)}` : ""} />`)
      : html`<p class="muted small">${stream.quotaError ? `Allowance unavailable: ${stream.quotaError}` : "No allowance reading yet."}</p>`}
    ${(stream.models || []).length > 0 &&
    html`<p class="model-reasons">
      ${stream.models.map((m) => html`<span key=${m.id}><b>${m.name}</b>${assigned === m.name && html`<${Tag} tone="on" title="The next automatic run uses this model">next<//>`} ${streamReason(m.reason)}</span>`)}
    </p>`}
  </section>`;
}

function Operation({ op }) {
  const d = op.result?.data,
    running = op.state === "running";
  const text = op.choiceHandled ? "Choice submitted; a new check is queued below." : op.state === "queued" ? "Queued" : running
    ? "Checking the ticket and starting its T3 run"
    : d?.reason === "dispatched"
      ? `Started ${d.ticket || "ticket"} with ${d.model}.`
      : d?.skipped?.[0]?.reason || d?.message || d?.reason || "Check factory status before retrying.";
  return html`<div class=${`operation ${op.state}`} role="status">
    ${running && html`<i class="spinner"></i>`}
    <span><b class="key">${op.input.ticket || "Next eligible ticket"}</b> · ${op.input.model} · ${op.input.overrideLimits ? "Override limits" : "Respect limits"}<br />${text}${op.state === "uncertain" && html` <span class="muted">This request will not be resent automatically.</span>`}</span>
    ${!op.choiceHandled && d?.reason === "ready-label-confirmation-required" && html`<${Button} size="sm" onClick=${() => showReadinessConfirmation(op.id)}>Review and run anyway<//>`}
    ${!op.choiceHandled && d?.reason === "blocked-ticket-plan-required" && html`<${Button} size="sm" onClick=${() => showBlockedChoice(op.id)}>Choose how to run it<//>`}
    ${op.notReceived && html`<${Button} size="sm" onClick=${() => retryRequest(op.id)}>Retry saved request<//>`}
    ${!running && op.state !== "queued" && html`<${Button} variant="ghost" size="sm" icon aria-label=${`Dismiss ${op.input.ticket || "request"}`} onClick=${() => actions.dismissOperation(op.id)}>×<//>`}
  </div>`;
}

// Start bar: project key, dash, ticket number; model; override; start. An empty number means the next eligible ticket.
export function Composer({ initialTicket } = {}) {
  const linked = initialTicket !== undefined;
  // Only enabled projects: the scheduler refuses a named ticket from a disabled one.
  const keys = [...new Set(config.value.projects.filter((p) => p.enabled && p.key).map((p) => p.key))];
  const [linkKey = "", linkNumber = ""] = (ticketKey(initialTicket ?? "") || "").split("-");
  const [project, setProject] = useState(linkKey || keys[0] || "");
  const [number, setNumber] = useState(linkNumber);
  const [model, setModel] = useState("auto");
  const [override, setOverride] = useState(true);
  const ticket = number.trim() ? `${project}-${number.trim()}` : "";
  const key = ticketKey(ticket);
  // A bad launch link starts invalid, but picking a project and typing a number repairs it.
  const invalid = linked && !key;
  const pending = pendingRun(ticket);
  const submit = (e) => {
    e.preventDefault();
    if (invalid || pending) return;
    if (startRun({ ticket: key, model, overrideLimits: override }) && !linked) setNumber("");
  };
  const options = [...new Set([project, ...keys].filter(Boolean))].map((k) => [k, k]);
  return html`${invalid && html`<p class="alert" role="alert">Invalid ticket link. Enter a ticket key to continue.</p>`}<form class="composer" onSubmit=${submit}>
    <${Select} class="ticket-project" label="Ticket project" value=${project} onChange=${setProject} options=${options} />
    <input class="mono ticket-number" value=${number} onInput=${(e) => setNumber(e.target.value.replace(/\D/g, ""))} placeholder=${linked ? "number" : "next"} required=${linked} inputmode="numeric" aria-label="Ticket number" title=${number ? `Ticket ${project}-${number}` : "Leave empty to start the next eligible ticket"} />
    <${Select} label="Model" value=${model} onChange=${setModel} options=${[["auto", "Auto"], ...config.value.models.map((m) => [m.id, m.name])]} />
    <${Button} variant="ghost" icon="zap" aria-pressed=${override} label=${override ? "Override limits: on. Skips idle and reserve thresholds; readiness, difficulty, duplicate and merge checks still apply." : "Override limits: off. Waits for idle time and reserve."} onClick=${() => setOverride((v) => !v)} />
    <${Button} variant="primary" type="submit" icon="play" label=${key ? `Start ${key}` : "Start next eligible ticket"} disabled=${invalid || pending} />
  </form>`;
}

export function Operations() {
  return operations.value.map((op) => html`<${Operation} key=${op.id} op=${op} />`);
}

// Chains the user started: each ticket's state, and what the next one waits for.
export function Chains() {
  clock.value;
  const plans = (status.value.plans ?? []).filter((p) => p.state === "active");
  if (!plans.length) return null;
  const jobByTask = new Map(jobs.value.filter(isOpen).map((j) => [j.taskId, j]));
  return plans.map((p) => {
    const all = [...p.tickets, p.target], byId = new Map(all.map((t) => [t.id, t])), done = all.filter((t) => t.done).length;
    const state = (t) => {
      const job = jobByTask.get(t.id);
      if (t.done) return ["Done", "ok", ""];
      if (job) return [stateLabel(job.state), toneOf(job.state), ""];
      const ahead = t.blockedBy.filter((id) => !byId.get(id)?.done).map((id) => byId.get(id)?.key ?? "?");
      if (t === p.target && p.tickets.some((x) => !x.done)) return ["Last", "", "after every ticket above"];
      if (ahead.length) return ["Waits", "", `after ${ahead.join(", ")}`];
      return ["Next", "attention", t.note ?? "starts when a slot is free"];
    };
    return html`<${Section} key=${p.id} title=${`Chain to ${p.target.key}`} count=${`${done} of ${all.length} done`}
      aside=${html`<${Button} variant="ghost" size="sm" disabled=${busy.value} onClick=${() => confirmAction({ title: `Cancel the chain to ${p.target.key}?`, message: "Tickets already running finish on their own.", label: "Cancel chain" }, () => actions.cancelPlan(p.id))}>Cancel chain<//>`}>
      ${all.map((t) => {
        const [label, tone, note] = state(t), job = jobByTask.get(t.id);
        return html`<${job ? "a" : "div"} class="chain-row" key=${t.id} href=${job ? `/runs/${job.id}` : undefined} onClick=${job ? follow : undefined}>
          <${Tag} tone=${tone}>${label}<//><${RowBody} title=${html`<b class="key">${t.key}</b> ${t.title}`}>${note || (job ? modelName(config.value, job) : "")}<//>
        <//>`;
      })}
    <//>`;
  });
}

// Why a ticket cannot be started from here right now, or null when it can.
export function startHold(t) {
  if (pendingRun(t.key)) return "A request for this ticket is already pending.";
  if (jobs.value.some((j) => j.taskId === t.id && isOpen(j)) || (status.value.plans ?? []).some((p) => p.state === "active" && p.target.id === t.id)) return "This ticket already has an open run or active chain.";
  return null;
}

// One ticket in a list: key and title linking to the tracker, its facets, and the actions beside it.
// The queue and the session list share this row; `children` extends the facet line, `actions` the trailing buttons.
export function TicketRow({ ticket: t, project, children, actions }) {
  const c = config.value;
  return html`<div class="next" key=${t.id}>
    <a class="next-ticket" href=${ticketLink(c, { taskId: t.id, projectId: t.projectId })} target="_blank" rel="noopener noreferrer">
      <${RowBody} title=${html`<b class="key">${t.key}</b> ${t.title}`}>
        <${Meta} project=${project?.name ?? t.project ?? t.projectId} priority=${t.priority} difficulty=${t.difficulty || false} labels=${t.labels ?? []} highlight=${project?.priorityLabels ?? []}>${children}<//>
      <//>
    </a>
    ${actions}
  </div>`;
}

// Icon-only start of one ticket through the ordinary checks; `hold` names why it is disabled.
export const RunNow = ({ ticket: t, hold }) => html`<${Button} size="sm" icon class="next-run" aria-label=${`Run ${t.key} now`} disabled=${!!hold}
  title=${hold ?? "Override limits and start this ticket now."}
  onClick=${() => { if (!startHold(t) && !hold) startRun({ ticket: t.key, model: "auto", overrideLimits: true }); }}><${Icon} name="play" /><//>`;

// What the factory would start next, in order. The same list feeds the deck and the runs page.
export function UpNext({ limit = 5, children, filters, query = "" }) {
  clock.value;
  const c = config.value,
    q = status.value.upNext,
    tickets = (q?.tickets ?? []).filter(t => matchesRunFilters(t, filters, query)),
    held = (q?.held ?? []).filter(t => matchesRunFilters(t, filters, query)),
    all = limit === Infinity;
  const project = (id) => c.projects.find((p) => p.kaneoId === id);
  return html`<${Section} title="Up next" count=${q ? tickets.length : null} aside=${children}>
    ${!q
      ? html`<${Empty}>The queue has not been read yet.<//>`
      : tickets.length
        ? tickets.slice(0, limit).map((t) => html`<${TicketRow} key=${t.id} ticket=${t} project=${project(t.projectId)} actions=${html`<${RunNow} ticket=${t} hold=${startHold(t)} />`}>
            ${t.after?.length > 0 && html`<b class="tone-attention">after ${t.after.join(", ")}</b>`}
          <//>`)
        : html`<${Empty}>${query.trim() || ["projects", "tags", "difficulties", "priorities"].some(key => filters?.[key]?.length) ? held.length ? "No ready tickets match." : "No tickets match." : "Nothing is ready to start."}<//>`}
    ${all && held.length > 0 && html`<h3 class="held-title">Held back</h3>${held.map((h) => html`<div class="held" key=${h.key}><b class="key">${h.key}</b><span>${h.reason}</span><${Meta} priority=${h.priority} difficulty=${h.difficulty} labels=${h.labels ?? []} /></div>`)}`}
    ${q && html`<p class="hint">Queue read ${ago(q.at, serverNow())}${!all && held.length ? `. ${held.length} held back` : ""}.</p>`}
  <//>`;
}

// One run. Used on the deck, the runs page, and upstream reviews.
export function RunRow({ job, now = serverNow(), showProject = true }) {
  const c = config.value,
    project = projectOf(c, job),
    ticket = ticketLink(c, job),
    prs = (job.prUrls || []).map(safeLink).filter(Boolean),
    waiting = job.state === "waiting",
    active = isActive(job);
  // Short on the row, spelled out on hover.
  const [timing, timingTitle] = active
    ? [`${duration(job.createdAt, now)} · ${ago(job.lastExecutionAt ?? job.createdAt, now)}`, `Running for ${duration(job.createdAt, now)}; last activity ${ago(job.lastExecutionAt ?? job.createdAt, now)}`]
    : waiting
      ? [`for ${duration(job.lastExecutionAt ?? job.createdAt, now)}`, `Waiting for you since ${ago(job.lastExecutionAt ?? job.createdAt, now)}`]
      : job.completedAt
        ? [`${ago(job.completedAt, now)} · ${duration(job.createdAt, job.completedAt)}`, `Finished ${ago(job.completedAt, now)} after ${duration(job.createdAt, job.completedAt)}`]
        : job.dismissedAt
          ? [`${ago(job.dismissedAt, now)} · ${duration(job.createdAt, job.dismissedAt)}`, `Settled ${ago(job.dismissedAt, now)} after ${duration(job.createdAt, job.dismissedAt)}`]
          : [ago(job.createdAt, now), `Started ${ago(job.createdAt, now)}`];
  // Settling in T3 is the ordinary way a run ends, so only an unusual reason is worth a line.
  const note = waiting ? (job.thread?.pending ? PENDING_KINDS[job.thread.pending] ?? `waiting: ${job.thread.pending}` : job.reason) : job.state === "dismissed" && !/^Dismissed by settling/.test(job.reason ?? "") ? job.reason : "";
  return html`<a class=${`run ${job.state}`} href=${`/runs/${job.id}`} onClick=${follow}>
    <span class="run-key">
      ${ticket ? html`<span onClick=${(e) => e.stopPropagation()}><${Link} href=${ticket} class="key">${job.label}<//></span>` : html`<b class="key">${job.label}</b>`}
      ${note && html`<span onClick=${(e) => e.stopPropagation()}><${Help} text=${note} glyph=${waiting ? "!" : "i"} tone=${waiting ? "attention" : ""} /></span>`}
    </span>
    <${Meta} class="run-meta" project=${showProject && project?.name} kind=${job.kind && job.kind !== "ticket" && (job.kind === "upstream" ? "review" : "discovery")}
      model=${html`<span title=${`Model: ${providerName(providerOf(job))} ${modelName(c, job)}`}><${Icon} name=${providerIcon(providerOf(job))} /> ${modelName(c, job)}</span>`}
      priority=${job.priority} difficulty=${job.difficulty} labels=${job.labels ?? []} highlight=${project?.priorityLabels ?? []} />
    <${Stops} n=${stopOf(job.state)} tone=${toneOf(job.state)} label=${stateLabel(job.state)} />
    <span class="run-state muted" title=${timingTitle}><b class="run-stop">${stateLabel(job.state)}</b>${timing}</span>
    <span class="run-links" onClick=${(e) => e.stopPropagation()}>
      ${prs.map((href) => html`<${Link} key=${href} href=${href} class="run-pr" title=${prLabel(href)}><${Icon} name="pullRequest" label=${prLabel(href)} /><//>`)}
    </span>
  </a>`;
}

// Rows share one grid so the track column lines up under its legend. The pane around the grid is the
// size container, since a container query cannot read the queried element's own width.
// With a title the heading is the grid's first row, so the stop legend sits on the title line above its column.
export function RunList({ list, title, count, aside, now = serverNow() }) {
  return html`<div class="runs-pane"><div class="runs">
    ${title ? html`<header class="run-head"><h2>${title}${count != null && html`<small>${count}</small>`}</h2><div class="run-legend" aria-hidden="true">${STOPS.map((s) => html`<span key=${s}>${s}</span>`)}</div>${aside && html`<span class="run-aside">${aside}</span>`}</header>`
      : html`<div class="run-legend" aria-hidden="true">${STOPS.map((s) => html`<span key=${s}>${s}</span>`)}</div>`}
    ${list.map((j) => html`<${RunRow} key=${j.id} job=${j} now=${now} />`)}
  </div></div>`;
}

export function RunGroup({ title, list, limit = 8, empty, children }) {
  const [all, setAll] = useState(false);
  const visible = all ? list : list.slice(0, limit);
  return html`<${Section} title=${list.length ? null : title} count=${list.length || null} aside=${list.length ? null : children}>
    ${list.length ? html`<${RunList} list=${visible} title=${title} count=${list.length} aside=${children} />` : empty && html`<${Empty}>${empty}<//>`}
    ${!all && list.length > limit && html`<${Button} variant="ghost" size="sm" onClick=${() => setAll(true)}>Show all ${list.length}<//>`}
  <//>`;
}

export function Deck({ initialTicket } = {}) {
  useEffect(() => {
    if (!history.value) loadHistory().catch(() => {});
  }, []);
  clock.value; // re-render every second for relative times
  const list = jobs.value;
  const waiting = list.filter((j) => j.state === "waiting").sort(byNewest);
  const running = list.filter(isActive).sort(byNewest);
  // Settled runs leave the live status, so the finished list comes from history.
  const done = (history.value ?? list).filter(isFinished).sort(byFinished);
  return html`
    <${Status} initialTicket=${initialTicket} />
    <div class="strip">${PROVIDERS.map((p) => html`<${Machine} key=${p.driver} provider=${p} />`)}</div>
    <div class="deck">
      <div class="deck-main">
        ${operations.value.length > 0 && html`<${Section} class="launch"><${Operations} /><//>`}
        <${RunGroup} title="Open" list=${[...waiting, ...running]} empty="Nothing is running.">
          ${waiting.length > 0 && html`<span class="tone-attention">${waiting.length} need${waiting.length === 1 ? "s" : ""} you</span>`}
        <//>
        <${Chains} />
        <${UpNext}><${More} href="/runs?state=next" label="Whole queue" onClick=${follow} /><//>
        <${RunGroup} title="Finished recently" list=${done} limit=${5} empty="Nothing has finished yet.">
          <${More} href="/runs" label="All runs" onClick=${follow} />
        <//>
      </div>
      <aside class="deck-side">
        <${Section} title="Activity" aside=${html`<${More} href="/activity" label="All activity" onClick=${follow} />`}>
          ${journal.value.length ? html`<${Timeline} events=${journal.value.slice(0, 12)} />` : html`<${Empty}>Nothing recorded yet.<//>`}
        <//>
      </aside>
    </div>`;
}
