// Form controls. Inputs with a `path` bind straight to the config signal.
import { html, useEffect, useLayoutEffect, useRef, useState, useId } from "../lib/h.js";
import { at, set } from "../lib/store.js";
import { coerce, selectPosition } from "../lib/format.js";
import { Icon } from "./data.js";

const cls = (...parts) => parts.filter(Boolean).join(" ");

// `icon` names a glyph; with `label` and no children the button is icon-only and `label` is its name and tooltip.
export const Button = ({ variant, size, icon, label, class: extra, type = "button", children, ...props }) =>
  html`<button
    type=${type}
    class=${cls("btn", variant && `btn-${variant}`, size && `btn-${size}`, icon && (icon === true || !children) && "btn-icon", extra)}
    aria-label=${props["aria-label"] ?? label}
    title=${props.title ?? label}
    ...${props}
  >${typeof icon === "string" && html`<${Icon} name=${icon} />`}${children}</button>`;

// Icon-only link to a fuller page, for section headers.
export const More = ({ href, label, onClick }) => html`<a class="more" href=${href} onClick=${onClick} aria-label=${label} title=${label}><${Icon} name="arrowRight" /></a>`;

export const Switch = ({ checked, onChange, disabled, label }) =>
  html`<input
    type="checkbox"
    role="switch"
    class="switch"
    aria-label=${label}
    checked=${checked}
    disabled=${disabled}
    onChange=${onChange}
  />`;

// A small mark that explains its heading on hover or keyboard focus; a question mark unless another glyph is given.
export const Help = ({ text, glyph = "?", tone }) =>
  text ? html`<span class=${`help ${tone ? `help-${tone}` : ""}`} tabindex="0" role="note" aria-label=${text} data-tip=${text} onClick=${(e) => e.preventDefault()}>${glyph}</span>` : null;

// `group` renders a div instead of a label, for controls made of several buttons.
export const Field = ({ label, hint, children, group }) =>
  html`<${group ? "div" : "label"} class="field"><span class="field-label">${label}<${Help} text=${hint} /></span>${children}<//>`;

// Reads a bound config path, or an explicit value; writes through `set` or the given `onChange`.
const bind = (path, value, onChange) => [path ? at(path) : value, onChange ?? ((v) => set(path, v))];

// Text, number, or list input. `kind` decides how the value is stored; a "limit" is a whole number, or null when empty.
export function Input({ path, kind = "text", mono, value, onChange, ...props }) {
  const [current, change] = bind(path, value, onChange);
  const numeric = ["number", "integer", "limit"].includes(kind);
  return html`<input
    class=${mono ? "mono" : undefined}
    type=${numeric ? "number" : "text"}
    min=${numeric ? 0 : undefined}
    step=${kind === "number" ? "any" : numeric ? 1 : undefined}
    value=${kind === "list" ? (current || []).join(", ") : (current ?? "")}
    onInput=${(e) => change(coerce(kind, e.target))}
    ...${props}
  />`;
}

// Slider with a live readout. `format` turns the number into words.
export function Range({ path, value, onChange, min = 0, max = 100, step = 1, format = String, label }) {
  const [current, change] = bind(path, value, onChange);
  const n = Number(current) || 0;
  return html`<div class="range">
    <input type="range" min=${Math.min(min, n)} max=${Math.max(max, n)} step=${step} value=${n} aria-label=${label} aria-valuetext=${format(n)} onInput=${(e) => change(Number(e.target.value))} />
    <output>${format(n)}</output>
  </div>`;
}

// Integer with less and more buttons. `labels` names special values; `unlimited` names null, reached past `max`.
export function Stepper({ path, value, onChange, min = 0, max = 99, labels = {}, unlimited, label }) {
  const [current, change] = bind(path, value, onChange);
  const none = current == null;
  return html`<div class="stepper" role="group" aria-label=${label}>
    <${Button} size="sm" aria-label="Less" disabled=${!none && current <= min} onClick=${() => change(none ? max : Math.max(min, current - 1))}>−<//>
    <output aria-live="polite">${none ? unlimited : (labels[current] ?? current)}</output>
    <${Button} size="sm" aria-label="More" disabled=${none || (!unlimited && current >= max)} onClick=${() => change(unlimited && current >= max ? null : Math.min(max, current + 1))}>+<//>
  </div>`;
}

