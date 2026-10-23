import { html, useEffect, useState } from "../lib/h.js";
import { config, status, jobs, history, sources, selectedProject, clock, serverNow, actions, set, update } from "../lib/store.js";
import { isOpen, isActive, ago, until, projectLink, repoLink, span } from "../lib/format.js";
import { Button, Field, Input, Select, Chips, Slots, Toggle, Range, Tag, Link, Facts, Dialog, Empty, Section, Page, RowBody } from "../ui/index.js";
import { follow } from "../lib/router.js";

const t3Options = (current) => {
  const list = sources.value?.t3 ?? [];
  return [...(current && !list.some((p) => p.id === current) ? [[current, current]] : []), ...list.map((p) => [p.id, p.title])];
};
const kaneoOptions = (current) => {
  const list = sources.value?.kaneo.projects ?? [];
  return [...(current && !list.some((p) => p.id === current) ? [[current, current]] : []), ...list.map((p) => [p.id, `${p.name} (${p.slug})`])];
};
const columnOptions = (kaneoId) => (sources.value?.kaneo.columns[kaneoId] ?? []).map((c) => [c.slug, c.name]);
const labelOptions = () => (sources.value?.kaneo.labels ?? []).map((l) => [l, l]);

// One run limit per label; runs in this project count against every limited label they carry.
function LabelLimits({ index, project }) {
  const path = ["projects", String(index), "labelLimits"];
  const limits = project.labelLimits ?? {};
  const running = (label) => jobs.value.filter((j) => j.projectId === project.kaneoId && isActive(j) && j.labels?.includes(label)).length;
  const free = labelOptions().filter(([label]) => !(label in limits));
  return html`<div class="label-limits">
    ${Object.keys(limits).map((label) => {
      const n = running(label);
      return html`<div class="label-limit" key=${label}>
        <span><${Tag}>${label}<//> <small class="muted">${n} running</small></span>
        <${Slots} label=${`${label} runs at once`} path=${[...path, label]} running=${n} />
        <${Button} variant="ghost" size="sm" icon="x" label=${`Remove the ${label} limit`} onClick=${() => update((c) => delete c.projects[index].labelLimits[label])} />
      </div>`;
    })}
    ${free.length > 0 && html`<${Select} label="Limit a label" value="" options=${[["", "Limit a label"], ...free]} onChange=${(v) => v && set([...path, v], 1)} />`}
  </div>`;
}

// New projects start from the T3 and Kaneo catalogs so nothing has to be typed.
function AddProject({ open, onClose }) {
  const [t3, setT3] = useState("");
  const [kaneo, setKaneo] = useState("");
  const src = sources.value;
  const taken = new Set(config.value.projects.flatMap((p) => [p.t3Id, p.kaneoId]));
  const t3Choices = (src?.t3 ?? []).filter((p) => !taken.has(p.id)).map((p) => [p.id, p.title]);
  const kaneoChoices = (src?.kaneo.projects ?? []).filter((p) => !taken.has(p.id)).map((p) => [p.id, `${p.name} (${p.slug})`]);
  const t3Project = src?.t3.find((p) => p.id === t3),
    kaneoProject = src?.kaneo.projects.find((p) => p.id === kaneo);
  const add = () => {
    actions.addProject(t3Project, kaneoProject);
    setT3("");
    setKaneo("");
    onClose();
  };
  return html`<${Dialog} open=${open} onClose=${onClose} title="Add a project"
    actions=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//><${Button} variant="primary" disabled=${!t3Project && !kaneoProject} onClick=${add}>Add project<//>`}>
    ${src
      ? html`<${Field} label="T3 project" hint="Sets the repository path T3 works in."><${Select} label="T3 project" value=${t3} options=${[["", "Choose"], ...t3Choices]} onChange=${setT3} /><//>
        <${Field} label="Kaneo project" hint="Sets the ticket prefix and which columns mean ready and done."><${Select} label="Kaneo project" value=${kaneo} options=${[["", "Choose"], ...kaneoChoices]} onChange=${setKaneo} /><//>
        ${(t3Project || kaneoProject) && html`<${Facts} items=${[["Path", t3Project?.workspaceRoot], ["Tickets", kaneoProject && `${kaneoProject.slug}-…`], ["GitHub", kaneoProject?.githubRepo]]} />`}`
      : html`<p class="muted">Loading the T3 and Kaneo catalogs…</p>`}
  <//>`;
}

