import { html, useState, useEffect } from "../lib/h.js";
import { authenticated, auth, connection, config, jobs, notice, dirty, changes, busy, readiness, blocked, actions, runWithoutReadyLabel, runChain, message } from "../lib/store.js";
import { route, PAGES, follow } from "../lib/router.js";
import { Button, Dialog, Toast, Segmented, Tag } from "../ui/index.js";
import { THEMES, APPEARANCES, theme, choose, appearance } from "../lib/theme.js";
import { Login } from "./Login.js";
import { Deck } from "./Deck.js";
import { Runs, RunDetail } from "./Runs.js";
import { Activity } from "./Activity.js";
import { Models } from "./Models.js";
import { Capacity } from "./Capacity.js";
import { Projects } from "./Projects.js";
import { Upstream } from "./Upstream.js";

const pages = { "/": Deck, "/runs": Runs, "/runs/:id": RunDetail, "/activity": Activity, "/models": Models, "/capacity": Capacity, "/projects": Projects, "/upstream": Upstream };
const CONNECTION = { connecting: "Connecting", live: "Live", polling: "Polling", offline: "Offline" };

// Palette and light or dark choice, kept in this browser.
function ThemePicker({ open, onClose }) {
  const mode = appearance();
  return html`<${Dialog} open=${open} onClose=${onClose} title="Appearance">
    <${Segmented} label="Light or dark" value=${theme.value.appearance} options=${APPEARANCES} onChange=${(v) => choose({ appearance: v })} />
    <div class="swatches" role="group" aria-label="Theme">
      ${THEMES.map((t) => {
        const c = t[mode];
        return html`<button key=${t.id} type="button" class="swatch" aria-pressed=${t.id === theme.value.id} onClick=${() => choose({ id: t.id })}>
          <i>${[c.bg, c.surface, c.accent, c.ink].map((color) => html`<span style=${`background:${color}`}></span>`)}</i>
          <b>${t.label}</b><small>${t.id === "factory" ? "This app's own" : "From T3 Code"}</small>
        </button>`;
      })}
    </div>
  <//>`;
}

function Shell() {
  const { page, param } = route.value;
  const [picking, setPicking] = useState(false);
  const Page = pages[page];
  const waiting = jobs.value.filter((j) => j.state === "waiting").length;
  return html`<header class="top">
    <a class="wordmark" href="/" onClick=${follow}>FACTORY</a>
    <nav aria-label="Pages">
      ${PAGES.map(
        ([path, name]) => html`<a key=${path} href=${path} onClick=${follow} aria-current=${page === path || (path === "/runs" && page === "/runs/:id") ? "page" : undefined}>
          ${name}${path === "/runs" && waiting > 0 && html`<b class="badge" title="Runs that need you">${waiting}</b>`}
        </a>`,
      )}
    </nav>
    <span class="right">
      <span class=${`conn ${connection.value}`} title=${`Updates: ${CONNECTION[connection.value]}`}><i></i>${CONNECTION[connection.value]}</span>
      <${Button} variant="ghost" size="sm" onClick=${() => setPicking(true)}>Theme<//>
      <${Button} variant="ghost" size="sm" onClick=${actions.logout}>${auth.value.mode === "oidc" ? "Sign out" : "Disconnect"}<//>
    </span>
  </header>
  <${ThemePicker} open=${picking} onClose=${() => setPicking(false)} />
  <main key=${page + param}><${Page} id=${param} /></main>`;
}

function Readiness() {
  const r = readiness.value;
  return html`<${Dialog}
    open=${!!r}
    onClose=${() => (readiness.value = null)}
    title=${r ? `Run ${r.input.ticket.toUpperCase()} without ${r.label}?` : "Readiness"}
    actions=${html`<${Button} variant="ghost" onClick=${() => (readiness.value = null)}>Cancel<//>
      <${Button} variant="primary" onClick=${runWithoutReadyLabel}>Run anyway<//>`}
  >
    ${r && html`<p>This ticket is not marked ${r.label}. Run it anyway? This skips only the readiness-label requirement for this run. Dependency, difficulty, quota, and duplicate-run checks still apply.</p>`}
  <//>`;
}

// A ticket that waits on other tickets: run the first one that can start, or the whole chain and then the ticket.
function Blocked() {
  const b = blocked.value;
  const tickets = b?.tree.tickets ?? [];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const now = tickets.filter((t) => !t.blockedBy.length && t.runnable).length;
  return html`<${Dialog}
    open=${!!b}
    onClose=${() => (blocked.value = null)}
    title=${b ? `${b.ticket} waits on ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}` : "Blocked"}
    actions=${html`<${Button} variant="ghost" onClick=${() => (blocked.value = null)}>Cancel<//>
      <${Button} disabled=${!now} onClick=${() => runChain("first")}>Run the first blocker<//>
      <${Button} variant="primary" onClick=${() => runChain("all")}>Run the whole chain<//>`}
  >
    ${b && html`<p class="muted">The whole chain starts every ticket that can start now, within the run limits, continues as tickets finish, and runs ${b.ticket} last. Tickets without the ready label run anyway.</p>
      <div class="chain">
        ${tickets.map(
          (t) => {
            const ahead = t.blockedBy.map((id) => byId.get(id)?.key).filter(Boolean);
            return html`<div class="chain-row" key=${t.id}>
              <${Tag} tone=${ahead.length ? "" : t.runnable ? "ok" : "attention"}>${ahead.length ? "waits" : t.runnable ? "can start" : "not included"}<//>
              <span class="chain-body"><span><b class="key">${t.key}</b> ${t.title}</span>
                <small>${ahead.length ? `after ${ahead.join(", ")}` : "nothing ahead of it"}${t.priority ? ` · ${t.priority}` : ""}${t.difficulty ? ` · ${t.difficulty}` : " · no difficulty label"}${t.readyLabel ? "" : " · no ready label"}</small>
              </span>
            </div>`;
          },
        )}
      </div>`}
  <//>`;
}

const SaveBar = () => html`<div class="save-bar" role="region" aria-label="Unsaved changes">
  <span>${changes.value} unsaved ${changes.value === 1 ? "change" : "changes"}</span>
  <${Button} variant="ghost" disabled=${busy.value} onClick=${actions.revert}>Discard<//>
  <${Button} variant="primary" disabled=${busy.value} onClick=${actions.save}>Save changes<//>
</div>`;

// Cmd or Ctrl+S saves; leaving the page with edits asks first.
function useEditGuards() {
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty.value && !busy.value) actions.save();
      }
    };
    const leave = (e) => {
      if (dirty.value) e.preventDefault();
    };
    addEventListener("keydown", key);
    addEventListener("beforeunload", leave);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("beforeunload", leave);
    };
  }, []);
}

export function App() {
  useEditGuards();
  if (authenticated.value === null) return null;
  if (!authenticated.value) return html`<${Login} />`;
  return html`
    ${config.value && html`<${Shell} />`}
    <${Readiness} />
    <${Blocked} />
    ${dirty.value && html`<${SaveBar} />`}
    <${Toast} notice=${notice.value} onDone=${() => message("")} />`;
}
