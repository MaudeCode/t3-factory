// Pieces shared by the pages that list runs and tickets: provider meters, the start bar, requests, rows.
import { html, useRef, useState } from "../lib/h.js";
import { config, status, live, busy, jobs, launchOperations, clock, serverNow, quotaFor, actions, startRun, pendingRun, retryRequest, showBlockedChoice, sessionOverrides, setSessionOverrides, sessionProvider, setSessionProvider } from "../lib/store.js";
import { follow, followRun, openTicket } from "../lib/router.js";
import { confirmAction } from "../lib/confirmation.js";
import {
  ago,
  until,
  duration,
  PROVIDERS,
  WINDOW_NAMES,
  PENDING_KINDS,
  streamReason,
  QUOTA_HOLDS,
  providerOf,
  providerName,
  providerIcon,
  isActive,
  stateLabel,
  toneOf,
  ticketLink,
  ticketKey,
  parseTicketInput,
  safeLink,
  prLabel,
  threadLink,
  modelName,
  projectOf,
  matchesRunFilters,
  hasRunFilters,
  isOpen,
  OVERRIDES,
  overrideText,
  operationText,
} from "../lib/format.js";
import { Button, Select, Segmented, Chips, Meter, Icon, Tag, Empty, Meta, RowBody, Section, More, Popover } from "../ui/index.js";


