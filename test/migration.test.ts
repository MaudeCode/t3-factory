import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Job, type SessionTicket } from '../src/store.ts';
import { Kanvil, type T3, type Task } from '../src/clients.ts';
import type { Config } from '../src/config.ts';
import { collectSessionTickets, sessionTicketStatus } from '../src/session-tickets.ts';

test('historical runs remain readable without entering live ownership or cleanup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-migration-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const job = { id: 'old-run', kind: 'ticket', projectId: 'old-project', taskId: 'old-ticket', ticketKey: 'FIX-8', threadId: 'thread', messageId: 'message', createdAt: '2026-01-01T00:00:00Z', state: 'waiting', reason: 'Held work', lastPersonalActivity: null, reportPath: join(dir, 'report.json'), command: { untouched: true }, prUrls: [], completedAt: null } as Job;
  // Exercise the store boundary that the real history/report endpoints use.
  store.archiveJob(job);
  assert.equal(store.jobs().length, 0, 'imported history must never become a scheduler or cleanup claim');
  assert.equal(store.history().length, 1, 'the Runs endpoint must include the old run');
  assert.equal(store.job(job.id)?.historyOnly, true);
  assert.deepEqual(store.job(job.id)?.command, job.command);
  assert.throws(() => store.save(store.job(job.id)!), /historical/i, 'an archived run cannot be stopped or rewritten as live ownership');
  store.archiveJob(job);
  assert.equal(store.history().length, 1, 'repeated import is idempotent');
});

test('restored session projections refresh through one SSE snapshot instead of a credential-exhausting lookup burst', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-migration-snapshot-')), store = new Store(dir);
  const project = { id: 'project', workspaceId: 'workspace', key: 'FIX', name: 'Fixture' };
  const tickets = Array.from({ length: 410 }, (_, n) => ({ id: `ticket-${n}`, projectId: project.id, key: `FIX-${n + 1}`, number: n + 1,
    title: `Current ${n}`, priority: 'high', status: 'todo', labels: ['sf'], difficulty: 'med' as const, automationReady: true, holdReason: null,
    archived: false, parentId: null, createdAt: '2026-01-01T00:00:00Z', acceptanceCriteria: 'Verified', version: 1 }));
  for (const ticket of tickets) store.saveSessionTicket({ ...ticket, taskId: ticket.id, title: 'Old snapshot', labels: ['sf'], firstSeenAt: ticket.createdAt, refreshedAt: ticket.createdAt, refreshAfter: new Date(0).toISOString(), sources: [{ threadId: 'thread', messageId: 'message', projectId: 't3', title: 'Session', at: ticket.createdAt }] });
  let reads = 0, snapshots = 0, ticketReads = 0;
  const previous = process.env.KANVIL_API_KEY; process.env.KANVIL_API_KEY = 'fixture-key';
  t.after(() => { if (previous === undefined) delete process.env.KANVIL_API_KEY; else process.env.KANVIL_API_KEY = previous; store.close(); rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input)); reads++;
    if (reads > 20) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    if (url.pathname.endsWith('/checkpoint')) return Response.json({ cursor: '5' });
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: checkpoint\nid: 5\ndata: {"cursor":"5"}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname.endsWith('/snapshot')) { snapshots++; return Response.json({ project, tickets, cursor: '5' }); }
    if (url.pathname.endsWith('/projects')) return Response.json([project]);
    if (url.pathname.endsWith('/workflow')) return Response.json([{ category: 'todo', name: 'To do', position: 0 }]);
    ticketReads++; return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
  });
  const client = new Kanvil({ url: 'https://tracker.example.test', workspaceId: 'workspace', readyLabel: 'sf' });
  const ready = Promise.withResolvers<void>();
  const stream = client.subscribe(() => ready.resolve(), new AbortController().signal);
  try {
    await ready.promise;
    const config = { kanvil: client.config, projects: [{ kanvilId: project.id, name: project.name, enabled: true, readyStatuses: ['todo'] }] } as Config;
    await collectSessionTickets(config, store, { sessions: async () => [] } as unknown as T3, client, { refreshes: 410 });
    const status = sessionTicketStatus(config, store);
    assert.equal(status.error, null, 'bulk restoration must not reproduce HTTP 401 collection failures');
    assert.equal(status.rows.length, 410);
    assert.ok(store.sessionTickets().every(row => row.title.startsWith('Current ')), 'all restored metadata is reconciled across the cutover gap');
    assert.equal(snapshots, 1);
    assert.equal(ticketReads, 0, 'fresh project snapshots supply every row without individual REST lookups');
  } finally { await client.close(); await stream; }
});

