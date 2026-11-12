import { html, useEffect, useState } from "../lib/h.js";
import { config, status, jobs, history, sources, selectedProject, clock, serverNow, actions, set, update } from "../lib/store.js";
import { isOpen, isActive, ago, until, projectLink, repoLink, span } from "../lib/format.js";
import { Button, Field, Input, Select, Segmented, Chips, Slots, Toggle, Range, Tag, Icon, Link, Facts, Dialog, Empty, Section, Page, RowBody, SortableList } from "../ui/index.js";
import { follow } from "../lib/router.js";

const t3Options = (current) => {
  const list = sources.value?.t3 ?? [];
  return [...(current && !list.some((p) => p.id === current) ? [[current, current]] : []), ...list.map((p) => [p.id, p.title])];
};
const columnOptions = (kanvilId) => (sources.value?.kanvil.columns[kanvilId] ?? []).map((c) => [c.slug, c.name]);
const workspaceLabels = () => sources.value?.kanvil.labels ?? [];

// Add and Setup share the same workspace-scoped Select controls.
function KanvilPicker({ value, workspaceId = config.value.kanvil.workspaceId, onChange, onWorkspaceChange, exclude = new Set() }) {
  const [workspace, setWorkspace] = useState(workspaceId);
  useEffect(() => setWorkspace(workspaceId), [workspaceId]);
  const catalog = sources.value?.kanvil;
  const workspaces = catalog?.workspaces ?? [];
  const workspaceOptions = [...(!workspaces.some(w => w.id === workspaceId) ? [[workspaceId, workspaceId]] : []), ...workspaces.map(w => [w.id, w.name])];
  const projects = (catalog?.projects ?? []).filter(p => (p.workspaceId ?? config.value.kanvil.workspaceId) === workspace && (!exclude.has(p.id) || p.id === value));
  const selected = workspace === workspaceId ? value : projects.some(p => p.id === value) ? value : '';
  const options = [...(selected && !projects.some(p => p.id === selected) ? [[selected, selected]] : []), ...projects.map(p => [p.id, `${p.name} (${p.slug})`])];
  return html`<${Field} label="Kanvil workspace"><${Select} label="Kanvil workspace" value=${workspace} options=${workspaceOptions}
      onChange=${id => { setWorkspace(id); onWorkspaceChange?.(); }} /><//>
    <${Field} label="Kanvil project"><${Select} label="Kanvil project" value=${selected} options=${[['', projects.length ? 'Choose' : 'No projects available'], ...options]} onChange=${id => id && onChange(id)} /><//>`;
}

const OTHER = "\0other";
// Picks a label the project has not used yet: the workspace catalog, or a typed name the catalog lacks.
function LabelPicker({ label, text = label, exclude, onPick }) {
  const [typing, setTyping] = useState(false);
  const free = workspaceLabels().filter((l) => !exclude.has(l)).map((l) => [l, l]);
  const commit = (el) => {
    const v = el.value.trim();
    if (v && !exclude.has(v)) onPick(v);
    setTyping(false);
  };
  if (typing)
    return html`<input class="chip-input" aria-label=${`${label}, typed`} placeholder="Label name" ref=${(el) => el && el !== document.activeElement && el.focus()}
      onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget); } if (e.key === "Escape") { e.preventDefault(); setTyping(false); } }} onBlur=${(e) => commit(e.currentTarget)} />`;
  return html`<${Select} size="sm" label=${label} value="" options=${[["", text], ...free, [OTHER, "Other label…"]]} onChange=${(v) => (v === OTHER ? setTyping(true) : v && onPick(v))} />`;
}