export function Machine({ provider }) {
  const now = serverNow();
  const stream = (status.value.streams || []).find((s) => s.driver === provider.driver) || {};
  const active = jobs.value.filter((j) => providerOf(j) === provider.driver && isActive(j)).length;
  const limit = live.value.concurrency?.[provider.concurrency] ?? 1;
  const quota = quotaFor(provider.driver);
  const windows = (quota?.windows || []).map((w) => ({ label: WINDOW_NAMES[w.name] || w.name, value: w.remaining, marker: w.reserved, reset: w.resetsAt }));
  const fable = quota?.factoryRouting?.fableRemainingPercent;
  if (fable != null) windows.push({ label: "Fable", value: fable, marker: config.value.quota?.claude?.fable?.minRemainingPercent });
  const reason = !live.value.enabled && !active ? "paused" : streamReason(stream.reason);
  // Held back by its allowance: say so beside the name and offer the one way past it.
  const held = live.value.enabled && QUOTA_HOLDS.includes(stream.reason);
  const anyway = { model: "auto", provider: provider.driver, overrideLimits: true };
  const assigned = quota?.factoryRouting?.modelId && config.value.models.find((m) => m.id === quota.factoryRouting.modelId)?.name;
  return html`<section class="machine ready">
    <header>
      <h2><${Icon} name=${providerIcon(provider.driver)} /> ${provider.name} <span class="load" title="Running now of the automatic limit"><b>${active}</b>${limit ? ` of ${limit}` : ""} ${limit === 1 ? "slot" : "slots"}</span></h2>
      <span class=${`reason${held ? " tone-attention" : ""}`}>${reason}${quota?.capturedAt && html`<span class="muted" title=${`Allowance read ${ago(quota.capturedAt, now)}`}> · ${ago(quota.capturedAt, now)}</span>`}</span>
      ${held && html`<${Button} size="sm" disabled=${busy.value} title=${`Start the next eligible ticket on ${provider.name}, overriding its limits`} onClick=${() => startRun(anyway)}>Start anyway<//>`}
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

// What a request starts. An Epic request carries only its ID, so its name comes from the current status.
export const requestName = ({ upstream, ticket, epic }) => {
  if (!epic) return upstream || ticket;
  const known = [...(status.value.epics ?? []), ...(status.value.plans ?? []).flatMap(p => p.epic ?? [])].find(e => e.id === epic);
  return `Epic ${known?.title ?? epic}`;
};

function Operation({ op }) {
  return html`<div class=${`operation ${op.state}`} role="status">
    ${op.state === "running" && html`<i class="spinner"></i>`}
    <span><b class="key">${requestName(op.input) || "Next eligible ticket"}</b> ·${op.input.provider ? providerName(op.input.provider) : op.input.model} · ${overrideText(op.input.overrideLimits)}<br />${operationText(op)}${op.state === "uncertain" && html` <span class="muted">This request will not be resent automatically.</span>`}</span>
    <${OperationActions} op=${op} />
  </div>`;
}

// What can be done with a request that ended without starting. The request row and the notification area share these.
export function OperationActions({ op }) {
  const d = op.result?.data;
  return html`${!op.choiceHandled && d?.reason === "blocked-ticket-plan-required" && html`<${Button} size="sm" onClick=${() => showBlockedChoice(op.id)}>Choose how to run it<//>`}
    ${op.notReceived && html`<${Button} size="sm" onClick=${() => retryRequest(op.id)}>Retry saved request<//>`}
    ${!["queued", "running"].includes(op.state) && html`<${Button} variant="ghost" size="sm" icon aria-label=${`Dismiss ${requestName(op.input) || "request"}`} onClick=${() => actions.dismissOperation(op.id)}>×<//>`}`;
}

export const modelOptions = () => [["auto", "Auto"], ...config.value.models.map((m) => [m.id, m.name])];

// Start bar: project key, dash, ticket number; model; override; start. An empty number means the next eligible ticket.
export function Composer({ initialTicket } = {}) {
  const linked = initialTicket !== undefined;
  // Only enabled projects: the scheduler refuses a named ticket from a disabled one.
  const keys = [...new Set(config.value.projects.filter((p) => p.enabled && p.key).map((p) => p.key))];
  const [linkKey = "", linkNumber = ""] = (ticketKey(initialTicket ?? "") || "").split("-");
  const [project, setProject] = useState(linkKey || keys[0] || "");
  const [number, setNumber] = useState(linkNumber);
  const [model, setModel] = useState("auto");
  const [overrides, setOverrides] = useState(() => OVERRIDES.map(([v]) => v));
  const ticket = number.trim() ? `${project}-${number.trim()}` : "";
  const key = ticketKey(ticket);
  // A bad launch link starts invalid, but picking a project and typing a number repairs it.
  const invalid = linked && !key;
  const pending = pendingRun(ticket);
  const submit = (e) => {
    e.preventDefault();
    if (invalid || pending) return;
    if (startRun({ ticket: key, model, overrideLimits: overrides.length === OVERRIDES.length || overrides }) && !linked) setNumber("");
  };
  const options = [...new Set([project, ...keys].filter(Boolean))].map((k) => [k, k]);
  return html`${invalid && html`<p class="alert" role="alert">Invalid ticket link. Enter a ticket key to continue.</p>`}<form class="composer" onSubmit=${submit}>
    <${Select} class="ticket-project" label="Ticket project" value=${project} onChange=${setProject} options=${options} />
    <input class="mono ticket-number" value=${number} onInput=${(e) => { const parsed = parseTicketInput(e.target.value, keys); if (parsed.project) setProject(parsed.project); setNumber(e.target.value = parsed.number); }} placeholder=${linked ? "number" : "next"} required=${linked} inputmode="numeric" aria-label="Ticket number" title=${number ? `Ticket ${project}-${number}` : "Leave empty to start the next eligible ticket"} />
    <${Select} label="Model" value=${model} onChange=${setModel} options=${modelOptions()} />
    <${Select} multiple class="overrides" placeholder="Respect limits" label="Override limits" value=${overrides} onChange=${setOverrides} options=${OVERRIDES} />
    <${Button} variant="primary" type="submit" icon="play" label=${key ? `Start ${key}` : "Start next eligible ticket"} disabled=${invalid || pending} />
  </form>`;
}

export function Operations({ list = launchOperations.value } = {}) {
  return list.map((op) => html`<${Operation} key=${op.id} op=${op} />`);
}

// A chain's or an Epic's tickets: each one's state, what it waits for, and why it will not start. `plan.state` is
// missing on an Epic that has not started; `show` narrows the rows without changing what they wait for.
export function PlanRows({ plan, show = () => true }) {
  const all = plan.target ? [...plan.tickets, plan.target] : plan.tickets, byId = new Map(all.map((t) => [t.id, t]));
  const jobByTask = new Map(jobs.value.filter(isOpen).map((j) => [j.taskId, j]));
  const state = (t, job) => {
    if (t.done) return ["Done", "ok", ""];
    if (job) return [stateLabel(job.state), toneOf(job.state), ""];
    if (plan.state && plan.state !== "active") return ["Not run", "", ""];
    const ahead = t.blockedBy.filter((id) => !byId.get(id)?.done).map((id) => byId.get(id)?.key ?? "?");
    if (t === plan.target && plan.tickets.some((x) => !x.done)) return ["Last", "", "after every ticket above"];
    if (ahead.length) return ["Waits", "", `after ${ahead.join(", ")}`];
    return [plan.queued ? "Queued" : "Next", "attention", t.note ?? (plan.state ? "starts when a slot is free" : "")];
  };
  const reasons = (t) => [
    t.runnable === false && "Its project is not included in the factory",
    t.automationReady === false ? t.readiness?.reasons?.map((r) => r.message).join("; ") || "Automation readiness is off" : t.hold,
  ];
  return all.filter(show).map((t) => {
    const job = jobByTask.get(t.id), [label, tone, note] = state(t, job);
    // The scheduler writes the same not-included note, so a repeated reason shows once.
    const detail = [...new Set([note || (job ? modelName(config.value, job) : ""), t.outside && "outside this Epic", ...(t.done || job ? [] : reasons(t))])].filter(Boolean).join(" · ");
    return html`<${job ? "a" : "div"} class="chain-row" key=${t.id} href=${job ? `/runs/${job.id}` : undefined} onClick=${job ? follow : undefined}>
      <${Tag} tone=${tone}>${label}<//><${RowBody} title=${html`<b class="key">${t.key}</b> ${t.title}`}>${(detail || t.automationReady === true) && html`<${Meta} automationReady=${t.automationReady}>${detail}<//>`}<//>
    <//>`;
  });
}
export const planProgress = (plan) => {
  const all = plan.target ? [...plan.tickets, plan.target] : plan.tickets;
  return `${all.filter((t) => t.done).length} of ${all.length} done`;
};
export const CancelPlan = ({ plan, title, label, icon, class: extra }) => html`<${Button} variant="ghost" size="sm" icon=${icon} label=${icon && label} class=${extra} disabled=${busy.value} onClick=${() => confirmAction({ title, message: "Tickets already running finish on their own.", label }, () => actions.cancelPlan(plan.id))}>${!icon && label}<//>`;

