// Pieces shared by the pages that list runs and tickets: provider meters, the start bar, requests, rows.
import { html, useRef, useState } from "../lib/h.js";
import { config, statusSection, needSection, live, busy, jobs, launchOperations, quotaFor, actions, startRun, pendingRun, retryRequest, showBlockedChoice, sessionOverrides, setSessionOverrides, sessionProvider, setSessionProvider } from "../lib/store.js";
import { follow, followRun, ticketClick } from "../lib/router.js";
import { confirmAction } from "../lib/confirmation.js";
import {
  ago,
  until,
  duration,
  PROVIDERS,
  WINDOW_NAMES,
  PENDING_KINDS,
  streamReason,
  holdNote,
  runTitle,
  earlierWork,
  blockedByEarlierWork,
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
  RUN_KINDS,
} from "../lib/format.js";
import { Button, Select, Segmented, Chips, Meter, Icon, Tag, Mark, Empty, Meta, RowBody, Section, More, Popover, Switch, RelativeTime } from "../ui/index.js";

// The switch of a section with its own pause (queued runs, inbox triage, upstream reviews, CI repairs), for its page's actions.
export const SectionSwitch = ({ kind, label, on, off }) => html`<label class="automation"><${Switch} label=${label} checked=${live.value[kind]} disabled=${busy.value} onChange=${() => actions.toggle(kind)} /><b>${live.value[kind] ? on : off}</b></label>`;


