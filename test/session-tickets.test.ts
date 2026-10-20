import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { FactoryService } from '../src/service.ts';
import { v2Thread } from './v2-fixture.ts';

// Synthetic T3 conversation and Kaneo fixtures. No live sessions, tickets, or dispatches.
const AT = { threadStart: '2026-03-01T10:00:00.000Z', created: '2026-03-01T10:05:00.000Z', reported: '2026-03-01T10:06:00.000Z', threadEnd: '2026-03-01T10:10:00.000Z' };
const message = (id: string, type: 'assistant_message' | 'user_message', text: string, ordinal: number, startedAt = AT.reported, threadId = 'session-1') =>
  ({ id: `item-${id}`, threadId, type, messageId: `message-${id}`, text, ordinal, startedAt, updatedAt: startedAt, status: 'completed' });
const task = (id: string, number: number, projectId = 'FIX', extra: Record<string, unknown> = {}) =>
  ({ id, number, projectId, workspaceId: 'workspace', title: `Ticket ${number}`, priority: 'high', status: 'to-do', createdAt: AT.created, description: 'Problem\n\nFix it.', ...extra });

function serviceFixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-session-tickets-'));
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'fixture-sol' } }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', key: 'FIX', enabled: true, kaneoId: 'FIX', t3Id: 'FIX', repoPath: dir, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] }],
  });
  const path = join(dir, 'config.jsonc'); writeFileSync(path, JSON.stringify(c));
  const thread = v2Thread({ id: 'session-1', projectId: 'FIX', title: 'Plan the uploads fix', createdAt: AT.threadStart, updatedAt: AT.threadEnd, latestUserMessageAt: AT.threadStart });
  const turnItems = [message('u1', 'user_message', 'Please file a ticket for the upload bug.', 1, AT.threadStart), message('a1', 'assistant_message', 'Created FIX-7: Fix uploads.', 2)];
  const tasks = [task('task-7', 7)];
  t.mock.method(T3.prototype, 'subscribe', async (_: unknown, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())));
  t.mock.method(T3.prototype, 'providers', async () => []);
  t.mock.method(T3.prototype, 'request', async (route: string) => {
    if (route === '/api/orchestration/shell') return { schemaVersion: 2, snapshotSequence: 1, threads: [thread], archivedThreads: [], projects: [{ id: 'FIX', title: 'Fixture', workspaceRoot: dir }] };
    if (route === `/api/orchestration/threads/${thread.id}/bounded`) return { snapshotSequence: 1, historyCursor: null, hasMoreHistory: false, projection: { thread, messages: [], runtimeRequests: [], runs: [], providerSessions: [], turnItems } };
    throw new Error(`Unexpected T3 route ${route}`);
  });
  t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
  t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.map(x => ({ name: 'feat', taskId: x.id, workspaceId: 'workspace' }));
    if (name === 'get_task_relations') return [];
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: [] }] }, pagination: { total: 0, totalPages: 1 } };
    if (name === 'list_projects') return [{ id: 'FIX', name: 'Fixture', slug: 'FIX', workspaceId: 'workspace' }];
    if (name === 'list_project_columns') return [{ slug: 'to-do', name: 'To Do', isFinal: false, position: 0 }, { slug: 'done', name: 'Done', isFinal: true, position: 1 }];
    if (name === 'get_task_by_ticket_id') { const found = tasks.find(x => `${x.projectId}-${x.number}` === args.ticketId); if (!found) throw new Error('Kaneo get_task_by_ticket_id failed'); return structuredClone(found); }
    if (name === 'get_task') { const found = tasks.find(x => x.id === args.taskId); if (!found) throw new Error('Kaneo get_task failed'); return structuredClone(found); }
    throw new Error(`Unexpected Kaneo tool ${name}`);
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusFile = join(c.stateDir, 'status.json');
  const status = () => existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : {};
  const until = async (ready: (s: any) => boolean, ms = 8000) => { for (let n = 0; n < ms / 25 && !ready(status()); n++) await new Promise(resolve => setTimeout(resolve, 25)); return status(); };
  return { dir, c, path, thread, tasks, turnItems, status, until };
}

