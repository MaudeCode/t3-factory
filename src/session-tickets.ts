// Session tickets: tickets that T3 sessions report creating, collected into one durable list the operator can
// start or dismiss from. Collection reads every top-level session's conversation through the public T3 history
// contract, confirms each reported ticket against the tracker, and keeps its progress in the Store so a restart
// resumes where it stopped. It never changes a ticket, starts work, or alters automatic scheduling.
import { z } from 'zod';
import { backgroundCheckpoint, backgroundRead } from './read-context.ts';
import { T3, Kanvil, KanvilTaskNotFound, taskSchema, type Task, type Session } from './clients.ts';
import { Store, type Job, type SessionRef, type SessionSource, type SessionThread, type SessionTicket } from './store.ts';
import { ticketDifficulty } from './policy.ts';
import { log, safeError } from './scheduler.ts';
import type { Config } from './config.ts';
import { importedTickets, importedTicketSource } from './imported-tickets.ts';

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const CATALOG_MS = 10 * 60_000; // tracker projects and columns rarely change
const REFRESH_MS = 5 * 60_000; // a listed ticket's status, priority, title and labels are re-read at most this often
const CLOCK_SKEW_MS = 5 * 60_000; // T3 and the tracker keep separate clocks
const RETRY_MS = 5 * 60_000; // failed tracker lookups wait this long per attempt, up to an hour
export const REPORT_VERSION = 6;
const MAX_REPORT_KEYS = 200;

interface CatalogProject { id: string; name: string; slug: string; ready: string[]; final: string[] }
interface Catalog { at: number; projects: Record<string, CatalogProject> }
export interface Budget { reads?: number; lookups?: number; refreshes?: number }

// Apply the same priority to page reads and confirmations, including unfinished history walks.
const recentFirst = (a: Pick<SessionThread, 'updatedAt' | 'createdAt' | 'backfill'>, b: typeof a) =>
  (b.backfill?.updatedAt ?? b.updatedAt ?? b.createdAt).localeCompare(a.backfill?.updatedAt ?? a.updatedAt ?? a.createdAt);