// Chains the user started. Epics have their own tab on the Runs page.
export function Chains() {
  clock.value;
  return (status.value.plans ?? []).filter((p) => p.state === "active" && !p.epic).map((p) => html`<${Section} key=${p.id} title=${p.queued ? `Queued ${p.target.key}` : `Chain to ${p.target.key}`} count=${p.queued ? null : planProgress(p)}
    aside=${html`<${CancelPlan} plan=${p} title=${p.queued ? `Cancel the queued run for ${p.target.key}?` : `Cancel the chain to ${p.target.key}?`} label=${p.queued ? "Cancel queued run" : "Cancel chain"} />`}>
    <${PlanRows} plan=${p} />
  <//>`);
}

// A ticket that already has an open run or is the target of an active chain.
export const openRun = (t) => {
  const key = ticketKey(t.key);
  // Held queue rows carry a key without a tracker ID.
  const matches = (id, otherKey) => (t.id && id === t.id) || (key && ticketKey(otherKey) === key);
  return jobs.value.some(j => matches(j.taskId, j.ticketKey) && isOpen(j)) || (status.value.plans ?? []).some(p => p.state === "active" && p.target && matches(p.target.id, p.target.key));
};

// Why a ticket cannot be started from here right now, or null when it can.
export function startHold(t) {
  if (pendingRun(t.key)) return "A request for this ticket is already pending.";
  if (openRun(t)) return "This ticket already has an open run or active chain.";
  return null;
}

// One ticket in a list: key and title linking to the tracker, its facets, and the actions beside it.
// The queue, session and triage lists share this row; Start stays visible and secondary actions use a mobile popover.
// `badge`, such as a triage outcome, leads the facet line, so the row stays as tall as any other.
// A `plain` row is not a startable ticket, so it has no difficulty to warn about. `toggle` makes the row's body a
// disclosure button instead of a link; `expanded` is left unset when there is nothing to open.
export function TicketRow({ ticket: t, project, children, actions, secondaryActions, selection, badge, plain, link, meta, toggle }) {
  const c = config.value;
  const [open, setOpen] = useState(false), button = useRef();
  const label = `More actions for ${t.key}`;
  // A ticket opens in Factory's own panel. A modified or middle click keeps the link's tracker tab, and a row that
  // is not a ticket Factory can read (an inbox report) keeps the tracker link as it is.
  const panel = !plain && ticketKey(t.key ?? "") ? (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return; e.preventDefault(); openTicket(ticketKey(t.key)); } : undefined;
  const body = html`<${RowBody} title=${t.key ? html`<b class="key">${t.key}</b> ${t.title}` : t.title}>
    <${Meta} project=${project?.name ?? t.project ?? t.projectId} automationReady=${t.automationReady} priority=${t.priority} difficulty=${plain ? undefined : t.difficulty || false} labels=${t.labels ?? []} highlight=${(project?.priorityLabels ?? []).flat()} ...${meta}>${badge}${children}<//>
  <//>`;
  return html`<div class="next" key=${t.id}>
    ${selection}
    ${toggle
      ? html`<button type="button" class="next-ticket next-toggle" aria-expanded=${toggle.expanded} disabled=${toggle.disabled} onClick=${toggle.onClick}><${Icon} name="chevronRight" />${body}</button>`
      : html`<a class="next-ticket" ...${link ?? { href: ticketLink(c, { taskId: t.id, projectId: t.projectId }), target: "_blank", rel: "noopener noreferrer", onClick: panel }}>${body}</a>`}
    ${actions && html`<div class="next-actions">${actions}
      ${secondaryActions && html`<div class="next-secondary">${secondaryActions}</div>
        <span ref=${button} class="next-more"><${Button} size="sm" icon class="next-run" label=${label} aria-expanded=${open} onClick=${() => setOpen(!open)}>⋯<//></span>
        <${Popover} class="next-menu" open=${open} onClose=${() => setOpen(false)} anchor=${button} label=${label} width=${220}>
          <div onClick=${() => setOpen(false)}>${secondaryActions}</div>
        <//>`}
    </div>`}
  </div>`;
}

