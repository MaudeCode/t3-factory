// What the system covers of this window. A foldable can keep a status column over the right edge that no safe-area
// inset reports: fixed boxes stop short of it while the page runs underneath. `--covered-right` is that column's
// width, so a drawer can paint under it, and `--corner` drops the corner clearance that the column makes needless.
import { signal } from "./h.js";

export const display = signal("");
export function measure() {
  const root = document.documentElement, probe = document.createElement("i");
  probe.style.cssText = "position:fixed;top:0;right:0;width:0;height:0;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);
  const fixed = Math.round(probe.getBoundingClientRect().right), s = getComputedStyle(probe), insets = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat).join(" ");
  probe.remove();
  const page = Math.round(Math.max(innerWidth, root.clientWidth, root.getBoundingClientRect().width)), covered = Math.max(0, page - fixed);
  root.style.setProperty("--covered-right", `${covered}px`);
  if (covered) root.style.setProperty("--corner", "0px"); else root.style.removeProperty("--corner");
  const mode = ["standalone", "fullscreen", "minimal-ui"].find((m) => matchMedia(`(display-mode: ${m})`).matches) ?? "browser";
  display.value = `Window ${innerWidth} by ${innerHeight}, page ${root.clientWidth}, view ${Math.round(visualViewport?.width ?? 0)}, fixed edge ${fixed}, screen ${screen.width} by ${screen.height}, insets ${insets}, ${mode}, turned ${screen.orientation?.angle ?? "?"}`;
}
if (typeof document !== "undefined") {
  measure();
  for (const event of ["resize", "orientationchange"]) addEventListener(event, measure);
  globalThis.visualViewport?.addEventListener("resize", measure);
}
