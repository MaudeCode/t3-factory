// Dialog and toast. Both stay mounted so open and close can animate.
import { html, useEffect, useRef } from "../lib/h.js";
import { isBackdropClick } from "../lib/format.js";
import { Button } from "./controls.js";
import { confirmation, finishConfirmation } from "../lib/confirmation.js";

// Small panel anchored under `anchor` (a ref to the trigger); closes on outside pointer, Escape, or scroll away.
export function Popover({ open, onClose, anchor, label, width = 300, children }) {
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const panel = ref.current, trigger = anchor.current;
    const position = () => {
      const t = trigger.getBoundingClientRect(), edge = 8;
      const w = Math.min(width, innerWidth - edge * 2);
      Object.assign(panel.style, { width: `${w}px`, left: `${Math.max(edge, Math.min(t.right - w, innerWidth - edge - w))}px`, top: `${t.bottom + 4}px`, maxHeight: `${innerHeight - t.bottom - 12}px` });
    };
    const outside = (e) => !panel.contains(e.target) && !trigger.contains(e.target) && onClose();
    const escape = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); trigger.focus({ preventScroll: true }); } };
    panel.showPopover();
    position();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", position);
    return () => {
      panel.hidePopover();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", position);
    };
  }, [open]);
  return open && html`<div ref=${ref} class="popover" popover="manual" role="group" aria-label=${label}>${children}</div>`;
}

// Native <dialog>; closes on Escape, backdrop click, or the Done button.
export function Dialog({ open, onClose, title, children, actions, descriptionId }) {
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
    aria-describedby=${descriptionId}
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

export function Confirmation() {
  const prompt = confirmation.value;
  useEffect(() => () => finishConfirmation(), []);
  return html`<${Dialog}
    open=${!!prompt}
    onClose=${() => finishConfirmation()}
    title=${prompt?.title ?? "Confirm"}
    descriptionId="confirmation-message"
    actions=${html`<${Button} variant="ghost" autofocus onClick=${() => finishConfirmation()}>Cancel<//>
      <${Button} variant="danger" onClick=${() => finishConfirmation(true)}>${prompt?.label}<//>`}
  >
    <p id="confirmation-message">${prompt?.message}</p>
  <//>`;
}

export function Toast({ notice, onDone, ttl = 4000 }) {
  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(onDone, ttl);
    return () => clearTimeout(t);
  }, [notice, ttl]);
  if (!notice) return null;
  return html`<div key=${notice.at} class=${`toast ${notice.error ? "toast-error" : ""}`} role=${notice.error ? "alert" : "status"}>
    <div class="toast-content" tabindex="0" role="region" aria-label="Notification text">${notice.text}</div>
    <${Button} variant="ghost" class="toast-dismiss" onClick=${onDone}>Dismiss<//>
  </div>`;
}
