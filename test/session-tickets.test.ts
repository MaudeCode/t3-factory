import { mockTracker } from './tracker-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.ts';
import { T3, Kanvil, KanvilTaskNotFound } from '../src/clients.ts';
import { FactoryService } from '../src/service.ts';
import { v2Thread } from './v2-fixture.ts';

// Synthetic T3 conversation and Kanvil fixtures. No live sessions, tickets, or dispatches.
const AT = { threadStart: '2026-03-01T10:00:00.000Z', created: '2026-03-01T10:05:00.000Z', reported: '2026-03-01T10:06:00.000Z', threadEnd: '2026-03-01T10:10:00.000Z' };
const message = (id: string, type: 'assistant_message' | 'user_message', text: string, ordinal: number, startedAt = AT.reported, threadId = 'session-1') =>
  ({ id: `item-${id}`, threadId, type, messageId: `message-${id}`, text, ordinal, startedAt, updatedAt: startedAt, status: 'completed' });
const task = (id: string, number: number, projectId = 'FIX', extra: Record<string, unknown> = {}) =>
  ({ id, number, projectId, workspaceId: 'workspace', title: `Ticket ${number}`, priority: 'high', status: 'todo', createdAt: AT.created, description: 'Problem\n\nFix it.', ...extra });

function serviceFixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-session-tickets-'));
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'fixture-sol' } }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: dir, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
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
  t.mock.method(Kanvil.prototype, 'connect', async () => {}); t.mock.method(Kanvil.prototype, 'close', async () => {});
  mockTracker(t, Kanvil.prototype, async (name: string, args: Record<string, unknown>) => {
    if (name === 'labels') return tasks.map(x => ({ name: 'feat', taskId: x.id, workspaceId: 'workspace' }));
    if (name === 'relations') return [];
    if (name === 'tickets') return { data: { workspaceId: 'workspace', columns: [{ tasks: [] }] }, pagination: { total: 0, totalPages: 1 } };
    if (name === 'projects') return [{ id: 'FIX', name: 'Fixture', slug: 'FIX', workspaceId: 'workspace' }];
    if (name === 'columns') return [{ slug: 'todo', name: 'To Do', isFinal: false, position: 0 }, { slug: 'done', name: 'Done', isFinal: true, position: 1 }];
    if (name === 'ticketByKey') { const found = tasks.find(x => `${x.projectId}-${x.number}` === args.ticketId); if (!found) throw new Error('Kanvil ticketByKey failed'); return structuredClone(found); }
    if (name === 'ticket') { const found = tasks.find(x => x.id === args.taskId); if (!found) throw new Error('Kanvil ticket failed'); return structuredClone(found); }
    throw new Error(`Unexpected Kanvil tool ${name}`);
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
  let service = new FactoryService(f.path);
  try {
    await service.start();
    const published = await f.until(s => s.sessionTickets?.rows?.length > 0);
    assert.deepEqual(published.sessionTickets?.rows.map((r: any) => r.key), ['FIX-7'], 'the creation report reaches status.json without a skill run');
    const row = published.sessionTickets.rows[0];
    assert.equal(row.taskId, 'task-7');
    assert.deepEqual(row.sources.map((s: any) => [s.threadId, s.messageId]), [['session-1', 'message-a1']], 'the row keeps its source session and message');
    assert.deepEqual(row.labels, ['feat']);
  } finally { await service.stop(); }
  service = new FactoryService(f.path);
  try {
    await service.start();
    const restarted = await f.until(s => s.sessionTickets?.rows?.length > 0);
    assert.deepEqual(restarted.sessionTickets?.rows.map((r: any) => r.key), ['FIX-7'], 'the list survives a scheduler restart');
  } finally { await service.stop(); }
});

// Direct collector coverage: synthetic sessions, history pages and tracker answers, with every read scriptable.
const { collectSessionTickets, creationReports, dismissSessionTicket, sessionTicketStatus } = await import('../src/session-tickets.ts');
const { Store } = await import('../src/store.ts');
const { T3: T3Client, Kanvil: KanvilClient } = await import('../src/clients.ts');
const LINK = (taskId: string, project = 'FIX') => `https://kanvil.example.test/projects/${project}/tickets/${taskId}`;

