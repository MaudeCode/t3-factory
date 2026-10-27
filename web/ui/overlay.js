// Dialog and toast. Both stay mounted so open and close can animate.
import { html, useEffect, useRef } from "../lib/h.js";
import { isBackdropClick, selectPosition } from "../lib/format.js";
import { Button } from "./controls.js";
import { confirmation, finishConfirmation } from "../lib/confirmation.js";

// Small panel anchored under `anchor` (a ref to the trigger); follows it while the page scrolls or resizes,
// and closes on an outside pointer or Escape.
export function Popover({ open, onClose, anchor, label, width = 300, children, class: extra = "" }) {
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const panel = ref.current, trigger = anchor.current;
    const position = () => {
      if (!trigger.getClientRects().length) { onClose(); return; }
      const t = trigger.getBoundingClientRect(), viewport = window.visualViewport ?? { width: innerWidth, height: innerHeight };
      const w = Math.min(width, viewport.width - 16);
      panel.style.width = `${w}px`;
      const p = selectPosition({ left: t.right - w, top: t.top, bottom: t.bottom, width: w }, viewport, panel.scrollHeight + 2, Infinity);
      Object.assign(panel.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.height}px` });
    };
    const outside = (e) => !panel.contains(e.target) && !trigger.contains(e.target) && onClose();
    const escape = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); (trigger.querySelector("button") ?? trigger).focus({ preventScroll: true }); } };
    panel.showPopover();
    position();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    panel.addEventListener("toggle", position, true); // an opened <details> grows the panel
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      panel.hidePopover();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      panel.removeEventListener("toggle", position, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);
  return open && html`<div ref=${ref} class=${`popover ${extra}`} popover="manual" role="group" aria-label=${label}>${children}</div>`;
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