// Regression proof for the ticket's first acceptance criterion: paused automation, no browser, no skill run.
test('the scheduler collects a session-created ticket into status on its own and keeps it across a restart', { timeout: 20000 }, async t => {
  const f = serviceFixture(t);
  let service = new FactoryService(f.path, { kaneoPollMs: 600_000 });
  try {
    await service.start();
    const published = await f.until(s => s.sessionTickets?.rows?.length > 0);
    assert.deepEqual(published.sessionTickets?.rows.map((r: any) => r.key), ['FIX-7'], 'the creation report reaches status.json without a skill run');
    const row = published.sessionTickets.rows[0];
    assert.equal(row.taskId, 'task-7');
    assert.deepEqual(row.sources.map((s: any) => [s.threadId, s.messageId]), [['session-1', 'message-a1']], 'the row keeps its source session and message');
    assert.deepEqual(row.labels, ['feat']);
  } finally { await service.stop(); }
  service = new FactoryService(f.path, { kaneoPollMs: 600_000 });
  try {
    await service.start();
    const restarted = await f.until(s => s.sessionTickets?.rows?.length > 0);
    assert.deepEqual(restarted.sessionTickets?.rows.map((r: any) => r.key), ['FIX-7'], 'the list survives a scheduler restart');
  } finally { await service.stop(); }
});

// Direct collector coverage: synthetic sessions, history pages and tracker answers, with every read scriptable.
const { collectSessionTickets, creationReports, dismissSessionTicket, sessionTicketStatus } = await import('../src/session-tickets.ts');
const { Store } = await import('../src/store.ts');
const { T3: T3Client, Kaneo: KaneoClient } = await import('../src/clients.ts');
const LINK = (taskId: string, workspace = 'workspace') => `https://kaneo.example.test/dashboard/workspace/${workspace}/project/FIX/task/${taskId}`;

test('creation reports name keys and task links, not mentions, prompts, examples, quotes, tables, code or negations', () => {
  const refs = (text: string) => creationReports(text, 'workspace').map(r => `${r.kind}:${r.value}`);
  assert.deepEqual(refs('Created FIX-7: Fix uploads.'), ['key:FIX-7']);
  assert.deepEqual(refs(`Filed two tickets:\n- [FIX-8](${LINK('task-8')}) uploads\n- FIX-9 downloads`), ['task:task-8', 'key:FIX-8', 'key:FIX-9']);
  assert.deepEqual(refs('Opened OTH-3 in the other project.'), ['key:OTH-3']);
  assert.deepEqual(refs('FIX-3 is related; see also FIX-4 and the SHA-256 digest.'), [], 'a mention is not a report');
  assert.deepEqual(refs('Created tickets:\n| Ticket | Scope |\n|---|---|\n| FIX-5 | web |'), [], 'a table is illustrative');
  assert.deepEqual(refs('> Created FIX-6 earlier\n\nNothing else.'), [], 'quoted text is not this session\'s report');
  assert.deepEqual(refs('```\nCreated FIX-6\n```\n\nUse a key such as `FIX-6` when creating one.'), [], 'code and inline examples are not reports');
  assert.deepEqual(refs('No ticket was created for FIX-2; it already exists.'), [], 'a negated sentence is not a report');
  assert.deepEqual(refs("I couldn't create FIX-1 because it exists. I opened FIX-2 instead."), ['key:FIX-2'], 'negation covers only its own sentence');
  assert.deepEqual(refs(`Created [FIX-8](${LINK('task-8', 'elsewhere')}).`), ['key:FIX-8'], 'a link into another workspace is ignored');
  assert.deepEqual(refs('Created FIX-7.\n\nCreated FIX-7 again.'), ['key:FIX-7'], 'one reference per message');
});

function collectorFixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-collector-'));
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'fixture-sol' } }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', key: 'FIX', enabled: true, kaneoId: 'FIX', t3Id: 'FIX', repoPath: dir, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] }],
  });
  const session = (id: string, extra: Record<string, unknown> = {}) => ({ id, projectId: 'FIX', title: `Session ${id}`, createdAt: AT.threadStart, updatedAt: AT.threadEnd, lineage: { parentThreadId: null, relationshipToParent: null }, ...extra });
  type Page = { items: unknown[]; cursor: string | null; more: boolean };
  const f = {
    dir, c, store: new Store(c.stateDir), t3: new T3Client(c.t3), kaneo: new KaneoClient(c.kaneo),
    sessions: [] as Record<string, unknown>[], bounded: new Map<string, Page>(), history: new Map<string, Page>(),
    tasks: [] as Record<string, unknown>[], labels: new Map<string, string[]>(), failing: new Set<string>(), calls: [] as string[],
    session, task, message, LINK,
    collect: (budget?: { reads?: number; lookups?: number; refreshes?: number }) => collectSessionTickets(c, f.store, f.t3, f.kaneo, budget),
    status: () => sessionTicketStatus(c, f.store),
    keys: () => sessionTicketStatus(c, f.store).rows.map(r => r.key),
    // Collect until no work remains, as the service does batch after batch.
    drain: async () => { for (let n = 0; n < 50; n++) if (!await f.collect()) return; throw new Error('collection did not settle'); },
  };
  t.mock.method(f.t3, 'request', async (route: string) => {
    f.calls.push(route);
    if (f.failing.has(route)) { f.failing.delete(route); throw new Error(`T3 ${route} returned HTTP 503`); }
    if (route === '/api/orchestration/shell') return { threads: f.sessions, archivedThreads: [], projects: [] };
    const bounded = route.match(/^\/api\/orchestration\/threads\/([^/]+)\/bounded$/);
    if (bounded) { const page = f.bounded.get(bounded[1]) ?? { items: [], cursor: null, more: false }; return { historyCursor: page.cursor, hasMoreHistory: page.more, projection: { turnItems: page.items } }; }
    const history = route.match(/^\/api\/orchestration\/threads\/([^/]+)\/history\?cursor=([^&]+)&view=conversation$/);
    if (history) { const page = f.history.get(decodeURIComponent(history[2])); if (!page) throw new Error('T3 history page returned HTTP 404'); return { items: page.items.map((item: any) => ({ sourceThreadId: item.sourceThreadId ?? history[1], item })), nextCursor: page.cursor, hasMoreHistory: page.more }; }
    throw new Error(`Unexpected T3 route ${route}`);
  });
  t.mock.method(f.kaneo, 'call', async (name: string, args: Record<string, unknown>) => {
    f.calls.push(name);
    if (f.failing.has(name)) { f.failing.delete(name); throw new Error(`Kaneo ${name} failed; check its authenticated connection`); }
    if (name === 'list_workspace_labels') return [...f.labels].flatMap(([taskId, names]) => names.map(n => ({ name: n, taskId, workspaceId: 'workspace' })));
    if (name === 'list_projects') return [{ id: 'FIX', name: 'Fixture', slug: 'FIX' }, { id: 'OTH', name: 'Other', slug: 'OTH' }];
    if (name === 'list_project_columns') return [{ slug: 'ready', name: 'Ready', isFinal: false, position: 0 }, { slug: 'done', name: 'Done', isFinal: true, position: 1 }];
    if (name === 'get_task_by_ticket_id') { const found = f.tasks.find(x => `${x.projectId}-${x.number}` === args.ticketId && x.projectId === args.projectId); if (!found) throw new Error('Kaneo get_task_by_ticket_id failed; check its authenticated connection'); return structuredClone(found); }
    if (name === 'get_task') { const found = f.tasks.find(x => x.id === args.taskId); if (!found) throw new Error('Kaneo get_task failed; check its authenticated connection'); return structuredClone(found); }
    throw new Error(`Unexpected Kaneo tool ${name}`);
  });
  t.after(() => { f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test('reports across projects become one row per confirmed task, in priority order, with their provenance', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7), task('task-3', 3, 'OTH', { status: 'ready', priority: 'urgent' }), task('task-9', 9, 'FIX', { priority: 'low' }), task('task-2', 2, 'FIX', { createdAt: '2026-02-01T00:00:00.000Z' }));
  f.labels.set('task-7', ['feat', 'web']);
  f.sessions.push(f.session('s1'), f.session('s2', { title: 'Second session' }), f.session('child', { lineage: { parentThreadId: 's1', relationshipToParent: 'subagent' } }), f.session('gone', { deletedAt: AT.threadEnd }));
  f.bounded.set('s1', { items: [
    message('u1', 'user_message', 'Create FIX-1 and FIX-9 please.', 1, AT.threadStart, 's1'),
    message('a1', 'assistant_message', `Created FIX-7 and [OTH-3](${LINK('task-3')}).\n\nFIX-2 was created last month and stays as is.`, 2, AT.reported, 's1'),
    message('a2', 'assistant_message', 'Created FIX-2 just now.', 3, AT.reported, 's1'),
    message('x1', 'assistant_message', 'Created FIX-9.', 4, AT.reported, 'another-thread'),
  ], cursor: null, more: false });
  f.bounded.set('s2', { items: [message('b1', 'assistant_message', 'Filed FIX-7 (duplicate report) and FIX-9.', 1, AT.reported, 's2')], cursor: null, more: false });
  f.bounded.set('child', { items: [message('c1', 'assistant_message', 'Created FIX-9.', 1, AT.reported, 'child')], cursor: null, more: false });
  await f.drain();
  const s = f.status();
  assert.deepEqual(s.rows.map(r => [r.key, r.priority, r.project, r.unavailable]), [['OTH-3', 'urgent', 'Other', 'Project not configured in Factory'], ['FIX-7', 'high', 'Fixture', null], ['FIX-9', 'low', 'Fixture', null]]);
  assert.deepEqual(s.rows[1].labels, ['feat', 'web']);
  assert.deepEqual(s.rows[1].sources.map(x => `${x.threadId}/${x.messageId}`), ['s1/message-a1', 's2/message-b1'], 'a duplicate report adds provenance, not a row');
  assert.deepEqual(s.rows[2].sources.map(x => x.threadId), ['s2'], 'user prompts, inherited items and subagent threads are not evidence');
  assert.equal(f.store.sessionTickets().some(r => r.key === 'FIX-2'), false, 'a ticket created before the session is only mentioned');
  assert.equal(s.error, null);
  assert.deepEqual(f.store.events(10).filter(e => e.kind === 'session.ticket').map(e => e.text).toSorted(), ['FIX-7 was created in session Session s1', 'FIX-9 was created in session Second session', 'OTH-3 was created in session Session s1']);
  const reads = f.calls.filter(x => x.includes('/bounded')).length;
  await f.drain();
  assert.equal(f.calls.filter(x => x.includes('/bounded')).length, reads, 'unchanged sessions are not re-read');
});

