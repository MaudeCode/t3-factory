// Theme selection. The factory's own palette plus T3 Code's, applied as CSS variables on the root
// element so the stylesheet never names a colour twice. The choice persists in this browser.
import { signal, effect } from "./h.js";
import { T3_THEMES } from "./themes.js";

const FACTORY = {
  id: "factory",
  label: "Factory",
  dark: { bg: "#171320", surface: "#1f1a2b", "surface-2": "#2a2438", ink: "#f5f1fa", muted: "#9b92ad", line: "#332c44", accent: "#bfd7ff", "accent-ink": "#171320", "accent-text": "#bfd7ff", attention: "#ffa36b", danger: "#ff7b86" },
  light: { bg: "#f7f4fb", surface: "#ffffff", "surface-2": "#ebe6f4", ink: "#1d1828", muted: "#6b6380", line: "#dcd5e9", accent: "#3b5bdb", "accent-ink": "#ffffff", "accent-text": "#2f4ec2", attention: "#b45309", danger: "#c2283a" },
};
// T3 has no success role; one per appearance keeps Done and Live readable on every palette.
const OK = { dark: "#9ee2b8", light: "#15803d" };

export const THEMES = [FACTORY, ...T3_THEMES];
export const APPEARANCES = [["system", "System"], ["dark", "Dark"], ["light", "Light"]];
const storage = globalThis.localStorage;
const stored = (() => { try { return JSON.parse(storage?.getItem("factoryTheme") ?? "null"); } catch { return null; } })();
export const theme = signal({ id: "factory", appearance: "dark", ...stored });
const media = globalThis.matchMedia?.("(prefers-color-scheme: light)");

export const themeOf = (id) => THEMES.find((t) => t.id === id) ?? FACTORY;
export const appearance = () => (theme.value.appearance === "system" ? (media?.matches ? "light" : "dark") : theme.value.appearance);

export function apply() {
  const mode = appearance(),
    colors = themeOf(theme.value.id)[mode],
    root = document.documentElement;
  for (const [token, value] of Object.entries(colors)) root.style.setProperty(`--${token}`, value);
  root.style.setProperty("--ok", OK[mode]);
  root.style.colorScheme = mode;
  document.querySelector("meta[name=theme-color]")?.setAttribute("content", colors.bg);
  storage?.setItem("factoryTheme", JSON.stringify(theme.value));
}
export function choose(patch) {
  theme.value = { ...theme.value, ...patch };
}
if (typeof document !== "undefined") {
  effect(apply);
  media?.addEventListener("change", apply);
}
