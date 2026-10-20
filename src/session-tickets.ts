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

// Creation reports: a block of an assistant message that says it created, filed or opened something, naming
// tracker keys or task links. Quoted lines, tables, code and negated sentences are not reports.
const CREATED = /\b(?:creat(?:ed|ing)|filed|filing|opened|opening)\b/i;
const NEGATED = /\b(?:not|no|never|without|didn't|did not|wasn't|was not|cannot|can't|could not|couldn't)\b[^.\n]{0,40}\b(?:creat|fil|open)/i;
const KEY = /\b([A-Z][A-Z0-9]*-\d+)\b/g;
const LINK = /\/dashboard\/workspace\/([^/\s)]+)\/project\/[^/\s)]+\/task\/([\w-]+)/g;
const decoded = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
export function creationReports(text: string, workspaceId: string): Pick<SessionRef, 'kind' | 'value'>[] {
  const refs = new Map<string, Pick<SessionRef, 'kind' | 'value'>>();
  for (const block of text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').split(/\n\s*\n/)) {
    const body = block.split('\n').filter(line => !/^\s*(?:>|\|)/.test(line)).join('\n');
    if (!CREATED.test(body) || NEGATED.test(body)) continue;
    for (const [, workspace, taskId] of body.matchAll(LINK)) if (decoded(workspace) === workspaceId) refs.set(`task:${taskId}`, { kind: 'task', value: taskId });
    for (const [, key] of body.replace(LINK, ' ').matchAll(KEY)) refs.set(`key:${key}`, { kind: 'key', value: key });
  }
  return [...refs.values()];
}

// A Factory start counts once T3 has the thread; a dispatch that was only prepared, or whose outcome is unknown, does not.
export const launched = (job: Job) => job.state !== 'dispatching' || job.reason === 'T3 accepted dispatch';

// Projects and their columns, cached in the Store; configured projects keep their configured statuses.
async function catalog(c: Config, store: Store, kaneo: Kaneo): Promise<Catalog> {
  const cached = JSON.parse(store.get('sessionCatalog') ?? 'null') as Catalog | null;
  if (cached && Date.now() - cached.at < CATALOG_MS) return cached;
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
  try {
    let reads = 0;
    for (const session of await t3.sessions()) {
      const rec: SessionThread = { ...(store.sessionThread(session.id) ?? { id: session.id, pending: [] }), projectId: session.projectId, title: session.title, createdAt: session.createdAt };
      if (!rec.backfill && rec.updatedAt === session.updatedAt) continue;
      if (reads++ >= limits.reads) { more = true; break; }
      try { await scanSession(t3, store, rec, session, c.kaneo.workspaceId); }
      catch (error) { errors.push(`Reading session ${session.title}: ${safeError(error)}`); }
      if (store.sessionThread(session.id)?.backfill) more = true;
    }
  } catch (error) { errors.push(`Listing sessions: ${safeError(error)}`); }
  let cat: Catalog | undefined;
  const due = store.sessionThreads().filter(rec => rec.pending.some(ref => !ref.retryAfter || Date.parse(ref.retryAfter) <= now));
  if (due.length) {
    try { cat = await catalog(c, store, kaneo); } catch (error) { errors.push(`Reading tracker projects: ${safeError(error)}`); }
  }
  let lookups = 0;
  for (const rec of cat ? due : []) {
    for (const ref of [...rec.pending]) {
      if (ref.retryAfter && Date.parse(ref.retryAfter) > now) continue;
      if (lookups++ >= limits.lookups) { more = true; break; }
      try {
        const task = await lookup(c, kaneo, cat!, ref);
        const created = task ? Date.parse(task.createdAt) : NaN;
        // Creation evidence: the ticket came into being during this session, no later than the report.
        if (task && created >= Date.parse(rec.createdAt) - CLOCK_SKEW_MS && created <= Date.parse(ref.at) + CLOCK_SKEW_MS) {
          const project = cat!.projects[task.projectId];
          const row: SessionTicket = store.sessionTicket(task.id) ?? { taskId: task.id, projectId: task.projectId, key: `${project.slug}-${task.number}`, number: task.number, title: task.title, priority: task.priority, status: task.status, labels: [], createdAt: task.createdAt, firstSeenAt: at, refreshedAt: at, sources: [] };
          Object.assign(row, { title: task.title, priority: task.priority, status: task.status, labels: await labelsOf(task.id), refreshedAt: at, refreshError: undefined });
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
  const stale = store.sessionTickets().filter(r => !r.dismissedAt && !r.consumed && now - Date.parse(r.refreshedAt) >= REFRESH_MS).toSorted((a, b) => a.refreshedAt.localeCompare(b.refreshedAt));
  if (stale.length > limits.refreshes) more = true;
  for (const row of stale.slice(0, limits.refreshes)) {
    try {
      const task = trackerTask.parse(await kaneo.call('get_task', { taskId: row.taskId }));
      Object.assign(row, { title: task.title, priority: task.priority, status: task.status, labels: await labelsOf(task.id), refreshedAt: at, refreshError: undefined });
    } catch (error) { row.refreshError = safeError(error); errors.push(`Refreshing ${row.key}: ${row.refreshError}`); }
    store.saveSessionTicket(row);
  }
  const jobs = store.jobs();
  for (const row of store.sessionTickets().filter(r => !r.consumed)) {
    const job = jobs.find(j => j.taskId === row.taskId && launched(j));
    if (job) { row.consumed = { jobId: job.id, at }; store.saveSessionTicket(row); }
  }
  if (errors.length) { store.set('sessionTickets:error', JSON.stringify({ at, message: errors.slice(0, 3).join('; ') })); log('session-tickets-failed', { message: errors.slice(0, 3).join('; ') }); }
  else { store.set('sessionTickets:error', ''); store.set('sessionTickets:at', at); }
  return more;
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
