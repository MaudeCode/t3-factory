import type { DatabaseSync } from 'node:sqlite';
import { Store, type Job, type SessionTicket, type SessionThread } from './store.ts';
import { taskSchema, type Task } from './clients.ts';
import { refreshTicket } from './session-tickets.ts';

// Import only identities explicitly recorded by Kanvil's importer. Ticket numbers can change.
export function importedTickets(tickets: Task[]) {
  const ids = new Map<string, Task>();
  for (const ticket of tickets) {
    const matches = [...(ticket.description ?? '').matchAll(/\n---\nKaneo source: ([A-Z0-9]+-\d+)\nSource task ID: ([^\n]+)\nSource created: ([^\n]+)/g)];
    if (!matches.length) continue;
    if (matches.length !== 1 || ids.has(matches[0]![2]!)) throw new Error('Ambiguous Kaneo import identity');
    ids.set(matches[0]![2]!, taskSchema.parse(ticket));
  }
  return ids;
}

export function migrateKaneoState(source: DatabaseSync, target: Store, tickets: Task[], projects: Record<string, string>) {
  const identities = importedTickets(tickets);
  const read = <T>(table: 'jobs' | 'session_tickets' | 'session_threads'): T[] => source.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(r => JSON.parse(r.data as string));
  const jobs = read<Job>('jobs'), rows = read<SessionTicket>('session_tickets'), threads = read<SessionThread>('session_threads');
  if (jobs.some(j => ['dispatching', 'running'].includes(j.state))) throw new Error('Finish active legacy runs before migration');
  const missing = rows.filter(row => !identities.has(row.taskId));
  if (missing.length) throw new Error(`Missing verified Kanvil identities for ${missing.length} session tickets`);
  if (rows.some(row => !identities.get(row.taskId)!.description?.includes(`\nKaneo source: ${row.key}\nSource task ID: ${row.taskId}\n`))) throw new Error('Imported source key does not match the legacy ledger');
  if (threads.some(t => t.pending.length || t.backfill || t.error)) throw new Error('Legacy session collection must be settled before migration');
  const marker = 'migration:kaneo-state';
  const prior = target.get(marker);
  if (prior) return { ...JSON.parse(prior), alreadyMigrated: true } as { jobs: number; sessionTickets: number; sessionThreads: number; events: number; alreadyMigrated: boolean };
  const now = Date.now(), at = new Date(now).toISOString();
  const events = source.prepare('SELECT * FROM events ORDER BY id').all();
  const result = { jobs: jobs.length, sessionTickets: rows.length, sessionThreads: threads.length, events: events.length, alreadyMigrated: false };
  target.db.exec('BEGIN IMMEDIATE');
  try {
    for (const job of jobs) {
      const ticket = job.taskId ? identities.get(job.taskId) : undefined;
      target.archiveJob({ ...job, projectId: ticket?.projectId ?? projects[job.projectId] ?? job.projectId,
        taskId: ticket?.id ?? null, sourceIdentity: { backend: 'kaneo', projectId: job.projectId, taskId: job.taskId, ticketKey: job.ticketKey } });
    }
    for (const original of rows) {
      const ticket = identities.get(original.taskId)!;
      const current = target.sessionTicket(ticket.id);
      const row: SessionTicket = { ...original, ...current, taskId: ticket.id, createdAt: original.createdAt,
        firstSeenAt: original.firstSeenAt, sources: [...original.sources, ...(current?.sources ?? []).filter(s => !original.sources.some(old => old.threadId === s.threadId && old.messageId === s.messageId))],
        dismissedAt: current?.dismissedAt ?? original.dismissedAt, consumed: current?.consumed ?? original.consumed };
      refreshTicket(row, ticket, { slug: ticket.key!.replace(/-\d+$/, '') }, { at, now, changed: false });
      row.refreshAfter = new Date(0).toISOString(); // The new service must reconcile snapshots across the cutover gap.
      target.saveSessionTicket(row);
    }
    for (const thread of threads) {
      const current = target.sessionThread(thread.id);
      // A completed current scan may include new post-cutover messages. Keep its greater progress.
      if (!current || (current.lastOrdinal ?? -1) < (thread.lastOrdinal ?? -1)) target.saveSessionThread(thread);
    }
    const insert = target.db.prepare('INSERT INTO events(id,time,kind,job_id,text,data) VALUES(?,?,?,?,?,?)');
    const lastLegacyId = Number(events.at(-1)?.id ?? 0);
    // Negative IDs retain legacy order below the destination's new events without collisions.
    for (const event of events) insert.run(Number(event.id) - lastLegacyId - 1, event.time as string, event.kind as string, event.job_id as string | null, event.text as string, event.data as string);
    target.set(marker, JSON.stringify(result));
    target.db.exec('COMMIT');
    return result;
  } catch (error) { target.db.exec('ROLLBACK'); throw error; }
}
