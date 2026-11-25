// Theme selection. The factory's own palette plus T3 Code's, applied as CSS variables on the root
// element so the stylesheet never names a colour twice. The choice persists in this browser.
import { signal, effect } from "./h.js";
import { T3_THEMES } from "./themes.js";

// The default: neutral near-black greys, hairline borders and one indigo accent, after Linear's interface.
// Orange, green and red are kept for state.
const FACTORY = {
  id: "factory",
  label: "Factory",
  dark: { bg: "#08090a", surface: "#101113", "surface-2": "#1c1d21", ink: "#f7f8f8", muted: "#8a8f98", line: "#23252a", accent: "#5e6ad2", "accent-ink": "#ffffff", "accent-text": "#8b93ff", attention: "#f2994a", danger: "#eb5757", ok: "#4cb782" },
  light: { bg: "#fbfbfb", surface: "#ffffff", "surface-2": "#f0f0f2", ink: "#1b1c1f", muted: "#6b6f76", line: "#e6e6e9", accent: "#5e6ad2", "accent-ink": "#ffffff", "accent-text": "#4f58c4", attention: "#c2600c", danger: "#c9372c", ok: "#1f9d55" },
};
// T3 has no success role; one per appearance keeps Done and Live readable on its palettes.
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
  if (!colors.ok) root.style.setProperty("--ok", OK[mode]);
  root.style.colorScheme = mode;
  document.querySelector("meta[name=theme-color]")?.setAttribute("content", colors.bg);
  try { storage?.setItem("factoryTheme", JSON.stringify(theme.value)); } catch { /* private window */ }
}
export function choose(patch) {
  theme.value = { ...theme.value, ...patch };
}
if (typeof document !== "undefined") {
  effect(apply);
  media?.addEventListener("change", apply);
}