test('session sources are unique by thread and retain the latest creation report', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7));
  f.sessions.push(f.session('s1'), f.session('s2', { title: 'Session s1' }));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1'), message('a2', 'assistant_message', 'Created FIX-7.', 2, AT.threadEnd, 's1')], cursor: null, more: false });
  f.bounded.set('s2', { items: [message('b1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's2')], cursor: null, more: false });
  await f.drain();
  const row = f.store.sessionTicket('task-7')!;
  // Older reports may arrive through backfill after a newer report was already stored.
  f.store.saveSessionTicket({ ...row, sources: row.sources.toReversed() });
  assert.deepEqual(f.status().rows[0].sources.map(s => [s.threadId, s.messageId, s.at]).toSorted(), [
    ['s1', 'message-a2', AT.threadEnd], ['s2', 'message-b1', AT.reported],
  ], 'each creating session appears once, using its latest report even when storage order differs');
  assert.equal(f.store.sessionTicket('task-7')!.sources.length, 3, 'all message provenance remains stored');
});

test('Factory discovery threads are excluded from old rows, fresh scans, retries and refreshes', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7), task('task-8', 8), task('task-9', 9));
  f.sessions.push(f.session('ordinary'), f.session('legacy'), f.session('owned'));
  f.bounded.set('ordinary', { items: [message('a1', 'assistant_message', 'Created FIX-8.', 1, AT.reported, 'ordinary')], cursor: null, more: false });
  f.bounded.set('legacy', { items: [message('b1', 'assistant_message', 'Created FIX-7 and FIX-8.', 1, AT.reported, 'legacy')], cursor: null, more: false });
  f.bounded.set('owned', { items: [message('c1', 'assistant_message', 'Created FIX-9.', 1, AT.reported, 'owned')], cursor: null, more: false });
  await f.drain();
  const rec = f.store.sessionThread('legacy')!;
  f.store.saveSessionThread({ ...rec, title: 'Factory Discovery: Fixture', pending: [{ kind: 'key', value: 'FIX-99', messageId: 'pending', at: AT.reported, attempts: 1, error: 'Old lookup error' }], error: 'Old history error' });
  for (const row of f.store.sessionTickets()) f.store.saveSessionTicket({ ...row, refreshAfter: '2000-01-01T00:00:00Z', sources: row.sources.map(s => s.threadId === 'legacy' ? { ...s, title: 'Factory Discovery: Fixture' } : s) });
  f.store.save({ id: 'discovery-job', kind: 'discovery', projectId: 'FIX', taskId: null, ticketKey: null, threadId: 'owned', messageId: 'start', createdAt: AT.threadStart, completedAt: AT.threadEnd, state: 'complete', reason: 'Done', lastPersonalActivity: null, reportPath: join(f.dir, 'report'), command: null, prUrls: [] });
  assert.deepEqual(f.keys(), ['FIX-8'], 'legacy discovery titles and retained job ownership exclude discovery-only tickets');
  assert.deepEqual(f.status().rows[0].sources.map(s => s.threadId), ['ordinary'], 'mixed tickets keep their ordinary source');
  assert.equal(f.store.sessionTicket('task-8')!.sources.length, 2, 'exclusion preserves stored provenance');
  f.sessions.push(f.session('fresh', { title: 'factory discovery: New project' }), f.session('discussion', { title: 'Discuss Factory Discovery: settings' }));
  f.calls.length = 0;
  await f.drain();
  assert.equal(f.calls.some(c => /\/threads\/(legacy|owned|fresh)\//.test(c)), false, 'discovery history is not scanned');
  assert.equal(f.calls.filter(c => c === 'ticketByKey').length, 0, 'discovery references are not confirmed');
  assert.equal(f.calls.filter(c => c === 'ticket').length, 1, 'only the mixed ticket with an ordinary source is refreshed');
  assert.equal(f.calls.some(c => c.includes('/threads/discussion/')), true, 'only the requested title prefix matches');
  assert.equal(f.status().error, null, 'old discovery failures do not keep the collection error alive');
});

test('upstream release-review sources are excluded from collection and existing projections', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7), task('task-8', 8), task('task-9', 9));
  f.labels.set('task-9', ['upstream', 'feat']);
  f.sessions.push(f.session('ordinary'), f.session('review'));
  f.bounded.set('ordinary', { items: [message('a1', 'assistant_message', 'Created FIX-8 and FIX-9.', 1, AT.reported, 'ordinary')], cursor: null, more: false });
  f.bounded.set('review', { items: [message('b1', 'assistant_message', 'Created FIX-7 and FIX-8.', 1, AT.reported, 'review')], cursor: null, more: false });
  await f.drain();
  f.store.save({ id: 'review-job', kind: 'upstream', projectId: 'FIX', taskId: null, ticketKey: null, threadId: 'review', messageId: 'start', createdAt: AT.threadStart, completedAt: AT.threadEnd, state: 'complete', reason: 'Done', lastPersonalActivity: null, reportPath: join(f.dir, 'report'), command: null, prUrls: [] });
  assert.deepEqual(f.keys(), ['FIX-8', 'FIX-9'], 'upstream-only tickets leave the existing list');
  assert.deepEqual(f.status().rows[0].sources.map(s => s.threadId), ['ordinary'], 'mixed tickets retain only ordinary source sessions');
  assert.equal(f.store.sessionTicket('task-8')!.sources.length, 2, 'stored provenance is preserved');
  assert.ok(f.status().rows.find(r => r.key === 'FIX-9')!.labels.includes('upstream'), 'labels do not classify the source session');
  f.sessions[1] = f.session('review', { updatedAt: '2026-03-01T11:00:00Z' });
  const rec = f.store.sessionThread('review')!;
  rec.pending.push({ kind: 'key', value: 'FIX-404', messageId: 'missing', at: AT.reported, attempts: 1, error: 'Old upstream lookup failure' });
  rec.error = 'Old upstream read failure'; f.store.saveSessionThread(rec);
  f.sessions.push(f.session('fresh-review'));
  f.bounded.set('fresh-review', { items: [message('c1', 'assistant_message', 'Created FIX-10.', 1, AT.reported, 'fresh-review')], cursor: null, more: false });
  f.store.save({ ...f.store.job('review-job')!, id: 'fresh-review-job', threadId: 'fresh-review' });
  f.store.saveSessionTicket({ ...f.store.sessionTicket('task-7')!, refreshAfter: '2000-01-01T00:00:00Z' });
  f.calls.length = 0;
  assert.equal(await f.collect(), false, 'excluded upstream work cannot keep background collection queued');
  assert.equal(f.calls.some(c => /\/threads\/(review|fresh-review)\//.test(c)), false, 'new and previously collected upstream review history is not read');
  assert.equal(f.store.sessionThread('fresh-review'), undefined, 'an excluded review is never added to the scan ledger');
  assert.equal(f.calls.includes('ticketByKey'), false, 'upstream pending references are not confirmed');
  assert.equal(f.calls.includes('ticket'), false, 'upstream-only rows are not refreshed');
  assert.equal(f.status().error, null, 'excluded source failures do not keep the collection notice alive');
});

