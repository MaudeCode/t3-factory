// Path-based routing on the History API. The server returns index.html for any extensionless path.
import { signal } from "./h.js";
import { ticketKey } from "./format.js";

// The sidebar's groups: [path, name, icon]. PAGES is the same list flat, for route matching.
export const NAV = [
  ["Operate", [["/", "Now", "home"], ["/runs", "Runs", "play"], ["/triage", "Triage", "inbox"], ["/session-tickets", "Session tickets", "issueOpened"], ["/activity", "Activity", "pulse"]]],
  ["Maintain", [["/cleanup", "Cleanup", "trash"], ["/upstream", "Upstream", "gitBranch"]]],
  ["Configure", [["/projects", "Projects", "repo"], ["/models", "Models", "cpu"], ["/capacity", "Capacity", "meter"]]],
];
export const PAGES = NAV.flatMap(([, pages]) => pages);
// The phone's bottom bar; the rest of NAV is behind More.
export const TABS = [["/", "Now"], ["/runs", "Runs"], ["/triage", "Triage"], ["/session-tickets", "Tickets"]];

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

const current = () => (globalThis.location?.pathname ?? "/") + (globalThis.location?.search ?? "");
export const route = signal(match(current()));

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

export function navigate(href, replace = false) {
  const query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  const next = match(href);
  const target = next.path + (query ? `?${query}` : "");
  if (target !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", target);
  route.value = next;
  ticketPanel.value = panelKey(target);
  window.scrollTo(0, 0);
}
globalThis.addEventListener?.("popstate", () => { route.value = match(current()); ticketPanel.value = panelKey(current()); });

// Click handler for internal links: same-tab navigation without a reload.
export const follow = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href"));
};
