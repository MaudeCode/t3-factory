import { html, useEffect, useState, useRef } from "../lib/h.js";
import { config, operations, loadCleanup, inspectCleanup, startCleanup, clock, serverNow } from "../lib/store.js";
import { stateLabel, ago, clockTime, formatBytes as bytes, ticketLink, threadLink, safeLink, prLabel } from "../lib/format.js";
import { follow } from "../lib/router.js";
import { Button, Select, Field, Input, Tag, RowBody, Meta, Page, Section, Facts, Dialog, Empty, Timeline, Link } from "../ui/index.js";
import { confirmAction } from "../lib/confirmation.js";
import { Operations } from "./Deck.js";

const keyOf = item => `${item.projectId}:${item.path}`;
const targetOf = item => ({ projectId: item.projectId, path: item.path });
const stamp = at => at ? ago(at, serverNow()) : "Unknown";
function CleanupReview({ item, onClose, onNext }) {
  const [detail, setDetail] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [force, setForce] = useState(false), [path, setPath] = useState(""), [reason, setReason] = useState("");
  const inspection = useRef();
  const pending = operations.value.some(op => op.kind === "cleanup" && ["queued", "running", "uncertain"].includes(op.state));
  const refresh = async (review = false, size = false) => {
    inspection.current?.abort(); inspection.current = new AbortController();
    const signal = inspection.current.signal;
    setLoading(true); setError(""); setForce(review); setPath("");
    try { setDetail(await inspectCleanup({ ...targetOf(item), ...review ? {} : { size } }, review, signal)); }
    catch (e) { if (!signal.aborted) { setError(e.message); setDetail(null); } } finally { if (!signal.aborted) setLoading(false); }
  };
  useEffect(() => { refresh(); return () => inspection.current?.abort(); }, []);
  const submit = type => {
    const input = type === "force" ? { type, reviewId: detail.reviewId, confirmation: path, reason } : { type, targets: [targetOf(item)], reason: "Operator requested normal cleanup" };
    if (startCleanup(input)) onClose();
  };
  return html`<${Dialog} open onClose=${onClose} title=${force ? "Force remove review" : "Worktree review"} actions=${html`
    <${Button} variant="ghost" onClick=${onClose}>Close<//>${onNext && html`<${Button} onClick=${onNext}>Next selected<//>`}
    ${force ? html`<${Button} variant="danger" disabled=${loading || pending || !detail?.forceAllowed || path !== detail.path || !reason.trim() || Date.parse(detail.expiresAt) <= serverNow()} onClick=${() => submit("force")}>Force remove<//>` : html`
      <${Button} disabled=${loading || pending || !detail?.jobs.length} onClick=${() => submit("retry")}>Retry now<//>
      <${Button} disabled=${loading || pending || !detail?.jobs.length} onClick=${() => confirmAction({ title: "Remove verified workspace?", message: item.path + ". Normal completion and activity checks still apply.", label: "Remove" }, () => submit("remove"))}>Normal remove<//>`}`}>
    <p class="mono cleanup-path">${item.path}</p>
    ${error && html`<p role="alert" class="alert">${error}</p>`}
    ${loading && html`<p role="status">Inspecting ownership, Git and process use…</p>`}
    <div class="links-row">
      <${Button} size="sm" icon="sync" label="Refresh inspection" disabled=${loading} onClick=${() => refresh()} />
      <${Button} size="sm" disabled=${loading} onClick=${() => refresh(false, true)}>Estimate size<//>
      ${!force && html`<${Button} size="sm" variant="danger" disabled=${loading || pending} onClick=${() => refresh(true)}>Review force removal<//>`}
    </div>
    ${detail && html`
      ${force && html`<${Section} title="Removal consequences">
        <p>The worktree directory and all its files will be removed. Branch refs, completion reports and terminal history are preserved. Force never stops active work.</p>
        ${detail.overridden.length ? html`<p>Checks overridden by this confirmation:</p><ul>${detail.overridden.map(text => html`<li>${text}</li>`)}</ul>` : html`<p>No completion or content checks need overriding.</p>`}
        <p>Review expires at ${clockTime(detail.expiresAt)}. Any changed content, HEAD, ownership or activity requires a new review.</p>
        <${Field} label="Exact worktree path"><${Input} mono value=${path} onChange=${setPath} aria-label="Exact worktree path" autocomplete="off" /><//>
        <${Field} label="Reason for force removal"><${Input} value=${reason} onChange=${setReason} aria-label="Reason for force removal" maxlength="800" /><//>
      <//>`}
      <${Facts} items=${[
        ["Repository", detail.repository], ["Branch", detail.workspace?.branch || "Unknown"], ["HEAD", detail.workspace?.head || "Unknown"],
        ["Directory", detail.workspace ? detail.workspace.present ? "Present" : "Absent" : "Unknown"], ["Git registration", detail.workspace ? detail.workspace.registered ? "Present" : "Absent" : "Unknown"],
        ["Ownership", detail.ownership], ["Inspected", stamp(detail.checkedAt)], ["Estimated size", `${bytes(detail.size.bytes)}${detail.size.checkedAt ? `, ${stamp(detail.size.checkedAt)}` : ""}`],
        ["Contents", detail.workspace && `${detail.workspace.tracked} tracked changes, ${detail.workspace.untracked} untracked files, ${detail.workspace.ignored} ignored entries`],
        ["Process use", detail.processCount == null ? "Unknown" : `${detail.processCount} observed working directories`], ["Terminals", detail.terminals.map(t => `${t.terminalId}: ${t.status}`).join(", ") || "None observed"],
      ]} />
      ${detail.workspace?.changes?.length > 0 && html`<${Section} title="Changed paths"><ul class="mono cleanup-path">${detail.workspace.changes.map(c => html`<li>${c.kind} ${c.path}</li>`)}</ul><p class="muted">Up to 100 entries. Contents are never displayed.</p><//>`}
      <${Section} title="Checks">
        ${detail.checks.map(check => html`<div class="cleanup-check" key=${check.name}><${RowBody} title=${check.name}><span>${check.detail} · ${stamp(check.checkedAt)}</span><//><${Tag} tone=${check.state === "pass" ? "ok" : "attention"}>${check.state}${check.override && check.state !== "pass" ? " · overridable" : ""}<//></div>`)}
      <//>
      <${Section} title="Jobs and bindings">
        ${detail.jobs.map(job => html`<div class="cleanup-check" key=${job.id}><${RowBody} title=${html`<a href=${`/runs/${job.id}`} onClick=${follow}>${job.ticketKey || job.id}</a>`}>
          ${job.stage} · ${job.state} · last attempt ${stamp(job.lastAttempt)}${job.nextRetry && ` · next retry ${clockTime(job.nextRetry)}`}${job.error && html`<span class="error">${job.error}</span>`}
          ${ticketLink(config.value, job) && html`<${Link} href=${ticketLink(config.value, job)}>Ticket<//>`}
          ${job.prUrls.map(safeLink).filter(Boolean).map(url => html`<${Link} href=${url}>${prLabel(url)}<//>`)}
        <//></div>`)}
        ${detail.bindings.map(t => html`<div class="cleanup-check" key=${t.id}><${RowBody} title=${html`<a href=${threadLink({ threadId: t.id })}>${t.id}</a>`}>${t.status} · ${t.lineage?.relationshipToParent || "thread"} · ${stamp(t.updatedAt)}<//></div>`)}
        ${!detail.jobs.length && !detail.bindings.length && html`<${Empty}>No recorded owners. Fresh live checks remain required.<//>`}
      <//>
      <${Section} title="Completion evidence">
        ${detail.reports.length ? detail.reports.map(r => html`<p>${r.status}: ${r.reason}</p>`) : html`<p class="muted">No verified completion report.</p>`}
      <//>
      <${Section} title="Action history"><${Timeline} actions=${detail.actions} /><//>
    `}
  <//>`;
}
export function Cleanup() {
  clock.value;
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ query: new URLSearchParams(location.search).get("query") ?? "", repository: "", ownership: "", state: "", sort: "path", offset: 0 });
  const [selected, setSelected] = useState([]), [review, setReview] = useState(null), [reviewQueue, setReviewQueue] = useState([]), [revision, setRevision] = useState(0);
  const ops = operations.value.filter(op => op.kind === "cleanup"), pending = ops.some(op => ["queued", "running", "uncertain"].includes(op.state));
  const completed = ops.filter(op => op.state === "done").length;
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    const timer = setTimeout(() => loadCleanup({ ...filters, limit: 50 }, abort.signal).then(value => { setData(value); setSelected([]); }, e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }), 120);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [JSON.stringify(filters), revision, completed]);
  const change = (key, value) => setFilters({ ...filters, [key]: value, offset: 0 });
  const refresh = () => setRevision(n => n + 1);
  const batch = type => confirmAction({ title: type === "retry" ? "Retry selected workspaces?" : "Remove selected workspaces?", message: `${selected.length} workspaces will pass the normal verifier. Each item keeps its own outcome.`, label: type === "retry" ? "Retry now" : "Normal remove" }, () => startCleanup({ type, targets: selected.map(k => targetOf(data.items.find(i => keyOf(i) === k))), reason: "Operator selected normal cleanup" }));
  const pick = item => { const k = keyOf(item); setSelected(selected.includes(k) ? selected.filter(v => v !== k) : [...selected, k]); };
  return html`<${Page} title="Cleanup" actions=${html`<${Button} icon="sync" label="Refresh cleanup inventory" disabled=${loading} onClick=${refresh} />`}>
    ${error && html`<p role="alert" class="alert">${error}</p>`}
    ${loading && html`<p role="status">Scanning configured repositories…</p>`}
    <${Operations} list=${ops} />
    ${data && html`
      <${Section} title="Workspace maintenance" aside=${html`<span class="muted">Scan ${stamp(data.checkedAt)}</span>`}>
        <div class="cleanup-summary">${Object.entries(data.counts).filter(([, n]) => n > 0).map(([state, n]) => html`<span><${Tag} state=${state} /> ${n}</span>`)}<span>${data.present} directories present</span></div>
        <${Facts} items=${[["Last successful scan", stamp(data.lastSuccessfulScan)], ["Next automatic retry", data.nextRetry ? clockTime(data.nextRetry) : "None scheduled"], ["Ticket automation", data.automationEnabled ? "Enabled" : "Paused"], ["Cleanup maintenance", data.maintenance?.state || "No attempt recorded"], ["Last attempt", stamp(data.maintenance?.lastAttempt)], ["Last successful removal", stamp(data.maintenance?.lastSuccess)]]} />
        ${data.stalled && html`<p class="alert">No maintenance progress since ${clockTime(data.maintenance.lastAttempt)}. Refresh inspection or retry retained workspaces.</p>`}
        ${data.maintenance?.error && html`<p class="alert">${data.maintenance.error}</p>`}
        ${data.repositories.map(r => html`<p class="small mono cleanup-path">${r.path} · ${bytes(r.freeBytes)} free</p>`)}
        ${data.errors.map(e => html`<p class="alert" role="alert">${e.repository}: ${e.message}</p>`)}
      <//>
    `}
    <div class="cleanup-filters">
      <input class="search" aria-label="Find a worktree" placeholder="Path, branch, ticket, job, thread or error" value=${filters.query} onInput=${e => change("query", e.target.value)} />
      <${Select} label="Repository" value=${filters.repository} onChange=${v => change("repository", v)} options=${[["", "All repositories"], ...(data?.repositories ?? []).map(r => [r.path, r.path.split("/").at(-1)])]} />
      <${Select} label="Ownership" value=${filters.ownership} onChange=${v => change("ownership", v)} options=${[["", "Any ownership"], ...["factory", "shared", "t3-only", "orphan", "unknown"].map(v => [v, v])]} />
      <${Select} label="Cleanup state" value=${filters.state} onChange=${v => change("state", v)} options=${[["", "Any state"], ...["pending", "blocked", "active", "missing", "complete", "stale-registration", "review", "unknown", "primary"].map(v => [v, stateLabel(v)])]} />
      <${Select} label="Sort worktrees" value=${filters.sort} onChange=${v => change("sort", v)} options=${[["path", "Path"], ["repository", "Repository"], ["branch", "Branch"], ["attempt", "Last attempt"], ["size", "Known size"]]} />
    </div>
    <div class="links-row">
      <span>${selected.length} selected${selected.length === 20 ? " · batch limit" : ""}</span>
      <${Button} size="sm" disabled=${!selected.length} onClick=${() => { const list = selected.map(k => data.items.find(i => keyOf(i) === k)); setReview(list[0]); setReviewQueue(list.slice(1)); }}>Review selected<//>
      <${Button} size="sm" disabled=${pending || !selected.length} onClick=${() => batch("retry")}>Retry now<//>
      <${Button} size="sm" disabled=${pending || !selected.length} onClick=${() => batch("remove")}>Normal remove<//>
      ${selected.length > 0 && html`<${Button} size="sm" onClick=${() => setSelected([])}>Clear selection<//>`}
    </div>
    <div class="cleanup-list" aria-label="Worktrees">
      ${(data?.items ?? []).map(item => html`<div class="cleanup-row" key=${keyOf(item)}>
        <input type="checkbox" aria-label=${`Select ${item.path}`} checked=${selected.includes(keyOf(item))} disabled=${(!selected.includes(keyOf(item)) && selected.length >= 20) || item.state === "primary"} onChange=${() => pick(item)} />
        <${RowBody} title=${html`<button type="button" class="cleanup-open mono" title=${item.path} onClick=${() => setReview(item)}>${item.path}</button>`}>
          <${Meta}>${item.branch || "Unknown branch"} · ${item.ownership} · ${item.present ? "directory present" : "directory absent"} · ${item.registered ? "Git registered" : "not registered"} · ${bytes(item.size.bytes)}${item.size.state === "stale" ? " (stale estimate)" : ""}${item.jobs.map(j => html`<a href=${`/runs/${j.id}`} onClick=${follow}>${j.ticketKey || j.id}</a>`)}<//>
        <//>
        <${Tag} state=${item.state} />
        <${Button} size="sm" icon="arrowRight" label=${`Review ${item.path}`} onClick=${() => setReview(item)} />
      </div>`)}
      ${data && !data.items.length && html`<${Empty}>No worktrees match.<//>`}
    </div>
    ${data && html`<div class="links-row"><span>${Math.min(data.offset + 1, data.total)}–${Math.min(data.offset + data.items.length, data.total)} of ${data.total}</span>
      <${Button} size="sm" disabled=${loading || !data.offset} onClick=${() => setFilters({ ...filters, offset: Math.max(0, data.offset - 50) })}>Previous<//>
      <${Button} size="sm" disabled=${loading || data.offset + 50 >= data.total} onClick=${() => setFilters({ ...filters, offset: data.offset + 50 })}>Next<//>
    </div><${Section} title="Action history"><${Timeline} actions=${data.actions} /><//>`}
    ${review && html`<${CleanupReview} key=${keyOf(review)} item=${review} onClose=${() => { setReview(null); setReviewQueue([]); refresh(); }} onNext=${reviewQueue.length ? () => { setReview(reviewQueue[0]); setReviewQueue(reviewQueue.slice(1)); } : undefined} />`}
  <//>`;
}