const reviewKickoff = "Review Example (`example/project`) from `v1.0` to `v2.0` with Example's `upstream-release-review` skill.";
test('legacy review kickoff requests classify upstream sources without job records', async t => {
  for (const kickoff of [reviewKickoff, '$upstream-release-review example/project v1.0..v2.0']) await t.test(kickoff, async t => {
    const f = collectorFixture(t);
    f.tasks.push(task('task-7', 7), task('task-8', 8));
    f.labels.set('task-8', ['upstream']);
    f.sessions.push(f.session('review', { title: 'Ordinary title' }), f.session('ordinary', { title: 'Upstream release: Example' }));
    f.bounded.set('review', { items: [message('u1', 'user_message', kickoff, 1, AT.threadStart, 'review'), message('a1', 'assistant_message', 'Created FIX-7.', 2, AT.reported, 'review')], cursor: null, more: false });
    f.bounded.set('ordinary', { items: [message('u2', 'user_message', `Review docs from start to finish with upstream-release-review skill examples.\n\n> ${reviewKickoff}`, 1, AT.threadStart, 'ordinary'), message('a2', 'assistant_message', 'Created FIX-8.', 2, AT.reported, 'ordinary')], cursor: null, more: false });
    await f.drain();
    assert.deepEqual(f.keys(), ['FIX-8'], 'explicit review kickoff sources are excluded without relying on titles or labels');
    assert.equal(f.store.sessionThread('review')!.upstreamReview, true);
    assert.equal(f.store.sessionThread('ordinary')!.upstreamReview, false);
    assert.equal(f.calls.filter(c => c === 'ticketByKey').length, 1, 'excluded review candidates are not confirmed');
  });
});

test('cached legacy origins backfill past known history and retain rows across read failures', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7));
  f.sessions.push(f.session('legacy'));
  f.bounded.set('legacy', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 50, AT.reported, 'legacy')], cursor: null, more: false });
  await f.collect();
  const rec = f.store.sessionThread('legacy')!;
  delete rec.upstreamReview; f.store.saveSessionThread(rec); // old persisted scan without origin classification
  f.bounded.set('legacy', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 50, AT.reported, 'legacy')], cursor: null, more: true });
  await f.collect();
  assert.match(f.status().error?.message ?? '', /no cursor for origin classification/);
  assert.equal(f.store.sessionThread('legacy')!.upstreamReview, undefined, 'incomplete history is not an ordinary-origin verdict');
  f.store.saveSessionThread({ ...f.store.sessionThread('legacy')!, retryAfter: undefined });
  f.bounded.set('legacy', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 50, AT.reported, 'legacy')], cursor: 'origin', more: true });
  f.history.set('origin', { items: [message('u1', 'user_message', reviewKickoff, 1, AT.threadStart, 'legacy')], cursor: null, more: false });
  assert.equal(await f.collect({ reads: 1 }), true, 'an unchanged legacy scan still classifies its older origin');
  assert.deepEqual(f.keys(), ['FIX-7'], 'unknown origin preserves the last known list');
  f.failing.add('/api/orchestration/threads/legacy/history?cursor=origin&view=conversation');
  await f.collect();
  assert.deepEqual(f.keys(), ['FIX-7'], 'a failed origin read does not erase the last known row');
  assert.match(f.status().error?.message ?? '', /Reading session/);
  const { retryAfter, ...ready } = f.store.sessionThread('legacy')!;
  assert.ok(retryAfter); f.store.saveSessionThread(ready);
  await f.drain();
  assert.deepEqual(f.keys(), [], 'the completed origin backfill removes the legacy review source');
  assert.equal(f.store.sessionThread('legacy')!.upstreamReview, true);
  assert.equal(f.store.sessionTicket('task-7')!.sources.length, 1, 'stored provenance is preserved');
  assert.equal(f.status().error, null);
});

test('new ticket confirmations wait until an older origin is classified', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7));
  f.sessions.push(f.session('review'));
  f.bounded.set('review', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 50, AT.reported, 'review')], cursor: 'origin', more: true });
  f.history.set('origin', { items: [message('u1', 'user_message', reviewKickoff, 1, AT.threadStart, 'review')], cursor: null, more: false });
  assert.equal(await f.collect({ reads: 1 }), true);
  assert.deepEqual(f.keys(), [], 'an unclassified review cannot briefly publish new tickets');
  assert.equal(f.calls.includes('ticketByKey'), false);
  await f.drain();
  assert.deepEqual(f.keys(), []);
  assert.equal(f.status().error, null);
});

