import { html, useEffect } from "../lib/h.js";
import { config, status, providers, jobs, selectedModel, actions, chooseModel, setModelOption, instanceDriver } from "../lib/store.js";
import { DIFFICULTIES, difficultyLabel, providerName, providerIcon, streamReason, isOpen } from "../lib/format.js";
import { Button, Field, Input, Select, Segmented, Toggle, Tag, Icon, SortableList, Page, RowBody } from "../ui/index.js";

// What the scheduler thinks of each model right now.
function liveState(m) {
  const streams = status.value.streams || [];
  for (const s of streams) {
    if (s.quota?.factoryRouting?.modelId === m.id) return { text: "next automatic run", tone: "ok", next: true };
    const entry = (s.models || []).find((x) => x.id === m.id);
    if (entry) return { text: streamReason(entry.reason), tone: entry.reason === "provider-running" ? "on" : "" };
  }
  return m.automatic ? { text: "not considered on the last check", tone: "" } : { text: "manual only", tone: "" };
}

function Editor({ index }) {
  const m = config.value.models[index];
  const p = ["models", String(index)],
    provider = providers.value.find((x) => x.instanceId === m.model.instanceId),
    available = provider?.models || [],
    chosen = available.find((x) => x.slug === m.model.model),
    descriptors = (chosen?.capabilities?.optionDescriptors || []).filter((d) => d.type === "select");
  const providerOptions = [
    ...(provider ? [] : [[m.model.instanceId, m.model.instanceId]]),
    ...providers.value.map((x) => [x.instanceId, providerName(x.driver) + (x.instanceId === x.driver ? "" : ", " + x.instanceId)]),
  ];
  const slugOptions = [
    ...(chosen ? [] : [[m.model.model, m.model.model || "Choose a model"]]),
    ...available.map((x) => [x.slug, x.name || x.slug]),
  ];
  const live = liveState(m);
  const inUse = jobs.value.some((j) => isOpen(j) && j.modelSelection?.model === m.model.model && j.modelSelection?.instanceId === m.model.instanceId);
  return html`<div class="detail">
    <div class="detail-head">
      <div><h2><${Icon} name=${providerIcon(instanceDriver(m.model.instanceId))} /> ${m.name}</h2><p class="muted">${live.text}${provider && provider.status && provider.status !== "ready" ? `. Provider ${provider.status}` : ""}</p></div>
      <${Button} variant="danger" size="sm" disabled=${inUse || config.value.models.length === 1} icon="trash" label=${inUse ? "A run is still using this model" : "Remove model"} onClick=${() => actions.removeModel(index)} />
    </div>
    <${Toggle} path=${[...p, "automatic"]} label="Takes tickets automatically" hint=${m.automatic ? "The scheduler may pick this model when it is next in priority and inside its allowance." : "Only used when you start a run and choose it."} />
    <div class="grid-2">
      <${Field} label="Name"><${Input} path=${[...p, "name"]} /><//>
      <${Field} group label="Hardest ticket it may take" hint="Tickets carry a difficulty label. Applies to automatic and manual runs."><${Segmented} label="Hardest ticket" path=${[...p, "maxDifficulty"]} options=${DIFFICULTIES} /><//>
      <${Field} label="Provider"><${Select} label="Provider" value=${m.model.instanceId} options=${providerOptions} onChange=${(v) => chooseModel(index, v, "")} /><//>
      <${Field} label="Model"><${Select} label="Model" value=${m.model.model} options=${slugOptions} onChange=${(v) => chooseModel(index, m.model.instanceId, v)} /><//>
      ${descriptors.map((d) => {
        const current = m.model.options?.find((o) => o.id === d.id)?.value ?? d.currentValue ?? d.options.find((o) => o.isDefault)?.id;
        return html`<${Field} key=${d.id} label=${d.label || d.id}>
          <${Select} label=${d.label || d.id} value=${current} options=${d.options.map((o) => [o.id, o.label || o.id])} onChange=${(v) => setModelOption(index, d.id, v)} />
        <//>`;
      })}
    </div>
    ${m.quotaWindowId && html`<p class="small muted">Budgeted against the ${m.quotaWindowId.replaceAll("_", " ")} window.</p>`}
  </div>`;
}

export function Models() {
  useEffect(actions.ensureCatalog, []);
  const list = config.value.models;
  const index = Math.min(selectedModel.value, list.length - 1);
  return html`<${Page} title="Models" hint="Drag to set priority. The first model that is automatic, within its difficulty ceiling, and inside its allowance takes the next ticket."
    actions=${html`<${Button} variant="ghost" size="sm" icon="sync" label="Refresh catalog" onClick=${actions.catalog} /><${Button} variant="primary" size="sm" icon="plus" label="Add model" onClick=${actions.addModel} />`}>
    <div class="split">
      <${SortableList}
        label="Models by priority"
        items=${list}
        keyOf=${(m) => m.id}
        onMove=${actions.moveModel}
        render=${(m, i, grip) => {
          const live = liveState(m);
          return html`<div class=${`item ${i === index ? "current" : ""}`} role="option" aria-selected=${i === index} tabindex="0"
            onClick=${() => (selectedModel.value = i)} onKeyDown=${(e) => e.key === "Enter" && (selectedModel.value = i)}>
            ${grip}
            <span class="rank">${i + 1}</span>
            <${RowBody} title=${html`<b>${m.name}</b>`}>
              <${Icon} name=${providerIcon(instanceDriver(m.model.instanceId))} label=${providerName(instanceDriver(m.model.instanceId))} /> ${m.model.model || "no model"}
              <${Tag} title=${`Hardest ticket it may take: ${difficultyLabel(m.maxDifficulty).toLowerCase()}`}><small>D</small>${m.maxDifficulty}<//>
              ${live.next ? html`<${Tag} tone="on" title="The next automatic run uses this model">next<//>` : live.tone === "on" ? html`<${Tag} tone="on">working<//>` : null}
            <//>
            <${Icon} name=${m.automatic ? "zap" : "person"} label=${m.automatic ? "Automatic: the scheduler may pick it" : "Manual: only when you choose it"} />
          </div>`;
        }}
      />
      <${Editor} key=${list[index]?.id} index=${index} />
    </div>
  <//>`;
}
