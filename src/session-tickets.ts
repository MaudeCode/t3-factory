// Session tickets: tickets that T3 sessions report creating, collected into one durable list the operator can
// start or dismiss from. Collection reads every top-level session's conversation through the public T3 history
// contract, confirms each reported ticket against the tracker, and keeps its progress in the Store so a restart
// resumes where it stopped. It never changes a ticket, starts work, or alters automatic scheduling.
import { z } from 'zod';
import { T3, Kaneo, taskSchema, listTaskLabels, type Session } from './clients.ts';
import { Store, type Job, type SessionRef, type SessionThread, type SessionTicket } from './store.ts';
import { ticketDifficulty } from './policy.ts';
import { log, safeError } from './scheduler.ts';
import type { Config } from './config.ts';

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'no-priority'];
const CATALOG_MS = 10 * 60_000; // tracker projects and columns rarely change
const REFRESH_MS = 5 * 60_000; // a listed ticket's status, priority, title and labels are re-read at most this often
const CLOCK_SKEW_MS = 5 * 60_000; // T3 and the tracker keep separate clocks
const RETRY_MS = 5 * 60_000; // failed tracker lookups wait this long per attempt, up to an hour

interface CatalogProject { id: string; name: string; slug: string; ready: string[]; final: string[] }
interface Catalog { at: number; projects: Record<string, CatalogProject> }
export interface Budget { reads?: number; lookups?: number; refreshes?: number }

// Creation reports: a block of an assistant message with a clause that says it created, filed or opened something,
// naming tracker keys or task links. Quoted lines, tables and code are not reports. A negator counts only against
// the creation verb in its own clause, so "did not find one, so I created X" reports X and "did not create X" does not.
const CREATED = /\b(?:creat(?:ed|ing)|filed|filing|opened|opening)\b/i;
const NEGATED = /\b(?:not|no|never|without|didn't|did not|wasn't|was not|cannot|can't|could not|couldn't)\b[^.\n]{0,40}\b(?:creat|fil|open)/i;
const CLAUSE = /[,;:]|\s(?:so|but|and|then|yet)\s/i;
const KEY = /\b([A-Z][A-Z0-9]*-\d+)\b/g;
const LINK = /\/dashboard\/workspace\/([^/\s)]+)\/project\/[^/\s)]+\/task\/([\w-]+)/g;
const decoded = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
// Walk a block clause by clause. A clause with a creation verb sets the polarity (affirmed, or negated when a
// negator precedes the verb); a clause without one keeps the polarity before it. A new sentence starts neutral
// unless it continues a header ("Created two tickets:") or is a list item. Only clauses under an affirmed creation
// yield references.
function* affirmedClauses(block: string) {
  let polarity: 'yes' | 'no' | null = null, header = false;
  for (const sentence of block.split(/(?<=[.!?])\s+|\n+/)) {
    const marker = /^\s*(?:[-*+•]|\d+[.)])(?:\s|$)/.test(sentence);
    if (!header && !marker) polarity = null;
    // A header, or a bare list number the sentence split left on its own, carries its polarity into the next fragment.
    header = /:\s*$/.test(sentence) || /^\s*(?:[-*+•]|\d+[.)])\s*$/.test(sentence);
    for (const clause of sentence.split(CLAUSE)) {
      if (CREATED.test(clause) && !NEGATED.test(clause)) polarity = 'yes';
      else if (NEGATED.test(clause) || CREATED.test(clause)) polarity = 'no';
      if (polarity === 'yes') yield clause;
    }
  }
}
export function creationReports(text: string, workspaceId: string): Pick<SessionRef, 'kind' | 'value'>[] {
  const refs = new Map<string, Pick<SessionRef, 'kind' | 'value'>>();
  for (const block of text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').split(/\n\s*\n/)) {
    const body = [...affirmedClauses(block.split('\n').filter(line => !/^\s*(?:>|\|)/.test(line)).join('\n'))].join('\n');
    for (const [, workspace, taskId] of body.matchAll(LINK)) if (decoded(workspace) === workspaceId) refs.set(`task:${taskId}`, { kind: 'task', value: taskId });
    for (const [, key] of body.replace(LINK, ' ').matchAll(KEY)) refs.set(`key:${key}`, { kind: 'key', value: key });
  }
  return [...refs.values()];
}

// A Factory start counts once T3 has the thread; a dispatch that was only prepared, or whose outcome is unknown, does not.
export const launched = (job: Job) => job.state !== 'dispatching' || job.reason === 'T3 accepted dispatch';

