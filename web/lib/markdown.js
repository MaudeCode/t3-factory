// Tracker text as elements: headings, paragraphs, lists, task items, code, quotes, rules, tables, bold, italic, links,
// and a `<details>` block as a closed disclosure. That block is the one piece of HTML read; its parts are built here.
// The text is untrusted. Every piece becomes a text node or one of the elements built here, so HTML in a ticket
// shows as its characters, and a link is kept only when `safeLink` accepts its target.
import { h } from "./h.js";
import { safeLink } from "./format.js";

const FENCE = /^\s*(`{3,}|~{3,})/, HEADING = /^\s{0,3}(#{1,6})\s+(.+)$/, RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/, TASK = /^\[([ xX])\]\s+(.*)$/, INDENTED = /^\s+\S/;
const DETAILS = /^\s*<details(?:\s+open)?\s*>/i, DETAILS_END = /<\/details\s*>/i, SUMMARY = /^\s*<summary>([\s\S]*?)<\/summary>/i;
const ROW = /^\s*\|.*\|\s*$/, DIVIDER = /^\s*\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|\s*$/;
// A star opens emphasis only at a word's start, so `src/*.ts and web/*.js` stays as written.
const INLINE = /`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)?)\*\*|(?<![\w/*])\*(\S(?:[^*\n]*?\S)?)\*(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)|https:\/\/[^\s<>]+/g;
const starts = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || DETAILS.test(line);
// A fence closes on a line of its own character, at least as long as the one that opened it.
const closes = (fence, line) => line.length >= fence.length && line === fence[0].repeat(line.length);
const cells = (line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim());

function inline(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1]) out.push(h("code", null, m[1]));
    else if (m[2]) out.push(h("strong", null, inline(m[2])));
    else if (m[3]) out.push(h("em", null, inline(m[3])));
    else {
      // A bare address ends before the sentence's punctuation.
      const target = m[4] ? m[5] : m[0].replace(/[.,;:!?)\]]+$/, ""), href = safeLink(target);
      if (href) out.push(h("a", { href, target: "_blank", rel: "noopener noreferrer" }, m[4] ?? target), m[4] ? "" : m[0].slice(target.length));
      else out.push(m[0]);
    }
  }
  out.push(text.slice(at));
  return out;
}

// One run of list lines; a change between bullets and numbers at its own level starts the next list.
function lists(lines, depth) {
  const base = ITEM.exec(lines[0])[1].length, found = [];
  for (const line of lines) {
    const m = ITEM.exec(line), ordered = m && /\d/.test(m[2]);
    if (!m || m[1].length > base) { found.at(-1).items.at(-1).rest.push(line); continue; }
    if (found.at(-1)?.ordered !== ordered) found.push({ ordered, start: parseInt(m[2], 10), items: [] });
    found.at(-1).items.push({ text: m[3], rest: [] });
  }
  return found.map(({ ordered, start, items }) => h(ordered ? "ol" : "ul", ordered ? { start } : null, items.map(({ text, rest }) => {
    const task = TASK.exec(text), indent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    return h("li", task ? { class: "task" } : null,
      task && h("input", { type: "checkbox", checked: task[1] !== " ", disabled: true }),
      inline(task ? task[2] : text),
      blocks(rest.map((l) => l.slice(indent)), depth + 1));
  })));
}

// Tracker text is not ours: past `DEEPEST` levels of quote, list or details, what is left is one paragraph of text.
const DEEPEST = 12;
function blocks(lines, depth = 0) {
  if (depth > DEEPEST) return [h("p", null, lines.join("\n"))];
  const out = [];
  let i = 0;
  const take = (test) => { const from = i; while (i < lines.length && test(lines[i], lines[i + 1])) i++; return lines.slice(from, i); };
  while (i < lines.length) {
    const line = lines[i], fence = FENCE.exec(line), heading = HEADING.exec(line);
    if (!line.trim()) i++;
    else if (fence) {
      i++;
      out.push(h("pre", null, h("code", null, take((l) => !closes(fence[1], l.trim())).join("\n"))));
      i++;
    } else if (DETAILS.test(line)) {
      // Everything up to the matching close, nested blocks included; an unclosed block runs to the end of the text.
      const inner = [];
      for (let depth = 0; i < lines.length; i++) {
        depth += (lines[i].match(/<details(?:\s+open)?\s*>/gi) ?? []).length - (lines[i].match(/<\/details\s*>/gi) ?? []).length;
        inner.push(lines[i]);
        if (depth <= 0) { i++; break; }
      }
      const text = inner.join("\n").replace(DETAILS, "").replace(/<\/details\s*>\s*$/i, ""), summary = SUMMARY.exec(text);
      out.push(h("details", null, h("summary", null, inline(summary ? summary[1].trim().replace(/\s*\n\s*/g, " ") : "Details")), blocks(text.slice(summary?.[0].length ?? 0).split("\n"), depth + 1)));
    } else if (heading) {
      i++;
      // The panel's own headings are h3 and h4; a ticket's sit under them.
      out.push(h(heading[1].length < 3 ? "h5" : "h6", null, inline(heading[2])));
    } else if (RULE.test(line)) {
      i++;
      out.push(h("hr"));
    } else if (QUOTE.test(line)) out.push(h("blockquote", null, blocks(take((l) => QUOTE.test(l)).map((l) => l.replace(QUOTE, "")), depth + 1)));
    else if (ITEM.test(line)) out.push(...lists(take((l, next = "") => ITEM.test(l) || INDENTED.test(l) || (!l.trim() && (ITEM.test(next) || INDENTED.test(next)))), depth));
    else if (ROW.test(line) && DIVIDER.test(lines[i + 1] ?? "")) {
      const [head, , ...body] = take((l) => ROW.test(l));
      // The wrapper scrolls a table wider than the text column, so its columns keep their words whole.
      out.push(h("div", { class: "table-scroll" }, h("table", null,
        h("thead", null, h("tr", null, cells(head).map((cell) => h("th", null, inline(cell))))),
        h("tbody", null, body.map((row) => h("tr", null, cells(row).map((cell) => h("td", null, inline(cell)))))))));
    } else {
      i++;
      out.push(h("p", null, inline([line, ...take((l) => l.trim() && !starts(l))].join("\n"))));
    }
  }
  return out;
}

export const markdown = (text) => blocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
