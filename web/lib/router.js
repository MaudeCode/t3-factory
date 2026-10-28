// Path-based routing on the History API. The server returns index.html for any extensionless path.
import { signal } from "./h.js";
import { ticketKey } from "./format.js";

export const PAGES = [
  ["/", "Deck"],
  ["/runs", "Runs"],
  ["/session-tickets", "Session tickets"],
  ["/activity", "Activity"],
  ["/cleanup", "Cleanup"],
  ["/models", "Models"],
  ["/capacity", "Capacity"],
  ["/projects", "Projects"],
  ["/upstream", "Upstream"],
  ["/triage", "Triage"],
];

// Resolve a path to { page, param }. Unknown paths fall back to the deck.
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

export function navigate(href, replace = false) {
  const query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  const next = match(href);
  const target = next.path + (query ? `?${query}` : "");
  if (target !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", target);
  route.value = next;
  window.scrollTo(0, 0);
}
globalThis.addEventListener?.("popstate", () => (route.value = match(current())));

// Click handler for internal links: same-tab navigation without a reload.
export const follow = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href"));
};