// Manual starts share independent provider and limit override choices.
// Ticket lists share the choice.
export const startOptions = () => {
  const provider = sessionProvider.value === "auto" ? undefined : sessionProvider.value;
  return { provider, overrideLimits: sessionOverrides.value };
};
export function StartOptions() {
  return html`<${Segmented} icons=${Object.fromEntries([["auto", "zap"], ...PROVIDERS.map(p => [p.driver, providerIcon(p.driver)])])} label="Start provider" value=${sessionProvider.value} onChange=${setSessionProvider} options=${[["auto", "Auto: use selected overrides"], ...[...PROVIDERS].reverse().map(p => [p.driver, `${p.name}: use selected overrides`])]} /><${Chips} label="Override limits" value=${sessionOverrides.value} onChange=${setSessionOverrides} options=${OVERRIDES.map(([key, name, icon]) => [key, html`<${Icon} name=${icon} />`, `Override ${name.toLowerCase()}${key === "providers" ? ", including providers set to Off" : ""}`])} />`;
}

// Newest or oldest first, for ticket and run lists.
export const OrderChoice = ({ label, value, onChange, disabled }) => html`<${Segmented} label=${label} value=${value} onChange=${onChange} disabled=${disabled} icons=${{ newest: "arrowDown", oldest: "arrowUp" }} options=${[["newest", "Newest first"], ["oldest", "Oldest first"]]} />`;

// Icon-only start of one ticket through the ordinary checks; `hold` names why it is disabled, `origin` the page that started it.
export const runNow = (t, hold, origin, { overrideLimits = true, provider } = {}) => !startHold(t) && !hold ? startRun({ ticket: t.key, model: "auto", overrideLimits, ...(provider ? { provider } : {}) }, origin) : null;
export const RunNow = ({ ticket: t, hold, origin, overrideLimits = true, provider }) => html`<${Button} size="sm" icon class="next-run" aria-label=${`Run ${t.key} now`} disabled=${!!hold}
  title=${hold ?? `${overrideText(overrideLimits)} and start this ticket now.`}
  onClick=${() => runNow(t, hold, origin, { overrideLimits, provider })}><${Icon} name="play" /><//>`;

// What the factory would start next, in order. The same list feeds the deck and the runs page.
export function UpNext({ limit = 5, children, filters, query = "", start }) {
  clock.value;
  const c = config.value,
    q = status.value.upNext,
    visible = t => !startHold(t) && matchesRunFilters(t, filters, query),
    tickets = (q?.tickets ?? []).filter(visible),
    held = (q?.held ?? []).filter(visible),
    all = limit === Infinity;
  const project = (id) => c.projects.find((p) => p.kanvilId === id);
  return html`<${Section} title="Up next" count=${q ? tickets.length : null} aside=${children}>
    ${!q
      ? html`<${Empty}>The queue has not been read yet.<//>`
      : tickets.length
        ? tickets.slice(0, limit).map((t) => html`<${TicketRow} key=${t.id} ticket=${t} project=${project(t.projectId)} actions=${html`<${RunNow} ticket=${t} hold=${startHold(t)} ...${start} />`}>
            ${t.after?.length > 0 && html`<b class="tone-attention">after ${t.after.join(", ")}</b>`}
          <//>`)
        : html`<${Empty}>${query.trim() || hasRunFilters(filters) ? held.length ? "No ready tickets match." : "No tickets match." : "Nothing is ready to start."}<//>`}
    ${all && held.length > 0 && html`<h3 class="held-title">Held back</h3>${held.map((h) => html`<div class="held" key=${h.key}><b class="key">${h.key}</b><span>${h.reason}</span><${Meta} automationReady=${h.automationReady} priority=${h.priority} difficulty=${h.difficulty} labels=${h.labels ?? []} /></div>`)}`}
    ${q && html`<p class="hint">Queue read ${ago(q.at, serverNow())}${!all && held.length ? `. ${held.length} held back` : ""}.</p>`}
  <//>`;
}