export function Projects() {
  clock.value;
  useEffect(actions.ensureSources, []);
  const [adding, setAdding] = useState(false);
  const c = config.value,
    entries = c.projects,
    now = serverNow();
  const i = Math.min(selectedProject.value, entries.length - 1),
    p = ["projects", String(i)],
    current = entries[i];
  const all = history.value ?? jobs.value;
  const stats = (project) => {
    const mine = all.filter((j) => j.projectId === project.kaneoId);
    return {
      active: jobs.value.filter((j) => j.projectId === project.kaneoId && isActive(j)).length,
      waiting: jobs.value.filter((j) => j.projectId === project.kaneoId && j.state === "waiting").length,
      done: mine.filter((j) => j.state === "complete").length,
    };
  };
  const s = stats(current);
  const inUse = jobs.value.some((j) => j.projectId === current.kaneoId && isOpen(j));
  const discovery = (status.value.discovery || []).find((d) => d.projectId === current.kaneoId);
  const t3Project = sources.value?.t3.find((x) => x.id === current.t3Id);
  const pathMismatch = t3Project && t3Project.workspaceRoot !== current.repoPath;
  const columns = columnOptions(current.kaneoId);
  return html`<${Page} title="Projects" hint="A project pairs a T3 project with a Kaneo project." actions=${html`<${Button} variant="primary" size="sm" icon="plus" label="Add project" onClick=${() => setAdding(true)} />`}>
    <${AddProject} open=${adding} onClose=${() => setAdding(false)} />
    <div class="split">
      <div class="list" role="listbox" aria-label="Projects">
        ${entries.map((x, j) => {
          const st = stats(x);
          return html`<div class=${`item ${j === i ? "current" : ""}`} key=${x.kaneoId || j} role="option" aria-selected=${j === i} tabindex="0"
            onClick=${() => (selectedProject.value = j)} onKeyDown=${(e) => e.key === "Enter" && (selectedProject.value = j)}>
            <${RowBody} title=${html`<b>${x.name}</b>`}>
              <span class="mono">${x.githubRepo || x.repoPath || "not set"}</span> · ${st.active} running${st.waiting ? `, ${st.waiting} need you` : ""}${x.upstreams?.length ? `, ${x.upstreams.length} watched` : ""}
            <//>
            <${Tag} tone=${x.enabled ? "on" : ""}>${x.enabled ? "included" : "off"}<//>
          </div>`;
        })}
      </div>
      <div class="detail" key=${i}>
        <div class="detail-head">
          <div>
            <h2>${current.name}</h2>
            <p class="links-row">
              ${current.githubRepo && html`<${Link} href=${repoLink(current.githubRepo)}>GitHub<//>`}
              ${current.kaneoId && html`<${Link} href=${projectLink(c, current.kaneoId)}>Kaneo<//>`}
            </p>
          </div>
          <${Button} variant="danger" size="sm" disabled=${inUse || entries.length === 1} icon="trash" label=${inUse ? "Runs are still open for this project" : "Remove project"} onClick=${() => actions.removeProject(i)} />
        </div>
        <${Facts}
          items=${[
            ["Running", String(s.active)],
            ["Needs you", String(s.waiting)],
            ["Completed", String(s.done)],
            ["Discovery", discovery?.nextAt && Date.parse(discovery.nextAt) > now ? `paused until ${until(discovery.nextAt, now).replace("in ", "")} from now` : discovery?.lastAt ? `last ran ${ago(discovery.lastAt, now)}` : "never run"],
          ]}
        />
        <${Toggle} path=${[...p, "enabled"]} label="Included in automatic work" hint=${current.enabled ? "Its ready tickets, discovery, and watched releases are all eligible." : "Nothing starts here until you include it. Open runs still finish."} />
        <${Section} title="Repository">
          <div class="grid-2">
            <${Field} label="Name"><${Input} path=${[...p, "name"]} /><//>
            <${Field} label="GitHub owner/repo"><${Input} mono path=${[...p, "githubRepo"]} /><//>
            <${Field} label="T3 project" hint="T3 creates each run's worktree from this project."><${Select} label="T3 project" value=${current.t3Id} options=${t3Options(current.t3Id)} onChange=${(v) => actions.linkT3(i, v)} /><//>
            <${Field} label="Base branch"><${Input} mono path=${[...p, "baseBranch"]} /><//>
          </div>
          <${Field} label="Repository path on your Mac" hint="Must match the T3 project's workspace root, or T3 cannot create worktrees for its runs."><${Input} mono path=${[...p, "repoPath"]} /><//>
          ${pathMismatch && html`<p class="hint section-hint tone-attention">T3 works in <code>${t3Project.workspaceRoot}</code>. Dispatch fails until these match.
            <${Button} variant="ghost" size="sm" onClick=${() => set([...p, "repoPath"], t3Project.workspaceRoot)}>Use T3's path<//></p>`}
        <//>
        <${Section} title="Tickets">
          <div class="grid-2">
            <${Field} label="Kaneo project"><${Select} label="Kaneo project" value=${current.kaneoId} options=${kaneoOptions(current.kaneoId)} onChange=${(v) => actions.linkKaneo(i, v)} /><//>
            <${Field} label="Ticket prefix"><${Input} mono path=${[...p, "key"]} /><//>
          </div>
          <${Field} group label="Ready when in" hint="Tickets in these columns may be picked up."><${Chips} label="Ready statuses" path=${[...p, "readyStatuses"]} options=${columns} custom=${columns.length ? undefined : "Add a status"} /><//>
          <${Field} group label="Done when in" hint="A ticket moved here is finished; its run is settled."><${Chips} label="Done statuses" path=${[...p, "doneStatuses"]} options=${columns} custom=${columns.length ? undefined : "Add a status"} /><//>
          <${Field} group label="Priority labels" hint="Pick in order of importance. Tickets with a higher label go first; among equals, urgency decides."><${Chips} ordered label="Priority labels" path=${[...p, "priorityLabels"]} options=${labelOptions()} custom="Other label" /><//>
          <${Field} group label="Runs at once by label" hint="For tickets that compete for one machine resource, such as a simulator. Runs waiting for you free their slot; a run you start by hand with Override limits on may exceed the limit."><${LabelLimits} index=${i} project=${current} /><//>
        <//>
        <${Section} title="Watched releases" hint="Each new release of these repositories gets a review run.">
          ${current.upstreams?.length
            ? current.upstreams.map((u) => html`<div class="row" key=${u.repo}><span><b>${u.name}</b> <small class="muted mono">${u.repo}</small></span><small class="muted">${u.prereleases ? "including pre-releases" : "releases only"}${u.checkMinutes ? `, every ${span(u.checkMinutes * 60)}` : ""}</small></div>`)
            : html`<${Empty}>None yet.<//>`}
          <p class="small"><a href="/upstream" onClick=${follow}>Manage watched releases</a></p>
        <//>
      </div>
    </div>
    <${Section} title="Discovery" hint="When no tickets are eligible, a free provider investigates one included project for new work and files tickets. Tickets waiting for classification are skipped, not replaced.">
      <div class="grid-2">
        <${Field} label="Prompt file on your Mac" hint="Read for each discovery run."><${Input} mono path=${["discovery", "promptFile"]} /><//>
        <${Field} label="After finding nothing, leave a project alone for"><${Range} label="Discovery cooldown" path=${["discovery", "emptyCooldownHours"]} min="1" max="168" step="1" format=${(h) => span(h * 3600)} /><//>
      </div>
    <//>
  <//>`;
}