export function Machine({ provider }) {
  const stream = (statusSection("streams").value || []).find((s) => s.driver === provider.driver) || {};
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
      <h2><${Icon} name=${providerIcon(provider.driver)} /> ${provider.name} <span class="load" title="Running now of the automatic limit"><span class="pips" aria-hidden="true">${Array.from({ length: Math.min(limit || 0, 12) }, (_, i) => html`<i class=${i < active ? "on" : ""}></i>`)}</span><b>${active}</b>${limit ? ` of ${limit}` : ""} ${limit === 1 ? "slot" : "slots"}</span></h2>
      <span class=${`reason${held ? " tone-attention" : ""}`}>${reason}${quota?.capturedAt && html`<${RelativeTime} class="muted" text=${(now) => ` · ${ago(quota.capturedAt, now)}`} title=${(now) => `Allowance read ${ago(quota.capturedAt, now)}`} />`}</span>
      ${held && html`<${Button} size="sm" icon="play" label=${`Start the next eligible ticket on ${provider.name} anyway, overriding its limits`} disabled=${busy.value} onClick=${() => startRun(anyway)} />`}
    </header>
    ${windows.length
      ? windows.map((w) => html`<${Meter} key=${w.label} label=${w.label} value=${w.value} marker=${w.marker} note=${w.reset ? html`<${RelativeTime} at=${w.reset} form="in" title=${(now) => `Resets ${until(w.reset, now)}`} />` : ""} />`)
      : html`<p class="muted small">${stream.quotaError ? `Allowance unavailable: ${stream.quotaError}` : "No allowance reading yet."}</p>`}
    ${(stream.models || []).length > 0 &&
    html`<p class="model-reasons">
      ${stream.models.map((m) => html`<span key=${m.id}><b>${m.name}</b>${assigned === m.name && html`<${Tag} tone="on" title="The next automatic run uses this model">next<//>`} ${streamReason(m.reason)}</span>`)}
    </p>`}
  </section>`;
}

// What a request starts. An Epic request carries only its ID, so its name comes from the current status.
export const requestName = ({ upstream, ticket, epic, reconcile }) => {
  if (reconcile) return `Investigate ${ticket}`;
  if (!epic) return upstream || ticket;
  const known = [...(needSection("epics").value ?? []), ...(statusSection("plans").value ?? []).flatMap(p => p.epic ?? [])].find(e => e.id === epic);
  return `Epic ${known?.title ?? epic}`;
};

function Operation({ op }) {
  return html`<div class=${`operation ${op.state}`} role="status">
    ${op.state === "running" && html`<i class="spinner"></i>`}
    <span><b class="key">${requestName(op.input) || "Next eligible ticket"}</b> · ${op.input.provider ? providerName(op.input.provider) : op.input.model} · ${overrideText(op.input.overrideLimits)}<br />${operationText(op)}${op.state === "uncertain" && html` <span class="muted">This request will not be resent automatically.</span>`}</span>
    <${OperationActions} op=${op} />
  </div>`;
}

// What can be done with a request that ended without starting. The request row and the notification area share these.
export function OperationActions({ op }) {
  const d = op.result?.data, settled = !["queued", "running"].includes(op.state), held = settled && earlierWork(op);
  return html`${held && html`<${Investigate} held=${held} onStart=${() => actions.dismissOperation(op.id)} />`}
    ${!op.choiceHandled && d?.reason === "blocked-ticket-plan-required" && html`<${Button} size="sm" icon="checklist" label="Choose how to run it" onClick=${() => showBlockedChoice(op.id)} />`}
    ${op.notReceived && html`<${Button} size="sm" icon="sync" label="Retry saved request" onClick=${() => retryRequest(op.id)} />`}
    ${!["queued", "running"].includes(op.state) && html`<${Button} variant="ghost" size="sm" icon="x" label=${`Dismiss ${requestName(op.input) || "request"}`} onClick=${() => actions.dismissOperation(op.id)} />`}`;
}

export const modelOptions = () => [["auto", "Auto"], ...config.value.models.map((m) => [m.id, m.name])];

// Start bar: project key, dash, ticket number; model; override; start. An empty number means the next eligible ticket.
export function Composer({ initialTicket } = {}) {
  const linked = initialTicket !== undefined;
  // Every configured project: automatic work off does not stop a named start.
  const keys = [...new Set(config.value.projects.filter((p) => p.key).map((p) => p.key))];
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
    <input class="mono ticket-number" value=${number} onInput=${(e) => { const parsed = parseTicketInput(e.target.value, keys); if (parsed.project) setProject(parsed.project); setNumber(e.target.value = parsed.number); }} placeholder=${linked ? "number" : "next eligible"} required=${linked} inputmode="numeric" aria-label="Ticket number" title=${number ? `Ticket ${project}-${number}` : "Leave empty to start the next eligible ticket"} />
    <${Select} label="Model" value=${model} onChange=${setModel} options=${modelOptions()} />
    <${Select} multiple class="overrides" placeholder="Respect limits" label="Override limits" value=${overrides} onChange=${setOverrides} options=${OVERRIDES} summary=${(names) => names.length === OVERRIDES.length ? "Override all" : `Override ${names.length} of ${OVERRIDES.length}`} />
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
    return [plan.queued ? "" : "Next", "attention", holdNote(t.note) ?? (plan.state ? "waiting for a slot" : "")];
  };
  // A ticket a running chain or Epic keeps waiting can be started by name: every limit overridden, any model the
  // page's provider choice allows. The plan stays as it is and goes on when the run finishes.
  const startNow = (t) => forceStart(t.key);
  const reasons = (t) => [
    t.runnable === false && "Its project is not included in the factory",
    t.automationReady === false ? t.readiness?.reasons?.map((r) => r.message).join("; ") || "Automation readiness is off" : t.hold,
  ];
  return all.filter(show).map((t) => {
    const job = jobByTask.get(t.id), [label, tone, note] = state(t, job);
    // The scheduler writes the same not-included note, so a repeated reason shows once.
    const detail = [...new Set([note || (job ? modelName(config.value, job) : ""), t.outside && "outside this Epic", ...(t.done || job ? [] : reasons(t).map(holdNote))])].filter(Boolean).join(" · ");
    // The row opens the ticket in Factory's panel, which lists its runs; a modified or middle click keeps the tracker tab.
    // Earlier work in the way of a ticket that is next: the scheduler says so in its note.
    const blocked = !job && blockedByEarlierWork(t);
    const waiting = label === "Next" && !t.done && !job && plan.state === "active" && !blocked;
    // The short reason is the row's; hovering or opening the ticket gives the scheduler's own words.
    const full = [t.note, ...(t.done || job ? [] : reasons(t))].filter(Boolean).join(" · ");
    return html`<a class="chain-row" key=${t.id} href=${ticketLink(config.value, { taskId: t.id, projectId: t.projectId })} target="_blank" rel="noopener noreferrer" onClick=${ticketClick(ticketKey(t.key))}>
      <${Mark} tone=${label ? tone : ""} label=${label || "Queued"} /><${RowBody} title=${html`<b class="key">${t.key}</b> ${t.title}`}>${html`<${Meta} automationReady=${t.automationReady}><span class="row-key" aria-hidden="true">${t.key}</span>${label && html`<${Tag} tone=${tone}>${label}<//>`}${detail && html`<span class="meta-detail" title=${full || undefined}>${detail}</span>`}<//>`}<//>
    <//>${(blocked || waiting) && html`<span class="chain-fix" key=${`${t.id}-fix`}>${blocked
      ? html`<${Investigate} held=${{ key: t.key, id: t.id, conflict: "artifacts" }} />`
      : html`<${Button} size="sm" icon="play" class="next-run" label=${`Start ${t.key} now: any model, every limit overridden`} disabled=${busy.value || pendingRun(t.key)} onClick=${() => startNow(t)} />`}</span>`}`;
  });
}
export const planProgress = (plan) => {
  const all = plan.target ? [...plan.tickets, plan.target] : plan.tickets;
  return `${all.filter((t) => t.done).length} of ${all.length} done`;
};
export const CancelPlan = ({ plan, title, label, icon = "x", class: extra, danger }) => html`<${Button} variant=${danger ? "danger" : "ghost"} size="sm" icon=${icon} label=${label} class=${`btn-icon ${extra ?? ""}`} disabled=${busy.value} onClick=${() => confirmAction({ title, message: "Tickets already running finish on their own.", label }, () => actions.cancelPlan(plan.id))}><span class="next-action-label">${label}</span><//>`;