test('state migration preserves session evidence and tombstones while replacing native identities', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-migration-'));
  const source = new Store(join(dir, 'source')), target = new Store(join(dir, 'target'));
  t.after(() => { source.close(); target.close(); rmSync(dir, { recursive: true, force: true }); });
  const row: SessionTicket = { taskId: 'old-ticket', projectId: 'old-project', key: 'FIX-8', number: 8, title: 'Original', priority: 'high', status: 'to-do', labels: ['sf'], createdAt: '2026-01-01T01:00:00Z', firstSeenAt: '2026-01-01T02:00:00Z', refreshedAt: '2026-01-01T02:00:00Z', dismissedAt: '2026-01-02T00:00:00Z', sources: [{ threadId: 'thread', messageId: 'message', projectId: 't3-project', title: 'Source', at: '2026-01-01T02:00:00Z' }] };
  source.saveSessionTicket(row);
  source.record('legacy-event', 'Original journal');
  target.record('current-event', 'New journal');
  source.saveSessionThread({ id: 'thread', projectId: 't3-project', title: 'Source', createdAt: row.createdAt, updatedAt: row.refreshedAt, lastOrdinal: 90, reportVersion: 2, upstreamReview: false, pending: [] });
  const { migrateKaneoState } = await import('../src/migration.ts');
  const native: Task = { id: 'native-ticket', projectId: 'native-project', key: 'FIX-3', number: 3, title: 'Imported', priority: 'medium', status: 'todo', labels: [{ name: 'sf' }], difficulty: 'med', automationReady: true, holdReason: null, archived: false, parentId: null, createdAt: '2026-10-26T01:00:00Z', description: '\n---\nKaneo source: FIX-8\nSource task ID: old-ticket\nSource created: 2026-01-01T01:00:00Z\nSource state: to-do' };
  const result = migrateKaneoState(source.db, target, [native], { 'old-project': 'native-project' });
  assert.equal(result.sessionTickets, 1);
  const migrated = target.sessionTicket('native-ticket')!;
  assert.deepEqual([migrated.projectId, migrated.key, migrated.number, migrated.status], ['native-project', 'FIX-3', 3, 'todo']);
  assert.equal(migrated.createdAt, row.createdAt, 'native import time cannot erase original creation evidence');
  assert.equal(migrated.dismissedAt, row.dismissedAt, 'dismissed tickets must never reappear');
  assert.deepEqual(migrated.sources, row.sources);
  assert.deepEqual(target.events().map(event => event.kind), ['current-event', 'legacy-event']);
  assert.equal(target.sessionThread('thread')?.lastOrdinal, 90, 'migration must not replay old history and flood the API');
  assert.equal(target.sessionThread('thread')?.pending.length, 0);
  assert.throws(() => migrateKaneoState(source.db, target, [native, { ...native, id: 'ambiguous' }], {}), /ambiguous/i);
  assert.equal(target.sessionTickets().length, 1, 'a rejected mapping cannot mutate the target');
  assert.throws(() => migrateKaneoState(source.db, target, [], {}), /Missing verified/);
  assert.equal(migrateKaneoState(source.db, target, [native], {}).alreadyMigrated, true);

  target.saveSessionTicket({ ...migrated, dismissedAt: undefined });
  const sourceThread = target.sessionThread('thread')!;
  const calls: string[] = [];
  const t3 = { sessions: async () => [sourceThread], bounded: async () => { throw new Error('Historical conversations must not be replayed'); } } as unknown as T3;
  const kanvil = { realtime: true, revision: 0, ensureProjectStream: async (id: string) => { calls.push(id); }, tasks: async () => [native],
    projects: async () => [{ id: 'native-project', name: 'Fixture', slug: 'FIX' }], columns: async () => [{ slug: 'todo', isFinal: false }],
    task: async (_id: string, _project: string, cached: boolean) => { assert.equal(cached, true, 'restored rows share project snapshots instead of issuing a burst of authenticated reads'); return native; } } as unknown as Kanvil;
  const config = { kanvil: { workspaceId: 'workspace' }, projects: [{ kanvilId: 'native-project', name: 'Fixture', enabled: true, readyStatuses: ['todo'] }] } as Config;
  await collectSessionTickets(config, target, t3, kanvil);
  const status = sessionTicketStatus(config, target);
  assert.equal(status.error, null, 'restored cursors avoid the failing historical HTTP lookup path');
  assert.deepEqual(status.rows.map(row => row.key), ['FIX-3']);
  assert.deepEqual(calls, ['native-project'], 'persisted rows regain scoped access monitoring after restart');
});
