// Worktrees on disk for every configured repository: which are unused, what blocks the rest, and one way to delete them.
import { html, useEffect, useState, useRef } from "../lib/h.js";
import { config, status, operations, loadCleanup, inspectCleanup, startCleanup, stopCleanupQueue, cleanupOperationHolds, actions, clock, serverNow, message } from "../lib/store.js";
import { cleanupResultSummary, projectCleanupResults, ago, clockTime, formatBytes as bytes, ticketLink, threadLink, safeLink, prLabel } from "../lib/format.js";
import { follow } from "../lib/router.js";
import { Button, Select, Field, RowBody, Meta, Tag, Help, Icon, Page, Section, Segmented, Facts, Empty, Timeline, Link, Check } from "../ui/index.js";
import { confirmAction } from "../lib/confirmation.js";
import { RunFilters } from "./Runs.js";

const keyOf = item => `${item.projectId}:${item.path}`;
const targetOf = item => ({ projectId: item.projectId, path: item.path });
const stamp = at => at ? ago(at, serverNow()) : "Not recorded";
const folderOf = item => item.path.split("/").at(-1);
const projectOf = item => config.value.projects.find(p => p.kanvilId === item.projectId)?.name || item.repository.split("/").at(-1);
const targetsOf = op => op.cleanupTargets ?? op.input.targets ?? [];
const pendingState = state => ["queued", "running", "uncertain"].includes(state);
const nextOf = item => item.next ?? { group: "attention", reason: "Not checked yet", action: "inspect" };
const selectable = item => !["protected", "gone"].includes(nextOf(item).group);
const ageOf = item => item.jobs.map(j => j.completedAt).filter(Boolean).sort()[0] || item.bindings.map(t => t.updatedAt).sort()[0];
const GROUPS = { ready: ["Unused", "ok"], attention: ["Blocked", "attention"], retrying: ["Retrying", "on"], protected: ["In use", ""], gone: ["Deleted", "ok"] };
// Segmented views and the API views behind them.
const VIEWS = [["present", "All"], ["ready", "Unused"], ["blocked", "Blocked"], ["inuse", "In use"]];
const REASON = "Deleted from the Cleanup page";

// Reads up to `want` rows in requests the inventory API accepts, at most 100 rows each.
async function loadRows(query, want, signal) {
  let value;
  for (let offset = 0; offset < want; offset += 100) {
    const page = await loadCleanup({ ...query, offset, limit: Math.min(100, want - offset) }, signal);
    value = value ? { ...value, items: [...value.items, ...page.items] } : page;
    if (offset + page.items.length >= page.total || !page.items.length) break;
  }
  return value;
}

function previousFailure(item) {
  if (item.lastOutcome?.state === "failed") return { message: item.lastOutcome.message, at: item.lastOutcome.updatedAt };
  const job = item.jobs.find(j => j.error);
  return job ? { message: job.error, at: item.lastAttempt } : null;
}

