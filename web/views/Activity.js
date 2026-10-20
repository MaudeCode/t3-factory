import { html, useState, useEffect } from "../lib/h.js";
import { journal, jobs, history, loadHistory } from "../lib/store.js";
import { follow } from "../lib/router.js";
import { Segmented, Empty, Timeline, Page } from "../ui/index.js";

const KINDS = [
  ["all", "Everything"],
  ["runs", "Runs"],
  ["decision", "Checks"],
];

export function Activity() {
  const [kind, setKind] = useState("all");
  useEffect(() => {
    if (!history.value) loadHistory().catch(() => {});
  }, []);
  const list = journal.value.filter((e) => kind === "all" || (kind === "runs" ? e.kind.startsWith("job.") : e.kind === kind));
  const known = new Set([...jobs.value, ...(history.value ?? [])].map((j) => j.id));
  const text = (e) =>
    e.jobId && known.has(e.jobId) ? html`<a href=${`/runs/${e.jobId}`} onClick=${follow}>${e.text}</a>` : e.text;
  return html`<${Page} narrow title="Activity" hint="A check is recorded when its outcome changes." actions=${html`<${Segmented} label="Kind" value=${kind} onChange=${setKind} options=${KINDS} />`}>
    ${list.length ? html`<${Timeline} events=${list} renderText=${text} />` : html`<${Empty}>Nothing recorded yet.<//>`}
  <//>`;
}