// Projects and their columns, cached in the Store; configured projects keep their configured statuses.
async function catalog(c: Config, store: Store, kaneo: Kaneo, reread = false): Promise<Catalog> {
  const cached = JSON.parse(store.get('sessionCatalog') ?? 'null') as Catalog | null;
  if (cached && !reread && Date.now() - cached.at < CATALOG_MS) return cached;
  const projects = z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), archivedAt: z.string().nullish() }).passthrough()).parse(await kaneo.call('list_projects', { workspaceId: c.kaneo.workspaceId })).filter(p => !p.archivedAt);
  const column = z.object({ slug: z.string(), isFinal: z.boolean(), position: z.number() }).passthrough();
  const entries = await Promise.all(projects.map(async (p): Promise<CatalogProject> => {
    const configured = c.projects.find(x => x.kaneoId === p.id);
    if (configured) return { id: p.id, name: configured.name, slug: configured.key, ready: configured.readyStatuses, final: configured.doneStatuses };
    const columns = z.array(column).parse(await kaneo.call('list_project_columns', { projectId: p.id })).toSorted((a, b) => a.position - b.position);
    return { id: p.id, name: p.name, slug: p.slug, ready: [columns.find(x => !x.isFinal)?.slug ?? columns[0]?.slug].filter(Boolean), final: columns.filter(x => x.isFinal).map(x => x.slug) };
  }));
  const fresh: Catalog = { at: Date.now(), projects: Object.fromEntries(entries.map(e => [e.id, e])) };
  store.set('sessionCatalog', JSON.stringify(fresh));
  return fresh;
}

// Read one page of a session and record what it reports. Progress is written only with its candidates.
async function scanSession(t3: T3, store: Store, rec: SessionThread, session: Session, workspaceId: string) {
  const page = await t3.conversation(session.id, rec.backfill?.cursor);
  const unseen = page.items.filter(i => rec.lastOrdinal === undefined || i.ordinal > rec.lastOrdinal);
  for (const item of unseen) {
    if (item.type !== 'assistant_message' || !item.text) continue;
    for (const ref of creationReports(item.text, workspaceId)) {
      const messageId = item.messageId ?? item.id;
      if (!rec.pending.some(p => p.messageId === messageId && p.kind === ref.kind && p.value === ref.value)) rec.pending.push({ ...ref, messageId, at: item.updatedAt ?? item.startedAt, attempts: 0 });
    }
  }
  const reachedKnown = rec.lastOrdinal !== undefined && page.items.some(i => i.ordinal <= rec.lastOrdinal!);
  if (rec.backfill) {
    if (!page.more || !page.cursor || reachedKnown) { rec.lastOrdinal = rec.backfill.top; rec.updatedAt = rec.backfill.updatedAt; delete rec.backfill; }
    else rec.backfill.cursor = page.cursor;
  } else {
    const top = Math.max(rec.lastOrdinal ?? -1, ...page.items.map(i => i.ordinal));
    // The window did not reach what was already seen: walk the older pages until it does, or history ends.
    if (page.more && page.cursor && !reachedKnown) rec.backfill = { cursor: page.cursor, updatedAt: session.updatedAt, top };
    else { rec.lastOrdinal = top; rec.updatedAt = session.updatedAt; }
  }
  store.saveSessionThread(rec);
}

const trackerTask = taskSchema.extend({ workspaceId: z.string().optional() });
// The tracker's own record for a reference, or null when the reference cannot be a ticket in this workspace.
async function lookup(c: Config, kaneo: Kaneo, cat: Catalog, ref: SessionRef) {
  let found: unknown;
  if (ref.kind === 'task') found = await kaneo.call('get_task', { taskId: ref.value });
  else {
    const project = Object.values(cat.projects).find(p => p.slug === ref.value.split('-')[0]);
    if (!project) return null;
    found = await kaneo.call('get_task_by_ticket_id', { ticketId: ref.value, workspaceId: c.kaneo.workspaceId, projectId: project.id });
  }
  const task = trackerTask.parse(found);
  if (task.workspaceId !== undefined && task.workspaceId !== c.kaneo.workspaceId) return null;
  return cat.projects[task.projectId] ? task : null;
}

