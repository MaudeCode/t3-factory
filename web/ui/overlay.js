// Dialog and toast. Both stay mounted so open and close can animate.
import { html, useEffect, useRef } from "../lib/h.js";
import { isBackdropClick } from "../lib/format.js";
import { Button } from "./controls.js";

// Native <dialog>; closes on Escape, backdrop click, or the Done button.
export function Dialog({ open, onClose, title, children, actions }) {
  const ref = useRef();
  useEffect(() => {
    const d = ref.current;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return html`<dialog
    ref=${ref}
    onClose=${onClose}
    onClick=${(e) => isBackdropClick(e, ref.current) && ref.current.close()}
    aria-label=${title}
  >
    ${open &&
    html`<div class="dialog-head">
        <h2>${title}</h2>
        ${!actions && html`<${Button} variant="ghost" size="sm" onClick=${() => ref.current.close()}>Done<//>`}
      </div>
      ${children}
      ${actions && html`<div class="dialog-actions">${actions}</div>`}`}
  </dialog>`;
}

export function Toast({ notice, onDone, ttl = 4000 }) {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDone, notice.error ? ttl * 2 : ttl);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return html`<div key=${notice.at} class=${`toast ${notice.error ? "toast-error" : ""}`} role=${notice.error ? "alert" : "status"} onClick=${onDone} title="Dismiss">
    ${notice.text}
  </div>`;
}
