// What the system does to this window on a foldable, measured because no media query reports it.
// The open Duo in landscape shows the app one of three ways: full width with a live-activity pill floating over the
// top right corner and no inset; full width under a status column, reported as a right safe-area inset; or beside
// that column, in a window narrower than the screen with no inset. Only the first needs the corner clearance in
// style.css. The inset covers the second there, and `--corner` set to 0 here covers the third, which shows as an
// inner width short of the outer one.
import { signal } from "./h.js";

export const display = signal("");
export function measure() {
  const root = document.documentElement, probe = document.createElement("i");
  probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);
  const s = getComputedStyle(probe), insets = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat).join(" ");
  probe.remove();
  if (outerWidth - innerWidth >= 60) root.style.setProperty("--corner", "0px"); else root.style.removeProperty("--corner");
  const mode = ["standalone", "fullscreen", "minimal-ui"].find((m) => matchMedia(`(display-mode: ${m})`).matches) ?? "browser";
  display.value = `Window ${innerWidth} by ${innerHeight}, outer ${outerWidth} by ${outerHeight}, screen ${screen.width} by ${screen.height}, insets ${insets}, ${mode}, turned ${screen.orientation?.angle ?? "?"}`;
}
if (typeof document !== "undefined") {
  measure();
  for (const event of ["resize", "orientationchange"]) addEventListener(event, measure);
}