test('creation reports name keys and task links, not mentions, prompts, examples, quotes, tables, code or negations', () => {
  const refs = (text: string) => creationReports(text).map(r => `${r.kind}:${r.value}`);
  assert.deepEqual(refs('Created FIX-7: Fix uploads.'), ['key:FIX-7']);
  assert.deepEqual(refs(`Filed two tickets:\n- [FIX-8](${LINK('task-8')}) uploads\n- FIX-9 downloads`), ['task:task-8', 'key:FIX-8', 'key:FIX-9']);
  assert.deepEqual(refs('Opened OTH-3 in the other project.'), ['key:OTH-3']);
  assert.deepEqual(refs('FIX-3 is related; see also FIX-4 and the SHA-256 digest.'), [], 'a mention is not a report');
  assert.deepEqual(refs('Created tickets:\n| Ticket | Scope |\n|---|---|\n| FIX-5 | web |'), [], 'a table is illustrative');
  assert.deepEqual(refs('> Created FIX-6 earlier\n\nNothing else.'), [], 'quoted text is not this session\'s report');
  assert.deepEqual(refs('```\nCreated FIX-6\n```\n\nUse a key such as `FIX-6` when creating one.'), [], 'code and inline examples are not reports');
  assert.deepEqual(refs('No ticket was created for FIX-2; it already exists.'), [], 'a negated sentence is not a report');
  assert.deepEqual(refs("I couldn't create FIX-1 because it exists. I opened FIX-2 instead."), ['key:FIX-2'], 'negation covers only its own sentence');
  assert.deepEqual(refs('I did not find an existing ticket, so I created FIX-2.'), ['key:FIX-2'], 'negation binds to the creation clause, not an earlier phrase');
  assert.deepEqual(refs('Created FIX-5 without a difficulty label.'), ['key:FIX-5'], 'a negator after the verb does not negate it');
  assert.deepEqual(refs("I didn't create FIX-1 and FIX-3 after all."), [], 'a negated creation drops every key it names');
  assert.deepEqual(refs("I couldn't create FIX-1, but I opened FIX-2 instead."), ['key:FIX-2'], 'only the affirmative clause of a mixed sentence reports');
  assert.deepEqual(refs('FIX-3 was already there. Created FIX-7.'), ['key:FIX-7'], 'a key before any creation clause is a mention');
  assert.deepEqual(refs('Created FIX-1. FIX-2 is related.'), ['key:FIX-1'], 'a new sentence starts neutral');
  assert.deepEqual(refs('Created these:\n1. FIX-1\n2. FIX-2\n\nFIX-3 is related.'), ['key:FIX-1', 'key:FIX-2'], 'a numbered list continues its header');
  assert.deepEqual(refs(`Created [FIX-8](${LINK('task-8', 'elsewhere')}).`), ['task:task-8', 'key:FIX-8'], 'links are confirmed against the workspace-scoped project catalog before collection');
  assert.deepEqual(refs('Created FIX-7.\n\nCreated FIX-7 again.'), ['key:FIX-7'], 'one reference per message');
});

test('sectioned creation reports retain their ticket lists, bounded ranges and numeric shorthand', () => {
  const refs = (text: string) => creationReports(text).filter(r => r.kind === 'key').map(r => r.value);
  assert.deepEqual(refs('Ten tickets filed.\n\n**Do now**\n\n1. FIX-7 Handle reuse. Today every reader opens the DB.\n2. FIX-8 One pass.\n\n**Later**\n\n- FIX-9 Cache reads.\n\nExisting FIX-1 was linked instead.'), ['FIX-7', 'FIX-8', 'FIX-9']);
  assert.deepEqual(refs('All five tickets are filed and verified. Numbers run FIX-10 through FIX-14.\n\n**By component**\n\n- Web: FIX-10, 11, 12.\n- App: FIX-13, 14.'), ['FIX-10', 'FIX-11', 'FIX-12', 'FIX-13', 'FIX-14']);
  assert.deepEqual(refs('Three tickets filed.\n\n**By component**\n\n- Web: FIX-10, 11, 12.\n- Existing FIX-13 is related.'), ['FIX-10', 'FIX-11', 'FIX-12']);
  assert.deepEqual(refs('I will be filing tickets:\n- FIX-7'), [], 'future intent is not a creation report');
  for (const text of ['I will create tickets.\n\n- FIX-7', 'No tickets were created.\n\n**Later**\n\n- FIX-7', 'Tickets filed.\n\nExisting tickets:\n\n- FIX-7', 'Tickets filed.\n\nUnrelated discussion of FIX-7.\n\n- FIX-8']) assert.deepEqual(refs(text), [], text);
  assert.deepEqual(refs('Created FIX-1 through FIX-1000000.'), [], 'range expansion is bounded and fails closed');
});

test('legacy scan progress replays sectioned reports through bounded history and preserves tombstones', async t => {
  const f = collectorFixture(t);
  f.sessions.push(f.session('s1'));
  f.tasks.push(task('task-7', 7), task('task-8', 8), task('task-9', 9));
  const retry = { kind: 'key' as const, value: 'FIX-99', messageId: 'unconfirmed', at: AT.reported, attempts: 3, error: 'Previous failure', retryAfter: '2099-01-01T00:00:00Z' };
  f.store.saveSessionThread({ id: 's1', projectId: 'FIX', title: 'Session s1', createdAt: AT.threadStart, updatedAt: AT.threadEnd, lastOrdinal: 20, pending: [retry], upstreamReview: false });
  f.bounded.set('s1', { items: [message('latest', 'assistant_message', 'Nothing new.', 20, AT.reported, 's1')], cursor: 'older', more: true });
  f.history.set('older', { items: [message('filed', 'assistant_message', 'Three tickets filed.\n\n**Do now**\n\n- FIX-7\n- FIX-8\n- FIX-9', 2, AT.reported, 's1')], cursor: null, more: false });
  for (const [id, number] of [['task-8', 8], ['task-9', 9]] as const) f.store.saveSessionTicket({ taskId: id, projectId: 'FIX', key: `FIX-${number}`, number, title: 'Existing marker', priority: 'high', status: 'todo', labels: [], createdAt: AT.created, firstSeenAt: AT.reported, refreshedAt: AT.reported, sources: [], ...(number === 8 ? { dismissedAt: AT.reported } : { consumed: { jobId: 'launched', at: AT.reported } }) });
  assert.equal(await f.collect({ reads: 1 }), true, 'legacy progress starts a bounded rescan');
  f.store.close(); f.store = new Store(f.c.stateDir);
  f.failing.add('/api/orchestration/threads/s1/history?cursor=older&view=conversation');
  await f.collect({ reads: 1 });
  const pending = f.store.sessionThread('s1')!;
  assert.equal(pending.backfill?.cursor, 'older', 'a failed page retains its durable cursor');
  delete pending.retryAfter; f.store.saveSessionThread(pending);
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7']);
  assert.equal(f.store.sessionTicket('task-8')!.dismissedAt, AT.reported);
  assert.equal(f.store.sessionTicket('task-9')!.consumed?.jobId, 'launched');
  assert.deepEqual(f.store.sessionThread('s1')!.pending, [retry], 'existing lookup retries are retained');
  const reads = f.calls.filter(c => c.includes('/history?')).length;
  await f.drain();
  assert.equal(f.calls.filter(c => c.includes('/history?')).length, reads, 'the new parser does not rescan again');
  assert.equal(f.store.sessionTicket('task-7')!.sources.length, 1, 'replay is idempotent');
});