// The bar that opens a ticket's or an Epic's panel, under its head: where it stands in Factory, in a mark and a few
// words, and what can be done about it. It stays at the panel's top while the text under it scrolls.
export const PanelBar = ({ tone, progress, label, detail, children }) => html`<div class="panel-bar">
  <span class="panel-standing">${label && html`<${Mark} tone=${tone} progress=${progress} label=${label} /><b>${label}</b>${detail && html`<span>${detail}</span>`}`}</span>
  <span class="panel-actions">${children}</span>
</div>`;

// The actions that follow a row's main one: beside it where the row has room, behind one More button where it has not.
// Each action carries a `.next-action-label`, which the menu shows beside its icon.
export function RowActions({ label, children }) {
  const [open, setOpen] = useState(false), button = useRef();
  return html`<div class="next-secondary">${children}</div>
    <span ref=${button} class="next-more"><${Button} size="sm" icon="kebab" class="next-run" label=${label} aria-expanded=${open} onClick=${() => setOpen(!open)} /></span>
    <${Popover} class="next-menu" open=${open} onClose=${() => setOpen(false)} anchor=${button} label=${label} width=${220}>
      <div onClick=${() => setOpen(false)}>${children}</div>
    <//>`;
}

// A ticket that already has an open run or is the target of an active chain.
// Held queue rows carry a key without a tracker ID.
const sameTicket = (t) => { const key = ticketKey(t.key); return (id, otherKey) => (t.id && id === t.id) || (key && ticketKey(otherKey) === key); };
const openJob = (t) => { const matches = sameTicket(t); return jobs.value.some(j => matches(j.taskId, j.ticketKey) && isOpen(j)); };
export const openRun = (t) => { const matches = sameTicket(t); return openJob(t) || (statusSection("plans").value ?? []).some(p => p.state === "active" && p.target && matches(p.target.id, p.target.key)); };

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
// With a `link` as well, the chevron alone is the disclosure and the body stays the link.
// `mark` leads the row with its state at a glance.
export function TicketRow({ ticket: t, project, children, actions, secondaryActions, selection, badge, plain, link, meta, toggle, mark }) {
  const c = config.value;
  const label = `More actions for ${t.key ?? t.title}`;
  // A ticket or an inbox report opens in Factory's own panel; a modified or middle click keeps the link's tracker tab.
  const panel = ticketClick(ticketKey(t.key ?? ""));
  const body = html`<${RowBody} tip=${typeof t.title === "string" ? t.title : undefined} title=${t.key ? html`<b class="key">${t.key}</b> ${t.title}` : t.title}>
    <${Meta} project=${project?.name ?? t.project ?? t.projectId} automationReady=${t.automationReady} priority=${t.priority} difficulty=${plain ? undefined : t.difficulty || false} labels=${t.labels ?? []} highlight=${(project?.priorityLabels ?? []).flat()} ...${meta}>${t.key && html`<span class="row-key" aria-hidden="true">${t.key}</span>`}${badge}${children}<//>
  <//>`;
  return html`<div class="next" key=${t.id}>
    ${selection}
    ${toggle && link
      ? html`<button type="button" class="next-toggle next-chevron" aria-label=${toggle.label} title=${toggle.label} aria-expanded=${toggle.expanded} disabled=${toggle.disabled} onClick=${toggle.onClick}><${Icon} name="chevronRight" /></button>${mark}<a class="next-ticket next-wrap" ...${link}>${body}</a>`
      : toggle
      ? html`<button type="button" class="next-ticket next-toggle next-wrap" aria-expanded=${toggle.expanded} disabled=${toggle.disabled} onClick=${toggle.onClick}><${Icon} name="chevronRight" />${body}</button>`
      : html`${mark}<a class="next-ticket" ...${link ?? { href: ticketLink(c, { taskId: t.id, projectId: t.projectId }), target: "_blank", rel: "noopener noreferrer", onClick: panel }}>${body}</a>`}
    ${(actions || secondaryActions) && html`<div class="next-actions">${actions}
      ${secondaryActions && html`<${RowActions} label=${label}>${secondaryActions}<//>`}
    </div>`}
  </div>`;
}

