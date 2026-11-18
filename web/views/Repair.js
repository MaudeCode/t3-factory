// The Settings area's Repair tab: the switch, how runs are read, each project's watched workflows and what they last did.
import { html } from "../lib/h.js";
import { config, status, jobs, clock, serverNow } from "../lib/store.js";
import { ago, until, byNewest, repoLink, safeLink, span } from "../lib/format.js";
import { Field, Input, Range, Chips, Tag, Empty, Link, Section, Page, RowBody } from "../ui/index.js";
import { RunGroup, SectionSwitch } from "./Deck.js";

const minutes = (m) => span(m * 60);
const runLink = (run) => html`<${Link} href=${safeLink(run.url)} class="mono">${run.id}<//>`;

// One watched workflow, in the upstream release row's layout.
function WorkflowRow({ row: r, now }) {
  const failed = r.finished && r.finished.conclusion !== "success";
  const state = r.repairing ? html`<${Tag} tone="on">repairing<//>`
    : r.pending ? html`<${Tag} tone="attention">repair due<//>`
    : failed ? html`<${Tag} tone="attention">failing<//>`
    : r.finished ? html`<${Tag} tone="ok">passing<//>` : html`<${Tag}>not checked<//>`;
  return html`<div class="release">
    <span><${RowBody} title=${html`<b>${r.workflow}</b>`}><${Link} href=${`${repoLink(r.repo)}/actions/workflows/${encodeURIComponent(r.workflow)}`}>${r.repo}<//>, ${r.branch}, ${r.project}<//></span>
    <span class="release-state row-actions">${state}</span>
    <span class="release-versions">
      <span><small>result</small>${r.finished ? html`${runLink(r.finished)} ${r.finished.conclusion}${failed && r.finished.failedJobs?.length ? `: ${r.finished.failedJobs.join(", ")}` : ""}` : html`<span class="muted">none yet</span>`}</span>
      <span><small>following</small>${r.following ? html`${runLink(r.following)} ${r.following.status.replaceAll("_", " ")}` : html`<span class="muted">nothing running</span>`}</span>
      <span><small>last repair</small>${r.lastRepair ? html`<a href=${`/runs/${r.lastRepair.jobId}`}>run ${r.lastRepair.runId}</a>${r.lastRepair.endedAt ? `, ${ago(r.lastRepair.endedAt, now)}` : ", running"}${r.lastRepair.unrepaired.length ? html`<em class="muted">, left ${r.lastRepair.unrepaired.join(", ")}</em>` : ""}` : html`<span class="muted">never</span>`}</span>
      <span><small>checked</small>${r.checkedAt ? ago(r.checkedAt, now) : html`<span class="muted">not yet</span>`}${r.cooldownEndsAt && html`<em class="muted">, cooldown ends ${until(r.cooldownEndsAt, now)}</em>`}</span>
      ${failed && !r.pending && !r.repairing && !r.cooldownEndsAt && r.hold && html`<span class="muted">${r.hold}</span>`}
      ${r.checkError && html`<span class="tone-attention">${r.checkError}</span>`}
    </span>
  </div>`;
}

export function Repair({ lead } = {}) {
  clock.value;
  const c = config.value, now = serverNow();
  if (!c.repair)
    return html`<${Page} class="settings-page" title="Settings">
      ${lead}
      <${Empty}>Add <code>repair</code> with a prompt file to the config file to turn CI repairs on.<//>
    <//>`;
  const rows = status.value.repairs || [];
  const repairs = jobs.value.filter((j) => j.kind === "repair").sort(byNewest);
  return html`<${Page} class="settings-page" title="Settings" hint="A failed run of a watched workflow on a project's base branch starts one repair run. Pull request checks are left to the run that owns the pull request."
    actions=${html`<${SectionSwitch} kind="repair" label="CI repairs" on="Repairs on" off="Repairs paused" />`}>
    ${lead}
    <${Section} title="Repair runs">
      <${Field} label="Prompt file on your Mac" hint="A project can set its own."><${Input} mono path=${["repair", "promptFile"]} /><//>
      <${Field} label="After a repair, wait" hint="A failure inside this wait starts nothing; the newest result decides when it ends."><${Range} label="Cooldown" path=${["repair", "cooldownMinutes"]} min="15" max="1440" step="15" format=${minutes} /><//>
      <${Field} label="Look for runs every" hint="A running run is followed on every pass, and a merge by the factory is checked on the next."><${Range} label="Check interval" path=${["repair", "checkMinutes"]} min="5" max="240" step="5" format=${minutes} /><//>
    <//>
    <${Section} title="Watched workflows">
      ${c.projects.map((p, i) => html`<${Field} group key=${p.kanvilId || i} label=${p.name}><${Chips} label=${`${p.name} workflows`} path=${["projects", String(i), "repairWorkflows"]} custom="Add a workflow" /><//>`)}
      ${rows.length ? rows.map((r) => html`<${WorkflowRow} key=${`${r.projectId}:${r.workflow}`} row=${r} now=${now} />`) : html`<${Empty}>No workflow is watched yet.<//>`}
    <//>
    <${RunGroup} title="Repairs" list=${repairs} empty="No repairs yet." />
  <//>`;
}