test('backfill follows history past the bounded window and catch-up covers downtime longer than one window', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7), task('task-8', 8));
  f.sessions.push(f.session('s1'));
  const chatter = (from: number, count: number, thread = 's1') => Array.from({ length: count }, (_, i) => message(`m${from + i}`, 'assistant_message', `Working on step ${from + i}.`, from + i, AT.reported, thread));
  f.bounded.set('s1', { items: chatter(10, 3), cursor: 'older-1', more: true });
  f.history.set('older-1', { items: [message('old-report', 'assistant_message', 'Created FIX-7.', 5, AT.reported, 's1'), ...chatter(6, 4)], cursor: 'older-2', more: true });
  f.history.set('older-2', { items: chatter(1, 4), cursor: null, more: false });
  assert.equal(await f.collect({ reads: 1 }), true, 'a bounded batch reports remaining work');
  assert.deepEqual(f.keys(), [], 'the first window alone has no report');
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7'], 'backfill reaches the report behind the window');
  assert.equal(f.store.sessionThread('s1')?.lastOrdinal, 12);
  // Downtime: the session gains more messages than one window holds, with a report among the ones the window no longer shows.
  f.sessions[0] = f.session('s1', { updatedAt: '2026-03-01T12:00:00.000Z' });
  f.bounded.set('s1', { items: chatter(30, 3), cursor: 'catch-1', more: true });
  f.history.set('catch-1', { items: [message('new-report', 'assistant_message', 'Created FIX-8.', 20, AT.reported, 's1'), ...chatter(21, 9)], cursor: 'catch-2', more: true });
  f.history.set('catch-2', { items: [...chatter(10, 3), ...chatter(13, 7)], cursor: 'older-1', more: true });
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7', 'FIX-8'], 'catch-up walks back to the last seen turn and stops there');
  assert.equal(f.calls.includes('/api/orchestration/threads/s1/history?cursor=older-1&view=conversation'), true);
  assert.equal(f.calls.filter(x => x.endsWith('cursor=older-1&view=conversation')).length, 1, 'already seen pages are not read again');
});