// Creation reports: a block of an assistant message with a clause that says it created, filed or opened something,
// naming tracker keys or task links. Tables need an affirmative creation introduction. Quoted lines and code
// are not reports. A negator counts only against the creation verb in its own clause, so "did not find one,
// so I created X" reports X and "did not create X" does not.
const CREATED = /\b(?:creat(?:ed|ing)|filed|filing|opened|opening)\b/i;
const NEGATED = /\b(?:not|no|never|without|didn't|did not|wasn't|was not|cannot|can't|could not|couldn't)\b[^.\n]{0,40}\b(?:creat|fil|open)/i;
const FUTURE = /\b(?:will|planning to|going to|intend to|please)\b[^.\n]{0,40}\b(?:creat|fil|open)/i;
const CLAUSE = /[,;:]|\s(?:so|but|and|then|yet)\s/i;
const SENTENCE = /(?<=[.!?])\s+|\n+/;
const KEY = /\b([A-Z][A-Z0-9]*-\d+)\b/g;
const LINK = /\/projects\/([^/\s)]+)\/tickets\/([\w-]+)/g;
const LEGACY_LINK = /\/dashboard\/workspace\/[^/\s)]+\/project\/[^/\s)]+\/task\/([\w-]+)/g;
const reportBoundary = (line: string) => /^(?:existing|related|next|examples?|references|unfiled|not (?:created|filed|opened)|see also)\b/i.test(line.replace(/^\s*(?:(?:#{1,6}|[-*+•]|\d+[.)])\s+)?(?:\*\*|__)?/, ''));
// Explicit skill commands and the legacy release-review launch request, not titles or discussion of the skill.
const UPSTREAM_REVIEW_REQUEST = /^(?:[$/](?:skills[:/])?upstream-release-review\b|Review [^\n]+?\bfrom\b[^\n]+?\bto\b[^\n]+?\bwith\b[^\n]*\bupstream-release-review`?\s+skill(?=[.!?](?:\s|$)|\s*$))/i;
// Walk a block clause by clause. A clause with a creation verb sets the polarity (affirmed, or negated when a
// negator precedes the verb); a clause without one keeps the polarity before it. A new sentence starts neutral
// unless it continues a header ("Created two tickets:") or is a list item. Only clauses under an affirmed creation
// yield references.
function* affirmedClauses(block: string) {
  let polarity: 'yes' | 'no' | null = null, header = false;
  for (const sentence of block.split(SENTENCE)) {
    const marker = /^\s*(?:[-*+•]|\d+[.)])(?:\s|$)/.test(sentence);
    if (!header && !marker) polarity = null;
    // A header, or a bare list number the sentence split left on its own, carries its polarity into the next fragment.
    header = /:\s*$/.test(sentence) || /^\s*(?:[-*+•]|\d+[.)])\s*$/.test(sentence);
    for (const clause of sentence.split(CLAUSE)) {
      if (CREATED.test(clause) && !NEGATED.test(clause) && !FUTURE.test(clause)) polarity = 'yes';
      else if (NEGATED.test(clause) || CREATED.test(clause)) polarity = 'no';
      if (polarity === 'yes') yield clause;
    }
  }
}
// Expand only explicit ranges and line-ending numeric lists; never turn a large range into unbounded work.
function expandReportKeys(text: string) {
  return text.replace(/\b([A-Z][A-Z0-9]*)-(\d+)\s*(?:through|to|[–—])\s*(?:\1-)?(\d+)\b/g, (_, prefix, start, end) => {
    const first = Number(start), last = Number(end);
    return Number.isSafeInteger(last) && first > 0 && last >= first && last - first < MAX_REPORT_KEYS
      ? Array.from({ length: last - first + 1 }, (_, i) => `${prefix}-${first + i}`).join(', ') : '';
  }).replace(/\b([A-Z][A-Z0-9]*)-(\d+)((?:,\s*\d+)+)(?=\.?\s*$)/gm, (_, prefix, first, rest) => {
    const numbers = [first, ...rest.match(/\d+/g)].map(Number);
    return numbers.length <= MAX_REPORT_KEYS && numbers.every(n => Number.isSafeInteger(n) && n > 0) ? numbers.map(n => `${prefix}-${n}`).join(', ') : '';
  });
}

export function creationReports(text: string): Pick<SessionRef, 'kind' | 'value'>[] {
  const refs = new Map<string, Pick<SessionRef, 'kind' | 'value'>>();
  let section = false;
  const blocks = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    .replace(/^(#{1,6}\s+[^\n]+|\*\*[^\n]+\*\*|__[^\n]+__)\s*$/gm, '\n\n$1\n\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(line => !/^\s*>/.test(line));
    const plain = expandReportKeys(lines.filter(line => !/^\s*\|/.test(line)).join('\n')).trim();
    const table = lines.filter(line => /^\s*\|/.test(line)).map(line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim()));
    const ticketColumn = table[0]?.findIndex(cell => /^(?:tickets?|issues?|keys?)$/i.test(cell.replace(/\*|_/g, ''))) ?? -1;
    const creationTable = ticketColumn >= 0 && table.length >= 3 && table[1]!.length === table[0]!.length && table[1]!.every(cell => /^:?-{3,}:?$/.test(cell));
    const heading = /^(?:#{1,6}\s+[^\n]+|(?:\*\*|__)[^\n]+(?:\*\*|__))$/.test(plain);
    const list = /^\s*(?:[-*+•]|\d+[.)])\s/.test(plain);
    const stop = reportBoundary(plain);
    const clauses = [...affirmedClauses(plain)];
    // A compound verb ("Created and verified six tickets") splits the verb and its noun into separate affirmed clauses.
    const summary = plain.split(SENTENCE).some(sentence => {
      const affirmed = [...affirmedClauses(sentence)].join(' ');
      return /\b(?:created|filed|opened)\b/i.test(affirmed) && /\b(?:tickets?|issues?|these|following)\b/i.test(affirmed);
    });
    const inherited = section && list && !stop;
    section = !stop && (summary || (section && (heading || list || (!plain && creationTable))));
    const listBody = plain.split('\n').filter(line => !reportBoundary(line)).join('\n');
    const reported = inherited
      ? listBody.split(/(?=^\s*(?:[-*+•]|\d+[.)])\s)/m).flatMap(item => [...affirmedClauses(`Created tickets:\n${item}`)])
      : clauses;
    // Only the table's ticket column is creation evidence; descriptions can mention existing tickets.
    if (section && creationTable) for (const row of table.slice(2)) {
      const cell = row[ticketColumn]!;
      if (row.length === table[0]!.length && !reportBoundary(cell)) reported.push(...affirmedClauses(`Created tickets:\n- ${expandReportKeys(cell)}`));
    }
    // Batch summaries often state their exact number range in the next sentence of the same paragraph.
    if (summary) for (const range of plain.matchAll(/\bNumbers\s+(?:run|range(?: from)?)\s+([^.!?\n]+)/gi)) reported.push(range[1]!);
    const body = reported.join('\n');
    for (const [, , taskId] of body.matchAll(LINK)) refs.set(`task:${taskId}`, { kind: 'task', value: taskId });
    for (const [, taskId] of body.matchAll(LEGACY_LINK)) refs.set(`legacy-task:${taskId}`, { kind: 'legacy-task', value: taskId });
    // A legacy link's label is in the old key namespace; its stable source ID is the reference.
    const keyBody = body.replace(/\[[^\]\n]*\]\(([^)]*)\)/g, (link: string, url: string) => url.match(LEGACY_LINK) ? ' ' : link);
    for (const [, key] of keyBody.replace(LINK, ' ').replace(LEGACY_LINK, ' ').matchAll(KEY)) refs.set(`key:${key}`, { kind: 'key', value: key });
  }
  return [...refs.values()];
}

// Tool calls are the authoritative creation evidence: a completed Kanvil create or duplicate call, whatever the
// session later says about it. T3 omits tool output from history, so confirmation reads the full item.
const KANVIL_CREATION = /(?:^|\.|__)(?:create|duplicate)_ticket$/;
// A call still running when its page is scanned is never revisited by ordinal, so it waits in pending instead.
const UNFINISHED = new Set(['idle', 'pending', 'running', 'waiting']);
class ToolCallUnfinished extends Error {}
const toolCall = z.object({ status: z.string().nullish(), toolName: z.string().nullish(), toolSource: z.object({ key: z.string() }).passthrough().nullish() }).passthrough();
const kanvilCreation = (item: unknown) => {
  const call = toolCall.safeParse(item);
  return call.success && (call.data.status === 'completed' || UNFINISHED.has(call.data.status ?? '')) && call.data.toolSource?.key === 'mcp:kanvil' && KANVIL_CREATION.test(call.data.toolName ?? '');
};
async function toolTicketId(t3: T3, threadId: string, itemId: string) {
  const item = await t3.turnItem(threadId, itemId), status = toolCall.safeParse(item).data?.status ?? '';
  if (UNFINISHED.has(status)) throw new ToolCallUnfinished('Kanvil tool call has not finished');
  return status === 'completed' ? createdTicketId(item) : null;
}
// Codex returns the result object; Claude returns it as JSON text in `content`.
export function createdTicketId(item: unknown): string | null {
  let output = z.object({ output: z.unknown() }).passthrough().safeParse(item).data?.output;
  const text = z.object({ content: z.string() }).passthrough().safeParse(output);
  if (text.success) { try { output = JSON.parse(text.data.content); } catch { return null; } }
  return z.object({ result: z.object({ id: z.string() }).passthrough() }).passthrough().safeParse(output).data?.result.id ?? null;
}

// A Factory start counts once T3 has the thread; a dispatch that was only prepared, or whose outcome is unknown, does not.
export const launched = (job: Job) => job.state !== 'dispatching' || job.reason === 'T3 accepted dispatch';

// Job ownership and stored origin/title evidence cover current and legacy Factory sessions.
function sessionSourceFilter(jobs: Pick<Job, 'kind' | 'threadId'>[], sessions: SessionThread[]) {
  const discovery = (title: string) => /^Factory discovery:/i.test(title);
  const excluded = new Set([...jobs.filter(job => job.kind === 'upstream' || job.kind === 'discovery').map(job => job.threadId), ...sessions.filter(session => session.upstreamReview || discovery(session.title)).map(session => session.id)]);
  return (threadId: string, title = '') => !excluded.has(threadId) && !discovery(title);
}

// Projects and their columns, cached in the Store; configured projects keep their configured statuses.
async function catalog(c: Config, store: Store, kanvil: Kanvil, reread = false): Promise<Catalog> {
  const cached = JSON.parse(store.get('sessionCatalog') ?? 'null') as Catalog | null;
  if (cached && !reread && Date.now() - cached.at < CATALOG_MS) return cached;
  const projects = await backgroundRead(() => kanvil.projects());
  const column = z.object({ slug: z.string(), isFinal: z.boolean(), position: z.number() }).passthrough();
  const entries: CatalogProject[] = [];
  for (const p of projects) {
    await backgroundCheckpoint();
    const configured = c.projects.find(x => x.kanvilId === p.id);
    if (configured) { entries.push({ id: p.id, name: configured.name, slug: configured.key, ready: configured.readyStatuses, final: configured.doneStatuses }); continue; }
    const columns = z.array(column).parse(await backgroundRead(() => kanvil.columns(p.id))).toSorted((a, b) => a.position - b.position);
    entries.push({ id: p.id, name: p.name, slug: p.slug, ready: ['todo'], final: columns.filter(x => x.isFinal).map(x => x.slug) });
  }
  const fresh: Catalog = { at: Date.now(), projects: Object.fromEntries(entries.map(e => [e.id, e])) };
  store.set('sessionCatalog', JSON.stringify(fresh));
  return fresh;
}

// Read one page of a session and record what it reports. Progress is written only with its candidates.
async function scanSession(t3: T3, store: Store, rec: SessionThread, session: Session) {
  const page = await backgroundRead(() => t3.conversation(session.id, rec.backfill?.cursor));
  if (page.items.some(item => item.type === 'user_message' && item.text && UPSTREAM_REVIEW_REQUEST.test(item.text.trim()))) {
    rec.upstreamReview = true; rec.updatedAt = session.updatedAt; delete rec.backfill;
    store.saveSessionThread(rec);
    return;
  }
  if (rec.upstreamReview === undefined && page.more && !page.cursor) throw new Error('T3 session history has no cursor for origin classification');
  if (!page.more) rec.upstreamReview = false;
  const unseen = page.items.filter(i => rec.lastOrdinal === undefined || i.ordinal > rec.lastOrdinal);
  for (const item of unseen) {
    const refs: Pick<SessionRef, 'kind' | 'value'>[] = item.type === 'dynamic_tool' ? (kanvilCreation(item) ? [{ kind: 'tool', value: item.id }] : [])
      : item.type === 'assistant_message' && item.text ? creationReports(item.text) : [];
    for (const ref of refs) {
      const messageId = item.messageId ?? item.id;
      if (!rec.pending.some(p => p.messageId === messageId && p.kind === ref.kind && p.value === ref.value)) rec.pending.push({ ...ref, messageId, at: item.updatedAt ?? item.startedAt, attempts: 0 });
    }
  }
  const reachedKnown = rec.upstreamReview !== undefined && rec.lastOrdinal !== undefined && page.items.some(i => i.ordinal <= rec.lastOrdinal!);
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
// Confirmation and refresh distinguish native absence from a failed tracker read in the same place.
async function readTicket(kanvil: Kanvil, id: string, cached = false) {
  try {
    return trackerTask.parse(await kanvil.task(id, undefined, cached));
  } catch (error) {
    if (error instanceof KanvilTaskNotFound) return null;
    throw error;
  }
}
// The tracker's own record for a reference, or null when the reference cannot be a ticket in this workspace.
async function lookup(c: Config, t3: T3, kanvil: Kanvil, cat: Catalog, threadId: string, ref: SessionRef, imports: (cat: Catalog) => Promise<Map<string, Task>>) {
  const created = ref.kind === 'tool' ? await toolTicketId(t3, threadId, ref.value) : ref.value;
  let task: z.infer<typeof trackerTask> | null = ref.kind === 'legacy-task'
    ? (await imports(cat)).get(ref.value) ?? null : created ? await readTicket(kanvil, created) : null;
  // Old keys may now name another ticket. Search explicit source keys before applying creation-time evidence.
  if (ref.kind === 'key' && (!task || Date.parse(task.createdAt) > Date.parse(ref.at) + CLOCK_SKEW_MS)) {
    const matches = [...(await imports(cat)).values()].filter(ticket => importedTicketSource(ticket)?.key === ref.value);
    if (matches.length > 1) throw new Error('Ambiguous Kaneo source key');
    task = matches[0] ?? task;
  }
  if (!task || (task.workspaceId !== undefined && task.workspaceId !== c.kanvil.workspaceId) || !cat.projects[task.projectId]) return null;
  const source = importedTicketSource(task);
  return source ? { ...task, createdAt: source.createdAt } : task;
}

// Both confirmation and refresh publish native identity and preserve any concurrent event invalidation.
export function refreshTicket(row: SessionTicket, task: Task, project: Pick<CatalogProject, 'slug'>, reading: { at: string; now: number; changed: boolean }) {
  Object.assign(row, { projectId: task.projectId, key: task.key ?? `${project.slug}-${task.number}`, number: task.number,
    difficulty: task.difficulty, automationReady: task.automationReady, holdReason: task.holdReason,
    title: task.title, priority: task.priority, status: task.status, archived: task.archived, labels: (task.labels ?? []).map(l => l.name),
    refreshedAt: reading.at, refreshAfter: new Date(reading.changed ? 0 : reading.now + REFRESH_MS).toISOString(), refreshError: undefined, missing: undefined });
}

// One bounded batch: scan changed sessions, confirm pending references, refresh listed tickets, mark consumed
// ones. Returns true when work remains for another batch. Failures are recorded and never empty the list.
export async function collectSessionTickets(c: Config, store: Store, t3: T3, kanvil: Kanvil, budget: Budget = {}): Promise<boolean> {
  const limits = { reads: 8, lookups: 10, refreshes: 10, ...budget };
  const now = Date.now(), at = new Date(now).toISOString(), errors: string[] = [];
  let includeSource = sessionSourceFilter(store.history(), store.sessionThreads());
  let more = false;
  let listed: Set<string> | undefined;
  try {
    let reads = 0;
    const sessions = (await backgroundRead(() => t3.sessions())).filter(session => includeSource(session.id, session.title)).toSorted(recentFirst);
    listed = new Set(sessions.map(s => s.id));
    for (const session of sessions) {
      await backgroundCheckpoint();
      const rec: SessionThread = { ...(store.sessionThread(session.id) ?? { id: session.id, pending: [] }), projectId: session.projectId, title: session.title, createdAt: session.createdAt };
      const replay = rec.reportVersion !== REPORT_VERSION;
      if (!replay && rec.upstreamReview !== undefined && !rec.backfill && rec.updatedAt === session.updatedAt) continue;
      if (rec.retryAfter && Date.parse(rec.retryAfter) > now) continue;
      if (reads++ >= limits.reads) { more = true; break; }
      if (replay) {
        // Reuse bounded backfill for old reports; references, provenance and tombstones remain intact.
        delete rec.updatedAt; delete rec.lastOrdinal; delete rec.backfill;
        rec.reportVersion = REPORT_VERSION;
      }
      try { delete rec.retryAfter; delete rec.error; await scanSession(t3, store, rec, session); }
      catch (error) {
        // Progress is untouched; the session waits before its next read so an outage cannot loop on the same sessions.
        rec.error = `Reading session ${session.title}: ${safeError(error)}`; rec.retryAfter = new Date(now + RETRY_MS).toISOString();
        store.saveSessionThread(rec); errors.push(rec.error);
      }
      if (store.sessionThread(session.id)?.backfill) more = true;
    }
  } catch (error) { errors.push(`Listing sessions: ${safeError(error)}`); }
  includeSource = sessionSourceFilter(store.history(), store.sessionThreads());
  let cat: Catalog | undefined;
  let imported: { catalog: Catalog; revision: number; records: Promise<Map<string, Task>> } | undefined;
  const imports = (catalog: Catalog) => {
    if (!imported || imported.catalog !== catalog || imported.revision !== kanvil.revision) {
      const records = async () => {
        const tickets: Task[] = [];
        for (const project of Object.values(catalog.projects)) {
          await backgroundCheckpoint();
          tickets.push(...await backgroundRead(() => kanvil.tasks(project.id, undefined, true)));
        }
        return importedTickets(tickets);
      };
      const entry = { catalog, revision: kanvil.revision, records: records() };
      imported = entry;
      entry.records = entry.records.catch(error => {
        if (imported === entry) imported = undefined;
        throw error;
      });
    }
    return imported.records;
  };
  const due = store.sessionThreads().filter(rec => includeSource(rec.id) && rec.upstreamReview === false && rec.pending.some(ref => !ref.retryAfter || Date.parse(ref.retryAfter) <= now)).toSorted(recentFirst);
  if (due.length) {
    try { cat = await catalog(c, store, kanvil); } catch (error) { errors.push(`Reading tracker projects: ${safeError(error)}`); }
  }
  let lookups = 0, refreshedCatalog = false;
  for (const rec of cat ? due : []) {
    for (const ref of [...rec.pending]) {
      await backgroundCheckpoint();
      if (ref.retryAfter && Date.parse(ref.retryAfter) > now) continue;
      if (lookups++ >= limits.lookups) { more = true; break; }
      try {
        const revision = kanvil.revision;
        let task = await backgroundRead(() => lookup(c, t3, kanvil, cat!, rec.id, ref, imports));
        // A project created since the catalog was cached is read once, fresh, before its reference is discarded.
        if (!task && !refreshedCatalog) { refreshedCatalog = true; cat = await catalog(c, store, kanvil, true); task = await lookup(c, t3, kanvil, cat, rec.id, ref, imports); }
        const created = task ? Date.parse(task.createdAt) : NaN;
        // Creation evidence: the ticket came into being during this session, no later than the report.
        if (task && created >= Date.parse(rec.createdAt) - CLOCK_SKEW_MS && created <= Date.parse(ref.at) + CLOCK_SKEW_MS) {
          const project = cat!.projects[task.projectId];
          const row: SessionTicket = store.sessionTicket(task.id) ?? { taskId: task.id, projectId: task.projectId, key: `${project.slug}-${task.number}`, number: task.number, title: task.title, priority: task.priority, status: task.status, labels: [], createdAt: task.createdAt, firstSeenAt: at, refreshedAt: at, sources: [] };
          const changed = revision !== kanvil.revision;
          refreshTicket(row, task, project, { at, now, changed });
          if (changed) more = true;
          if (!row.sources.some(s => s.threadId === rec.id && s.messageId === ref.messageId)) row.sources.push({ threadId: rec.id, messageId: ref.messageId, projectId: rec.projectId, title: rec.title, at: ref.at });
          const first = !store.sessionTicket(task.id);
          store.saveSessionTicket(row);
          if (first) store.record('session.ticket', `${row.key} was created in session ${rec.title}`, { ticketKey: row.key, taskId: row.taskId, threadId: rec.id });
        }
        rec.pending.splice(rec.pending.indexOf(ref), 1);
      } catch (error) {
        // An unfinished call is not a failure; it is read again after the usual wait.
        if (error instanceof ToolCallUnfinished) { ref.retryAfter = new Date(now + RETRY_MS).toISOString(); store.saveSessionThread(rec); continue; }
        ref.attempts++; ref.error = safeError(error); ref.retryAfter = new Date(now + Math.min(ref.attempts, 12) * RETRY_MS).toISOString();
        errors.push(`Confirming ${ref.value}: ${ref.error}`);
      }
      store.saveSessionThread(rec);
    }
  }
  // A failed read keeps the row's last honest reading and waits before trying again, so an outage cannot loop on the same rows.
  const dueAt = (r: SessionTicket) => r.refreshAfter ?? new Date(Date.parse(r.refreshedAt) + REFRESH_MS).toISOString();
  const retained = () => store.sessionTickets().filter(r => !r.dismissedAt && !r.consumed && r.sources.some(s => includeSource(s.threadId, s.title)));
  if (kanvil.realtime) for (const projectId of new Set(retained().map(r => r.projectId))) {
    await backgroundCheckpoint();
    try { await backgroundRead(() => kanvil.ensureProjectStream(projectId)); }
    catch (error) { errors.push(`Watching session tickets: ${safeError(error)}`); }
  }
  const stale = retained().filter(r => (!kanvil.realtime || r.missing || r.refreshError || Date.parse(r.refreshAfter ?? '') === 0) && Date.parse(dueAt(r)) <= now).toSorted((a, b) => dueAt(a).localeCompare(dueAt(b)));
  if (kanvil.realtime) for (const projectId of new Set(stale.slice(0, limits.refreshes).map(r => r.projectId))) {
    try { await backgroundRead(() => kanvil.tasks(projectId)); }
    catch (error) { errors.push(`Reading session snapshot: ${safeError(error)}`); }
  }
  if (stale.length > limits.refreshes) more = true;
  for (const cached of stale.slice(0, limits.refreshes)) {
    await backgroundCheckpoint();
    let row = store.sessionTicket(cached.taskId)!;
    if (row.dismissedAt || row.consumed) continue;
    try {
      const revision = kanvil.revision;
      const task = await backgroundRead(() => readTicket(kanvil, cached.taskId, true));
      row = store.sessionTicket(cached.taskId)!;
      if (row.dismissedAt || row.consumed) continue;
      if (!task) {
        row.missing = true; delete row.refreshError;
        row.refreshAfter = new Date(revision !== kanvil.revision ? 0 : now + RETRY_MS).toISOString();
        if (revision !== kanvil.revision) more = true;
        store.saveSessionTicket(row);
        continue;
      }
      cat ??= await catalog(c, store, kanvil);
      if (!cat.projects[task.projectId] && !refreshedCatalog) { refreshedCatalog = true; cat = await catalog(c, store, kanvil, true); }
      const project = cat.projects[task.projectId];
      if (!project || (task.workspaceId !== undefined && task.workspaceId !== c.kanvil.workspaceId)) throw new Error('Ticket moved outside the configured Kanvil workspace');
      row = store.sessionTicket(cached.taskId)!;
      if (row.dismissedAt || row.consumed) continue;
      refreshTicket(row, task, project, { at, now, changed: revision !== kanvil.revision });
      if (revision !== kanvil.revision) more = true;
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
    const lingering = [
      ...store.sessionThreads().filter(rec => includeSource(rec.id)).flatMap(rec => [...rec.pending.filter(ref => ref.error).map(ref => `Confirming ${ref.value}: ${ref.error}`), ...(rec.error && listed?.has(rec.id) ? [rec.error] : [])]),
      ...retained().filter(row => row.refreshError).map(row => `Refreshing ${row.key}: ${row.refreshError}`),
    ];
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
  const includeSource = sessionSourceFilter(store.history(), store.sessionThreads());
  const rows = store.sessionTickets().filter(r => !r.archived && !r.missing && !r.dismissedAt && !r.consumed && !jobs.some(j => j.taskId === r.taskId && launched(j))).flatMap(r => {
    const bySession = new Map<string, SessionSource>();
    for (const source of r.sources) {
      if (!includeSource(source.threadId, source.title)) continue;
      const previous = bySession.get(source.threadId);
      if (!previous || source.at > previous.at) bySession.set(source.threadId, source);
    }
    const sources = [...bySession.values()];
    if (!sources.length) return [];
    const project = c.projects.find(p => p.kanvilId === r.projectId), known = cat?.projects[r.projectId];
    const ready = project?.readyStatuses ?? known?.ready;
    if (ready && !ready.includes(r.status)) return [];
    let difficulty: ReturnType<typeof ticketDifficulty>;
    try { difficulty = 'difficulty' in r ? r.difficulty ?? undefined : ticketDifficulty(r.labels.map(name => ({ name }))); } catch { difficulty = undefined; }
    const name = project?.name ?? known?.name ?? r.projectId;
    return [{ taskId: r.taskId, projectId: r.projectId, project: name, key: r.key, number: r.number, title: r.title, priority: r.priority, status: r.status, labels: r.labels, difficulty, automationReady: r.automationReady, createdAt: r.createdAt, refreshedAt: r.refreshedAt, refreshError: r.refreshError ?? null,
      sources: sources.map(s => ({ threadId: s.threadId, messageId: s.messageId, title: s.title, at: s.at })),
      unavailable: !project ? 'Project not configured in Factory' : !project.enabled ? 'Project disabled in Factory settings' : null }];
  }).toSorted((a, b) => (PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)) || a.key.replace(/-\d+$/, '').localeCompare(b.key.replace(/-\d+$/, '')) || a.number - b.number);
  return { at: store.get('sessionTickets:at') || null, error: JSON.parse(store.get('sessionTickets:error') || 'null') as { at: string; message: string } | null, rows };
}
