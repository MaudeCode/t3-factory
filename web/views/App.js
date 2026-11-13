import { html, signal, useState, useEffect, useRef } from "../lib/h.js";
import { authenticated, auth, connection, config, status, live, clock, jobs, notice, dirty, changes, busy, blocked, actions, runChain, message, issues, issuesOpen, serverNow } from "../lib/store.js";
import { route, NAV, TABS, follow } from "../lib/router.js";
import { Button, Dialog, Confirmation, Toast, Segmented, Switch, Icon, Tag, Meta, RowBody, Popover } from "../ui/index.js";
import { ago, until } from "../lib/format.js";
import { confirmAction } from "../lib/confirmation.js";
import { THEMES, APPEARANCES, theme, choose, appearance } from "../lib/theme.js";
import { Login } from "./Login.js";
import { OperationActions, Composer } from "./Deck.js";
import { Now } from "./Now.js";
import { TicketPanel } from "./TicketPanel.js";
import { Runs, RunDetail } from "./Runs.js";
import { Queue } from "./Queue.js";
import { Cleanup } from "./Cleanup.js";
import { Activity } from "./Activity.js";
import { Models } from "./Models.js";
import { Capacity } from "./Capacity.js";
import { Projects } from "./Projects.js";
import { Upstream } from "./Upstream.js";
import { Triage } from "./Triage.js";

const pages = { "/": Now, "/start": Now, "/runs": Runs, "/runs/:id": RunDetail, "/queue": Queue, "/activity": Activity, "/cleanup": Cleanup, "/models": Models, "/capacity": Capacity, "/projects": Projects, "/upstream": Upstream, "/triage": Triage };
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