// Ranks, highest first. Labels in one rank share it; urgency orders tickets inside a rank, and unranked tickets follow.
function PriorityTiers({ index, project }) {
  const path = ["projects", String(index), "priorityLabels"];
  const tiers = project.priorityLabels ?? [];
  const ranked = new Set(tiers.flat());
  const queued = (status.value.upNext?.tickets ?? []).filter((t) => t.projectId === project.kanvilId);
  const rankOf = (t) => tiers.findIndex((tier) => t.labels?.some((l) => tier.includes(l)));
  const count = (rank) => queued.filter((t) => rankOf(t) === rank).length;
  const save = (next) => set(path, next.filter((tier) => tier.length));
  const edit = (i, labels) => save(tiers.map((tier, j) => (j === i ? labels : tier)));
  const upNext = (n) => html`<small class="muted tier-count">${n} up next</small>`;
  const items = tiers.map((labels, i) => ({ labels, i }));
  return html`<div class="ladder">
    <${SortableList} label="Priority ranks" items=${items} keyOf=${(t) => t.labels.join(", ")}
      onMove=${(from, to) => { const next = [...tiers]; next.splice(to, 0, ...next.splice(from, 1)); save(next); }}
      render=${({ labels, i }, _, grip) => html`<div class="tier">
        ${grip}
        <span class="rank">${i + 1}</span>
        <span class="chips tier-labels" role="group" aria-label=${`Rank ${i + 1} labels`}>
          ${labels.map((l) => html`<button key=${l} type="button" aria-pressed="true" aria-label=${`Remove ${l} from rank ${i + 1}`} title="Remove from this rank" onClick=${() => edit(i, labels.filter((x) => x !== l))}>${l}<${Icon} name="x" /></button>`)}
          <${LabelPicker} label=${`Add a label to rank ${i + 1}`} text="Add label" exclude=${ranked} onPick=${(l) => edit(i, [...labels, l])} />
        </span>
        ${upNext(count(i))}
      </div>`} />
    <div class="tier tier-new">
      <span class="rank muted">${tiers.length + 1}</span>
      <span class="chips tier-labels"><${LabelPicker} label="Start a new rank" exclude=${ranked} onPick=${(l) => save([...tiers, [l]])} /></span>
    </div>
    <div class="tier tier-rest">
      <span class="rank muted" aria-hidden="true">–</span>
      <${RowBody} title="Everything else">by urgency, then oldest first<//>
      ${upNext(queued.filter((t) => rankOf(t) < 0).length)}
    </div>
  </div>`;
}

// One run limit per label; runs in this project count against every limited label they carry.
function LabelLimits({ index, project }) {
  const path = ["projects", String(index), "labelLimits"];
  const limits = project.labelLimits ?? {};
  return html`<div class="label-limits">
    ${Object.keys(limits).map((label) => {
      const setting = limits[label], legacy = typeof setting === 'number', mode = legacy ? 'running' : setting.mode;
      const n = jobs.value.filter((j) => j.projectId === project.kanvilId && (mode === 'full' ? isOpen(j) : isActive(j)) && j.labels?.includes(label)).length;
      return html`<div class="label-limit" key=${label}>
        <span><${Tag}>${label}<//> <small class="muted">${n} ${mode === 'full' ? 'open' : 'running'}</small></span>
        <${Segmented} label=${`${label} block mode`} value=${mode} options=${[['full', 'Full block'], ['running', 'Running block']]} icons=${{ full: 'lock', running: 'play' }}
          onChange=${(mode) => set([...path, label], { limit: legacy ? setting : setting.limit, mode })} />
        <${Slots} label=${`${label} runs at once`} path=${legacy ? [...path, label] : [...path, label, 'limit']} running=${n} busyLabel=${mode === 'full' ? 'reserved by an open run' : undefined} />
        <${Button} variant="ghost" size="sm" icon="x" label=${`Remove the ${label} limit`} onClick=${() => update((c) => delete c.projects[index].labelLimits[label])} />
      </div>`;
    })}
    <${LabelPicker} label="Limit a label" exclude=${new Set(Object.keys(limits))} onPick=${(v) => set([...path, v], 1)} />
  </div>`;
}