// Manual starts share independent provider and limit override choices.
// Ticket lists share the choice.
export const startOptions = () => {
  const provider = sessionProvider.value === "auto" ? undefined : sessionProvider.value;
  return { provider, overrideLimits: sessionOverrides.value };
};
// The limits a manual start overrides, as chips. `limits` narrows them to the ones the caller's actions use;
// `value` may be `true`, which is every limit.
export function OverrideChips({ value, onChange, limits, disabled }) {
  const shown = OVERRIDES.filter(([key]) => !limits || limits.includes(key)), keys = shown.map(([key]) => key);
  const all = OVERRIDES.map(([key]) => key).filter((key) => value === true || value?.includes(key));
  return html`<${Chips} label="Override limits" disabled=${disabled} value=${all.filter((key) => keys.includes(key))} onChange=${(next) => onChange([...all.filter((key) => !keys.includes(key)), ...next])} options=${shown.map(([key, name, icon]) => [key, html`<${Icon} name=${icon} /> ${name}`, `Override ${name.toLowerCase()}${key === "providers" ? ", including providers set to Off" : ""}`])} />`;
}
// `limits` drops the provider choice with the overrides a page's actions do not use.
// The page shows one button with the chosen provider's glyph. Its panel names each choice.
// The panel stays mounted while closed, so its controls are always the page's one source of the choice.
export function StartOptions({ limits } = {}) {
  const anchor = useRef(), [open, setOpen] = useState(false);
  if (limits) return html`<${OverrideChips} value=${sessionOverrides.value} onChange=${setSessionOverrides} limits=${limits} />`;
  const provider = sessionProvider.value;
  const summary = `${provider === "auto" ? "Auto" : providerName(provider)}, ${overrideText(sessionOverrides.value).toLowerCase()}`;
  return html`<span ref=${anchor} class="start-options"><${Button} size="sm" icon=${provider === "auto" ? "zap" : providerIcon(provider)} label=${`Start options: ${summary}`} aria-expanded=${open} onClick=${() => setOpen(!open)} /></span>
    <${Popover} mounted class="start-options-panel" open=${open} onClose=${() => setOpen(false)} anchor=${anchor} label="Start options" width=${320}>
      <div class="field"><span class="field-label">Start on</span>
        <${Segmented} label="Start provider" value=${provider} onChange=${setSessionProvider} options=${[["auto", "Auto"], ...[...PROVIDERS].reverse().map(p => [p.driver, p.name])]} /></div>
      <div class="field"><span class="field-label">Override</span><${OverrideChips} value=${sessionOverrides.value} onChange=${setSessionOverrides} /></div>
    <//>`;
}

// Newest or oldest first, for ticket and run lists. It sits in the list's filter panel, named `label`.
export const OrderChoice = ({ label, value, onChange, disabled }) => html`<${Segmented} named label=${label} value=${value} onChange=${onChange} disabled=${disabled} icons=${{ newest: "arrowDown", oldest: "arrowUp" }} options=${[["newest", "Newest first"], ["oldest", "Oldest first"]]} />`;

