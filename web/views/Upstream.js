import { html, useState } from "../lib/h.js";
import { config, status, live, busy, jobs, clock, serverNow, actions } from "../lib/store.js";
import { ago, until, byNewest, repoLink, releaseLink, span } from "../lib/format.js";
import { Button, Switch, Field, Input, Select, Toggle, Range, Tag, Empty, Link, Dialog, Section, Page, RowBody } from "../ui/index.js";
import { RunGroup } from "./Deck.js";

const minutes = (n) => span(n * 60);
const nextCheck = (checkedAt, every, now) => {
  const at = Date.parse(checkedAt) + every * 60_000;
  return at > now ? until(at, now) : "due";
};
const blank = { name: "", repo: "", firstBase: "", prereleases: false, checkMinutes: undefined };

// One watched repository, new or existing. Edits land in the config only on Save.
function WatchDialog({ edit, onClose }) {
  const c = config.value;
  const [project, setProject] = useState(edit?.project ?? Math.max(0, c.projects.findIndex((p) => p.enabled)));
  const [entry, setEntry] = useState(edit?.entry ?? blank);
  const patch = (k) => (v) => setEntry((e) => ({ ...e, [k]: v }));
  const custom = entry.checkMinutes != null;
  const valid = entry.name.trim() && /^[\w.-]+\/[\w.-]+$/.test(entry.repo.trim()) && entry.firstBase.trim();
  const save = () => {
    const next = { ...entry, name: entry.name.trim(), repo: entry.repo.trim().toLowerCase(), firstBase: entry.firstBase.trim() };
    if (!custom) delete next.checkMinutes;
    if (edit?.entry && project === edit.project) actions.setUpstream(edit.project, edit.index, next);
    else {
      if (edit?.entry) actions.removeUpstream(edit.project, edit.index);
      actions.addUpstream(project, next);
    }
    onClose();
  };
  return html`<${Dialog} open=${!!edit} onClose=${onClose} title=${edit?.entry ? `Watching ${edit.entry.name}` : "Watch a repository"}
    actions=${html`${edit?.entry && html`<${Button} variant="danger" onClick=${() => (actions.removeUpstream(edit.project, edit.index), onClose())}>Stop watching<//>`}
      <span style="flex:1"></span>
      <${Button} variant="ghost" onClick=${onClose}>Cancel<//>
      <${Button} variant="primary" disabled=${!valid} onClick=${save}>${edit?.entry ? "Apply" : "Watch"}<//>`}>
    ${edit && html`
      <${Field} label="Reviewed for" hint="Reviews file tickets in this project."><${Select} label="Project" value=${project} options=${c.projects.map((p, i) => [i, p.name])} onChange=${setProject} /><//>
      <div class="grid-2">
        <${Field} label="GitHub owner/repo"><${Input} mono value=${entry.repo} onChange=${patch("repo")} placeholder="owner/repo" /><//>
        <${Field} label="Name"><${Input} value=${entry.name} onChange=${patch("name")} /><//>
      </div>
      <${Field} label="Already reviewed up to" hint="The release tag the project is current with. Anything newer gets a review."><${Input} mono value=${entry.firstBase} onChange=${patch("firstBase")} placeholder="v1.2.0" /><//>
      <${Toggle} label="Include pre-releases" checked=${entry.prereleases} onChange=${(e) => patch("prereleases")(e.target.checked)} />
      <${Toggle} label="Own check interval" hint=${custom ? "For a repository that publishes too often to review every release." : `Checked every ${minutes(c.upstream?.checkMinutes ?? 360)} with the others.`} checked=${custom} onChange=${(e) => patch("checkMinutes")(e.target.checked ? c.upstream?.checkMinutes ?? 360 : undefined)} />
      ${custom && html`<${Field} label="Check every"><${Range} label="Check interval" value=${entry.checkMinutes} onChange=${patch("checkMinutes")} min="15" max="2880" step="15" format=${minutes} /><//>`}
    `}
  <//>`;
}

export function Upstream() {
  clock.value;
  const [edit, setEdit] = useState(null);
  const now = serverNow();
  const c = config.value;
  if (!c.upstream)
    return html`<${Page} narrow title="Upstream">
      <${Empty}>No watched repositories. Add <code>upstream</code> with a prompt file to the config file to turn reviews on.<//>
    <//>`;
  const byRepo = Object.fromEntries((status.value.upstreams || []).map((r) => [r.repo, r]));
  const watched = c.projects.flatMap((p, project) => p.upstreams.map((u, index) => ({ project, index, entry: u, projectName: p.name, enabled: p.enabled, live: byRepo[u.repo] })));
  const reviews = jobs.value.filter((j) => j.kind === "upstream").sort(byNewest),
    minutesDefault = c.upstream.checkMinutes;
  return html`<${Page} title="Upstream" hint="Each new release of a watched repository gets a review run that files tickets for anything worth adopting."
    actions=${html`<label class="automation"><${Switch} label="Upstream reviews" checked=${live.value.upstream} disabled=${busy.value} onChange=${() => actions.toggle("upstream")} /><b>${live.value.upstream ? "Reviews on" : "Reviews paused"}</b></label>`}>
    <${WatchDialog} key=${edit ? `${edit.project}-${edit.index ?? "new"}` : "closed"} edit=${edit} onClose=${() => setEdit(null)} />
    <div class="cols">
      <div>
        <${Section} title="Watched releases">
          ${watched.length
            ? watched.map(
                ({ entry: u, live: r, ...w }) => html`<div class="release" key=${u.repo} role="button" tabindex="0" onClick=${() => setEdit({ ...w, entry: u })} onKeyDown=${(e) => e.key === "Enter" && setEdit({ ...w, entry: u })}>
                  <span onClick=${(e) => e.target.closest("a") && e.stopPropagation()}><${RowBody} title=${html`<b>${u.name}</b>`}><${Link} href=${repoLink(u.repo)}>${u.repo}<//>${u.prereleases ? ", pre-releases" : ""}, ${w.projectName}${w.enabled ? "" : " (off)"}<//></span>
                  <span class="release-state">
                    ${r?.reviewing ? html`<${Tag} tone="on">reviewing<//>` : r?.pending ? html`<${Tag} tone="attention">review due<//>` : r?.latest ? html`<${Tag} tone="ok">up to date<//>` : html`<${Tag}>new<//>`}
                  </span>
                  <span class="release-versions">
                    <span><small>reviewed</small><${Link} href=${releaseLink(u.repo, r?.reviewed ?? u.firstBase)} class="mono">${r?.reviewed ?? u.firstBase}<//></span>
                    <span><small>latest</small>${r?.latest ? html`<${Link} href=${releaseLink(u.repo, r.latest)} class="mono">${r.latest}<//>` : html`<span class="muted">not checked</span>`}</span>
                    <span><small>checked</small>${r?.checkedAt ? html`${ago(r.checkedAt, now)}<em class="muted">, next ${nextCheck(r.checkedAt, u.checkMinutes ?? minutesDefault, now)}</em>` : html`<span class="muted">not yet</span>`}</span>
                    ${r?.checkError && html`<span class="tone-attention">${r.checkError}</span>`}
                  </span>
                </div>`,
              )
            : html`<${Empty}>No watched repositories yet.<//>`}
          <${Button} size="sm" style="margin-top:8px" onClick=${() => setEdit({ project: Math.max(0, c.projects.findIndex((p) => p.enabled)), index: -1 })}>Watch a repository<//>
        <//>
        <${RunGroup} title="Reviews" list=${reviews} empty="No reviews yet." />
      </div>
      <div>
        <${Section} title="Settings">
          <${Field} label="Prompt file on your Mac" hint="Read for each review run."><${Input} mono path=${["upstream", "promptFile"]} /><//>
          <${Field} label="Check for releases every" hint="A repository can set its own interval."><${Range} label="Check interval" path=${["upstream", "checkMinutes"]} min="15" max="1440" step="15" format=${minutes} /><//>
        <//>
      </div>
    </div>
  <//>`;
}