test('paused service recovers a sectioned report from a legacy up-to-date cursor', { timeout: 20000 }, async t => {
  const f = serviceFixture(t), store = new Store(f.c.stateDir);
  store.saveSessionThread({ id: f.thread.id, projectId: 'FIX', title: f.thread.title, createdAt: AT.threadStart, updatedAt: AT.threadEnd, lastOrdinal: 2, pending: [], upstreamReview: false });
  store.close();
  f.turnItems[1]!.text = 'Ticket filed.\n\n**Completed**\n\n- FIX-7 Uploads.';
  const service = new FactoryService(f.path);
  try {
    await service.start();
    const s = await f.until(s => s.sessionTickets?.rows?.length > 0);
    assert.deepEqual(s.sessionTickets?.rows.map((r: any) => r.key), ['FIX-7'], 'recovered report reaches status without a browser or dispatch');
  } finally { await service.stop(); }
});

test('recent creation reports are collected before the historical replay backlog', async t => {
  const f = collectorFixture(t);
  f.sessions.push(f.session('old'), f.session('recent', { updatedAt: '2026-03-01T10:11:00.000Z' }));
  f.tasks.push(task('task-7', 7), task('task-8', 8));
  f.bounded.set('old', { items: [message('old', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 'old')], cursor: null, more: false });
  f.bounded.set('recent', { items: [message('recent', 'assistant_message', 'Created FIX-8.', 1, AT.reported, 'recent')], cursor: null, more: false });
  await f.collect({ reads: 1 });
  assert.deepEqual(f.keys(), ['FIX-8'], 'the first bounded read reaches the recently updated session');
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7', 'FIX-8'], 'historical replay continues after recent sessions are current');
});

test('recent pending confirmations are collected before old replay candidates', async t => {
  const f = collectorFixture(t);
  f.sessions.push(f.session('old'));
  f.tasks.push(task('task-7', 7), task('task-8', 8));
  f.bounded.set('old', { items: [message('old', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 'old')], cursor: null, more: false });
  await f.collect({ lookups: 0 });
  f.sessions.push(f.session('recent', { updatedAt: '2026-03-01T10:11:00.000Z' }));
  f.bounded.set('recent', { items: [message('recent', 'assistant_message', 'Created FIX-8.', 1, AT.reported, 'recent')], cursor: null, more: false });
  await f.collect({ reads: 1, lookups: 1 });
  assert.deepEqual(f.keys(), ['FIX-8'], 'the first confirmation reaches the recently updated session');
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7', 'FIX-8']);
});

function collectorFixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-collector-'));
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'fixture-sol' } }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: dir, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
  });
  const session = (id: string, extra: Record<string, unknown> = {}) => ({ id, projectId: 'FIX', title: `Session ${id}`, createdAt: AT.threadStart, updatedAt: AT.threadEnd, lineage: { parentThreadId: null, relationshipToParent: null }, ...extra });
  type Page = { items: unknown[]; cursor: string | null; more: boolean };
  const f = {
    dir, c, store: new Store(c.stateDir), t3: new T3Client(c.t3), kanvil: new KanvilClient(c.kanvil),
    sessions: [] as Record<string, unknown>[], bounded: new Map<string, Page>(), history: new Map<string, Page>(),
    tasks: [] as Record<string, unknown>[], labels: new Map<string, string[]>(), failing: new Set<string>(), down: new Set<string>(), calls: [] as string[],
    projects: [{ id: 'FIX', name: 'Fixture', slug: 'FIX' }, { id: 'OTH', name: 'Other', slug: 'OTH' }] as Record<string, unknown>[],
    session, task, message, LINK,
    collect: (budget?: { reads?: number; lookups?: number; refreshes?: number }) => collectSessionTickets(c, f.store, f.t3, f.kanvil, budget),
    status: () => sessionTicketStatus(c, f.store),
    keys: () => sessionTicketStatus(c, f.store).rows.map(r => r.key),
    // Collect until no work remains, as the service does batch after batch.
    drain: async () => { for (let n = 0; n < 50; n++) if (!await f.collect()) return; throw new Error('collection did not settle'); },
  };
  t.mock.method(f.t3, 'request', async (route: string) => {
    f.calls.push(route);
    if (f.failing.has(route) || f.down.has(route)) { f.failing.delete(route); throw new Error(`T3 ${route} returned HTTP 503`); }
    if (route === '/api/orchestration/shell') return { threads: f.sessions, archivedThreads: [], projects: [] };
    const bounded = route.match(/^\/api\/orchestration\/threads\/([^/]+)\/bounded$/);
    if (bounded) { const page = f.bounded.get(bounded[1]) ?? { items: [], cursor: null, more: false }; return { historyCursor: page.cursor, hasMoreHistory: page.more, projection: { turnItems: page.items } }; }
    const history = route.match(/^\/api\/orchestration\/threads\/([^/]+)\/history\?cursor=([^&]+)&view=conversation$/);
    if (history) { const page = f.history.get(decodeURIComponent(history[2])); if (!page) throw new Error('T3 history page returned HTTP 404'); return { items: page.items.map((item: any) => ({ sourceThreadId: item.sourceThreadId ?? history[1], item })), nextCursor: page.cursor, hasMoreHistory: page.more }; }
    throw new Error(`Unexpected T3 route ${route}`);
  });
  mockTracker(t, f.kanvil, async (name: string, args: Record<string, unknown>) => {
    f.calls.push(name);
    if (f.failing.has(name)) { f.failing.delete(name); throw new Error(`Kanvil ${name} failed; check its authenticated connection`); }
    if (name === 'labels') return [...f.labels].flatMap(([taskId, names]) => names.map(n => ({ name: n, taskId, workspaceId: 'workspace' })));
    if (name === 'projects') return structuredClone(f.projects);
    if (name === 'columns') return [{ slug: 'backlog', name: 'Backlog', isFinal: false, position: 0 }, { slug: 'todo', name: 'To do', isFinal: false, position: 0 }, { slug: 'done', name: 'Done', isFinal: true, position: 1 }];
    if (name === 'tickets') return { data: { columns: [{ tasks: f.tasks.filter(row => row.projectId === args.projectId) }] }, pagination: { totalPages: 1 } };
    if (name === 'ticketByKey') { const found = f.tasks.find(x => `${x.projectId}-${x.number}` === args.ticketId && x.projectId === args.projectId); if (!found) throw new KanvilTaskNotFound('Kanvil ticket not found or inaccessible'); return structuredClone(found); }
    if (name === 'ticket') { const found = f.tasks.find(x => x.id === args.taskId); if (!found) throw new KanvilTaskNotFound('Kanvil ticket not found or inaccessible'); return structuredClone(found); }
    throw new Error(`Unexpected Kanvil tool ${name}`);
  });
  t.after(() => { f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}

async function httpTracker(t: test.TestContext, f: ReturnType<typeof collectorFixture>, readTask: (url: URL) => unknown) {
  t.mock.method(f.kanvil, 'task', async (id: string, projectId?: string) => {
    const url = new URL(`/api/v1/projects/${projectId ?? 'FIX'}/tickets/${id}`, 'https://tracker.example');
    const row = await readTask(url);
    return row as any;
  });
}

test('session ticket keys resolve with their native project context', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
  const paths: string[] = [];
  await httpTracker(t, f, url => {
    paths.push(url.pathname);
    if (url.pathname === '/api/v1/projects/FIX/tickets/FIX-7') {
      return f.tasks[0];
    }
    throw new Error(`Unexpected tracker path ${url.pathname}`);
  });
  await f.collect();
  assert.deepEqual(f.keys(), ['FIX-7'], 'reported ticket is confirmed with the native project and key');
  assert.equal(f.status().error, null);
  assert.ok(paths.includes('/api/v1/projects/FIX/tickets/FIX-7'), 'key lookup uses the tracker endpoint directly');
});

test('missing session ticket references stop retrying without losing the known list', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
  await f.collect();
  const rec = f.store.sessionThread('s1')!;
  // Persisted failures from before the client could distinguish absence from an outage.
  rec.pending = [{ kind: 'key', value: 'FIX-404' }, { kind: 'task', value: 'missing-task' }].map(ref => ({ ...ref, kind: ref.kind as 'key' | 'task', messageId: 'missing', at: AT.reported, attempts: 4, error: 'Old generic connection error', retryAfter: '2000-01-01T00:00:00Z' }));
  f.store.saveSessionThread(rec);
  await httpTracker(t, f, url => { throw new KanvilTaskNotFound('Kanvil ticket not found or inaccessible'); });
  await f.collect();
  assert.deepEqual(f.keys(), ['FIX-7'], 'existing rows survive absent creation references');
  assert.equal(f.store.sessionThread('s1')!.pending.length, 0, 'explicitly missing task and key references are retired');
  assert.equal(f.status().error, null, 'definitive absence is not a collection failure');
  const row = f.store.sessionTicket('task-7')!;
  f.store.saveSessionTicket({ ...row, refreshAfter: '2000-01-01T00:00:00Z' });
  await f.collect();
  assert.deepEqual(f.keys(), ['FIX-7'], 'absence on refresh preserves an already listed row');
  assert.equal(f.store.sessionTicket('task-7')!.refreshedAt, row.refreshedAt);
  assert.match(f.status().error?.message ?? '', /Refreshing FIX-7: Kanvil ticket not found/);
});

test('task lookup errors without explicit absence remain retryable', async t => {
  for (const detail of ['Task not found', 'HTTP 404', 'Unauthorized (UNAUTHORIZED)', 'Forbidden (FORBIDDEN)', 'Connection failed', 'Tool not found', 'Task not found (NOT_FOUND) trailing data']) await t.test(detail, async t => {
    const f = collectorFixture(t);
    f.sessions.push(f.session('s1'));
    f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
    await httpTracker(t, f, () => { throw new Error(detail); });
    await f.collect();
    const pending = f.store.sessionThread('s1')!.pending;
    assert.equal(pending.length, 1, 'the candidate remains available for retry');
    assert.equal(pending[0].attempts, 1);
    assert.ok(pending[0].retryAfter);
    assert.match(f.status().error?.message ?? '', /Confirming FIX-7/);
  });
});