// One run. Used on the deck, the runs page, and upstream reviews.
// `selected` is set by the Runs list: true marks the row as the run shown beside it, and either value keeps the click in place.
export function RunRow({ job, now = serverNow(), showProject = true, selected }) {
  const c = config.value,
    project = projectOf(c, job),
    ticket = ticketLink(c, job),
    prs = (job.prUrls || []).map(safeLink).filter(Boolean),
    waiting = job.state === "waiting",
    active = isActive(job),
    // Every way of opening the run from the row behaves alike: in place from the Runs list, a page change elsewhere.
    open = selected === undefined ? follow : followRun;
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
  return html`<${TicketRow} ticket=${{ ...job, id: job.taskId, key: job.label, title: job.thread?.title }} project=${project} plain
    link=${{ href: `/runs/${job.id}`, onClick: open, "aria-current": selected ? "true" : undefined }}
    meta=${{ project: showProject ? project?.name : undefined, difficulty: job.difficulty, kind: job.kind && job.kind !== "ticket" && (job.kind === "upstream" ? "review" : "discovery"), model: html`<span title=${`Model: ${providerName(providerOf(job))} ${modelName(c, job)}`}><${Icon} name=${providerIcon(providerOf(job))} /> ${modelName(c, job)}</span>` }}
    badge=${html`<${Tag} state=${job.state} title=${note || stateLabel(job.state)} />`}
    actions=${html`<a class="btn btn-sm btn-icon next-run" href=${`/runs/${job.id}`} onClick=${open} aria-label=${`Open run ${job.label}`} title=${`Open run ${job.label}`}><${Icon} name="arrowRight" /><//>`}
    secondaryActions=${(ticket || prs.length > 0 || job.threadId) && html`${ticket && html`<a class="btn btn-sm btn-icon next-run" href=${ticket} target="_blank" rel="noopener noreferrer" aria-label=${`Open ticket ${job.label}`} title=${`Open ticket ${job.label}`}><${Icon} name="tag" /><span class="next-action-label">Open ticket</span></a>`}
      ${prs.map(href => html`<a key=${href} class="btn btn-sm btn-icon next-run" href=${href} target="_blank" rel="noopener noreferrer" aria-label=${prLabel(href)} title=${prLabel(href)}><${Icon} name="pullRequest" /><span class="next-action-label">${prLabel(href)}</span></a>`)}
      ${job.threadId && html`<a class="btn btn-sm btn-icon next-run" href=${threadLink(job)} aria-label=${`Open ${job.label} in T3 Code`} title=${`Open ${job.label} in T3 Code`}><${Icon} name="commentDiscussion" /><span class="next-action-label">Open session</span></a>`}`}>
    <span class="muted" title=${timingTitle}>${timing}</span>
    ${note && html`<span class="tone-attention">${note}</span>`}
  <//>`;
}

export function RunList({ list, title, count, aside, now = serverNow(), selected }) {
  return html`<${Section} class="list" title=${title} count=${count} aside=${aside}>
    ${list.map((j) => html`<${RunRow} key=${j.id} job=${j} now=${now} selected=${selected === undefined ? undefined : j.id === selected} />`)}
  <//>`;
}

export function RunGroup({ title, list, limit = 8, empty, children }) {
  const [all, setAll] = useState(false);
  const visible = all ? list : list.slice(0, limit);
  return html`<${Section} title=${list.length ? null : title} count=${list.length || null} aside=${list.length ? null : children}>
    ${list.length ? html`<${RunList} list=${visible} title=${title} count=${list.length} aside=${children} />` : empty && html`<${Empty}>${empty}<//>`}
    ${!all && list.length > limit && html`<${Button} variant="ghost" size="sm" onClick=${() => setAll(true)}>Show all ${list.length}<//>`}
  <//>`;
}
