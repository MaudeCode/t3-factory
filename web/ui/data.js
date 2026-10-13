// Read-only display pieces: gauges, tags, tables, timelines.
import { html, useEffect, useState } from "../lib/h.js";
import { clockTime, dayLabel } from "../lib/format.js";
import { Help } from "./controls.js";
import { ICONS } from "../vendor/icons.js";

const pct = (value) => Math.max(0, Math.min(100, Number(value) || 0));

// False on the first frame, true afterwards, so gauges transition in from empty.
export function useReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return ready;
}

// Remaining allowance. `marker` draws the reserve line; `note` sits under the value.
export const Meter = ({ label, value, marker, note, lowBelow }) => {
  const n = pct(value),
    low = n < (lowBelow ?? marker ?? 20);
  return html`<div class=${`meter ${low ? "meter-low" : ""}`}>
    <span class="meter-label">${label}</span>
    <i style=${`--p:${n}%`} role="progressbar" aria-label=${label} aria-valuenow=${Math.round(n)}>
      ${marker != null && html`<u style=${`left:${pct(marker)}%`} title=${`Reserve ${Math.round(marker)}%`}></u>`}
    </i>
    <em>${Math.round(n)}<small>%</small></em>
    ${note && html`<span class="meter-note">${note}</span>`}
  </div>`;
};

// An inline glyph from the vendored set. With a `label` it is announced; without one it is decoration.
export const Icon = ({ name, label }) => {
  const icon = ICONS[name];
  return html`<svg class=${`icon icon-${name}`} viewBox=${`0 0 ${icon.box} ${icon.box}`} width="1em" height="1em" fill="currentColor" role=${label ? "img" : undefined} aria-label=${label} aria-hidden=${label ? undefined : "true"}><path d=${icon.d} /></svg>`;
};

// Four-stop track of a run; the first `n` stops are lit.
export const Stops = ({ n, tone, label }) =>
  html`<span class=${`stops ${tone ? `stops-${tone}` : ""}`} data-n=${n} role="img" aria-label=${label} title=${label}><i></i><i></i><i></i><i></i></span>`;

export const Tag = ({ tone, children, title }) => html`<span class=${`tag ${tone ? `tag-${tone}` : ""}`} title=${title}>${children}</span>`;

export const Empty = ({ children }) => html`<p class="empty">${children}</p>`;

// Titled block of a page. `aside` sits on the title line; `hint` explains the block from a question mark beside the title.
export const Section = ({ title, hint, aside, children }) =>
  html`<section class="section">
    <header><h2>${title}<${Help} text=${hint} /></h2>${aside}</header>
    ${children}
  </section>`;

// `head` is a list of column labels; `rows` is a list of cell arrays (strings or nodes).
export const Table = ({ head, rows, stack = true }) =>
  html`<table class=${`table ${stack ? "stack" : ""}`}>
    <thead><tr>${head.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>
      ${rows.map(
        (cells, i) =>
          html`<tr key=${i}>${cells.map((cell, j) => html`<td data-label=${j ? head[j] : undefined}>${cell}</td>`)}</tr>`,
      )}
    </tbody>
  </table>`;

export const Link = ({ href, children, class: extra, title }) =>
  href ? html`<a class=${extra} href=${href} title=${title} target="_blank" rel="noopener noreferrer">${children}</a>` : null;

// Label and value pairs.
export const Facts = ({ items }) =>
  html`<dl class="facts">
    ${items.filter(([, v]) => v != null && v !== "").map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}
  </dl>`;

const TONES = { "job.state": (e) => ({ waiting: "attention", complete: "ok", dismissed: "" })[e.data.state] ?? "on", "job.created": () => "on", "job.pr": () => "ok", "job.stop": () => "attention", decision: (e) => (e.data.reason === "error" ? "attention" : "") };

// Journal entries grouped by day, newest first.
export const Timeline = ({ events, renderText }) => {
  const groups = [];
  for (const e of events) {
    const day = dayLabel(e.time);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1).items.push(e);
  }
  return html`<div class="timeline">
    ${groups.map(
      (g) => html`<section key=${g.day}>
        <h3>${g.day}</h3>
        ${g.items.map(
          (e) => html`<div class="event" key=${e.id}>
            <time datetime=${e.time}>${clockTime(e.time)}</time>
            <i class=${`dot ${TONES[e.kind]?.(e) ?? ""}`}></i>
            <span>${renderText ? renderText(e) : e.text}</span>
          </div>`,
        )}
      </section>`,
    )}
  </div>`;
};
