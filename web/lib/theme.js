// Theme selection. The factory's own palette plus T3 Code's, applied as CSS variables on the root
// element so the stylesheet never names a colour twice. The choice persists in this browser.
import { signal, effect } from "./h.js";
import { T3_THEMES } from "./themes.js";

// Ink: a muted plum-blue. Colour is kept for state, so the accent stays close to the ink.
const FACTORY = {
  id: "factory",
  label: "Factory",
  dark: { bg: "#14141d", surface: "#1b1b28", "surface-2": "#272738", ink: "#ecedf6", muted: "#9193ab", line: "#2b2b3e", accent: "#c4cae9", "accent-ink": "#14141d", "accent-text": "#b9c0e6", attention: "#dcae8e", danger: "#f0a0a8", ok: "#a2ccba" },
  light: { bg: "#f3f4f9", surface: "#ffffff", "surface-2": "#e5e7f1", ink: "#1c1d2b", muted: "#63667e", line: "#d9dbe8", accent: "#3f4570", "accent-ink": "#ffffff", "accent-text": "#4a5296", attention: "#9a5b2e", danger: "#b3394a", ok: "#3d7a57" },
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
