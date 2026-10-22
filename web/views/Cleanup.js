import { html, useEffect, useState, useRef } from "../lib/h.js";
import { config, status, operations, loadCleanup, inspectCleanup, startCleanup, stopCleanupQueue, cleanupOperationHolds, actions, clock, serverNow } from "../lib/store.js";
import { cleanupResultSummary, projectCleanupResults, stateLabel, ago, clockTime, formatBytes as bytes, ticketLink, threadLink, safeLink, prLabel } from "../lib/format.js";
import { follow } from "../lib/router.js";
import { Button, Select, Field, Input, RowBody, Page, Section, Facts, Empty, Timeline, Link, Check } from "../ui/index.js";
import { confirmAction } from "../lib/confirmation.js";
import { RunFilters } from "./Runs.js";

const keyOf = item => `${item.projectId}:${item.path}`;
const targetOf = item => ({ projectId: item.projectId, path: item.path });
const stamp = at => at ? ago(at, serverNow()) : "Not recorded";
const nameOf = item => item.jobs.find(j => j.ticketKey)?.ticketKey || item.branch?.replace(/^(feat|fix|chore)\//, "").replace(/-factory-[a-f0-9]+$/, "") || item.path.split("/").at(-1);
const projectOf = item => config.value.projects.find(p => p.kaneoId === item.projectId)?.name || item.repository.split("/").at(-1);
function previousFailure(item) {
  if (item.lastOutcome?.state === "failed") return { message: item.lastOutcome.message, at: item.lastOutcome.updatedAt };
  const job = item.jobs.find(j => j.error);
  return job ? { message: job.error, at: item.lastAttempt } : null;
}
const targetsOf = op => op.cleanupTargets ?? op.input.targets ?? [];
const pendingState = state => ["queued", "running", "uncertain"].includes(state);
const nextOf = item => item.next ?? { group: "attention", reason: "Cleanup has not been checked", action: "inspect" };
const ageOf = item => item.jobs.map(j => j.completedAt).filter(Boolean).sort()[0] || item.bindings.map(t => t.updatedAt).sort()[0];

// A row owns its cheap expansion and explicit inspection. Browsing never starts a check.
function CleanupRow({ item, selected, onSelect, onRemove, refreshing }) {
  const [open, setOpen] = useState(false), [detail, setDetail] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [force, setForce] = useState(false), [path, setPath] = useState(""), [reason, setReason] = useState(""), [copied, setCopied] = useState(false);
  const inspection = useRef(), opener = useRef();
  const next = nextOf(item), previous = previousFailure(item);
  const matching = operations.value.filter(op => op.kind === "cleanup" && targetsOf(op).some(t => keyOf(t) === keyOf(item)));
  const op = matching.findLast(op => cleanupOperationHolds(op, item)) ?? matching.at(-1);
  const pending = !!op && cleanupOperationHolds(op, item), outcome = op?.result?.data?.outcomes?.find(o => o.path === item.path);
  const refresh = async (review = false) => {
    inspection.current?.abort(); inspection.current = new AbortController(); const signal = inspection.current.signal;
    setOpen(true); setLoading(true); setError(""); setForce(false); setPath(""); setReason("");
    try {
      const value = await inspectCleanup(targetOf(item), review, signal);
      if (signal.aborted) return;
      setDetail(value); setForce(review && value.forceAllowed);
      if (review && !value.forceAllowed) setError(value.checks.filter(c => !c.override && c.state !== "pass").map(c => c.detail).join(". ") || "Fresh safety checks prevent deletion.");
    } catch (e) { if (!signal.aborted) setError(e.message); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  useEffect(() => () => inspection.current?.abort(), []);
  const toggle = () => { if (open) { inspection.current?.abort(); setLoading(false); setForce(false); } setOpen(!open); };
  const owner = item.bindings[0]?.id || item.jobs.find(j => j.threadId)?.threadId;
  const ticket = item.jobs.map(j => ticketLink(config.value, j)).find(Boolean);
  const action = detail?.state === "eligible" ? "remove" : next.action === "thread" && !owner || next.action === "ticket" && !ticket ? "inspect" : next.action;
  const primary = action === "remove" ? html`<${Button} size="sm" disabled=${pending || refreshing} onClick=${() => onRemove([item])}>${op?.state === "queued" ? "Queued" : op?.state === "running" ? "Removing…" : "Delete"}<//>`
    : action === "thread" ? html`<${Link} class="btn btn-sm" href=${threadLink({ threadId: owner })}>Open thread<//>`
    : action === "ticket" ? html`<${Link} class="btn btn-sm" href=${ticket}>Open ticket<//>`
    : action === "force" ? html`<${Button} size="sm" disabled=${loading || pending} onClick=${() => refresh(true)}>${loading ? "Checking…" : "Delete anyway…"}<//>`
    : action === "retry" ? html`<${Button} size="sm" disabled=${pending} onClick=${() => startCleanup({ type: "retry", targets: [targetOf(item)], reason: "Retry the current maintenance step" })}>Retry now<//>`
    : action === "inspect" ? html`<${Button} size="sm" disabled=${loading} onClick=${() => refresh()}>${loading ? "Checking…" : "Check now"}<//>` : null;
  const checks = list => list.map(c => html`<div class="cleanup-check" key=${c.name}><strong>${c.name}</strong><span>${c.detail}</span><small>${c.state} · ${stamp(c.checkedAt)}</small></div>`);
  const blocked = detail?.checks.filter(c => c.state !== "pass") ?? [], passed = detail?.checks.filter(c => c.state === "pass") ?? [];
  return html`<div class=${`cleanup-row-group ${open ? "is-current" : ""}`}>
    <div class="cleanup-row">
      ${!["protected", "gone"].includes(next.group) && html`<${Check} aria-label=${`Select ${item.path}`} checked=${selected} disabled=${pending} onChange=${() => onSelect(item)} />`}
      <button ref=${opener} type="button" class="cleanup-open" aria-label=${`Details ${item.path}`} aria-expanded=${open} onClick=${toggle}><${RowBody} title=${html`<strong>${nameOf(item)}</strong><span class="muted small">${projectOf(item)}</span>`}><span class="cleanup-reason">${previous && next.action === "remove" ? `Previous attempt failed ${stamp(previous.at)}; Delete rechecks this worktree` : next.reason}</span><//></button>
      <span class="cleanup-age muted small" title=${ageOf(item)}>${ageOf(item) ? stamp(ageOf(item)) : ""}</span>
      <div class="cleanup-row-actions">${primary}</div>
    </div>
    ${loading && html`<p class="cleanup-row-status" role="status">Checking ownership, files and activity… <${Button} size="sm" variant="ghost" onClick=${() => { inspection.current?.abort(); setLoading(false); }}>Cancel check<//></p>`}
    ${op && html`<p class="cleanup-row-status ${outcome?.state === "failed" || op.state === "uncertain" ? "error" : ""}" role="status">${op.state === "queued" ? "Queued for removal" : op.state === "running" ? "Verifying and removing this batch…" : pending ? "Result not confirmed. Check now before another removal request." : outcome?.state === "confirmed" && typeof outcome.physicalRemoval === "boolean" ? `${outcome.physicalRemoval === false ? "Already gone; records finalized" : "Removed"}${outcome.freeSpaceChange > 0 ? ` · measured ${bytes(outcome.freeSpaceChange)} freed` : ""}` : outcome?.state === "cancelled" ? "Stopped before sending" : `${op.state === "failed" ? `Attempt failed ${stamp(op.result?.data?.updatedAt ?? op.completedAt)}: ` : ""}${outcome?.message || op.result?.data?.message || "Check the recorded result before retrying."}`}</p>`}
    ${open && html`<section class="cleanup-inspector" aria-label=${`Details for ${nameOf(item)}`}>
      <div class="cleanup-path-line"><code class="cleanup-path">${item.path}</code><${Button} size="sm" variant="ghost" onClick=${async () => { try { await navigator.clipboard.writeText(item.path); setCopied(true); } catch { setError("Couldn't copy the path. Select it here to copy."); } }}>${copied ? "Copied" : "Copy path"}<//></div>
      <p class="small muted cleanup-path">${item.branch || "Branch unknown"}${item.size.bytes != null ? ` · ${bytes(item.size.bytes)} estimated${item.size.state === "stale" ? " · stale" : ""}` : ""}</p>
      <div class="links-row small">${item.jobs.map(j => html`<a href=${`/runs/${j.id}`} onClick=${follow}>Run ${j.ticketKey || "details"}</a>`)}${ticket && html`<${Link} href=${ticket}>Ticket<//>`}${item.jobs.flatMap(j => j.prUrls).map(safeLink).filter(Boolean).map(url => html`<${Link} href=${url}>${prLabel(url)}<//>`)}${owner && html`<${Link} href=${threadLink({ threadId: owner })}>Thread<//>`}</div>
      ${previous && html`<p class="small muted cleanup-path" title=${previous.at ? undefined : "Attempt time was not recorded"}>${previous.at ? `Previous cleanup result · ${stamp(previous.at)}` : "Previous cleanup result"}: ${previous.message}</p>`}
      <div class="links-row cleanup-inline-tools"><${Button} variant="ghost" size="sm" label=${`Check ${nameOf(item)}`} disabled=${loading} onClick=${() => refresh()}>${detail ? "Check again" : "Check now"}<//>${next.group !== "protected" && next.group !== "gone" && action !== "force" && html`<${Button} variant="ghost" size="sm" disabled=${loading || pending} onClick=${() => refresh(true)}>Delete anyway…<//>`}${detail && html`<span class="small muted">Checked ${stamp(detail.checkedAt)}</span>`}</div>
      ${error && html`<p role="alert" class="alert">${error}</p>`}
      ${detail && html`<div class="cleanup-verdict">${blocked.length ? checks(blocked) : html`<p>No removal blocker found by this check. Removal rechecks the evidence.</p>`}</div>
        <${Section} collapsible class="cleanup-disclosure" title=${`${passed.length} checks passed`}>${checks(passed)}<//>
        <${Section} collapsible class="cleanup-disclosure" title="Files and identity"><${Facts} items=${[["Repository", detail.repository], ["HEAD", detail.workspace?.head || "Unknown"], ["Directory", detail.workspace ? detail.workspace.present ? "Present" : "Absent" : "Unknown"], ["Git registration", detail.workspace ? detail.workspace.registered ? "Present" : "Absent" : "Unknown"], ["Contents", detail.workspace && `${detail.workspace.tracked} tracked changes, ${detail.workspace.untracked} untracked files, ${detail.workspace.ignored} ignored entries`]]} />${detail.workspace?.changes?.length > 0 && html`<ul class="mono cleanup-path">${detail.workspace.changes.map(c => html`<li>${c.kind} ${c.path}</li>`)}</ul><p class="small muted">Up to 100 paths. File contents are never displayed.</p>`}<//>
        <${Section} collapsible class="cleanup-disclosure" title="Owners and completion"><${Facts} items=${[["Ownership", detail.ownership], ["Process working directories", detail.processCount == null ? "Unknown" : detail.processCount], ["Terminals", detail.terminals.map(t => `${t.terminalId}: ${t.status}`).join(", ") || "None observed"]]} />${detail.jobs.map(j => html`<p class="small cleanup-path"><a href=${`/runs/${j.id}`} onClick=${follow}>${j.ticketKey || "Run details"}</a> · ${j.stage} · ${j.state}${j.nextRetry ? ` · retry ${clockTime(j.nextRetry)}` : ""}</p>`)}${detail.bindings.map(t => html`<p class="small cleanup-path"><${Link} href=${threadLink({ threadId: t.id })}>T3 thread<//> · ${t.status}${t.pending ? ` · pending ${t.pending.kind}` : ""}${t.background?.map(b => ` · ${b.kind}`).join("")}</p>`)}${detail.reports.length ? detail.reports.map(r => html`<p class="small">${r.status}: ${r.reason}</p>`) : html`<p class="small muted">No verified completion report.</p>`}<//>
        <${Section} collapsible class="cleanup-disclosure" title="Action history"><${Timeline} actions=${detail.actions} /><//>`}
      ${force && detail && html`<form class="cleanup-force" onSubmit=${e => { e.preventDefault(); if (path === detail.path && reason.trim() && Date.parse(detail.expiresAt) > serverNow() && !pending) { const id = startCleanup({ type: "force", reviewId: detail.reviewId, confirmation: path, reason }, targetOf(item)); if (id) setForce(false); else setError("An earlier cleanup request still needs verification."); } }}>
        <h3>Delete this worktree anyway</h3><p>Deletes the directory and all its files. Branch refs, reports and terminal history stay.</p><ul>${detail.overridden.map(text => html`<li>${text}</li>`)}</ul>
        <${Field} label="Exact worktree path"><${Input} mono aria-label="Exact worktree path" value=${path} onChange=${setPath} autocomplete="off" /><//><${Field} label="Reason"><${Input} aria-label="Reason for deletion" value=${reason} onChange=${setReason} maxlength="800" /><//>
        <div class="links-row"><span class="small muted">Valid until ${clockTime(detail.expiresAt)}</span><${Button} variant="ghost" onClick=${() => setForce(false)}>Cancel<//>${Date.parse(detail.expiresAt) <= serverNow() ? html`<${Button} disabled=${loading} onClick=${() => refresh(true)}>Review again<//>` : html`<${Button} type="submit" variant="danger" disabled=${pending || path !== detail.path || !reason.trim()}>Delete<//>`}</div>
      </form>`}
    </section>`}
  </div>`;
}

export function Cleanup() {
  clock.value;
  const [snapshot, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ query: new URLSearchParams(location.search).get("query") ?? "", repository: "", ownership: "", state: "", view: "retained", sort: "action", offset: 0 });
  const [selected, setSelected] = useState([]), [revision, setRevision] = useState(0), [preparing, setPreparing] = useState(false), [extras, setExtras] = useState({});
  const batchRead = useRef(), extraReads = useRef(new Map()), generation = useRef(0), wasRunning = useRef(false), rescan = useRef(false);
  const ops = operations.value.filter(op => op.kind === "cleanup"), running = ops.some(op => ["queued", "running"].includes(op.state));
  const currentOps = ops;
  const data = projectCleanupResults(snapshot, ops, filters);
  const summary = cleanupResultSummary(currentOps), totalTargets = summary.total;
  const outcomeSummary = [["removed", summary.removed], ["already gone", summary.absent], ["failed", summary.failed], ["unconfirmed", summary.uncertain], ["still pending", summary.pending], ["not sent", summary.cancelled]].filter(([label, n]) => label === "removed" || n).map(([label, n]) => `${n} ${label}`).join(" · ");
  useEffect(() => { if (wasRunning.current && !running) { setRevision(n => n + 1); setSelected([]); } wasRunning.current = running; }, [running]);
  useEffect(() => {
    const abort = new AbortController(); generation.current++; batchRead.current?.abort(); for (const read of extraReads.current.values()) read.abort(); extraReads.current.clear(); setPreparing(false); setLoading(true); setError("");
    const force = rescan.current;
    const timer = setTimeout(() => { rescan.current = false; return loadCleanup({ ...filters, limit: 6, ...force ? { refresh: true } : {} }, abort.signal).then(value => { if (!abort.signal.aborted) { setData(value); setSelected([]); setExtras({}); } }, e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); }, 120);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [JSON.stringify(filters), revision, status.value.at]);
  useEffect(() => () => { batchRead.current?.abort(); for (const read of extraReads.current.values()) read.abort(); }, []);
  const refresh = () => { rescan.current = true; setRevision(n => n + 1); };
  const change = (key, value) => { setSelected([]); setFilters(current => ({ ...current, offset: 0, [key]: value })); };
  const pick = item => { const key = keyOf(item); setSelected(current => current.includes(key) ? current.filter(v => v !== key) : [...current, key]); };
  const remove = items => { const id = startCleanup({ type: "remove", targets: items.map(targetOf), reason: "Remove verified finished worktrees, including ignored files" }); if (!id) setError("An earlier cleanup request needs verification before these worktrees can be removed."); return id; };
  const removeBatch = async () => {
    batchRead.current?.abort(); batchRead.current = new AbortController(); const signal = batchRead.current.signal;
    setPreparing(true); setError("");
    try {
      let items = [];
      if (selected.length) items = data.items.filter(i => selected.includes(keyOf(i)));
      else for (let offset = 0; ; offset += 100) { const page = await loadCleanup({ ...filters, view: "retained", offset, limit: 100 }, signal); items.push(...page.items); if (offset + page.items.length >= page.total || !page.items.length) break; }
      if (!signal.aborted && items.length) confirmAction({ title: `Delete unused worktrees?`, message: `Checks ${items.length} worktrees and deletes those merged into the remote release branch with no activity or local changes. Deletes all ignored files. Keeps branches, reports and threads.`, label: `Delete unused` }, () => remove(items));
    } catch (e) { if (!signal.aborted) setError(e.message); } finally { if (!signal.aborted) setPreparing(false); }
  };
  const extra = async (group, append = false) => {
    if (extras[group]?.loading) return;
    const offset = append ? extras[group].items.length : 0, epoch = generation.current;
    extraReads.current.get(group)?.abort(); const controller = new AbortController(); extraReads.current.set(group, controller);
    setExtras(current => ({ ...current, [group]: { ...current[group], open: true, loading: true, error: "" } }));
    try { const page = await loadCleanup({ ...filters, view: group, offset, limit: 50 }, controller.signal); if (epoch !== generation.current || controller.signal.aborted) return; setExtras(current => ({ ...current, [group]: { open: true, loading: false, ...page, items: [...append ? current[group].items : [], ...page.items] } })); }
    catch (e) { if (controller.signal.aborted || epoch !== generation.current) return; setExtras(current => ({ ...current, [group]: { ...current[group], loading: false, error: e.message } })); }
  };
  const rows = items => items.map(item => html`<${CleanupRow} key=${keyOf(item)} item=${item} selected=${selected.includes(keyOf(item))} onSelect=${pick} onRemove=${remove} refreshing=${loading || data?.staleResults || data?.policy?.ignoredFiles !== "disposable"} />`);
  const more = async () => {
    const epoch = generation.current;
    setLoading(true);
    try { const page = await loadCleanup({ ...filters, view: "retained", offset: data.items.length, limit: 50 }); if (epoch !== generation.current) return; setData(current => ({ ...current, groups: page.groups, total: page.total, items: [...current.items, ...page.items.filter(i => !current.items.some(old => keyOf(old) === keyOf(i)))] })); }
    catch (e) { if (epoch === generation.current) setError(e.message); } finally { if (epoch === generation.current) setLoading(false); }
  };
  const missingProject = data?.maintenance?.error?.match(/Keep project (\S+) configured/);
  return html`<${Page} title="Cleanup" class="cleanup-page" actions=${html`<div class="links-row">${data?.filesystems?.map(f => html`<span class="cleanup-disk" title=${f.repositories.map(p => p.split("/").at(-1)).join(", ")}>${bytes(f.freeBytes)} free</span>`)}<span class="muted small cleanup-updated">${loading ? "Loading…" : data?.checkedAt ? `Updated ${stamp(data.checkedAt)}${data.refreshing ? " · updating" : ""}` : data?.refreshing ? "Discovering…" : ""}</span><${Button} icon="sync" label="Refresh cleanup inventory" disabled=${loading} onClick=${refresh} /></div>`}>
    <div class="cleanup-search"><${RunFilters} rows=${[]} filters=${filters} query=${filters.query} onQuery=${v => change("query", v)} onFilters=${v => setFilters(current => ({ ...current, repository: "", ownership: "", state: "", sort: "action", ...v, offset: 0 }))} searchLabel="Find ticket, branch or path" filterLabel="Filter worktrees" activeCount=${[filters.repository, filters.ownership, filters.state, filters.sort !== "action"].filter(Boolean).length}><${Field} group label="Repository"><${Select} label="Repository" value=${filters.repository} onChange=${v => change("repository", v)} options=${[["", "All repositories"], ...(data?.repositories ?? []).map(r => [r.path, r.path.split("/").at(-1)])]} /><//><${Section} collapsible class="cleanup-disclosure" title="More filters">
      <${Field} group label="Ownership"><${Select} label="Ownership" value=${filters.ownership} onChange=${v => change("ownership", v)} options=${[["", "Any owner"], ...["factory", "shared", "t3-only", "orphan", "unknown"].map(v => [v, v])]} /><//>
      <${Field} group label="Cleanup state"><${Select} label="Cleanup state" value=${filters.state} onChange=${v => change("state", v)} options=${[["", "Any state"], ...["pending", "blocked", "active", "missing", "complete", "stale-registration", "review", "unknown", "primary"].map(v => [v, v === "complete" ? "Removed" : stateLabel(v)])]} /><//>
      <${Field} group label="Order"><${Select} label="Order worktrees" value=${filters.sort} onChange=${v => change("sort", v)} options=${[["action", "Next action, oldest first"], ["repository", "Repository"], ["branch", "Branch"], ["path", "Path"], ["attempt", "Last attempt"], ["size", "Known size"]]} /><//>
    <//><//></div>
    ${error && html`<p role="alert" class="alert">${error}</p>`}
    ${data?.errors.map(e => html`<p role="alert" class="alert">Couldn't scan ${e.repository === "T3" ? "T3 ownership" : e.repository.split("/").at(-1)}. ${e.message} <${Button} size="sm" onClick=${refresh}>Retry scan<//></p>`)}
    ${data?.stalled && html`<p role="alert" class="alert">Automatic cleanup has stalled since ${clockTime(data.maintenance.lastAttempt)}. Use Check now on a retained worktree to inspect its blocker.</p>`}
    ${totalTargets > 0 && html`<div class=${`cleanup-progress ${summary.failed > 0 ? "error" : ""}`} role=${summary.failed > 0 ? "alert" : "status"}><span>${running ? "" : "Recorded results · "}${outcomeSummary || "No removals verified"}${running ? ` · ${summary.processed} of ${totalTargets} results received` : ""}</span>${running ? html`<${Button} size="sm" onClick=${stopCleanupQueue}>Stop queued removals<//>` : html`<${Button} size="sm" variant="ghost" onClick=${() => currentOps.filter(op => !pendingState(op.state) && op.result?.data?.state !== "uncertain").forEach(op => actions.dismissOperation(op.id))}>Dismiss results<//>`}</div>`}
    ${!data && html`<${Empty}>${loading ? "Loading worktrees…" : "Inventory unavailable."}<//>`}
    ${data && html`
      <${Section} title="Worktrees" count=${data.staleResults ? undefined : data.total} aside=${html`<${Button} disabled=${loading || data.staleResults || preparing || !data.total || data.policy?.ignoredFiles !== "disposable"} onClick=${removeBatch}>${preparing ? "Preparing…" : selected.length ? `Delete ${selected.length} selected` : "Delete unused worktrees"}<//>`}>
        <p class="small muted cleanup-policy">Deletes merged, unused worktrees and their ignored files. Keeps local changes and active work.</p>
        ${data.policy?.ignoredFiles !== "disposable" && html`<p role="alert" class="alert">Deletion is unavailable until the cleanup backend is updated.</p>`}
        ${data.staleResults && html`<p role="status" class="small muted">Refreshing inventory to reconcile these results…</p>`}
        ${rows(data.items)}
        ${data.items.length < data.total && html`<${Button} size="sm" disabled=${loading} onClick=${more}>Show more worktrees<//>`}
        ${!data.total && html`<${Empty}>${data.refreshing ? "Discovering worktrees…" : "No unused worktrees found."}<//>`}
      <//>
      ${[["protected", "In use"], ["gone", "Already gone"]].map(([group, title]) => html`<${Section} collapsible class="cleanup-disclosure cleanup-footer" title=${`${title} · ${data.groups?.[group] ?? 0}`} onToggle=${e => { if (e.currentTarget.open && !extras[group]?.items && !extras[group]?.loading) extra(group); }}>
        ${extras[group]?.loading && html`<p role="status" class="small muted">Loading worktrees…</p>`}${extras[group]?.items && !extras[group]?.items.length && html`<${Empty}>No worktrees in this group.<//>`}
        ${extras[group]?.error && html`<p role="alert" class="alert">${extras[group].error}</p>`}${rows(extras[group]?.items ?? [])}
        ${extras[group]?.items?.length < extras[group]?.total && html`<${Button} disabled=${extras[group].loading} size="sm" onClick=${() => extra(group, true)}>Show more<//>`}
      <//>`)}
      <${Section} collapsible class="cleanup-disclosure cleanup-footer" title="Diagnostics">${missingProject && html`<p role="alert" class="alert">A finished run references a removed project. Restore it as disabled to finish automatic cleanup. <a href="/projects" onClick=${follow}>Open Projects</a></p>`}<${Facts} items=${[["Last scan", stamp(data.lastSuccessfulScan)], ["Terminal access", data.terminalAccess ? `${data.terminalAccess.state === "available" ? "Available" : "Unavailable"} · checked ${stamp(data.terminalAccess.checkedAt)}` : null], ["Last attempt", stamp(data.maintenance?.lastAttempt)], ["Last removal", stamp(data.maintenance?.lastSuccess)], ["Next retry", data.nextRetry ? clockTime(data.nextRetry) : "None scheduled"], ["Ticket automation", data.automationEnabled ? "Enabled" : "Paused"], ["Cleanup maintenance", data.maintenance?.state || "No attempt recorded"]]} /><//>
    `}
  <//>`;
}