// Icon-only start of one ticket through the ordinary checks; `hold` names why it is disabled, `origin` the page that started it.
// A named start that passes every limit, for a ticket its queue, chain or Epic keeps waiting; the page's provider choice applies.
export const forceStart = (key) => { const { provider } = startOptions(); return startRun({ ticket: key, model: "auto", ...(provider ? { provider } : {}), overrideLimits: true }); };
export const runNow = (t, hold, origin, { overrideLimits = true, provider } = {}) => !startHold(t) && !hold ? startRun({ ticket: t.key, model: "auto", overrideLimits, ...(provider ? { provider } : {}) }, origin) : null;
export const RunNow = ({ ticket: t, hold, origin, overrideLimits = true, provider }) => html`<${Button} size="sm" icon class="next-run" aria-label=${`Run ${t.key} now`} disabled=${!!hold}
  title=${hold ?? `${overrideText(overrideLimits)} and start this ticket now.`}
  onClick=${() => runNow(t, hold, origin, { overrideLimits, provider })}><${Icon} name="play" /><//>`;

// A held row whose ticket waits on earlier threads, branches or PRs: after a confirmation, a run settles that work.
// An icon button named by its tooltip, offered wherever the hold is stated. `quiet` is for a list of several, where one
// accent button per row would shout. `onStart` runs once the request is on its way.
export const Investigate = ({ held: h, quiet, onStart }) => h.conflict === "artifacts" && html`<${Button} size="sm" variant=${quiet ? undefined : "primary"} icon="search" class="investigate next-run" label="Investigate and fix in T3" disabled=${!!pendingRun(h.key) || openJob(h)}
  onClick=${() => confirmAction({ title: `Investigate ${h.key} in T3?`, message: "A Factory run in a new T3 thread closes the ticket if its work already merged, delivers unmerged work, or removes clean abandoned branches, worktrees and threads so the ticket can start again. Active sessions are left alone.", label: "Start run" },
    () => { if (startRun({ ticket: h.key, reconcile: true, model: "auto", ...startOptions() })) onStart?.(); })} />`;

// What the factory would start next, in order. The same list feeds the deck and the runs page.
// The whole list renders a page of rows at a time: a phone should not lay out hundreds it has not scrolled to.
const UP_NEXT_PAGE = 60;
export function UpNext({ limit = 5, children, filters, query = "", start }) {
  const [pages, setPages] = useState(1);
  const c = config.value,
    q = needSection("upNext").value,
    visible = t => !startHold(t) && matchesRunFilters(t, filters, query),
    tickets = (q?.tickets ?? []).filter(visible),
    held = (q?.held ?? []).filter(visible),
    all = limit === Infinity;
  const project = (id) => c.projects.find((p) => p.kanvilId === id);
  return html`<${Section} title="Up next" count=${q ? tickets.length : null} aside=${children}>
    ${!q
      ? html`<${Empty}>The queue has not been read yet.<//>`
      : tickets.length
        ? html`${tickets.slice(0, all ? pages * UP_NEXT_PAGE : limit).map((t) => html`<${TicketRow} key=${t.id} ticket=${t} project=${project(t.projectId)} actions=${html`<${RunNow} ticket=${t} hold=${startHold(t)} ...${start} />`}>
            ${t.after?.length > 0 && html`<b class="tone-attention">after ${t.after.join(", ")}</b>`}
          <//>`)}
          ${all && tickets.length > pages * UP_NEXT_PAGE && html`<${Button} variant="ghost" size="sm" onClick=${() => setPages(pages + 1)}>Show ${Math.min(UP_NEXT_PAGE, tickets.length - pages * UP_NEXT_PAGE)} more of ${tickets.length - pages * UP_NEXT_PAGE}<//>`}`
        : html`<${Empty}>${query.trim() || hasRunFilters(filters) ? held.length ? "No ready tickets match." : "No tickets match." : "Nothing is ready to start."}<//>`}
    ${all && held.length > 0 && html`<h3 class="held-title">Held back<small>${held.length}</small></h3>
      ${Object.entries(Object.groupBy(held, (h) => h.reason)).map(([reason, list]) => html`<div class="held-group" key=${reason}>
        <p class="held-reason">${reason}<small>${list.length}</small></p>
        ${list.map((h) => html`<div class="held" key=${h.key}><a class="held-ticket" href=${`?ticket=${encodeURIComponent(ticketKey(h.key))}`} onClick=${ticketClick(ticketKey(h.key))}><${RowBody} tip=${h.title} title=${html`<b class="key">${h.key}</b> ${h.title}`}><${Meta} automationReady=${h.automationReady} priority=${h.priority} difficulty=${h.difficulty} labels=${h.labels ?? []}><span class="row-key" aria-hidden="true">${h.key}</span><//><//></a><${Investigate} held=${h} quiet /></div>`)}
      </div>`)}`}
    ${q && html`<p class="hint">Queue read <${RelativeTime} at=${q.at} />${!all && held.length ? `. ${held.length} held back` : ""}.</p>`}
  <//>`;
}

