import { html, useState } from "../lib/h.js";
import { journal, jobs, history } from "../lib/store.js";
import { follow } from "../lib/router.js";
import { Segmented, Empty, Timeline, Help } from "../ui/index.js";

const KINDS = [
  ["all", "Everything"],
  ["runs", "Runs"],
  ["decision", "Checks"],
];

export function Activity() {
  const [kind, setKind] = useState("all");
  const list = journal.value.filter((e) => kind === "all" || (kind === "runs" ? e.kind.startsWith("job.") : e.kind === kind));
  const known = new Set([...jobs.value, ...(history.value ?? [])].map((j) => j.id));
  const text = (e) =>
    e.jobId && known.has(e.jobId) ? html`<a href=${`/runs/${e.jobId}`} onClick=${follow}>${e.text}</a>` : e.text;
  return html`<div class="page narrow">
    <div class="page-head">
      <div><h1>Activity<${Help} text="What the factory decided and what each run did. A check is recorded when its outcome changes." /></h1></div>
    </div>
    <${Segmented} label="Kind" value=${kind} onChange=${setKind} options=${KINDS} />
    ${list.length ? html`<${Timeline} events=${list} renderText=${text} />` : html`<${Empty}>Nothing recorded yet.<//>`}
  </div>`;
}
