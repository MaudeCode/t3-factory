// Path-based routing on the History API. The server returns index.html for any extensionless path.
import { signal } from "./h.js";
import { ticketKey } from "./format.js";

// The sidebar's groups: [path, name, icon]. PAGES is the same list flat, for route matching.
export const NAV = [
  ["Work", [["/", "Now", "home"], ["/queue", "Queue", "checklist"], ["/runs", "Runs", "play"], ["/sources", "Sources", "inbox"]]],
  ["Upkeep", [["/activity", "Log", "pulse"], ["/cleanup", "Storage", "trash"], ["/settings", "Settings", "gear"]]],
];
// Controls is the fifth compact destination. Desktop already lists its destinations individually.
export const CONTROLS = ["/controls", "Controls", "gear"];
export const PAGES = [...NAV.flatMap(([, pages]) => pages), CONTROLS];
export const TABS = [...NAV[0][1], CONTROLS];

// Resolve a path to { page, param }. Unknown paths fall back to Now.
export function match(href) {
  const [path] = href.split("?");
  const query = href.slice(path.length + 1);
  if (path === "/start") {
    const tickets = new URLSearchParams(query).getAll("ticket");
    return { page: path, param: tickets.length === 1 ? ticketKey(tickets[0]) : "", path };
  }
  // Settings has one tab per area; the bare address opens the first.
  const settings = path.match(/^\/settings(?:\/(projects|models|limits|sources|repair))?$/);
  if (settings) return { page: "/settings", param: settings[1] ?? "projects", path };
  const run = path.match(/^\/runs\/([\w-]+)$/);
  if (run) return { page: "/runs/:id", param: run[1], path };
  return PAGES.some(([p]) => p === path) ? { page: path, param: null, path } : { page: "/", param: null, path: "/" };
}

// Pages that moved: an old address lands on its new place, keeping any other query it carried.
export function moved(href) {
  const [path] = href.split("?"), query = new URLSearchParams(href.slice(path.length + 1));
  const to = (target, ...drop) => {
    for (const key of drop) query.delete(key);
    const rest = query.toString();
    return rest ? `${target}${target.includes("?") ? "&" : "?"}${rest}` : target;
  };
  if (path === "/session-tickets") return to("/queue?origin=sessions");
  if (path === "/runs" && query.get("state") === "next") return to("/queue", "state");
  if (path === "/runs" && query.get("state") === "epics") return to("/queue?view=epics", "state");
  if (path === "/triage") return to("/sources");
  if (path === "/upstream") return to("/sources?view=upstream");
  if (path === "/projects") return to("/settings/projects");
  if (path === "/models") return to("/settings/models");
  if (path === "/capacity") return to("/settings/limits");
  return href;
}
const current = () => (globalThis.location?.pathname ?? "/") + (globalThis.location?.search ?? "");
// What scrolls the page: the document in a browser tab, the pane beside the sidebar in the installed app (see style.css).
export const pageScroller = () => { const pane = document.querySelector(".shell.phone, .shell > .content"); return pane && getComputedStyle(pane).overflowY === "auto" ? pane : window; };
// An old address typed, bookmarked or reached by Back is rewritten in place.
const settle = () => { const here = current(), there = moved(here); if (there !== here) history.replaceState(history.state, "", there); return there; };
export const route = signal(match(globalThis.location ? settle() : "/"));
// The query of the current address, for pages whose view is part of it.
export const search = signal(globalThis.location?.search ?? "");

// A side panel is addressed by a query parameter on any page except the launch link, which owns `ticket`.
// Opening adds a history entry, so Back steps out of the panel; the page under it does not move.
const panels = [];
function panel(name, parse) {
  const mark = `${name}Panel`;
  const read = (href) => { const [path] = href.split("?"); return path === "/start" ? "" : parse(new URLSearchParams(href.slice(path.length + 1)).get(name) ?? "") || ""; };
  const value = signal(read(current()));
  const address = (key) => {
    const url = new URL(location.href);
    if (key) url.searchParams.set(name, key); else url.searchParams.delete(name);
    return url.pathname + url.search;
  };
  panels.push((href) => { value.value = read(href); });
  return {
    value,
    // Each open is a history entry that records how many of this panel's entries lead to it, so a ticket opened from
    // inside another is one Back away from the first, and Close leaves the panel in one step however deep it went.
    // A panel reached by its address (a link, a typed URL) has no page under it; the first open over it gives it one.
    open(key) {
      let depth = value.value ? Number(history.state?.[mark]) || 0 : 0;
      if (value.value && !depth) { const here = address(value.value); history.replaceState(history.state, "", address("")); history.pushState({ [mark]: (depth = 1) }, "", here); }
      history.pushState({ [mark]: depth + 1 }, "", address(key));
      value.value = key;
    },
    close() {
      if (!value.value) return;
      const depth = Number(history.state?.[mark]) || 0;
      if (depth) return history.go(-depth);
      history.replaceState(null, "", address(""));
      value.value = "";
    },
  };
}
// A link that opens a panel on a plain click; a modified or middle click keeps the link's own address.
// A panel link inside a row keeps the click, so the row's own link does not open over it.
const panelClick = (open) => (key) => key ? (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return; e.preventDefault(); e.stopPropagation(); open(key); } : undefined;
// ?ticket=KEY is one ticket; ?epic=ID is an Epic, which stays under a ticket opened from it.
const ticket = panel("ticket", ticketKey), epic = panel("epic", (id) => /^[\w-]{1,64}$/.test(id) && id);
export const ticketPanel = ticket.value, openTicket = ticket.open, closeTicket = ticket.close, ticketClick = panelClick(ticket.open);
export const epicPanel = epic.value, closeEpic = epic.close, epicClick = panelClick(epic.open);

export function navigate(href, replace = false, keepScroll = false) {
  href = moved(href);
  const query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  const next = match(href);
  const target = next.path + (query ? `?${query}` : "");
  if (target !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", target);
  route.value = next;
  search.value = location.search;
  for (const sync of panels) sync(target);
  if (!keepScroll) pageScroller().scrollTo(0, 0);
}
globalThis.addEventListener?.("popstate", () => { const here = settle(); route.value = match(here); search.value = location.search; for (const sync of panels) sync(here); });

// A run chosen from the Runs list. Where the list and the run sit side by side, the list stays where it is scrolled;
// where the run replaces the list, the page starts at its top like any other navigation.
export const followRun = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  const beside = !!document.querySelector(".runs-split") && getComputedStyle(document.querySelector(".runs-split")).display === "grid";
  navigate(event.currentTarget.getAttribute("href"), false, beside);
};
// Click handler for internal links: same-tab navigation without a reload.
export const follow = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href"));
};