// One bounded batch: scan changed sessions, confirm pending references, refresh listed tickets, mark consumed
// ones. Returns true when work remains for another batch. Failures are recorded and never empty the list.
export async function collectSessionTickets(c: Config, store: Store, t3: T3, kaneo: Kaneo, budget: Budget = {}): Promise<boolean> {
  const limits = { reads: 8, lookups: 10, refreshes: 10, ...budget };
  const now = Date.now(), at = new Date(now).toISOString(), errors: string[] = [];
  let more = false;
  let labels: ReturnType<typeof listTaskLabels> | undefined;
  const labelsOf = async (taskId: string) => ((await (labels ??= listTaskLabels(kaneo))).get(taskId) ?? []).map(l => l.name);
  let listed: Set<string> | undefined;
  try {
    let reads = 0;
    const sessions = await t3.sessions();
    listed = new Set(sessions.map(s => s.id));
    for (const session of sessions) {
      const rec: SessionThread = { ...(store.sessionThread(session.id) ?? { id: session.id, pending: [] }), projectId: session.projectId, title: session.title, createdAt: session.createdAt };
      if (!rec.backfill && rec.updatedAt === session.updatedAt) continue;
      if (rec.retryAfter && Date.parse(rec.retryAfter) > now) continue;
      if (reads++ >= limits.reads) { more = true; break; }
      try { delete rec.retryAfter; delete rec.error; await scanSession(t3, store, rec, session, c.kaneo.workspaceId); }
      catch (error) {
        // Progress is untouched; the session waits before its next read so an outage cannot loop on the same sessions.
        rec.error = `Reading session ${session.title}: ${safeError(error)}`; rec.retryAfter = new Date(now + RETRY_MS).toISOString();
        store.saveSessionThread(rec); errors.push(rec.error);
      }
      if (store.sessionThread(session.id)?.backfill) more = true;
    }
  } catch (error) { errors.push(`Listing sessions: ${safeError(error)}`); }
  let cat: Catalog | undefined;
  const due = store.sessionThreads().filter(rec => rec.pending.some(ref => !ref.retryAfter || Date.parse(ref.retryAfter) <= now));
  if (due.length) {
    try { cat = await catalog(c, store, kaneo); } catch (error) { errors.push(`Reading tracker projects: ${safeError(error)}`); }
  }
  let lookups = 0, refreshedCatalog = false;
  for (const rec of cat ? due : []) {
    for (const ref of [...rec.pending]) {
      if (ref.retryAfter && Date.parse(ref.retryAfter) > now) continue;
      if (lookups++ >= limits.lookups) { more = true; break; }
      try {
        let task = await lookup(c, kaneo, cat!, ref);
        // A project created since the catalog was cached is read once, fresh, before its reference is discarded.
        if (!task && !refreshedCatalog) { refreshedCatalog = true; cat = await catalog(c, store, kaneo, true); task = await lookup(c, kaneo, cat, ref); }
        const created = task ? Date.parse(task.createdAt) : NaN;
        // Creation evidence: the ticket came into being during this session, no later than the report.
        if (task && created >= Date.parse(rec.createdAt) - CLOCK_SKEW_MS && created <= Date.parse(ref.at) + CLOCK_SKEW_MS) {
          const project = cat!.projects[task.projectId];
          const row: SessionTicket = store.sessionTicket(task.id) ?? { taskId: task.id, projectId: task.projectId, key: `${project.slug}-${task.number}`, number: task.number, title: task.title, priority: task.priority, status: task.status, labels: [], createdAt: task.createdAt, firstSeenAt: at, refreshedAt: at, sources: [] };
          Object.assign(row, { title: task.title, priority: task.priority, status: task.status, labels: await labelsOf(task.id), refreshedAt: at, refreshAfter: new Date(now + REFRESH_MS).toISOString(), refreshError: undefined });
          if (!row.sources.some(s => s.threadId === rec.id && s.messageId === ref.messageId)) row.sources.push({ threadId: rec.id, messageId: ref.messageId, projectId: rec.projectId, title: rec.title, at: ref.at });
          const first = !store.sessionTicket(task.id);
          store.saveSessionTicket(row);
          if (first) store.record('session.ticket', `${row.key} was created in session ${rec.title}`, { ticketKey: row.key, taskId: row.taskId, threadId: rec.id });
        }
        rec.pending.splice(rec.pending.indexOf(ref), 1);
      } catch (error) {
        // ponytail: the tracker client cannot tell "no such ticket" from an outage, so a bad reference retries hourly forever.
        ref.attempts++; ref.error = safeError(error); ref.retryAfter = new Date(now + Math.min(ref.attempts, 12) * RETRY_MS).toISOString();
        errors.push(`Confirming ${ref.value}: ${ref.error}`);
      }
      store.saveSessionThread(rec);
    }
  }
  // A failed read keeps the row's last honest reading and waits before trying again, so an outage cannot loop on the same rows.
  const dueAt = (r: SessionTicket) => r.refreshAfter ?? new Date(Date.parse(r.refreshedAt) + REFRESH_MS).toISOString();
  const stale = store.sessionTickets().filter(r => !r.dismissedAt && !r.consumed && Date.parse(dueAt(r)) <= now).toSorted((a, b) => dueAt(a).localeCompare(dueAt(b)));
  if (stale.length > limits.refreshes) more = true;
  for (const row of stale.slice(0, limits.refreshes)) {
    try {
      const task = trackerTask.parse(await kaneo.call('get_task', { taskId: row.taskId }));
      Object.assign(row, { title: task.title, priority: task.priority, status: task.status, labels: await labelsOf(task.id), refreshedAt: at, refreshAfter: new Date(now + REFRESH_MS).toISOString(), refreshError: undefined });
    } catch (error) { row.refreshError = safeError(error); row.refreshAfter = new Date(now + RETRY_MS).toISOString(); errors.push(`Refreshing ${row.key}: ${row.refreshError}`); }
    store.saveSessionTicket(row);
  }
  const jobs = store.jobs();
  for (const row of store.sessionTickets().filter(r => !r.consumed)) {
    const job = jobs.find(j => j.taskId === row.taskId && launched(j));
    if (job) { row.consumed = { jobId: job.id, at }; store.saveSessionTicket(row); }
  }
  if (errors.length) recordSessionTicketsFailure(store, errors.slice(0, 3).join('; '));
  else {
    store.set('sessionTickets:at', at);
    // A reference whose last lookup failed is still unresolved; the notice stays until a retry succeeds or the read is dropped.
    // A session T3 no longer lists is never read again, so its old read failure is not a current one.
    const lingering = store.sessionThreads().flatMap(rec => [...rec.pending.filter(ref => ref.error).map(ref => `Confirming ${ref.value}: ${ref.error}`), ...(rec.error && listed?.has(rec.id) ? [rec.error] : [])]);
    store.set('sessionTickets:error', lingering.length ? JSON.stringify({ at: JSON.parse(store.get('sessionTickets:error') || 'null')?.at ?? at, message: lingering.slice(0, 3).join('; ') }) : '');
  }
  return more;
}

