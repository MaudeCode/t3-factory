import { html } from "../lib/h.js";
import { config, jobs, serverNow, quotaFor, set } from "../lib/store.js";
import { PROVIDERS, WINDOW_NAMES, providerOf, providerIcon, isActive, until, span, moment } from "../lib/format.js";
import { Field, Range, Stepper, Slots, Toggle, Budget, Section, Segmented, Input, useReady, Page, Icon, RelativeTime } from "../ui/index.js";

const minutes = (n) => span(n * 60);
const seconds = (n) => span(n);

function Allowance({ provider, title, windows }) {
  const ready = useReady();
  const quota = quotaFor(provider.driver);
  const live = Object.fromEntries((quota?.windows || []).map((w) => [w.name, w]));
  if (quota?.factoryRouting?.fableRemainingPercent != null) live.fable = { remaining: quota.factoryRouting.fableRemainingPercent };
  return html`<${Section} title=${html`<${Icon} name=${providerIcon(provider.driver)} /> ${title}`} hint="The dashed line is what is held back right now; the reserve relaxes as the window nears its reset, the floor never does." aside=${html`<small class="muted">${quota?.capturedAt ? html`read <${RelativeTime} at=${quota.capturedAt} />` : "no reading yet"}</small>`}>
    ${windows.filter(([key]) => key !== "fiveHour" || !Array.isArray(quota?.windows) || live[key]).map(([key, label]) => {
      const w = live[key];
      return html`<${Budget} key=${key} ready=${ready} label=${label} remaining=${w?.remaining} reserved=${w?.reserved}
        note=${w?.resetsAt ? html`resets <${RelativeTime} at=${w.resetsAt} form="in" />` : ""}
        reservePath=${["quota", provider.concurrency, key, "reservePercent"]} floorPath=${["quota", provider.concurrency, key, "minRemainingPercent"]} />`;
    })}
  <//>`;
}

// One-shot timers for the Automation switch and the queue's. A weekly reset stores that provider's reset as it reads now.
function Schedule() {
  const s = config.value.schedule ?? {};
  const resets = PROVIDERS.map((p) => [p.concurrency, p.name, quotaFor(p.driver)?.windows?.find((w) => w.name === "weekly")?.resetsAt]).filter(([id, , at]) => at || s.offAtReset === id);
  const nextHour = () => new Date(Math.ceil((serverNow() + 1) / 3_600_000) * 3_600_000).toISOString();
  const atReset = (id) => set(["schedule"], { ...s, offAtReset: id, offAt: resets.find(([p]) => p === id)[2] ?? s.offAt });
  // Weekly reset starts on the provider that resets first; choosing it again keeps the provider already picked.
  const turnOff = (mode) => {
    if (mode !== "reset") return set(["schedule"], { ...s, offAtReset: null, offAt: mode ? (!s.offAtReset && s.offAt) || nextHour() : null });
    const first = resets.filter(([, , at]) => at).sort((a, b) => Date.parse(a[2]) - Date.parse(b[2]))[0];
    if (first && !s.offAtReset) atReset(first[0]);
  };
  return html`<${Section} title="Schedule" hint="Each timer sets Automation and queued runs once, then clears itself.">
    <${Field} group label="Turn on">
      <div class="timer">
        <${Segmented} label="Turn on" value=${s.onAt ? "at" : ""} onChange=${(mode) => set(["schedule", "onAt"], mode ? nextHour() : null)} options=${[["", "By hand"], ["at", "At a time"]]} />
        ${s.onAt && html`<${Input} kind="datetime" path=${["schedule", "onAt"]} aria-label="Turn on at" />`}
      </div>
    <//>
    <${Field} group label="Turn off" hint="At a weekly reset, both also turn off when that reset comes early.">
      <div class="timer">
        <${Segmented} label="Turn off" value=${s.offAtReset ? "reset" : s.offAt ? "at" : ""} onChange=${turnOff}
          options=${[["", "By hand"], ...(resets.some(([, , at]) => at) || s.offAtReset ? [["reset", "Weekly reset"]] : []), ["at", "At a time"]]} />
        ${s.offAtReset
          ? html`<${Segmented} label="Weekly reset of" value=${s.offAtReset} onChange=${atReset} options=${resets.map(([id, name]) => [id, name])} />
              <small class="muted"><${RelativeTime} text=${(now) => `${moment(s.offAt)}, ${until(s.offAt, now)}`} /></small>`
          : s.offAt && html`<${Input} kind="datetime" path=${["schedule", "offAt"]} aria-label="Turn off at" />`}
      </div>
    <//>
  <//>`;
}

// The Settings area's Limits tab; `lead` is its tab strip.
export function Capacity({ lead } = {}) {
  const running = Object.fromEntries(PROVIDERS.map((p) => [p.driver, jobs.value.filter((j) => providerOf(j) === p.driver && isActive(j)).length]));
  const waiting = jobs.value.filter((j) => j.state === "waiting").length;
  const limit = config.value.maxWaitingPRs;
  return html`<${Page} class="settings-page" title="Settings" hint="Running work always finishes; limits only decide what may start.">
    ${lead}
    <div class="cols">
      <div>
        <${Schedule} />
        <${Section} title="Runs at once" hint="Filled slots are running now. Runs waiting for you free their slot. A run you start by hand may exceed the limit.">
          ${PROVIDERS.map(
            (p) => html`<${Field} group key=${p.driver} label=${html`<${Icon} name=${providerIcon(p.driver)} /> ${p.name}: ${running[p.driver]} running`}><${Slots} label=${`${p.name} runs at once`} path=${["concurrency", p.concurrency]} running=${running[p.driver]} /><//>`,
          )}
        <//>
        <${Section} title="Timing">
          <${Field} label="Wait for the provider to be idle" hint="Automatic ticket work starts only after you have not used the provider for this long. Reviews skip the wait."><${Range} label="Idle time" path=${["idleMinutes"]} min="1" max="180" step="1" format=${minutes} /><//>
          <${Field} label="Check the queue every"><${Range} label="Check interval" path=${["pollSeconds"]} min="15" max="900" step="15" format=${seconds} /><//>
        <//>
        <${Section} title="Waiting and recovery">
          <${Toggle} label="Hold Epic tickets until the Epic starts" hint="Automatic starts skip a ticket in an Epic that has not started. You can still start it by name." path=${["holdEpicTicketsUntilStarted"]} />
          <${Field} group label=${`Runs that may wait for you: ${waiting} waiting now`} hint="Past the limit, automatic starts pause until you answer one."><${Stepper} label="Runs that may wait for you" path=${["maxWaitingPRs"]} min="1" max="20" unlimited="No limit" /><//>
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
  <//>`;
}