// New projects start from the T3 and Kanvil catalogs so nothing has to be typed.
function AddProject({ open, onClose }) {
  const [t3, setT3] = useState("");
  const [kanvil, setKanvil] = useState("");
  const src = sources.value;
  const taken = new Set(config.value.projects.flatMap((p) => [p.t3Id, p.kanvilId]));
  const t3Choices = (src?.t3 ?? []).filter((p) => !taken.has(p.id)).map((p) => [p.id, p.title]);
  const t3Project = src?.t3.find((p) => p.id === t3),
    kanvilProject = src?.kanvil.projects.find((p) => p.id === kanvil);
  const add = () => {
    actions.addProject(t3Project, kanvilProject);
    setT3("");
    setKanvil("");
    onClose();
  };
  return html`<${Dialog} open=${open} onClose=${onClose} title="Add a project"
    actions=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//><${Button} variant="primary" disabled=${!t3Project && !kanvilProject} onClick=${add}>Add project<//>`}>
    ${src
      ? html`<${Field} label="T3 project" hint="Sets the repository path T3 works in."><${Select} label="T3 project" value=${t3} options=${[["", "Choose"], ...t3Choices]} onChange=${setT3} /><//>
        <${KanvilPicker} value=${kanvil} onChange=${setKanvil} onWorkspaceChange=${() => setKanvil('')} exclude=${taken} />
        ${(t3Project || kanvilProject) && html`<${Facts} items=${[["Path", t3Project?.workspaceRoot], ["Tickets", kanvilProject && `${kanvilProject.slug}-…`], ["GitHub", kanvilProject?.githubRepo]]} />`}`
      : html`<p class="muted">Loading the T3 and Kanvil catalogs…</p>`}
  <//>`;
}

function Setup({ index, project }) {
  const p = ["projects", String(index)];
  const t3Project = sources.value?.t3.find((x) => x.id === project.t3Id);
  const pathMismatch = t3Project && t3Project.workspaceRoot !== project.repoPath;
  const columns = columnOptions(project.kanvilId);
  return html`<${Section} title="Repository">
      <div class="grid-2">
        <${Field} label="Name"><${Input} path=${[...p, "name"]} /><//>
        <${Field} label="GitHub owner/repo"><${Input} mono path=${[...p, "githubRepo"]} /><//>
        <${Field} label="T3 project" hint="T3 creates each run's worktree from this project."><${Select} label="T3 project" value=${project.t3Id} options=${t3Options(project.t3Id)} onChange=${(v) => actions.linkT3(index, v)} /><//>
        <${Field} label="Base branch"><${Input} mono path=${[...p, "baseBranch"]} /><//>
      </div>
      <${Field} label="Repository path on your Mac" hint="Must match the T3 project's workspace root, or T3 cannot create worktrees for its runs."><${Input} mono path=${[...p, "repoPath"]} /><//>
      ${pathMismatch && html`<p class="hint section-hint tone-attention">T3 works in <code>${t3Project.workspaceRoot}</code>. Dispatch fails until these match.
        <${Button} variant="ghost" size="sm" onClick=${() => set([...p, "repoPath"], t3Project.workspaceRoot)}>Use T3's path<//></p>`}
    <//>
    <${Section} title="Tickets">
      <div class="grid-2">
        <${KanvilPicker} value=${project.kanvilId} workspaceId=${project.kanvilWorkspaceId ?? config.value.kanvil.workspaceId} onChange=${(v) => actions.linkKanvil(index, v)} />
        <${Field} label="Ticket prefix"><${Input} mono path=${[...p, "key"]} /><//>
      </div>
      <${Field} group label="Ready when in" hint="Tickets in these columns may be picked up."><${Chips} label="Ready statuses" path=${[...p, "readyStatuses"]} options=${columns} custom=${columns.length ? undefined : "Add a status"} /><//>
      <${Field} group label="Done when in" hint="A ticket moved here is finished; its run is settled."><${Chips} label="Done statuses" path=${[...p, "doneStatuses"]} options=${columns} custom=${columns.length ? undefined : "Add a status"} /><//>
    <//>`;
}

