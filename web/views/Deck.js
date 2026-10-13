// Home: what the factory is doing right now, why, and what needs you.
import { html, useEffect, useRef, useState } from "../lib/h.js";
import { config, status, live, busy, jobs, journal, history, operation, dispatching, clock, serverNow, actions, startRun, retryRequest, showReadinessConfirmation, showBlockedChoice, loadHistory } from "../lib/store.js";
import { follow } from "../lib/router.js";
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
  safeLink,
  prLabel,
  threadLink,
  modelName,
  projectOf,
  difficultyLabel,
  byNewest,
  byFinished,
  isFinished,
  isOpen,
  STOPS,
  stopOf,
} from "../lib/format.js";
import { Button, Switch, Check, Select, Meter, Stops, Icon, Tag, Link, Empty, Timeline, Help } from "../ui/index.js";

function Status() {
  const on = live.value.enabled,
    d = status.value.decision,
    now = serverNow();
  const next = d?.at ? Date.parse(d.at) + (config.value.pollSeconds ?? 60) * 1000 : null;
  return html`<section class="status">
    <div class="status-main">
      <${Switch} label="Automation" checked=${on} disabled=${busy.value} onChange=${() => actions.toggle("enabled")} />
      <div>
        <h1>${on ? "Automation on" : "Automation paused"}</h1>
        <p>${decisionSentence(d)}</p>
      </div>
    </div>
    <div class="status-meta">
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
      <h2>${provider.name}</h2>
      <span class="reason">${reason}</span>
    </header>
    <p class="slots">
      <b>${active}</b> running${limit ? ` of ${limit}` : ", automatic starts off"}
      ${assigned && html`<span class="muted"> · next automatic run uses ${assigned}</span>`}
    </p>
    ${windows.length
      ? windows.map((w) => html`<${Meter} key=${w.label} label=${w.label} value=${w.value} marker=${w.marker} note=${w.reset ? `resets ${until(w.reset, now)}` : ""} />`)
      : html`<p class="muted small">${stream.quotaError ? `Allowance unavailable: ${stream.quotaError}` : "No allowance reading yet."}</p>`}
    ${(stream.models || []).length > 0 &&
    html`<p class="model-reasons">
      ${stream.models.map((m) => html`<span key=${m.id}><b>${m.name}</b> ${streamReason(m.reason)}</span>`)}
    </p>`}
    ${quota?.capturedAt && html`<p class="muted small checked">Quota read ${ago(quota.capturedAt, now)}</p>`}
  </section>`;
}

