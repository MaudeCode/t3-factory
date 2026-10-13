// Home: what the factory is doing right now, why, and what needs you.
import { html, useEffect, useRef, useState } from "../lib/h.js";
import { config, status, live, busy, jobs, journal, history, operation, dispatching, clock, serverNow, actions, startRun, retryRequest, showReadinessConfirmation, loadHistory } from "../lib/store.js";
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
} from "../lib/format.js";
import { Button, Switch, Check, Select, Meter, Tag, Link, Empty, Timeline, useReady } from "../ui/index.js";

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
      ${next && on && html`<span>Next check ${next > now + 1000 ? until(next, now) : "due now"}</span>`}
    </div>
  </section>`;
}

function Machine({ provider }) {
  const ready = useReady();
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
  return html`<section class=${`machine ${ready ? "ready" : ""}`}>
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
      : html`<p class="muted small">No quota reading yet.</p>`}
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

// One run. Used on the deck, the runs page, and upstream reviews.
export function RunRow({ job, now = serverNow(), showProject = true }) {
  const c = config.value,
    project = projectOf(c, job),
    ticket = ticketLink(c, job),
    prs = (job.prUrls || []).map(safeLink).filter(Boolean),
    waiting = job.state === "waiting",
    active = isActive(job);
  const timing = active
    ? `${duration(job.createdAt)} in, active ${ago(job.lastExecutionAt ?? job.createdAt, now)}`
    : waiting
      ? `since ${ago(job.lastExecutionAt ?? job.createdAt, now)}`
      : job.completedAt
        ? `${ago(job.completedAt, now)}, took ${duration(job.createdAt, job.completedAt)}`
        : job.dismissedAt
          ? `${ago(job.dismissedAt, now)}, after ${duration(job.createdAt, job.dismissedAt)}`
          : ago(job.createdAt, now);
  // Settling in T3 is the ordinary way a run ends, so only an unusual reason is worth a line.
  const note = waiting ? (job.thread?.pending ? PENDING_KINDS[job.thread.pending] ?? `waiting: ${job.thread.pending}` : job.reason) : job.state === "dismissed" && !/^Dismissed by settling/.test(job.reason ?? "") ? job.reason : "";
  return html`<a class=${`run ${job.state}`} href=${`/runs/${job.id}`} onClick=${follow}>
    <span class="run-key">
      ${ticket ? html`<${Link} href=${ticket} class="key">${job.label}<//>` : html`<b class="key">${job.label}</b>`}
      ${job.kind && job.kind !== "ticket" && html`<${Tag}>${job.kind === "upstream" ? "review" : "discovery"}<//>`}
    </span>
    <span class="run-meta">
      ${showProject && project && html`<span>${project.name}</span>`}
      <span>${modelName(c, job)} <span class="muted">(${providerName(providerOf(job))})</span></span>
      ${job.difficulty && html`<span class="muted">${difficultyLabel(job.difficulty).toLowerCase()}</span>`}
    </span>
    <span class="run-state">
      <${Tag} tone=${toneOf(job.state)}>${stateLabel(job.state)}<//>
      <span class="muted">${timing}</span>
    </span>
    <span class="run-links" onClick=${(e) => e.stopPropagation()}>
      ${prs.map((href) => html`<${Link} key=${href} href=${href}>${prLabel(href)}<//>`)}
    </span>
    ${note && html`<span class="run-note">${note}</span>`}
  </a>`;
}

export function RunGroup({ title, list, limit = 8, empty, children }) {
  const now = serverNow();
  const [all, setAll] = useState(false);
  const visible = all ? list : list.slice(0, limit);
  return html`<section class="group">
    <header><h2>${title} ${list.length > 0 && html`<small>${list.length}</small>`}</h2>${children}</header>
    ${list.length ? visible.map((j) => html`<${RunRow} key=${j.id} job=${j} now=${now} />`) : empty && html`<${Empty}>${empty}<//>`}
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
        ${waiting.length > 0 && html`<${RunGroup} title="Needs you" list=${waiting} />`}
        <${RunGroup} title="Running" list=${running} empty="Nothing is running." />
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