// Run limit picker: Off, quick picks up to `max`, and a last slot that opens a box for any higher limit.
export function Slots({ path, running = 0, max = 6, label, busyLabel = 'running now' }) {
  const limit = at(path) ?? 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const custom = limit > max;
  const slot = (n, text = n) => html`<button key=${n} type="button" role="radio" aria-checked=${limit === n} class=${cls("slot", n <= limit && "open", n <= running && "busy")}
    aria-label=${`${n} at once`} title=${n <= running ? busyLabel : n <= limit ? "free slot" : `allow ${n} at once`} onClick=${() => set(path, n)}>${text}</button>`;
  // Invalid text never reaches the config; Enter keeps the box open so it can be fixed, leaving it restores the saved limit.
  const commit = (el) => {
    if (el.dataset.cancel) return;
    if (el.value !== "" && el.validity.valid) set(path, el.valueAsNumber);
    setEditing(false);
  };
  const onKeyDown = (e) => {
    const el = e.currentTarget;
    if (e.key === "Enter" && el.value !== "" && el.validity.valid) commit(el);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); el.dataset.cancel = "1"; setEditing(false); }
  };
  return html`<div class="slots" role="radiogroup" aria-label=${label}>
    <button type="button" role="radio" aria-checked=${limit === 0} class="slot-off" onClick=${() => set(path, 0)}>Off</button>
    ${Array.from({ length: max }, (_, i) => slot(i + 1))}
    ${editing
      ? html`<input type="number" class="slot-custom" min="0" step="1" max=${Number.MAX_SAFE_INTEGER} required value=${draft} onInput=${(e) => setDraft(e.currentTarget.value)}
          aria-label=${`${label}, custom limit`} ref=${(el) => el && el !== document.activeElement && (el.focus(), el.select())}
          onKeyDown=${onKeyDown} onBlur=${(e) => commit(e.currentTarget)} />`
      : html`<button type="button" role="radio" aria-checked=${custom} class=${cls("slot", custom && "open", custom && running > max && "busy")}
          aria-label=${custom ? `${limit} at once, change` : `More than ${max} at once`} title=${custom ? "Change the limit" : "Set a higher limit"} onClick=${() => { setDraft(String(custom ? limit : max + 1)); setEditing(true); }}>${custom ? limit : `${max + 1}+`}</button>`}
  </div>`;
}

// Multi-select chips. `options` is a list of [value, name]; values not in it still show so nothing saved is hidden.
// `ordered` numbers the picks in the order they were chosen; `custom` adds a box for values the catalog lacks.
export function Chips({ path, value, onChange, options = [], ordered, custom, label }) {
  const [picked, change] = bind(path, value, onChange);
  const current = picked ?? [];
  const [draft, setDraft] = useState("");
  const names = new Map(options.map(([v, name]) => [v, name]));
  const titles = new Map(options.map(([v, , title]) => [v, title]));
  const all = ordered ? [...current, ...[...names.keys()].filter((v) => !current.includes(v))] : [...names.keys(), ...current.filter((v) => !names.has(v))];
  const toggle = (v) => change(current.includes(v) ? current.filter((x) => x !== v) : [...current, v]);
  const add = () => {
    const v = draft.trim();
    if (v && !current.includes(v)) change([...current, v]);
    setDraft("");
  };
  return html`<div class="chips" role="group" aria-label=${label}>
    ${all.map((v) => {
      const i = current.indexOf(v);
      return html`<button key=${v} type="button" aria-pressed=${i >= 0} title=${titles.get(v)} aria-label=${titles.get(v)} onClick=${() => toggle(v)}>${ordered && i >= 0 && html`<b>${i + 1}</b>`}${names.get(v) ?? v}</button>`;
    })}
    ${custom && html`<input class="chip-input" placeholder=${custom} aria-label=${custom} value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${add} onKeyDown=${(e) => e.key === "Enter" && (e.preventDefault(), add())} />`}
  </div>`;
}

// Switch with its name and a sentence of consequence.
export const Toggle = ({ path, checked, onChange, label, hint, disabled }) =>
  html`<label class="toggle">
    <span><b>${label}<${Help} text=${hint} /></b></span>
    <${Switch} label=${label} checked=${path ? !!at(path) : checked} disabled=${disabled} onChange=${onChange ?? ((e) => set(path, e.target.checked))} />
  </label>`;

