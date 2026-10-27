import { html, useState, useEffect, useRef } from "../lib/h.js";
import { authenticated, auth, connection, config, jobs, notice, dirty, changes, busy, blocked, actions, runChain, message } from "../lib/store.js";
import { route, PAGES, follow } from "../lib/router.js";
import { Button, Dialog, Confirmation, Toast, Segmented, Tag, Meta, RowBody } from "../ui/index.js";
import { confirmAction } from "../lib/confirmation.js";
import { THEMES, APPEARANCES, theme, choose, appearance } from "../lib/theme.js";
import { Login } from "./Login.js";
import { Deck } from "./Deck.js";
import { Runs, RunDetail } from "./Runs.js";
import { SessionTickets } from "./SessionTickets.js";
import { Cleanup } from "./Cleanup.js";
import { Activity } from "./Activity.js";
import { Models } from "./Models.js";
import { Capacity } from "./Capacity.js";
import { Projects } from "./Projects.js";
import { Upstream } from "./Upstream.js";

const pages = { "/": Deck, "/start": Deck, "/runs": Runs, "/runs/:id": RunDetail, "/session-tickets": SessionTickets, "/activity": Activity, "/cleanup": Cleanup, "/models": Models, "/capacity": Capacity, "/projects": Projects, "/upstream": Upstream };
const CONNECTION = { connecting: "Connecting", live: "Live", retrying: "Retrying", polling: "Polling", offline: "Offline" };

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

// Pulling down from the top of any page reloads its state. Dialogs and drag handles keep their touches.
const PULL = 60;
function usePullToRefresh(onRefresh) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current;
    let start = null;
    const move = (e) => {
      if (start === null) return;
      const dy = e.touches[0].clientY - start.y;
      // A sideways swipe belongs to the scroller under it.
      if (dy <= 0 || Math.abs(e.touches[0].clientX - start.x) > dy) return void ((start = null), (el.style.height = "0px"));
      if (e.cancelable) e.preventDefault();
      const d = Math.min(dy / 2, PULL);
      el.style.height = d + "px";
      el.textContent = d >= PULL ? "Release to refresh" : "Pull to refresh";
    };
    // scrollY dips below zero while a bounce settles; that still counts as the top.
    // A scrolled list under the finger, such as an open dropdown, scrolls back up instead.
    const atTop = (target) => {
      if (window.scrollY > 0 || target.closest?.("dialog, .grip")) return false;
      for (let n = target; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return false;
      return true;
    };
    const begin = (e) => {
      const t = e.touches[0];
      start = atTop(e.target) ? { x: t.clientX, y: t.clientY } : null;
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

function Shell() {
  const { page, param } = route.value;
  const [picking, setPicking] = useState(false);
  const ptr = usePullToRefresh(actions.refresh);
  const Page = pages[page];
  const waiting = jobs.value.filter((j) => j.state === "waiting").length;
  return html`<header class="top">
    <a class="wordmark" href="/" onClick=${follow}>FACTORY</a>
    <nav aria-label="Pages">
      ${PAGES.map(
        ([path, name]) => html`<a key=${path} href=${path} onClick=${follow} aria-current=${page === path || (path === "/" && page === "/start") || (path === "/runs" && page === "/runs/:id") ? "page" : undefined}>
          ${name}${path === "/runs" && waiting > 0 && html`<b class="badge" title="Runs that need you">${waiting}</b>`}
        </a>`,
      )}
    </nav>
    <span class="right">
      <span role="status" class=${`conn ${connection.value}`} title=${`Updates: ${CONNECTION[connection.value]}`}><i></i>${CONNECTION[connection.value]}</span>
      <${Button} variant="ghost" size="sm" icon="paintbrush" label="Theme" onClick=${() => setPicking(true)} />
      <${Button} variant="ghost" size="sm" icon="signOut" label=${auth.value.mode === "oidc" ? "Sign out" : "Disconnect"} onClick=${() => dirty.value ? confirmAction({ title: "Discard unsaved changes?", message: "Your unsaved settings will be lost.", label: auth.value.mode === "oidc" ? "Discard and sign out" : "Discard and disconnect" }, () => actions.logout()) : actions.logout()} />
    </span>
  </header>
  <${ThemePicker} open=${picking} onClose=${() => setPicking(false)} />
  <div ref=${ptr} class="ptr" aria-live="polite"></div>
  <main key=${page + param}><${Page} id=${param} initialTicket=${page === "/start" ? param : undefined} /></main>`;
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
    ${b && html`<p class="muted">The whole chain starts every ticket that can start now, within the run limits, continues as tickets finish, and runs ${b.ticket} last.</p>
      <div class="chain">
        ${tickets.map(
          (t) => {
            const ahead = t.blockedBy.map((id) => byId.get(id)?.key).filter(Boolean);
            return html`<div class="chain-row" key=${t.id}>
              <${Tag} tone=${ahead.length ? "" : t.runnable ? "ok" : "attention"}>${ahead.length ? "waits" : t.runnable ? "can start" : "not included"}<//>
              <${RowBody} title=${html`<b class="key">${t.key}</b> ${t.title}`}>
                <${Meta} automationReady=${t.automationReady} priority=${t.priority} difficulty=${t.difficulty || false}>${ahead.length ? `after ${ahead.join(", ")}` : "nothing ahead of it"}<//>
              <//>
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
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
    <${Blocked} />
    <${Confirmation} />
    ${dirty.value && html`<${SaveBar} />`}
    <${Toast} notice=${notice.value} onDone=${() => message("")} />`;
}