function Operation() {
  const op = operation.value;
  if (!op) return null;
  const d = op.result?.data,
    running = op.state === "running";
  const text = running
    ? "Checking the ticket and starting its T3 run"
    : d?.reason === "dispatched"
      ? `Started ${d.ticket || "ticket"} with ${d.model}.`
      : d?.skipped?.[0]?.reason || d?.message || d?.reason || "Check factory status before retrying.";
  return html`<div class=${`operation ${op.state}`} role="status">
    ${running && html`<i class="spinner"></i>`}
    <span>${text}${op.state === "uncertain" && html` <span class="muted">This request will not be resent automatically.</span>`}</span>
    ${d?.reason === "ready-label-confirmation-required" && html`<${Button} size="sm" onClick=${showReadinessConfirmation}>Review and run anyway<//>`}
    ${d?.reason === "blocked-ticket-plan-required" && html`<${Button} size="sm" onClick=${showBlockedChoice}>Choose how to run it<//>`}
    ${op.notReceived && html`<${Button} size="sm" onClick=${retryRequest}>Retry saved request<//>`}
    ${!running && html`<${Button} variant="ghost" size="sm" icon aria-label="Dismiss" onClick=${actions.dismissOperation}>×<//>`}
  </div>`;
}

export function Composer() {
  const [ticket, setTicket] = useState("");
  const [model, setModel] = useState("auto");
  const [override, setOverride] = useState(true);
  const submit = (e) => {
    e.preventDefault();
    startRun({ ticket: ticket.trim(), model, overrideLimits: override });
    setTicket("");
  };
  return html`<form class="composer" onSubmit=${submit}>
    <input class="mono" value=${ticket} onInput=${(e) => setTicket(e.target.value)} placeholder="Next eligible ticket" aria-label="Ticket key" autocapitalize="characters" spellcheck="false" />
    <${Select} label="Model" value=${model} onChange=${setModel} options=${[["auto", "Automatic model"], ...config.value.models.map((m) => [m.id, m.name])]} />
    <${Check} label="Override limits" checked=${override} onChange=${(e) => setOverride(e.target.checked)} hint="Skips idle and reserve thresholds. Readiness, difficulty, duplicate checks, and merge rules still apply." />
    <${Button} variant="primary" type="submit" disabled=${busy.value || dispatching.value}>Start run<//>
  </form>`;
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
    return html`<section class="group" key=${p.id}>
      <header>
        <h2>Chain to ${p.target.key} <small>${done} of ${all.length} done</small></h2>
        <${Button} variant="ghost" size="sm" disabled=${busy.value} onClick=${() => confirm(`Cancel the chain to ${p.target.key}? Tickets already running finish on their own.`) && actions.cancelPlan(p.id)}>Cancel chain<//>
      </header>
      ${all.map((t) => {
        const [label, tone, note] = state(t), job = jobByTask.get(t.id);
        const row = html`<span class="chain-body"><span><b class="key">${t.key}</b> ${t.title}</span><small>${note || (job ? `${modelName(config.value, job)}` : "")}</small></span>`;
        return html`<${job ? "a" : "div"} class="chain-row" key=${t.id} href=${job ? `/runs/${job.id}` : undefined} onClick=${job ? follow : undefined}>
          <${Tag} tone=${tone}>${label}<//>${row}
        <//>`;
      })}
    </section>`;
  });
}

// What the factory would start next, in order. The same list feeds the deck and the runs page.
export function UpNext({ limit = 5, children }) {
  clock.value;
  const c = config.value,
    q = status.value.upNext,
    tickets = q?.tickets ?? [],
    held = q?.held ?? [],
    all = limit === Infinity;
  const project = (id) => c.projects.find((p) => p.kaneoId === id);
  return html`<section class="group">
    <header><h2>Up next ${tickets.length > 0 && html`<small>${tickets.length}</small>`}</h2>${children}</header>
    ${!q
      ? html`<${Empty}>The queue has not been read yet.<//>`
      : tickets.length
        ? tickets.slice(0, limit).map(
            (t, i) => html`<a class="next" key=${t.id} href=${ticketLink(c, { taskId: t.id, projectId: t.projectId })} target="_blank" rel="noopener noreferrer">
              <span class="rank">${i + 1}</span>
              <span class="next-body">
                <span><b class="key">${t.key}</b> ${t.title}</span>
                <small>${t.after?.length ? html`<b class="tone-attention">after ${t.after.join(", ")}</b> · ` : ""}${project(t.projectId)?.name ?? t.projectId} · ${t.difficulty ?? "unclassified"} · ${t.priority}${t.labelRank != null ? ` · ${project(t.projectId)?.priorityLabels?.[t.labelRank] ?? "priority label"}` : ""}</small>
              </span>
              <span class=${`next-model ${t.model ? "" : "tone-attention"}`}>${t.model ?? "no automatic model fits"}</span>
            </a>`,
          )
        : html`<${Empty}>Nothing is ready to start.<//>`}
    ${all && held.length > 0 && html`<h3 class="held-title">Held back</h3>${held.map((h) => html`<div class="held" key=${h.key}><b class="key">${h.key}</b><span>${h.reason}</span></div>`)}`}
    ${q && html`<p class="hint">Queue read ${ago(q.at, serverNow())}${!all && held.length ? `. ${held.length} held back` : ""}.</p>`}
  </section>`;
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
      ${job.kind && job.kind !== "ticket" && html`<${Tag}>${job.kind === "upstream" ? "review" : "discovery"}<//>`}
      ${note && html`<span onClick=${(e) => e.stopPropagation()}><${Help} text=${note} glyph=${waiting ? "!" : "i"} tone=${waiting ? "attention" : ""} /></span>`}
    </span>
    <span class="run-meta">
      ${showProject && project && html`<span>${project.name}</span>`}
      <span><${Icon} name=${providerIcon(providerOf(job))} label=${providerName(providerOf(job))} /> ${modelName(c, job)}</span>
      ${job.difficulty && html`<${Tag} title=${`${difficultyLabel(job.difficulty)} difficulty`}>${job.difficulty}<//>`}
    </span>
    <${Stops} n=${stopOf(job.state)} tone=${toneOf(job.state)} label=${stateLabel(job.state)} />
    <span class="run-state muted" title=${timingTitle}><b class="run-stop">${stateLabel(job.state)}</b>${timing}</span>
    <span class="run-links" onClick=${(e) => e.stopPropagation()}>
      ${prs.map((href) => html`<${Link} key=${href} href=${href} class="run-pr" title=${prLabel(href)}><${Icon} name="pullRequest" label=${prLabel(href)} /><//>`)}
    </span>
  </a>`;
}

// Rows share one grid so the track column lines up under its legend. The pane around the grid is the
// size container, since a container query cannot read the queried element's own width.
export function RunList({ list, now = serverNow() }) {
  return html`<div class="runs-pane"><div class="runs">
    <div class="run-legend" aria-hidden="true">${STOPS.map((s) => html`<span key=${s}>${s}</span>`)}</div>
    ${list.map((j) => html`<${RunRow} key=${j.id} job=${j} now=${now} />`)}
  </div></div>`;
}

export function RunGroup({ title, list, limit = 8, empty, children }) {
  const [all, setAll] = useState(false);
  const visible = all ? list : list.slice(0, limit);
  return html`<section class="group">
    <header><h2>${title} ${list.length > 0 && html`<small>${list.length}</small>`}</h2>${children}</header>
    ${list.length ? html`<${RunList} list=${visible} />` : empty && html`<${Empty}>${empty}<//>`}
    ${!all && list.length > limit && html`<${Button} variant="ghost" size="sm" onClick=${() => setAll(true)}>Show all ${list.length}<//>`}
  </section>`;
}

const PULL = 60;
function usePullToRefresh(onRefresh) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current;
    let start = null;
    const move = (e) => {
      if (start === null) return;
      const dy = e.touches[0].clientY - start;
      if (dy <= 0) return void ((start = null), (el.style.height = "0px"));
      if (e.cancelable) e.preventDefault();
      const d = Math.min(dy / 2, PULL);
      el.style.height = d + "px";
      el.textContent = d >= PULL ? "Release to refresh" : "Pull to refresh";
    };
    const begin = (e) => {
      start = window.scrollY === 0 ? e.touches[0].clientY : null;
      el.classList.remove("settle");
    };
    const end = async () => {
      if (start === null) return;
      start = null;
      el.classList.add("settle");
      if (parseFloat(el.style.height) >= PULL) {
        el.textContent = "Refreshing";
        await onRefresh();
      }
      el.style.height = "0px";
    };
    document.addEventListener("touchstart", begin, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end, { passive: true });
    return () => {
      document.removeEventListener("touchstart", begin);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
    };
  }, []);
  return ref;
}

export function Deck() {
  const ptr = usePullToRefresh(actions.refresh);
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
    <div ref=${ptr} class="ptr" aria-live="polite"></div>
    <${Status} />
    <div class="strip">${PROVIDERS.map((p) => html`<${Machine} key=${p.driver} provider=${p} />`)}</div>
    <div class="deck">
      <div class="deck-main">
        <section class="group">
          <header><h2>Start a run</h2></header>
          <${Composer} />
          <${Operation} />
        </section>
        <${RunGroup} title="Open" list=${[...waiting, ...running]} empty="Nothing is running.">
          ${waiting.length > 0 && html`<span class="tone-attention">${waiting.length} need${waiting.length === 1 ? "s" : ""} you</span>`}
        <//>
        <${Chains} />
        <${UpNext}><a href="/runs?state=next" onClick=${follow}>Whole queue</a><//>
        <${RunGroup} title="Finished recently" list=${done} limit=${5} empty="Nothing has finished yet.">
          <a href="/runs" onClick=${follow}>All runs</a>
        <//>
      </div>
      <aside class="deck-side">
        <section class="group">
          <header><h2>Activity</h2><a href="/activity" onClick=${follow}>Everything</a></header>
          ${journal.value.length ? html`<${Timeline} events=${journal.value.slice(0, 12)} />` : html`<${Empty}>Nothing recorded yet.<//>`}
        </section>
      </aside>
    </div>`;
}