// The connection indicator doubles as the notification area. Background problems and requests that ended without
// starting add a count; their list opens from here or from an affected page. Problems never pop up on their own:
// a reconnecting stream would flicker.
function Updates() {
  const anchor = useRef(), list = issues.value, now = serverNow(), state = CONNECTION[connection.value];
  const problems = (error) => error.problems ?? [{ title: error.message, raw: [], subjects: [] }];
  const count = list.reduce((n, i) => n + problems(i.error).length, 0);
  useEffect(() => { if (!count) issuesOpen.value = false; }, [count]);
  // A chain choice opened from the list replaces it.
  useEffect(() => { if (blocked.value) issuesOpen.value = false; }, [blocked.value]);
  if (!count) return html`<span role="status" class=${`conn ${connection.value}`} title=${`Updates: ${state}`}><i></i><span class="conn-label">${state}</span></span>`;
  const close = () => (issuesOpen.value = false);
  return html`<span ref=${anchor}>
    <button type="button" class=${`conn ${connection.value}`} aria-expanded=${issuesOpen.value} aria-label=${`Updates: ${state}. ${count} ${count === 1 ? "issue" : "issues"}`} title="Show issues" onClick=${() => (issuesOpen.value = !issuesOpen.value)}>
      <i></i><span role="status" class="conn-label">${state}</span><b class="badge">${count}</b>
    </button>
    <${Popover} class="issues" open=${issuesOpen.value} onClose=${close} anchor=${anchor} label="Issues" width=${400}>
      ${list.map((i) => html`<section key=${i.source} class="issue-source">
        <header><a href=${i.href} onClick=${(e) => { close(); follow(e); }}>${i.source}</a><span>${i.note ?? `Last failure ${ago(i.error.at, now)}`}</span></header>
        ${problems(i.error).map((p) => html`<div class="issue">
          <p class="issue-title">${p.title}</p>
          ${p.cause && html`<p>${p.cause}</p>`}
          ${p.op && html`<div class="issue-actions"><${OperationActions} op=${p.op} /></div>`}
          ${(p.subjects.length > 0 || p.raw.length > 0) && html`<details>
            <summary>Details</summary>
            ${p.subjects.length > 0 && html`<ul class="issue-subjects">${p.subjects.map((id) => html`<li><${Tag}><code>${id}</code><//></li>`)}</ul>`}
            ${p.raw.map((r) => html`<p class="mono">${r}</p>`)}
          </details>`}
        </div>`)}
      </section>`)}
    <//>
  </span>`;
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

// Sidebar expanded or collapsed to icons. A stored choice wins; without one, wide windows start expanded.
const RAIL = "factoryRail";
const storedRail = () => { try { return globalThis.localStorage?.getItem(RAIL) ?? null; } catch { return null; } };
const rail = signal(storedRail() ? storedRail() === "collapsed" : (globalThis.innerWidth ?? 1200) < 900);
const setRail = (collapsed) => {
  rail.value = collapsed;
  try { globalThis.localStorage?.setItem(RAIL, collapsed ? "collapsed" : "expanded"); } catch { /* private window: the choice lasts until reload */ }
};
// At phone width the sidebar gives way to a top bar and a bottom tab bar.
const PHONE = "(max-width: 600px)";
function usePhone() {
  const [phone, setPhone] = useState(() => !!globalThis.matchMedia?.(PHONE).matches);
  useEffect(() => {
    const media = matchMedia(PHONE), change = () => setPhone(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return phone;
}

// The automation switch, with its state and when the scheduler looks next. `bare` is the switch alone.
function Automation({ bare }) {
  clock.value;
  const on = live.value.enabled, d = status.value.decision, now = serverNow();
  const next = d?.at ? Date.parse(d.at) + (config.value.pollSeconds ?? 60) * 1000 : null;
  return html`<div class="auto" title=${on ? "Automation on" : "Automation paused"}>
    <${Switch} label="Automation" checked=${on} disabled=${busy.value} onChange=${() => actions.toggle("enabled")} />
    ${!bare && html`<span class="auto-text"><b>${on ? "Automation on" : "Automation paused"}</b>
      <small>${on && next ? `Next check ${next > now + 1000 ? until(next, now) : "due now"}` : `Last check ${ago(d?.at, now)}`}</small></span>`}
  </div>`;
}

// Start a run from any page: the start bar in a panel under its button.
function Start() {
  const anchor = useRef(), [open, setOpen] = useState(false);
  return html`<span ref=${anchor} class="start">
    <${Button} variant="primary" icon="play" class="start-btn" aria-label="Start a run" title="Start a run" aria-expanded=${open} onClick=${() => setOpen(!open)}><span>Start a run</span><//>
    <${Popover} class="start-pop" open=${open} onClose=${() => setOpen(false)} anchor=${anchor} label="Start a run" width=${480}><${Composer} /><//>
  </span>`;
}

function Shell() {
  const { page, param } = route.value;
  const [picking, setPicking] = useState(false), [more, setMore] = useState(false);
  const phone = usePhone();
  const ptr = usePullToRefresh(actions.refresh);
  const Page = pages[page];
  const waiting = jobs.value.filter((j) => j.state === "waiting").length;
  const current = (path) => page === path || (path === "/" && page === "/start") || (path === "/runs" && page === "/runs/:id");
  const badge = (path) => path === "/runs" && waiting > 0 && html`<b class="badge" title="Runs that need you">${waiting}</b>`;
  const signOut = auth.value.mode === "oidc" ? "Sign out" : "Disconnect";
  const leave = () => dirty.value ? confirmAction({ title: "Discard unsaved changes?", message: "Your unsaved settings will be lost.", label: auth.value.mode === "oidc" ? "Discard and sign out" : "Discard and disconnect" }, () => actions.logout()) : actions.logout();
  const wordmark = html`<a class="wordmark" href="/" onClick=${follow} aria-label="Factory: Now"><img src="/icon.svg" width="24" height="24" alt="" /><span>Factory</span></a>`;
  const link = ([path, name, icon]) => html`<a key=${path} href=${path} title=${name} onClick=${(e) => { setMore(false); follow(e); }} aria-current=${current(path) ? "page" : undefined}>
    <${Icon} name=${icon} /><span>${name}</span>${badge(path)}
  </a>`;
  const tabbed = new Set(TABS.map(([path]) => path));
  const inMore = NAV.flatMap(([, list]) => list).filter(([path]) => !tabbed.has(path));
  return html`<div class=${`shell${phone ? " phone" : rail.value ? " rail" : ""}`}>
    ${phone
      ? html`<header class="top">${wordmark}<span class="right"><${Updates} /><${Automation} bare /><${Start} /></span></header>`
      : html`<aside class="side" aria-label="Sidebar">
        <div class="side-head">${wordmark}<${Button} variant="ghost" size="sm" icon="sidebar" label=${rail.value ? "Expand sidebar" : "Collapse sidebar"} aria-expanded=${!rail.value} onClick=${() => setRail(!rail.value)} /></div>
        <${Automation} /><${Start} />
        ${NAV.map(([group, list]) => html`<nav key=${group} aria-label=${group}><h2>${group}</h2>${list.map(link)}</nav>`)}
        <div class="side-foot"><${Updates} />
          <${Button} variant="ghost" size="sm" icon="paintbrush" label="Appearance" onClick=${() => setPicking(true)} />
          <${Button} variant="ghost" size="sm" icon="signOut" label=${signOut} onClick=${leave} /></div>
      </aside>`}
    <div class="content">
      <div ref=${ptr} class="ptr" aria-live="polite"></div>
      <main key=${page + param}><${Page} id=${param} initialTicket=${page === "/start" ? param : undefined} /></main>
    </div>
    ${phone && html`<nav class="tabbar" aria-label="Pages">
      ${TABS.map(([path, name]) => link([path, name, NAV.flatMap(([, list]) => list).find(([p]) => p === path)[2]]))}
      <button type="button" aria-expanded=${more} aria-current=${inMore.some(([path]) => current(path)) ? "page" : undefined} onClick=${() => setMore(true)}><${Icon} name="kebab" /><span>More</span></button>
    </nav>`}
  </div>
  <${Dialog} open=${more} onClose=${() => setMore(false)} title="More">
    <nav class="more-list" aria-label="More pages">${inMore.map(link)}
      <button type="button" onClick=${() => { setMore(false); setPicking(true); }}><${Icon} name="paintbrush" /><span>Appearance</span></button>
      <button type="button" onClick=${() => { setMore(false); leave(); }}><${Icon} name="signOut" /><span>${signOut}</span></button>
    </nav>
  <//>
  <${ThemePicker} open=${picking} onClose=${() => setPicking(false)} />`;
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

function SaveBar() {
  const ref = useRef();
  useEffect(() => {
    let frame;
    const measure = () => {
      const style = document.documentElement.style, height = `${ref.current.getBoundingClientRect().height}px`;
      if (style.getPropertyValue("--save-bar-height") !== height) style.setProperty("--save-bar-height", height);
    };
    // The height changes page padding; apply it outside observer delivery to avoid a resize feedback loop.
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    measure();
    observer.observe(ref.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); document.documentElement.style.removeProperty("--save-bar-height"); };
  }, []);
  return html`<div ref=${ref} class="save-bar" role="region" aria-label="Unsaved changes">
  <span>${changes.value} unsaved ${changes.value === 1 ? "change" : "changes"}</span>
  <${Button} variant="ghost" disabled=${busy.value} onClick=${actions.revert}>Discard<//>
  <${Button} variant="primary" disabled=${busy.value} onClick=${actions.save}>Save changes<//>
</div>`;
}

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
    <${TicketPanel} />
    <${Blocked} />
    <${Confirmation} />
    ${dirty.value && html`<${SaveBar} />`}
    <${Toast} notice=${notice.value} onDone=${() => message("")} />`;
}