// One run. Used on the deck, the runs page, upstream reviews and CI repairs.
// `selected` is set by the Runs list: true marks the row as the run shown beside it, and either value keeps the click in place.
export function RunRow({ job, showProject = true, selected }) {
  const c = config.value,
    project = projectOf(c, job),
    ticket = ticketLink(c, job),
    prs = (job.prUrls || []).map(safeLink).filter(Boolean),
    waiting = job.state === "waiting",
    active = isActive(job),
    // Every way of opening the run from the row behaves alike: in place from the Runs list, a page change elsewhere.
    open = selected === undefined ? follow : followRun;
  // Short on the row, spelled out on hover.
  const timing = (now) => active
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
  return html`<${TicketRow} ticket=${{ ...job, id: job.taskId, key: job.label, title: runTitle(job) }} project=${project} plain
    link=${{ href: `/runs/${job.id}`, onClick: open, "aria-current": selected ? "true" : undefined }}
    mark=${html`<${Mark} tone=${toneOf(job.state) || (active ? "on" : "")} label=${stateLabel(job.state)} />`}
    meta=${{ project: showProject ? project?.name : undefined, difficulty: job.difficulty, kind: RUN_KINDS[job.kind]?.[0], model: html`<span title=${`Model: ${providerName(providerOf(job))} ${modelName(c, job)}`}><${Icon} name=${providerIcon(providerOf(job))} /> ${modelName(c, job)}</span>` }}
    badge=${html`<${Tag} state=${job.state} title=${note || stateLabel(job.state)} />`}
    secondaryActions=${(ticket || prs.length > 0 || job.threadId || isOpen(job)) && html`${ticket && html`<a class="btn btn-sm btn-icon next-run" href=${ticket} target="_blank" rel="noopener noreferrer" aria-label=${`Open ticket ${job.label}`} title=${`Open ticket ${job.label}`}><${Icon} name="tag" /><span class="next-action-label">Open ticket</span></a>`}
      ${prs.map(href => html`<a key=${href} class="btn btn-sm btn-icon next-run" href=${href} target="_blank" rel="noopener noreferrer" aria-label=${prLabel(href)} title=${prLabel(href)}><${Icon} name="pullRequest" /><span class="next-action-label">${prLabel(href)}</span></a>`)}
      ${job.threadId && html`<a class="btn btn-sm btn-icon next-run" href=${threadLink(job)} aria-label=${`Open ${job.label} in T3 Code`} title=${`Open ${job.label} in T3 Code`}><${Icon} name="commentDiscussion" /><span class="next-action-label">Open session</span></a>`}
      ${isOpen(job) && html`<${Button} variant="danger" size="sm" icon="circleSlash" class="btn-icon next-run" label=${`Stop run ${job.label}`} disabled=${busy.value} onClick=${() => confirmAction({ title: `Stop ${job.label}?`, message: "T3 ends the run; the worktree and any open PR stay as they are.", label: "Stop run" }, () => actions.stopJob(job.id))}><span class="next-action-label">Stop run</span><//>`}`}>
    <${RelativeTime} class="muted" text=${(now) => timing(now)[0]} title=${(now) => timing(now)[1]} />
    ${note && html`<span class="tone-attention meta-note">${note}</span>`}
  <//>`;
}

// `limit` shows the first rows and one control, labelled `more`, that calls `onMore`.
export function RunList({ list, title, count, aside, selected, limit = Infinity, more, onMore }) {
  return html`<${Section} class="list" title=${title} count=${count} aside=${aside}>
    ${list.slice(0, limit).map((j) => html`<${RunRow} key=${j.id} job=${j} selected=${selected === undefined ? undefined : j.id === selected} />`)}
    ${list.length > limit && html`<${Button} variant="ghost" size="sm" onClick=${onMore}>${more}<//>`}
  <//>`;
}

export function RunGroup({ title, list, limit = 8, empty, children }) {
  const [all, setAll] = useState(false);
  return html`<${Section} title=${list.length ? null : title} count=${list.length || null} aside=${list.length ? null : children}>
    ${list.length ? html`<${RunList} list=${list} limit=${all ? Infinity : limit} more=${`Show all ${list.length}`} onMore=${() => setAll(true)} title=${title} count=${list.length} aside=${children} />` : empty && html`<${Empty}>${empty}<//>`}
  <//>`;
}
