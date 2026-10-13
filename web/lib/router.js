// Path-based routing on the History API. The server returns index.html for any extensionless path.
import { signal } from "./h.js";

export const PAGES = [
  ["/", "Deck"],
  ["/runs", "Runs"],
  ["/activity", "Activity"],
  ["/models", "Models"],
  ["/capacity", "Capacity"],
  ["/projects", "Projects"],
  ["/upstream", "Upstream"],
];

// Resolve a path to { page, param }. Unknown paths fall back to the deck.
export function match(path) {
  const run = path.match(/^\/runs\/([\w-]+)$/);
  if (run) return { page: "/runs/:id", param: run[1], path };
  return PAGES.some(([p]) => p === path) ? { page: path, param: null, path } : { page: "/", param: null, path: "/" };
}

export const route = signal(match(globalThis.location?.pathname ?? "/"));

export function navigate(href, replace = false) {
  const [path, query = ""] = href.split("?");
  const next = match(path);
  const target = next.path + (query ? `?${query}` : "");
  if (target !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", target);
  route.value = next;
  window.scrollTo(0, 0);
}
globalThis.addEventListener?.("popstate", () => (route.value = match(location.pathname)));

// Click handler for internal links: same-tab navigation without a reload.
export const follow = (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href"));
};