// One worktree on one fixed-height row: name, project, state tag, a glyph that explains a blocker on hover, age and one
// action. Expanding reads what the inventory already knows; only Check and Delete anyway contact the backend.
function CleanupRow({ item, selecting, selected, onSelect, onRemove, refreshing }) {
  const [open, setOpen] = useState(false), [detail, setDetail] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false), [copied, setCopied] = useState(false);
  const inspection = useRef();
  const next = nextOf(item), previous = previousFailure(item), folder = folderOf(item);
  const matching = operations.value.filter(op => op.kind === "cleanup" && targetsOf(op).some(t => keyOf(t) === keyOf(item)));
  const op = matching.findLast(op => cleanupOperationHolds(op, item)) ?? matching.at(-1);
  const pending = !!op && cleanupOperationHolds(op, item), outcome = op?.result?.data?.outcomes?.find(o => o.path === item.path);
  const refresh = async () => {
    inspection.current?.abort(); inspection.current = new AbortController(); const signal = inspection.current.signal;
    setOpen(true); setLoading(true); setError("");
    try { const value = await inspectCleanup(targetOf(item), false, signal); if (!signal.aborted) setDetail(value); }
    catch (e) { if (!signal.aborted) setError(e.message); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  // Review, then one confirmation that names what will be lost. The row stays as it is.
  const deleteAnyway = async () => {
    setReviewing(true);
    try {
      const review = await inspectCleanup(targetOf(item), true);
      if (!review.forceAllowed) return message(`${folder}: ${review.checks.filter(c => !c.override && c.state !== "pass").map(c => c.detail).join(". ") || "fresh safety checks prevent deletion"}`, true);
      confirmAction({ title: `Delete ${folder} anyway?`, message: `${review.overridden.join(". ")}. The folder and everything in it is deleted. Branch refs, reports and threads stay.`, label: "Delete" },
        () => { if (!startCleanup({ type: "force", reviewId: review.reviewId, confirmation: folder, reason: REASON }, targetOf(item))) message("An earlier cleanup request still needs verification.", true); });
    } catch (e) { message(`${folder}: ${e.message}`, true); }
    finally { setReviewing(false); }
  };
  useEffect(() => () => inspection.current?.abort(), []);
  const toggle = () => { if (open) { inspection.current?.abort(); setLoading(false); } setOpen(!open); };
  const owner = item.bindings[0]?.id || item.jobs.find(j => j.threadId)?.threadId;
  const ticket = item.jobs.map(j => ticketLink(config.value, j)).find(Boolean);
  const action = detail?.state === "eligible" ? "remove" : next.action === "thread" && !owner || next.action === "ticket" && !ticket ? "inspect" : next.action;
  const busy = op?.state === "queued" ? "Queued" : op?.state === "running" ? "Deleting…" : loading || reviewing ? "Checking…" : null;
  // Icon-only, like the queue's Run now; the label carries the verb and the folder.
  const primary = busy ? html`<${Button} size="sm" icon class="next-run" disabled label=${`${busy} ${folder}`}><i class="spinner"></i><//>`
    : action === "remove" ? html`<${Button} size="sm" icon="trash" class="next-run" label=${`Delete ${folder}`} disabled=${pending || refreshing} onClick=${() => onRemove([item])} />`
    : action === "thread" ? html`<${Link} class="btn btn-sm btn-icon next-run" href=${threadLink({ threadId: owner })} title=${`Open the thread using ${folder} in T3 Code`}><${Icon} name="commentDiscussion" label=${`Open the thread using ${folder} in T3 Code`} /><//>`
    : action === "ticket" ? html`<${Link} class="btn btn-sm btn-icon next-run" href=${ticket} title=${`Open the ticket for ${folder}`}><${Icon} name="arrowRight" label=${`Open the ticket for ${folder}`} /><//>`
    : action === "force" ? html`<${Button} size="sm" icon="trash" class="next-run tone-attention" label=${`Delete ${folder} anyway: ${next.reason}`} disabled=${pending} onClick=${deleteAnyway} />`
    : action === "retry" ? html`<${Button} size="sm" icon="sync" class="next-run" label=${`Retry cleanup of ${folder}`} disabled=${pending} onClick=${() => startCleanup({ type: "retry", targets: [targetOf(item)], reason: "Retry the current maintenance step" })} />`
    : action === "inspect" ? html`<${Button} size="sm" icon="checklist" class="next-run" label=${`Check ${folder}`} onClick=${() => refresh()} />` : null;
  const checks = list => list.map(c => html`<div class="cleanup-check" key=${c.name}><strong>${c.name}</strong><span>${c.detail}</span><small>${c.state} · ${stamp(c.checkedAt)}</small></div>`);
  const blocked = detail?.checks.filter(c => c.state !== "pass") ?? [], passed = detail?.checks.filter(c => c.state === "pass") ?? [];
  const [groupLabel, tone] = GROUPS[next.group] ?? GROUPS.attention;
  // Why the row is not simply deletable, on hover or focus; the last failed attempt rides along.
  const note = next.group === "ready" ? "" : `${next.reason}${previous && !next.reason.includes(previous.message) ? `. Last attempt: ${previous.message}` : ""}${outcome?.state === "failed" && !next.reason.includes(outcome.message) ? `. Failed: ${outcome.message}` : ""}`;
  return html`<div class=${`cleanup-row-group ${open ? "is-current" : ""}`}>
    <div class="cleanup-row">
      ${selecting && (selectable(item) ? html`<${Check} aria-label=${`Select ${item.path}`} checked=${selected} disabled=${pending} onChange=${() => onSelect(item)} />` : html`<span class="cleanup-spacer"></span>`)}
      <button type="button" class="cleanup-open" aria-label=${`Details ${item.path}`} aria-expanded=${open} onClick=${toggle}>
        <${RowBody} title=${html`<b class="key">${folder}</b>${item.branch && item.branch !== "HEAD" && html`<span class="muted">${item.branch}</span>`}`}>
          <${Meta} project=${projectOf(item)}><${Tag} tone=${tone} title=${next.reason}>${groupLabel}<//><//>
        <//>
      </button>
      <span class="cleanup-note">${note && html`<${Help} text=${note} glyph="!" tone=${next.group === "attention" ? "attention" : undefined} />`}</span>
      <span class="cleanup-age muted small" title=${ageOf(item) ? `Finished ${clockTime(ageOf(item))}` : undefined}>${ageOf(item) ? ago(ageOf(item), serverNow(), true) : ""}</span>
      <div class="cleanup-row-actions">${primary}</div>
    </div>
    ${open && html`<section class="cleanup-inspector" aria-label=${`Details for ${folder}`}>
      <div class="cleanup-path-line"><code class="cleanup-path">${item.path}</code><${Button} size="sm" variant="ghost" onClick=${async () => { try { await navigator.clipboard.writeText(item.path); setCopied(true); } catch { setError("Couldn't copy the path. Select it here to copy."); } }}>${copied ? "Copied" : "Copy path"}<//></div>
      <${Facts} items=${[["State", `${groupLabel} · ${next.reason}`], ["Branch", item.branch || "Detached"], ["Size", item.size.bytes != null ? `${bytes(item.size.bytes)} estimated${item.size.state === "stale" ? ", stale" : ""}` : null], ["Last result", previous && `${previous.message}${previous.at ? ` · ${stamp(previous.at)}` : ""}`], ["This request", op && (outcome?.state === "confirmed" ? `${outcome.physicalRemoval === false ? "Already gone" : "Deleted"}${outcome.freeSpaceChange > 0 ? ` · ${bytes(outcome.freeSpaceChange)} freed` : ""}` : outcome?.message || op.result?.data?.message || busy)]]} />
      <div class="links-row small">${item.jobs.map(j => html`<a href=${`/runs/${j.id}`} onClick=${follow}>Run ${j.ticketKey || "details"}</a>`)}${ticket && html`<${Link} href=${ticket}>Ticket<//>`}${item.jobs.flatMap(j => j.prUrls).map(safeLink).filter(Boolean).map(url => html`<${Link} href=${url}>${prLabel(url)}<//>`)}${owner && html`<${Link} href=${threadLink({ threadId: owner })}>Thread<//>`}</div>
      <div class="links-row cleanup-inline-tools"><${Button} variant="ghost" size="sm" label=${`Check ${folder}`} disabled=${loading} onClick=${() => refresh()}>${detail ? "Check again" : "Check"}<//>${loading && html`<${Button} size="sm" variant="ghost" onClick=${() => { inspection.current?.abort(); setLoading(false); }}>Cancel<//>`}${selectable(item) && action !== "force" && html`<${Button} variant="ghost" size="sm" disabled=${reviewing || pending} onClick=${deleteAnyway}>Delete anyway…<//>`}${detail && html`<span class="small muted">Checked ${stamp(detail.checkedAt)}</span>`}</div>
      ${error && html`<p role="alert" class="alert">${error}</p>`}
      ${detail && html`<div class="cleanup-verdict">${blocked.length ? checks(blocked) : html`<p>No blocker found. Delete rechecks before removing.</p>`}</div>
        <${Section} collapsible class="cleanup-disclosure" title=${`${passed.length} checks passed`}>${checks(passed)}<//>
        <${Section} collapsible class="cleanup-disclosure" title="Files and owners"><${Facts} items=${[["Repository", detail.repository], ["HEAD", detail.workspace?.head || "Unknown"], ["Directory", detail.workspace ? detail.workspace.present ? "Present" : "Absent" : "Unknown"], ["Git registration", detail.workspace ? detail.workspace.registered ? "Present" : "Absent" : "Unknown"], ["Contents", detail.workspace && `${detail.workspace.tracked} tracked changes, ${detail.workspace.untracked} untracked files, ${detail.workspace.ignored} ignored entries`], ["Ownership", detail.ownership], ["Processes", detail.processCount == null ? "Unknown" : detail.processCount], ["Terminals", detail.terminals.map(t => `${t.terminalId}: ${t.status}`).join(", ") || "None"]]} />${detail.workspace?.changes?.length > 0 && html`<ul class="mono cleanup-path">${detail.workspace.changes.map(c => html`<li>${c.kind} ${c.path}</li>`)}</ul><p class="small muted">Up to 100 paths.</p>`}${detail.jobs.map(j => html`<p class="small cleanup-path"><a href=${`/runs/${j.id}`} onClick=${follow}>${j.ticketKey || "Run details"}</a> · ${j.stage} · ${j.state}${j.nextRetry ? ` · retry ${clockTime(j.nextRetry)}` : ""}</p>`)}${detail.bindings.map(t => html`<p class="small cleanup-path"><${Link} href=${threadLink({ threadId: t.id })}>T3 thread<//> · ${t.status}${t.pending ? ` · pending ${t.pending.kind}` : ""}${t.background?.map(b => ` · ${b.kind}`).join("")}</p>`)}<//>
        <${Section} collapsible class="cleanup-disclosure" title="Action history"><${Timeline} actions=${detail.actions} /><//>`}
    </section>`}
  </div>`;
}

export function Cleanup() {
  clock.value;
  const [snapshot, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ query: new URLSearchParams(location.search).get("query") ?? "", repository: "", ownership: "", view: "present", sort: "action" });
  const [selecting, setSelecting] = useState(false), [selected, setSelected] = useState([]), [revision, setRevision] = useState(0), [preparing, setPreparing] = useState(false);
  const batchRead = useRef(), generation = useRef(0), wasRunning = useRef(false), rescan = useRef(false), scope = useRef("");
  const ops = operations.value.filter(op => op.kind === "cleanup"), running = ops.some(op => ["queued", "running"].includes(op.state));
  const data = projectCleanupResults(snapshot, ops, filters);
  const summary = cleanupResultSummary(ops), totalTargets = summary.total;
  const outcomeSummary = [["deleted", summary.removed], ["already gone", summary.absent], ["failed", summary.failed], ["unconfirmed", summary.uncertain], ["still pending", summary.pending], ["not sent", summary.cancelled]].filter(([label, n]) => label === "deleted" || n).map(([label, n]) => `${n} ${label}`).join(" · ");
  useEffect(() => { if (wasRunning.current && !running) { setRevision(n => n + 1); setSelected([]); } wasRunning.current = running; }, [running]);
  useEffect(() => {
    const abort = new AbortController(), force = rescan.current, filtered = JSON.stringify(filters);
    // Status pushes reload what is already on screen: the selection, extra pages and a bulk read survive. A filter change or
    // an explicit refresh starts over, and only the first load and an explicit refresh show as loading.
    const silent = !!snapshot && !force && scope.current === filtered;
    scope.current = filtered; setError("");
    if (!silent) { generation.current++; batchRead.current?.abort(); setPreparing(false); }
    if (!snapshot || force) setLoading(true);
    const keep = value => { const live = new Set(value.items.filter(selectable).map(keyOf)); return current => current.every(key => live.has(key)) ? current : current.filter(key => live.has(key)); };
    const timer = setTimeout(() => { rescan.current = false; return loadRows({ ...filters, ...force ? { refresh: true } : {} }, silent ? Math.max(50, snapshot.items.length) : 50, abort.signal).then(value => { if (!abort.signal.aborted) { setData(value); setSelected(silent ? keep(value) : []); } }, e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); }, 120);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [JSON.stringify(filters), revision, status.value.at]);
  useEffect(() => () => batchRead.current?.abort(), []);
  const refresh = () => { rescan.current = true; setRevision(n => n + 1); };
  const change = (key, value) => { setSelected([]); setFilters(current => ({ ...current, [key]: value })); };
  const pick = item => { const key = keyOf(item); setSelected(current => current.includes(key) ? current.filter(v => v !== key) : [...current, key]); };
  const remove = items => { const id = startCleanup({ type: "remove", targets: items.map(targetOf), reason: REASON }); if (!id) setError("An earlier cleanup request needs verification before these worktrees can be deleted."); return id; };
  const unused = data?.groups?.ready ?? 0, visible = (data?.items ?? []).filter(selectable);
  const removeBatch = async () => {
    batchRead.current?.abort(); batchRead.current = new AbortController(); const signal = batchRead.current.signal;
    setPreparing(true); setError("");
    try {
      let items = [];
      if (selected.length) items = data.items.filter(i => selected.includes(keyOf(i)));
      else items = (await loadRows({ ...filters, view: "ready" }, Infinity, signal)).items;
      const forced = selected.length ? items.filter(i => nextOf(i).action === "force") : [], plain = items.filter(i => !forced.includes(i));
      if (!signal.aborted && items.length) confirmAction({ title: `Delete ${items.length} ${items.length === 1 ? "worktree" : "worktrees"}?`, message: `${plain.length ? "Each one is rechecked first: it must be merged into the release branch, idle, and free of tracked or untracked changes. " : ""}${forced.length ? `${forced.length} of them ${forced.length === 1 ? "has" : "have"} unmerged work or local changes that will be lost. ` : ""}Ignored files are deleted with the folder. Branches, reports and threads stay.`, label: "Delete" }, async () => {
        if (plain.length) remove(plain);
        for (const item of forced) {
          try { const review = await inspectCleanup(targetOf(item), true); if (review.forceAllowed) startCleanup({ type: "force", reviewId: review.reviewId, confirmation: folderOf(item), reason: REASON }, targetOf(item)); else setError(`${folderOf(item)}: ${review.checks.filter(c => !c.override && c.state !== "pass").map(c => c.detail).join(". ") || "fresh safety checks prevent deletion"}`); }
          catch (e) { setError(`${folderOf(item)}: ${e.message}`); }
        }
      });
    } catch (e) { if (!signal.aborted) setError(e.message); } finally { if (!signal.aborted) setPreparing(false); }
  };
  const more = async () => {
    const epoch = generation.current;
    setLoading(true);
    try { const page = await loadCleanup({ ...filters, offset: data.items.length, limit: 50 }); if (epoch !== generation.current) return; setData(current => ({ ...current, groups: page.groups, total: page.total, items: [...current.items, ...page.items.filter(i => !current.items.some(old => keyOf(old) === keyOf(i)))] })); }
    catch (e) { if (epoch === generation.current) setError(e.message); } finally { if (epoch === generation.current) setLoading(false); }
  };
  const counts = data ? { present: (data.views?.retained ?? 0) + (data.views?.protected ?? 0), ready: data.groups?.ready ?? 0, blocked: (data.groups?.attention ?? 0) + (data.groups?.retrying ?? 0), inuse: data.groups?.protected ?? 0 } : {};
  const activeFilters = [filters.repository, filters.ownership, filters.sort !== "action"].filter(Boolean).length;
  return html`<${Page} title="Cleanup" class="cleanup-page" lead=${data?.filesystems?.map(f => `${bytes(f.freeBytes)} free`).join(" · ")} actions=${html`<${RunFilters} rows=${[]} filters=${filters} query=${filters.query} onQuery=${v => change("query", v)} onFilters=${v => setFilters(current => ({ ...current, repository: "", ownership: "", sort: "action", ...v }))} searchLabel="Find a branch or folder" filterLabel="Filter worktrees" activeCount=${activeFilters}>
      <${Field} group label="Repository"><${Select} label="Repository" value=${filters.repository} onChange=${v => change("repository", v)} options=${[["", "All repositories"], ...(data?.repositories ?? []).map(r => [r.path, r.path.split("/").at(-1)])]} /><//>
      <${Field} group label="Owner"><${Select} label="Owner" value=${filters.ownership} onChange=${v => change("ownership", v)} options=${[["", "Any"], ["factory", "Factory run"], ["t3-only", "T3 thread"], ["shared", "Shared"], ["orphan", "No owner"], ["unknown", "Unknown"]]} /><//>
      <${Field} group label="Order"><${Select} label="Order worktrees" value=${filters.sort} onChange=${v => change("sort", v)} options=${[["action", "Next action, oldest first"], ["repository", "Repository"], ["branch", "Branch"], ["path", "Path"], ["attempt", "Last attempt"], ["size", "Known size"]]} /><//>
    <//><${Button} size="sm" icon=${selecting ? "check" : "checklist"} label=${selecting ? "Done selecting worktrees" : "Select worktrees"} aria-pressed=${selecting} onClick=${() => { setSelecting(!selecting); setSelected([]); }} /><${Button} size="sm" icon="sync" label="Refresh cleanup inventory" disabled=${loading} onClick=${refresh} />`}>
    <${Segmented} label="Worktrees" value=${filters.view} onChange=${v => change("view", v)} options=${VIEWS.map(([value, label]) => [value, label, counts[value]])} />
    ${error && html`<p role="alert" class="alert">${error}</p>`}
    ${data?.errors.map(e => html`<p role="alert" class="alert">Couldn't scan ${e.repository === "T3" ? "T3 ownership" : e.repository.split("/").at(-1)}. ${e.message} <${Button} size="sm" onClick=${refresh}>Retry scan<//></p>`)}
    ${data?.stalled && html`<p role="alert" class="alert">Automatic cleanup has stalled since ${clockTime(data.maintenance.lastAttempt)}: ${data.maintenance.error || "no error recorded"}.</p>`}
    ${totalTargets > 0 && html`<div class=${`cleanup-progress ${summary.failed > 0 ? "error" : ""}`} role=${summary.failed > 0 ? "alert" : "status"}><span>${outcomeSummary || "Nothing deleted"}${running ? ` · ${summary.processed} of ${totalTargets} done` : ""}</span>${running ? html`<${Button} size="sm" onClick=${stopCleanupQueue}>Stop queued deletions<//>` : html`<${Button} size="sm" variant="ghost" onClick=${() => ops.filter(op => !pendingState(op.state) && op.result?.data?.state !== "uncertain").forEach(op => actions.dismissOperation(op.id))}>Dismiss<//>`}</div>`}
    ${!data && html`<${Empty}>${loading ? "Loading worktrees…" : "Inventory unavailable."}<//>`}
    ${data && html`
      <${Section} title=${VIEWS.find(([v]) => v === filters.view)?.[1]} count=${data.staleResults ? undefined : data.total} aside=${!selecting && html`<${Button} size="sm" icon="trash" label=${preparing ? "Preparing…" : `Delete ${unused} unused ${unused === 1 ? "worktree" : "worktrees"}`} disabled=${loading || data.staleResults || preparing || !unused} onClick=${removeBatch} />`}>
        ${selecting && !!data.items.length && html`<div class="selection-bar">
          <${Check} label="Select visible" aria-label="Select visible worktrees" checked=${visible.length > 0 && selected.length === visible.length} indeterminate=${selected.length > 0 && selected.length < visible.length} onChange=${() => setSelected(selected.length === visible.length ? [] : visible.map(keyOf))} />
          <span class="muted">${selected.length} selected</span>
          <${Button} size="sm" icon="trash" label="Delete selected worktrees" disabled=${!selected.length || preparing || loading || data.staleResults} onClick=${removeBatch} />
        </div>`}
        ${data.staleResults && html`<p role="status" class="small muted">Refreshing inventory to reconcile these results…</p>`}
        ${data.items.map(item => html`<${CleanupRow} key=${keyOf(item)} item=${item} selecting=${selecting} selected=${selected.includes(keyOf(item))} onSelect=${pick} onRemove=${remove} refreshing=${loading || data.staleResults} />`)}
        ${data.items.length < data.total && html`<${Button} size="sm" disabled=${loading} onClick=${more}>Show more<//>`}
        ${!data.total && html`<${Empty}>${data.refreshing ? "Discovering worktrees…" : filters.view === "ready" ? "No unused worktrees." : "No worktrees match."}<//>`}
      <//>
      <${Section} collapsible class="cleanup-disclosure cleanup-footer" title="Automatic cleanup"><${Facts} items=${[["Last scan", stamp(data.lastSuccessfulScan)], ["Terminal access", data.terminalAccess ? `${data.terminalAccess.state === "available" ? "Available" : "Unavailable"} · checked ${stamp(data.terminalAccess.checkedAt)}` : null], ["Last attempt", stamp(data.maintenance?.lastAttempt)], ["Last removal", stamp(data.maintenance?.lastSuccess)], ["Last error", data.maintenance?.error], ["Next retry", data.nextRetry ? clockTime(data.nextRetry) : "None scheduled"], ["State", data.maintenance?.state || "No attempt recorded"]]} /><//>
    `}
  <//>`;
}