test('a failed read or lookup is retried without losing candidates, duplicating rows or hiding the last list', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7), task('task-8', 8));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 10, AT.reported, 's1')], cursor: 'older-1', more: true });
  f.history.set('older-1', { items: [message('a0', 'assistant_message', 'Created FIX-8.', 1, AT.reported, 's1')], cursor: null, more: false });
  f.failing.add('get_task_by_ticket_id');
  await f.collect();
  assert.deepEqual(f.keys(), [], 'a failed confirmation lists nothing');
  assert.match(f.status().error?.message ?? '', /Confirming FIX-7/);
  const pending = f.store.sessionThread('s1')!.pending;
  assert.equal(pending.length, 1); assert.equal(pending[0].attempts, 1); assert.ok(pending[0].retryAfter);
  pending[0].retryAfter = '2000-01-01T00:00:00.000Z'; f.store.saveSessionThread({ ...f.store.sessionThread('s1')!, pending });
  f.failing.add('/api/orchestration/threads/s1/history?cursor=older-1&view=conversation');
  await f.collect();
  assert.deepEqual(f.keys(), ['FIX-7'], 'the retried lookup succeeds while the page read fails');
  assert.match(f.status().error?.message ?? '', /Reading session/);
  assert.deepEqual(f.store.sessionThread('s1')!.backfill?.cursor, 'older-1', 'an interrupted page is read again from the same cursor');
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7', 'FIX-8']);
  assert.equal(f.status().error, null, 'a clean batch clears the failure');
  assert.equal(f.store.sessionTickets().length, 2);
  f.failing.add('/api/orchestration/shell');
  await f.collect();
  assert.deepEqual(f.keys(), ['FIX-7', 'FIX-8'], 'a failed session listing keeps the known list');
  assert.match(f.status().error?.message ?? '', /Listing sessions/);
});

test('dismissal is a tombstone that rescans, other sessions and a reopened store respect, and the tracker is untouched', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7']);
  assert.deepEqual(dismissSessionTicket(f.store, 'task-7'), { ok: true, taskId: 'task-7' });
  assert.throws(() => dismissSessionTicket(f.store, 'unknown'), /not on the session list/);
  assert.deepEqual(f.keys(), []);
  f.sessions.push(f.session('s2'));
  f.bounded.set('s2', { items: [message('b1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's2')], cursor: null, more: false });
  await f.drain();
  assert.deepEqual(f.keys(), [], 'another session reporting the same ticket does not bring it back');
  assert.equal(f.store.sessionTicket('task-7')?.sources.length, 2, 'provenance still accrues on the tombstone');
  const reopened = new Store(f.c.stateDir);
  try { assert.deepEqual(sessionTicketStatus(f.c, reopened).rows, []); } finally { reopened.close(); }
  assert.deepEqual(f.calls.filter(x => !x.startsWith('/') && !/^(list_|get_)/.test(x)), [], 'collection and dismissal only read the tracker');
  assert.equal(f.store.events(5)[0].text, 'FIX-7 was removed from Session tickets');
});

test('only a confirmed Factory start consumes an entry, including starts made elsewhere, and status transitions follow the tracker', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7), task('task-8', 8));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7 and FIX-8.', 1, AT.reported, 's1')], cursor: null, more: false });
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7', 'FIX-8']);
  const job = (state: 'dispatching' | 'running' | 'complete', reason: string, taskId = 'task-7') => ({ id: `job-${taskId}`, kind: 'ticket' as const, projectId: 'FIX', taskId, ticketKey: 'FIX-7', threadId: 'thread', messageId: 'message', createdAt: AT.reported, state, reason, lastPersonalActivity: null, reportPath: join(f.dir, 'report'), command: null, prUrls: [], completedAt: null });
  f.store.save(job('dispatching', 'Dispatch prepared'));
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7', 'FIX-8'], 'a prepared dispatch is not a confirmed start');
  assert.equal(f.store.sessionTicket('task-7')?.consumed, undefined);
  f.store.save(job('dispatching', 'T3 accepted dispatch'));
  assert.deepEqual(f.keys(), ['FIX-8'], 'an accepted launch leaves the list at once');
  await f.drain();
  assert.equal(f.store.sessionTicket('task-7')?.consumed?.jobId, 'job-task-7', 'the collector records the consumption');
  f.store.save({ ...job('complete', 'Done'), completedAt: AT.threadEnd });
  f.tasks[0] = task('task-7', 7, 'FIX', { status: 'to-do' });
  for (const row of f.store.sessionTickets()) f.store.saveSessionTicket({ ...row, refreshedAt: '2000-01-01T00:00:00.000Z', refreshAfter: '2000-01-01T00:00:00.000Z' });
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-8'], 'a consumed entry stays consumed after its run finishes and the ticket returns to ready');
  // Tracker status drives membership for the remaining entry; a failed refresh keeps the old reading and says so.
  const refresh = async (status: string) => { f.tasks[1] = task('task-8', 8, 'FIX', { status }); f.store.saveSessionTicket({ ...f.store.sessionTicket('task-8')!, refreshedAt: '2000-01-01T00:00:00.000Z', refreshAfter: '2000-01-01T00:00:00.000Z' }); await f.drain(); };
  await refresh('in-progress'); assert.deepEqual(f.keys(), [], 'in-progress tickets are hidden');
  await refresh('to-do'); assert.deepEqual(f.keys(), ['FIX-8'], 'a ticket back in the ready column returns');
  f.failing.add('get_task'); await refresh('done');
  const stale = f.status().rows[0];
  assert.equal(stale.key, 'FIX-8'); assert.match(stale.refreshError ?? '', /get_task failed/); assert.equal(stale.refreshedAt, '2000-01-01T00:00:00.000Z', 'a failed read is not presented as fresh');
  await refresh('done'); assert.deepEqual(f.keys(), [], 'completed tickets leave the list');
});

