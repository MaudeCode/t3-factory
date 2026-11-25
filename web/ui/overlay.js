// Dialog and toast. Both stay mounted so open and close can animate.
import { html, useEffect, useRef, useState } from "../lib/h.js";
import { isBackdropClick, selectPosition } from "../lib/format.js";
import { Button } from "./controls.js";
import { confirmation, finishConfirmation } from "../lib/confirmation.js";

// Small panel anchored under `anchor` (a ref to the trigger); follows it while the page scrolls or resizes,
// and closes on an outside pointer or Escape.
// `beside` opens the panel to the right of a trigger that sits in the sidebar, so it never covers the navigation.
// A `mounted` panel keeps its content in the page while closed, for controls other parts of the page read.
export function Popover({ open, onClose, anchor, label, width = 300, children, class: extra = "", beside, mounted }) {
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const panel = ref.current, trigger = anchor.current;
    const position = () => {
      if (!trigger.getClientRects().length) { onClose(); return; }
      const t = trigger.getBoundingClientRect(), viewport = window.visualViewport ?? { width: innerWidth, height: innerHeight };
      const w = Math.min(width, viewport.width - 16);
      panel.style.width = `${w}px`;
      if (beside && t.right + 8 + w <= viewport.width - 8) {
        const height = Math.min(panel.scrollHeight + 2, viewport.height - 16);
        Object.assign(panel.style, { left: `${t.right + 8}px`, top: `${Math.max(8, Math.min(t.top, viewport.height - 8 - height))}px`, maxHeight: `${height}px` });
        return;
      }
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
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      panel.hidePopover();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      panel.removeEventListener("toggle", position, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open]);
  return (open || mounted) && html`<div ref=${ref} class=${`popover ${extra}`} popover="manual" role="group" aria-label=${label}>${children}</div>`;
}

const CONTROLS = "a, button, input, select, textarea, label, summary, [role=button], [role=switch], [tabindex], dialog, [popover], .toast";
// Native <dialog>; closes on Escape, backdrop click, or its Close button. With `modal` false it opens beside the page
// instead of over it, and the page stays in use; a tap on the page outside any control closes it. The choice is read
// when the dialog opens. `head` sits between the title and Close. A dialog without `actions` opens with its body
// focused, so it scrolls from the keyboard and no button wears a focus ring nobody asked for.
// Every way out goes through `leave`: the `closing` class plays the exit while the dialog is still open and holds what
// it showed, then the dialog closes. Safari hides a closed dialog at once, so a transition on `display` is no exit.
// Content stays mounted for as long as the element is open, so a close that arrives through `open` never remounts it.
export function Dialog({ open, onClose, title, children, actions, descriptionId, class: extra, modal = true, head }) {
  const ref = useRef(), timer = useRef(), last = useRef({});
  const [leaving, setLeaving] = useState(false), [, redraw] = useState(0);
  const view = open ? { title, head, children, actions } : last.current;
  if (open) last.current = view;
  const stay = () => { clearTimeout(timer.current); timer.current = null; setLeaving(false); };
  const leave = () => {
    const d = ref.current;
    if (!d.open || timer.current) return;
    const ms = parseFloat(getComputedStyle(d).transitionDuration) * 1000; // 0 where motion is off
    if (!ms) return d.close();
    setLeaving(true);
    timer.current = setTimeout(() => d.close(), ms);
  };
  // Escape belongs to a popover open inside the dialog before it belongs to the dialog.
  const escape = (e) => { e.preventDefault(); if (!ref.current.querySelector(":popover-open")) leave(); };
  // Reopened, or showing something else, while it was leaving: it stays.
  useEffect(() => {
    const d = ref.current;
    if (!open) return void (d.open && leave());
    if (timer.current) stay();
    if (!d.open) modal ? d.showModal() : d.show();
  }, [open, title]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Beside the page there is no backdrop to tap, so a tap on the page behind closes the panel. A control there keeps
  // its own meaning (a row opens its own ticket in the panel), and a scroll or drag is not a click.
  useEffect(() => {
    const d = ref.current;
    if (!open) return;
    const outside = (e) => d.open && !d.matches(":modal") && !d.contains(e.target) && !e.target.closest?.(CONTROLS) && leave();
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [open]);
  return html`<dialog
    ref=${ref}
    class=${`${extra ?? ""}${leaving ? " closing" : ""}`}
    onClose=${() => { stay(); redraw((n) => n + 1); onClose?.(); }}
    onCancel=${escape}
    onKeyDown=${(e) => { if (e.key === "Escape" && !ref.current.matches(":modal")) escape(e); }}
    onClick=${(e) => isBackdropClick(e, ref.current) && leave()}
    aria-label=${view.title}
    aria-describedby=${descriptionId}
  >
    ${(open || leaving || ref.current?.open) &&
    html`<div class="dialog-head">
        <h2>${view.title}</h2>${view.head}
        ${!view.actions && html`<${Button} variant="ghost" size="sm" icon="x" label="Close" class="dialog-close" onClick=${leave} />`}
      </div>
      <div class="dialog-body" tabindex=${view.actions ? undefined : -1} autofocus=${!view.actions}>${view.children}</div>
      ${view.actions && html`<div class="dialog-actions">${view.actions}</div>`}`}
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
    <${Button} variant="ghost" icon="x" label="Dismiss" class="toast-dismiss" onClick=${onDone} />
  </div>`;
}
