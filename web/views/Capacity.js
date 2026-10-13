import { html } from "../lib/h.js";
import { config, status, jobs, clock, serverNow } from "../lib/store.js";
import { PROVIDERS, WINDOW_NAMES, providerOf, isActive, until, ago, span } from "../lib/format.js";
import { Field, Range, Stepper, Slots, Budget, Section, useReady } from "../ui/index.js";

const minutes = (n) => span(n * 60);
const seconds = (n) => span(n);

// Live allowance for a provider, from the latest scheduler reading.
function quotaFor(driver) {
  const direct = status.value.decision?.quota;
  if (direct?.driver === driver) return direct;
  return (status.value.streams || []).find((s) => s.driver === driver)?.quota;
}

function Allowance({ provider, title, windows }) {
  const ready = useReady();
  const now = serverNow();
  const quota = quotaFor(provider.driver);
  const live = Object.fromEntries((quota?.windows || []).map((w) => [w.name, w]));
  if (quota?.factoryRouting?.fableRemainingPercent != null) live.fable = { remaining: quota.factoryRouting.fableRemainingPercent };
  return html`<${Section} title=${title} hint=${quota?.capturedAt ? `Read ${ago(quota.capturedAt, now)}. The dashed line is what is held back right now; the reserve relaxes as the window nears its reset, the floor never does.` : "No allowance reading yet."}>
    ${windows.map(([key, label]) => {
      const w = live[key];
      return html`<${Budget} key=${key} ready=${ready} label=${label} remaining=${w?.remaining} reserved=${w?.reserved}
        note=${w?.resetsAt ? `resets ${until(w.resetsAt, now)}` : ""}
        reservePath=${["quota", provider.concurrency, key, "reservePercent"]} floorPath=${["quota", provider.concurrency, key, "minRemainingPercent"]} />`;
    })}
  <//>`;
}

export function Capacity() {
  clock.value;
  const running = Object.fromEntries(PROVIDERS.map((p) => [p.driver, jobs.value.filter((j) => providerOf(j) === p.driver && isActive(j)).length]));
  const waiting = jobs.value.filter((j) => j.state === "waiting").length;
  const limit = config.value.maxWaitingPRs;
  return html`<div class="page">
    <div class="page-head"><div><h1>Capacity</h1><p>How many runs each provider may have open, how much allowance it must keep, and when it may start. Running work always finishes.</p></div></div>
    <div class="cols">
      <div>
        <${Section} title="Runs at once" hint="Filled slots are running now. Runs waiting for you free their slot. A run you start by hand may exceed the limit.">
          ${PROVIDERS.map(
            (p) => html`<${Field} group key=${p.driver} label=${`${p.name}: ${running[p.driver]} running`}><${Slots} label=${`${p.name} runs at once`} path=${["concurrency", p.concurrency]} running=${running[p.driver]} /><//>`,
          )}
        <//>
        <${Section} title="Timing">
          <${Field} label="Wait for the provider to be idle" hint="Automatic ticket work starts only after you have not used the provider for this long. Reviews skip the wait."><${Range} label="Idle time" path=${["idleMinutes"]} min="0" max="180" step="5" format=${minutes} /><//>
          <${Field} label="Check the queue every"><${Range} label="Check interval" path=${["pollSeconds"]} min="15" max="900" step="15" format=${seconds} /><//>
        <//>
        <${Section} title="Waiting and recovery">
          <${Field} group label="Runs that may wait for you" hint=${`${waiting} waiting now. Past the limit, automatic starts pause until you answer one.`}><${Stepper} label="Runs that may wait for you" path=${["maxWaitingPRs"]} min="1" max="20" unlimited="No limit" /><//>
          <${Field} label="Park a stalled monitor after" hint="A run whose background monitor makes no progress for this long is parked and marked as needing you."><${Range} label="Monitor timeout" path=${["monitoringTimeoutMinutes"]} min="5" max="240" step="5" format=${minutes} /><//>
          <${Field} label="Trust an allowance reading for" hint="Older readings are refreshed from T3 before a start."><${Range} label="Allowance reading age" path=${["quota", "maxAgeSeconds"]} min="30" max="1800" step="30" format=${seconds} /><//>
        <//>
        ${limit != null && waiting >= limit && html`<p class="hint tone-attention">Automatic starts are paused: ${waiting} runs are waiting for you.</p>`}
      </div>
      <div>
        <${Allowance} provider=${PROVIDERS[0]} title="Claude allowance" windows=${[["fiveHour", WINDOW_NAMES.fiveHour], ["weekly", WINDOW_NAMES.weekly], ["fable", WINDOW_NAMES.fable]]} />
        <${Allowance} provider=${PROVIDERS[1]} title="Codex allowance" windows=${[["weekly", WINDOW_NAMES.weekly]]} />
      </div>
    </div>
  </div>`;
}