test('reports across projects become one row per confirmed task, in priority order, with their provenance', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7), task('task-3', 3, 'OTH', { status: 'todo', priority: 'urgent' }), task('task-9', 9, 'FIX', { priority: 'low' }), task('task-2', 2, 'FIX', { createdAt: '2026-02-01T00:00:00.000Z' }));
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
  f.store.saveSessionThread({ id: 's1', projectId: 'FIX', title: 'Session s1', createdAt: AT.threadStart, pending: [], upstreamReview: false }); // origin already classified for this retry scenario
  f.tasks.push(task('task-7', 7), task('task-8', 8));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 10, AT.reported, 's1')], cursor: 'older-1', more: true });
  f.history.set('older-1', { items: [message('a0', 'assistant_message', 'Created FIX-8.', 1, AT.reported, 's1')], cursor: null, more: false });
  f.failing.add('ticketByKey');
  await f.collect();
  assert.deepEqual(f.keys(), [], 'a failed confirmation lists nothing');
  assert.match(f.status().error?.message ?? '', /Confirming FIX-7/);
  const pending = f.store.sessionThread('s1')!.pending;
  assert.equal(pending.length, 1); assert.equal(pending[0].attempts, 1); assert.ok(pending[0].retryAfter);
  await f.collect({ reads: 0 });
  assert.match(f.status().error?.message ?? '', /Confirming FIX-7/, 'an unresolved lookup failure stays visible before its retry is due');
  pending[0].retryAfter = '2000-01-01T00:00:00.000Z'; f.store.saveSessionThread({ ...f.store.sessionThread('s1')!, pending });
  f.failing.add('/api/orchestration/threads/s1/history?cursor=older-1&view=conversation');
  await f.collect();
  assert.deepEqual(f.keys(), ['FIX-7'], 'the retried lookup succeeds while the page read fails');
  assert.match(f.status().error?.message ?? '', /Reading session/);
  assert.deepEqual(f.store.sessionThread('s1')!.backfill?.cursor, 'older-1', 'an interrupted page is read again from the same cursor');
  await f.collect();
  assert.equal(f.calls.filter(x => x.endsWith('cursor=older-1&view=conversation')).length, 1, 'the failed page waits for its retry deadline');
  const { retryAfter, ...rested } = f.store.sessionThread('s1')!; assert.ok(retryAfter); f.store.saveSessionThread(rested); // the deadline passes
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
  assert.deepEqual(f.calls.filter(x => !x.startsWith('/') && !['projects', 'columns', 'ticket', 'ticketByKey', 'labels'].includes(x)), [], 'collection and dismissal only read the tracker');
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
  f.tasks[0] = task('task-7', 7, 'FIX', { status: 'todo' });
  for (const row of f.store.sessionTickets()) f.store.saveSessionTicket({ ...row, refreshedAt: '2000-01-01T00:00:00.000Z', refreshAfter: '2000-01-01T00:00:00.000Z' });
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-8'], 'a consumed entry stays consumed after its run finishes and the ticket returns to ready');
  // Tracker status drives membership for the remaining entry; a failed refresh keeps the old reading and says so.
  const refresh = async (status: string) => { f.tasks[1] = task('task-8', 8, 'FIX', { status }); f.store.saveSessionTicket({ ...f.store.sessionTicket('task-8')!, refreshedAt: '2000-01-01T00:00:00.000Z', refreshAfter: '2000-01-01T00:00:00.000Z' }); await f.drain(); };
  await refresh('in-progress'); assert.deepEqual(f.keys(), [], 'in-progress tickets are hidden');
  await refresh('todo'); assert.deepEqual(f.keys(), ['FIX-8'], 'a ticket back in the ready column returns');
  f.failing.add('ticket'); await refresh('done');
  const stale = f.status().rows[0];
  assert.equal(stale.key, 'FIX-8'); assert.match(stale.refreshError ?? '', /ticket failed/); assert.equal(stale.refreshedAt, '2000-01-01T00:00:00.000Z', 'a failed read is not presented as fresh');
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
  const failing = () => { f.failing.add('ticket'); };
  mockTracker(t, f.kanvil, async (name: string, args: Record<string, unknown>) => { f.calls.push(name); if (name === 'ticket') throw new Error('Kanvil ticket failed; check its authenticated connection'); if (name === 'labels') return []; throw new Error(name); });
  failing();
  const reads = () => f.calls.filter(x => x === 'ticket').length;
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
  t.mock.method(Kanvil.prototype, 'connect', async () => { throw new Error('Kanvil MCP process exited'); });
  const service = new FactoryService(f.path);
  try {
    await service.start();
    const published = await f.until(s => s.sessionTickets?.error);
    assert.match(published.sessionTickets?.error?.message ?? '', /Kanvil MCP process exited/, 'a setup failure reaches status.sessionTickets.error');
  } finally { await service.stop(); }
});

test('a reference to a project the cached catalog does not know forces one fresh catalog read before it is dropped', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7']);
  // A project created after the catalog was cached, and a ticket in it reported by a new session.
  f.projects.push({ id: 'NEW', name: 'Newcomer', slug: 'NEW' });
  f.tasks.push(task('task-n1', 1, 'NEW', { status: 'todo' }), task('task-n2', 2, 'NEW', { status: 'todo', priority: 'low' }));
  f.sessions.push(f.session('s2'));
  f.bounded.set('s2', { items: [message('b1', 'assistant_message', `Created NEW-1 and [NEW-2](${LINK('task-n2')}); the SHA-256 digest is unchanged.`, 1, AT.reported, 's2')], cursor: null, more: false });
  const catalogReads = () => f.calls.filter(x => x === 'projects').length;
  const before = catalogReads();
  await f.drain();
  assert.deepEqual(f.keys(), ['FIX-7', 'NEW-1', 'NEW-2'], 'tickets in a newly listed project are kept');
  assert.equal(catalogReads(), before + 1, 'one uncached catalog read per batch, not one per miss');
  assert.deepEqual(f.store.sessionThread('s2')?.pending, [], 'a key that is still not a project after the refresh is dropped, not retried');
});