test('failed refreshes back off instead of looping, and rows behind them still get their turn', async t => {
  const f = collectorFixture(t);
  const keys = Array.from({ length: 12 }, (_, i) => i + 1);
  for (const n of keys) f.tasks.push(task(`task-${n}`, n));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', `Created ${keys.map(n => `FIX-${n}`).join(', ')}.`, 1, AT.reported, 's1')], cursor: null, more: false });
  await f.drain();
  assert.equal(f.keys().length, 12);
  for (const row of f.store.sessionTickets()) f.store.saveSessionTicket({ ...row, refreshedAt: '2000-01-01T00:00:00.000Z', refreshAfter: '2000-01-01T00:00:00.000Z' });
  const failing = () => { f.failing.add('get_task'); };
  t.mock.method(f.kaneo, 'call', async (name: string, args: Record<string, unknown>) => { f.calls.push(name); if (name === 'get_task') throw new Error('Kaneo get_task failed; check its authenticated connection'); if (name === 'list_workspace_labels') return []; throw new Error(name); });
  failing();
  const reads = () => f.calls.filter(x => x === 'get_task').length;
  assert.equal(await f.collect(), true, 'two rows remain due after the first ten failures');
  assert.equal(reads(), 10);
  assert.equal(await f.collect(), false, 'the remaining rows are tried once and nothing else is due');
  assert.equal(reads(), 12, 'every stale row got one attempt; failed rows wait for their retry deadline');
  assert.equal(await f.collect(), false);
  assert.equal(reads(), 12, 'a tracker outage does not loop on the same rows');
  assert.ok(f.store.sessionTickets().every(r => r.refreshError && r.refreshedAt === '2000-01-01T00:00:00.000Z'), 'failed rows keep their honest last read and the error');
});

test('a collection batch that cannot start still records the failure for the page', { timeout: 20000 }, async t => {
  const f = serviceFixture(t);
  t.mock.method(Kaneo.prototype, 'connect', async () => { throw new Error('Kaneo MCP process exited'); });
  const service = new FactoryService(f.path, { kaneoPollMs: 600_000 });
  try {
    await service.start();
    const published = await f.until(s => s.sessionTickets?.error);
    assert.match(published.sessionTickets?.error?.message ?? '', /Kaneo MCP process exited/, 'a setup failure reaches status.sessionTickets.error');
  } finally { await service.stop(); }
});