// A failure the page must show: from a batch, or from the service when a batch could not start at all.
export function recordSessionTicketsFailure(store: Store, message: string) {
  store.set('sessionTickets:error', JSON.stringify({ at: new Date().toISOString(), message }));
  log('session-tickets-failed', { message });
}

// Remove an entry from the list, and keep it out. The ticket, its runs and automatic scheduling are untouched.
export function dismissSessionTicket(store: Store, taskId: string) {
  const row = store.sessionTicket(taskId);
  if (!row) throw new Error('That ticket is not on the session list');
  if (!row.dismissedAt) {
    row.dismissedAt = new Date().toISOString(); store.saveSessionTicket(row);
    store.record('session.dismissed', `${row.key} was removed from Session tickets`, { ticketKey: row.key, taskId });
  }
  return { ok: true, taskId };
}

// The list as the page shows it: actionable, not dismissed, not consumed by a confirmed Factory start, in priority order.
export function sessionTicketStatus(c: Config, store: Store) {
  const jobs = store.jobs(), cat = JSON.parse(store.get('sessionCatalog') ?? 'null') as Catalog | null;
  const rows = store.sessionTickets().filter(r => !r.dismissedAt && !r.consumed && !jobs.some(j => j.taskId === r.taskId && launched(j))).flatMap(r => {
    const project = c.projects.find(p => p.kaneoId === r.projectId), known = cat?.projects[r.projectId];
    const ready = project?.readyStatuses ?? known?.ready;
    if (ready && !ready.includes(r.status)) return [];
    let difficulty: ReturnType<typeof ticketDifficulty>;
    try { difficulty = ticketDifficulty(r.labels.map(name => ({ name }))); } catch { difficulty = undefined; }
    const name = project?.name ?? known?.name ?? r.projectId;
    return [{ taskId: r.taskId, projectId: r.projectId, project: name, key: r.key, number: r.number, title: r.title, priority: r.priority, status: r.status, labels: r.labels, difficulty, createdAt: r.createdAt, refreshedAt: r.refreshedAt, refreshError: r.refreshError ?? null,
      sources: r.sources.map(s => ({ threadId: s.threadId, messageId: s.messageId, title: s.title, at: s.at })),
      unavailable: !project ? 'Project not configured in Factory' : !project.enabled ? 'Project disabled in Factory settings' : null }];
  }).toSorted((a, b) => (PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)) || a.key.replace(/-\d+$/, '').localeCompare(b.key.replace(/-\d+$/, '')) || a.number - b.number);
  return { at: store.get('sessionTickets:at') || null, error: JSON.parse(store.get('sessionTickets:error') || 'null') as { at: string; message: string } | null, rows };
}
