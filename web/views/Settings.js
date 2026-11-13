// Everything that is configured rather than operated: projects, models, limits, and the sources' own settings.
// One tab each, in the address. Edits are bound to the config and survive a change of tab until saved or discarded.
import { html } from "../lib/h.js";
import { config } from "../lib/store.js";
import { navigate } from "../lib/router.js";
import { span } from "../lib/format.js";
import { Segmented, Field, Input, Range, Page, Section, Empty } from "../ui/index.js";
import { Projects } from "./Projects.js";
import { Models } from "./Models.js";
import { Capacity } from "./Capacity.js";
import { TriageSettings } from "./Triage.js";

const TABS = [["projects", "Projects"], ["models", "Models"], ["limits", "Limits"], ["sources", "Sources"]];
const minutes = (m) => span(m * 60);

// What each source reads and how often: the prompt files, intervals and promotion limits, in one place.
function SourceSettings({ lead }) {
  const c = config.value;
  return html`<${Page} class="settings-page" title="Settings" hint="How each source of new tickets is read. Switching a source on or off is on the Sources page.">
    ${lead}
    <${Section} title="Inbox triage">
      ${c.triage ? html`<${TriageSettings} />` : html`<${Empty}>No inboxes. Add <code>inbox</code> and <code>scopes</code> to a project and a <code>triage</code> section to the config file to turn triage on.<//>`}
    <//>
    <${Section} title="Discovery">
      ${c.discovery
        ? html`<${Field} label="Prompt file on your Mac" hint="Read for each discovery run."><${Input} mono path=${["discovery", "promptFile"]} /><//>
            <${Field} label="After finding nothing, leave a project alone for"><${Range} label="Discovery cooldown" path=${["discovery", "emptyCooldownHours"]} min="1" max="168" step="1" format=${(h) => span(h * 3600)} /><//>`
        : html`<${Empty}>Add <code>discovery</code> with a prompt file to the config file to turn discovery on.<//>`}
    <//>
    <${Section} title="Upstream releases">
      ${c.upstream
        ? html`<${Field} label="Prompt file on your Mac" hint="Read for each review run."><${Input} mono path=${["upstream", "promptFile"]} /><//>
            <${Field} label="Check for releases every" hint="A repository can set its own interval."><${Range} label="Check interval" path=${["upstream", "checkMinutes"]} min="15" max="1440" step="15" format=${minutes} /><//>`
        : html`<${Empty}>No watched repositories. Add <code>upstream</code> with a prompt file to the config file to turn reviews on.<//>`}
    <//>
  <//>`;
}

export function Settings({ id: tab = "projects" } = {}) {
  const lead = html`<${Segmented} label="Settings" value=${tab} onChange=${(v) => navigate(`/settings/${v}`)} options=${TABS} />`;
  const View = { projects: Projects, models: Models, limits: Capacity, sources: SourceSettings }[tab] ?? Projects;
  return html`<${View} lead=${lead} />`;
}