test('failed session reads back off before the batch continues, so an outage neither loops nor starves later sessions', async t => {
  const f = collectorFixture(t);
  for (let n = 1; n <= 9; n++) { f.sessions.push(f.session(`s${n}`)); f.down.add(`/api/orchestration/threads/s${n}/bounded`); }
  const reads = () => f.calls.filter(x => x.endsWith('/bounded')).length;
  assert.equal(await f.collect(), true, 'the ninth session is still unread after eight failed reads');
  assert.equal(reads(), 8);
  assert.equal(await f.collect(), false, 'the ninth session gets its read while the failed eight wait for their retry deadline');
  assert.equal(reads(), 9);
  assert.equal(await f.collect(), false);
  assert.equal(reads(), 9, 'a T3 outage does not loop on the same sessions');
  assert.match(f.status().error?.message ?? '', /Reading session/);
  assert.ok(f.store.sessionThreads().every(r => r.retryAfter && r.updatedAt === undefined), 'failed sessions keep no progress and carry a retry deadline');
  f.sessions.length = 0;
  await f.collect();
  assert.equal(f.status().error, null, 'failures of sessions T3 no longer lists do not keep the notice up');
});

test('a realtime session-ticket projection refreshes from events rather than the age of its last read', async t => {
  const f = collectorFixture(t);
  Object.defineProperty(f.kanvil, 'realtime', { value: true, configurable: true });
  f.tasks.push(task('task-7', 7)); f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
  await f.collect();
  const row = f.store.sessionTicket('task-7')!;
  f.store.saveSessionTicket({ ...row, refreshAfter: '2000-01-01T00:00:00Z' });
  f.tasks[0].title = 'Changed'; f.calls.length = 0;
  await f.collect();
  assert.ok(!f.calls.includes('ticket'), 'an elapsed fallback timer must not poll Kanvil');
  f.store.saveSessionTicket({ ...f.store.sessionTicket('task-7')!, refreshAfter: new Date(0).toISOString() });
  await f.collect();
  assert.equal(f.store.sessionTicket('task-7')!.title, 'Changed', 'an event invalidation refreshes the saved row');
});

test('session tickets in an unconfigured Kanvil project use the native To do category', async t => {
  const f = collectorFixture(t);
  t.mock.method(f.kanvil, 'columns', async () => [
    { slug: 'backlog', name: 'Backlog', isFinal: false, position: 0 },
    { slug: 'todo', name: 'To do', isFinal: false, position: 0 },
    { slug: 'done', name: 'Done', isFinal: true, position: 0 },
    { slug: 'cancelled', name: 'Cancelled', isFinal: true, position: 0 },
  ]);
  f.tasks.push(task('other-ticket', 3, 'OTH'));
  f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created OTH-3.', 1, AT.reported, 's1')], cursor: null, more: false });
  await f.collect();
  assert.deepEqual(f.keys(), ['OTH-3'], 'the native Backlog category must not hide To do tickets');
  assert.equal(f.status().rows[0].unavailable, 'Project not configured in Factory');
});

test('an event during initial confirmation cannot strand stale session-ticket metadata', async t => {
  const f = collectorFixture(t);
  Object.defineProperty(f.kanvil, 'realtime', { value: true, configurable: true });
  f.tasks.push(task('task-7', 7)); f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
  const original = f.kanvil.task.bind(f.kanvil), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let first = true;
  t.mock.method(f.kanvil, 'task', async (id: string, projectId?: string) => {
    const result = await original(id, projectId);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return result;
  });
  const collecting = f.collect(); await entered.promise;
  f.tasks[0].title = 'Changed while confirming'; f.kanvil.revision++;
  release.resolve(); await collecting; await f.drain();
  assert.equal(f.store.sessionTicket('task-7')!.title, 'Changed while confirming', 'a new row must retain an invalidation that arrived before it existed');
});

test('a moved session ticket refreshes current identity and preserves provenance', async t => {
  const f = collectorFixture(t);
  f.tasks.push(task('task-7', 7)); f.sessions.push(f.session('s1'));
  f.bounded.set('s1', { items: [message('a1', 'assistant_message', 'Created FIX-7.', 1, AT.reported, 's1')], cursor: null, more: false });
  await f.collect();
  const saved = f.store.sessionTicket('task-7')!, original = f.kanvil.task.bind(f.kanvil);
  f.tasks[0] = task('task-7', 11, 'OTH', { key: 'OTH-11', title: 'Moved ticket' });
  t.mock.method(f.kanvil, 'task', async (id: string, projectId?: string) => {
    if (projectId === 'FIX') throw new KanvilTaskNotFound('Ticket moved from the source project');
    return original(id, projectId);
  });
  f.store.saveSessionTicket({ ...saved, refreshAfter: new Date(0).toISOString() });
  await f.collect();
  const moved = f.store.sessionTicket('task-7')!;
  assert.deepEqual([moved.projectId, moved.key, moved.number, moved.title], ['OTH', 'OTH-11', 11, 'Moved ticket']);
  assert.deepEqual(moved.sources, saved.sources);
});
