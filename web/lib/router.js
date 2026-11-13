// Path-based routing on the History API. The server returns index.html for any extensionless path.
import { signal } from "./h.js";
import { ticketKey } from "./format.js";

// The sidebar's groups: [path, name, icon]. PAGES is the same list flat, for route matching.
export const NAV = [
  ["Operate", [["/", "Now", "home"], ["/queue", "Queue", "checklist"], ["/runs", "Runs", "play"], ["/sources", "Sources", "inbox"], ["/activity", "Activity", "pulse"]]],
  ["Maintain", [["/cleanup", "Cleanup", "trash"]]],
  ["Configure", [["/projects", "Projects", "repo"], ["/models", "Models", "cpu"], ["/capacity", "Capacity", "meter"]]],
];
export const PAGES = NAV.flatMap(([, pages]) => pages);
// The phone's bottom bar; the rest of NAV is behind More.
export const TABS = [["/", "Now"], ["/queue", "Queue"], ["/runs", "Runs"], ["/sources", "Sources"]];

// Resolve a path to { page, param }. Unknown paths fall back to Now.
export function match(href) {
  const [path] = href.split("?");
  const query = href.slice(path.length + 1);
  if (path === "/start") {
    const tickets = new URLSearchParams(query).getAll("ticket");
    return { page: path, param: tickets.length === 1 ? ticketKey(tickets[0]) : "", path };
  }
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
  return href;
}
const current = () => (globalThis.location?.pathname ?? "/") + (globalThis.location?.search ?? "");
// An old address typed, bookmarked or reached by Back is rewritten in place.
const settle = () => { const here = current(), there = moved(here); if (there !== here) history.replaceState(history.state, "", there); return there; };
export const route = signal(match(globalThis.location ? settle() : "/"));
// The query of the current address, for pages whose view is part of it.
export const search = signal(globalThis.location?.search ?? "");

// The ticket panel is addressed by ?ticket=KEY on any page except the launch link, which owns that parameter.
const panelKey = (href) => {
  const [path] = href.split("?");
  return path === "/start" ? "" : ticketKey(new URLSearchParams(href.slice(path.length + 1)).get("ticket") ?? "") || "";
};
export const ticketPanel = signal(panelKey(current()));
const withTicket = (key) => {
  const url = new URL(location.href);
  if (key) url.searchParams.set("ticket", key); else url.searchParams.delete("ticket");
  return url.pathname + url.search;
};
// Opening adds a history entry, so Back closes the panel; the page under it does not move.
export function openTicket(key) {
  history.pushState({ ticketPanel: true }, "", withTicket(key));
  ticketPanel.value = key;
}
export function closeTicket() {
  if (!ticketPanel.value) return;
  if (history.state?.ticketPanel) return history.back();
  history.replaceState(null, "", withTicket(""));
  ticketPanel.value = "";
}

export function navigate(href, replace = false, keepScroll = false) {
  href = moved(href);
  const query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  const next = match(href);
  const target = next.path + (query ? `?${query}` : "");
  if (target !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", target);
  route.value = next;
  search.value = location.search;
  ticketPanel.value = panelKey(target);
  if (!keepScroll) window.scrollTo(0, 0);
}
globalThis.addEventListener?.("popstate", () => { const here = settle(); route.value = match(here); search.value = location.search; ticketPanel.value = panelKey(here); });

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