// A live allowance bar with the two budget rules as handles on the same track.
// `reserved` is what the scheduler holds back right now; the handles set the rule at window start and the floor.
export function Budget({ label, remaining, reserved, note, reservePath, floorPath, ready }) {
  const pct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const left = remaining == null ? 0 : pct(remaining),
    reserve = pct(at(reservePath)),
    floor = pct(at(floorPath)),
    low = remaining != null && left <= pct(reserved);
  const handle = (path, value, name, tone) =>
    html`<input type="range" class=${`thumb thumb-${tone}`} min="0" max="100" value=${value} aria-label=${`${label}: ${name}`} aria-valuetext=${`${value}%`} onInput=${(e) => set(path, Number(e.target.value))} />`;
  return html`<div class=${cls("budget", ready && "ready", low && "budget-low")}>
    <div class="budget-head"><span>${label}</span><em class=${remaining == null ? "none" : ""}>${remaining == null ? "no reading" : html`${Math.round(left)}<small>%</small>`}</em></div>
    <div class="track">
      <i style=${`--p:${left}%`} role="progressbar" aria-label=${`${label} remaining`} aria-valuenow=${Math.round(left)}></i>
      ${reserved != null && html`<u style=${`left:${pct(reserved)}%`} title=${`Held back now: ${Math.round(reserved)}%`}></u>`}
      ${handle(reservePath, reserve, "reserve at window start", "reserve")}
      ${handle(floorPath, floor, "floor", "floor")}
    </div>
    <div class="budget-legend">
      <span><b class="dot-reserve"></b>Reserve ${reserve}% at window start</span>
      <span><b class="dot-floor"></b>Floor ${floor}%</span>
      ${note && html`<span class="muted">${note}</span>`}
    </div>
  </div>`;
}

// Custom dropdown. `options` is a list of [value, name]; `onChange` receives the value.
// `multiple` makes it a multi-pick: `value` is an array, the menu stays open while picking, and the
// trigger reads the placeholder (or label) until something is picked, then "A" or "A +2".
export function Select({ path, value, options, onChange, label, size, multiple, placeholder, class: extra }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef(), menu = useRef(), button = useRef();
  const id = useId();
  const current = path ? at(path) : value;
  const picked = multiple ? current ?? [] : [];
  const selected = (v) => (multiple ? picked.includes(v) : v === current);
  const index = multiple ? options.findIndex(([v]) => picked.includes(v)) : options.findIndex(([v]) => v === current);
  const names = options.filter(([v]) => picked.includes(v)).map(([, name]) => name);
  const text = multiple ? (names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : "") : options[index]?.[1] ?? current ?? "";
  const show = () => { setActive(Math.max(0, index)); setOpen(true); };
  const choose = (v) => {
    const change = onChange ?? ((x) => set(path, x));
    if (multiple) return change(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
    setOpen(false);
    button.current.focus({ preventScroll: true });
    if (v !== current) change(v);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const list = menu.current, trigger = button.current, wrapper = ref.current;
    const dialog = wrapper.closest("dialog"), viewport = window.visualViewport;
    const close = () => setOpen(false);
    const position = () => {
      const p = selectPosition(trigger.getBoundingClientRect(), viewport ?? { width: innerWidth, height: innerHeight }, list.scrollHeight + 2);
      Object.assign(list.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, maxHeight: `${p.height}px` });
    };
    const outside = (e) => !wrapper.contains(e.target) && close();
    const escape = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
      trigger.focus({ preventScroll: true });
    };
    list.showPopover();
    position();
    const observer = new ResizeObserver(position);
    observer.observe(trigger);
    observer.observe(list);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    dialog?.addEventListener("close", close);
    return () => {
      list.hidePopover();
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
      dialog?.removeEventListener("close", close);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const list = menu.current, item = list.children[active];
    if (!item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [open, active]);
  const onKeyDown = (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : open ? Math.max(0, Math.min(options.length - 1, active + step)) : Math.max(0, index));
      setOpen(true);
    } else if (open && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      if (options[active]) choose(options[active][0]);
    } else if (e.key === "Tab") setOpen(false);
  };
  return html`<div class=${cls("select", size && `select-${size}`, open && "open", extra)} ref=${ref}>
    <button
      ref=${button}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded=${open}
      aria-controls=${open ? id : undefined}
      aria-activedescendant=${open && options[active] ? `${id}-${active}` : undefined}
      aria-label=${multiple ? label : `${label}: ${text}`}
      data-on=${multiple && picked.length > 0}
      onClick=${() => open ? setOpen(false) : show()}
      onKeyDown=${onKeyDown}
    >
      <span>${multiple ? (text ? html`<b>${text}</b>` : placeholder ?? label) : text}</span>
    </button>
    ${open &&
    html`<ul ref=${menu} id=${id} popover="manual" role="listbox" aria-label=${label} aria-multiselectable=${multiple || undefined} onPointerDown=${(e) => e.preventDefault()} onClick=${(e) => e.preventDefault()}>
      ${options.map(
        ([v, name], i) =>
          html`<li key=${v} id=${`${id}-${i}`} role="option" aria-selected=${selected(v)} data-active=${i === active} onClick=${() => choose(v)}>${name}</li>`,
      )}
    </ul>`}
  </div>`;
}