const Scheduling = ({ index, project }) => html`<${Section} title="Priority" hint="Drag ranks to reorder. Rank 1 goes first, across every project. Labels in one rank are equal: a low ticket in rank 1 goes before an urgent ticket in rank 2.">
    <${PriorityTiers} index=${index} project=${project} />
  <//>
  <${Section} title="Runs at once by label" hint="Full block counts running and waiting runs; Running block frees slots while waiting for you. A manual label-limit override may exceed either limit.">
    <${LabelLimits} index=${index} project=${project} />
  <//>`;

const Releases = ({ project }) => html`<${Section} title="Watched releases" hint="Each new release of these repositories gets a review run.">
    ${project.upstreams?.length
      ? project.upstreams.map((u) => html`<div class="row" key=${u.repo}><span><b>${u.name}</b> <small class="muted mono">${u.repo}</small></span><small class="muted">${u.prereleases ? "including pre-releases" : "releases only"}${u.checkMinutes ? `, every ${span(u.checkMinutes * 60)}` : ""}</small></div>`)
      : html`<${Empty}>None yet.<//>`}
    <p class="small"><a href="/upstream" onClick=${follow}>Manage watched releases</a></p>
  <//>`;

const views = { setup: Setup, scheduling: Scheduling, releases: Releases };

export function Projects() {
  clock.value;
  useEffect(actions.ensureSources, []);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState("setup");
  const c = config.value,
    entries = c.projects,
    now = serverNow();
  const i = Math.min(selectedProject.value, entries.length - 1),
    current = entries[i];
  const all = history.value ?? jobs.value;
  const stats = (project) => {
    const mine = all.filter((j) => j.projectId === project.kanvilId);
    return {
      active: jobs.value.filter((j) => j.projectId === project.kanvilId && isActive(j)).length,
      waiting: jobs.value.filter((j) => j.projectId === project.kanvilId && j.state === "waiting").length,
      done: mine.filter((j) => j.state === "complete").length,
    };
  };
  const s = stats(current);
  const inUse = jobs.value.some((j) => j.projectId === current.kanvilId && isOpen(j));
  const discovery = (status.value.discovery || []).find((d) => d.projectId === current.kanvilId);
  const t3Project = sources.value?.t3.find((x) => x.id === current.t3Id);
  const pathMismatch = t3Project && t3Project.workspaceRoot !== current.repoPath;
  const ranks = (current.priorityLabels ?? []).length, limits = Object.keys(current.labelLimits ?? {}).length;
  const View = views[view];
  return html`<${Page} title="Projects" hint="A project pairs a T3 project with a Kanvil project." actions=${html`<${Button} variant="primary" size="sm" icon="plus" label="Add project" onClick=${() => setAdding(true)} />`}>
    <${AddProject} open=${adding} onClose=${() => setAdding(false)} />
    <div class="split">
      <div class="list" role="listbox" aria-label="Projects">
        ${entries.map((x, j) => {
          const st = stats(x);
          return html`<div class=${`item ${j === i ? "current" : ""}`} key=${x.kanvilId || j} role="option" aria-selected=${j === i} tabindex="0"
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
              ${current.kanvilId && html`<${Link} href=${projectLink(c, current.kanvilId)}>Kanvil<//>`}
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
        <${Toggle} path=${["projects", String(i), "enabled"]} label="Included in automatic work" hint=${current.enabled ? "Its ready tickets, discovery, and watched releases are all eligible." : "Nothing starts here until you include it. Open runs still finish."} />
        <${Segmented} label="Project settings" value=${view} onChange=${setView}
          options=${[["setup", "Setup", pathMismatch ? "!" : undefined], ["scheduling", "Scheduling", ranks + limits || undefined], ["releases", "Releases", current.upstreams?.length || undefined]]} />
        <${View} index=${i} project=${current} />
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