export const Check = ({ path, label, checked, onChange, hint, ...props }) =>
  html`<label class="check">
    <input
      type="checkbox"
      checked=${path ? !!at(path) : checked}
      onChange=${onChange ?? ((e) => set(path, e.target.checked))}
      ...${props}
    />
    ${label && html`<span>${label}</span>`}<${Help} text=${hint} />
  </label>`;

// Exclusive filter chips. `options` is a list of [value, name, count?].
export const Segmented = ({ path, options, value, onChange, label, icons }) => {
  const [current, change] = bind(path, value, onChange);
  return html`<div class=${icons ? 'slots' : 'segmented'} role="radiogroup" aria-label=${label}>
    ${options.map(
      ([v, name, count]) =>
        html`<button key=${v} type="button" role="radio" aria-checked=${v === current} class=${icons && cls('slot', v === current && 'open busy')}
          aria-label=${icons ? name : undefined} title=${icons ? name : undefined} onClick=${() => change(v)}>
          ${icons ? html`<${Icon} name=${icons[v]} />` : name}${count != null && html`<small>${count}</small>`}
        </button>`,
    )}
  </div>`;
};

// Drag-to-reorder list. Rows render through `render(item, index, grip)`; put `grip` on the handle.
// Pointer drags move neighbours out of the way; the arrow keys on a handle move one step.
export function SortableList({ items, keyOf, render, onMove, label }) {
  const ref = useRef();
  const [drag, setDrag] = useState(null); // { from, over, height, dy }
  const rows = () => [...ref.current.querySelectorAll(":scope > [data-index]")];
  const start = (from) => (e) => {
    if (e.button) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rects = rows().map((r) => r.getBoundingClientRect());
    const y0 = e.clientY;
    let over = from;
    const move = (ev) => {
      const y = ev.clientY;
      over = rects.findIndex((r, i) => (i < from ? y < r.top + r.height / 2 : i > from ? y > r.top + r.height / 2 : false));
      if (over === -1) over = from;
      else if (over > from) {
        // crossed several rows below: take the last one whose midpoint is above the pointer
        over = rects.reduce((acc, r, i) => (i > from && y > r.top + r.height / 2 ? i : acc), from);
      }
      setDrag({ from, over, height: rects[from].height, dy: y - y0 });
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      setDrag(null);
      if (over !== from) onMove(from, over);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };
  const shift = (i) => {
    if (!drag || i === drag.from) return "";
    if (drag.over > drag.from && i > drag.from && i <= drag.over) return `translateY(-${drag.height}px)`;
    if (drag.over < drag.from && i >= drag.over && i < drag.from) return `translateY(${drag.height}px)`;
    return "";
  };
  return html`<div class=${cls("sortable", drag && "dragging")} ref=${ref} role="list" aria-label=${label}>
    ${items.map((item, i) => {
      const grip = html`<button
        type="button"
        class="grip"
        aria-label=${`Reorder ${keyOf(item)}: drag, or use the arrow keys`}
        onPointerDown=${start(i)}
        onKeyDown=${(e) => {
          const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
          if (step && i + step >= 0 && i + step < items.length) {
            e.preventDefault();
            onMove(i, i + step);
            requestAnimationFrame(() => rows()[i + step]?.querySelector(".grip")?.focus());
          }
        }}
      ></button>`;
      return html`<div
        key=${keyOf(item)}
        data-index=${i}
        role="listitem"
        class=${cls("sortable-row", drag?.from === i && "lifted")}
        style=${drag?.from === i ? `transform:translateY(${drag.dy}px)` : shift(i) ? `transform:${shift(i)}` : ""}
      >
        ${render(item, i, grip)}
      </div>`;
    })}
  </div>`;
}
