import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cycle, refreshInventory } from '../src/scheduler.ts';
import { T3 } from '../src/clients.ts';
import type { OverrideLimits } from '../src/config.ts';
import type { ReconcileEvidence } from '../src/store.ts';
import { v2Thread } from './v2-fixture.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

type Fixture = ReturnType<typeof dispatchFixture>;
const none: ReconcileEvidence = { threads: [], refs: [], openPR: false };
// Earlier work that holds FIX-1 back, and work that holds it for another reason.
const leftovers: Record<string, (f: Fixture) => void> = {
  thread: f => { f.threads.push(v2Thread({ id: 'earlier', projectId: 'FIX', title: 'FIX-1 earlier attempt', status: 'completed' })); },
  branch: f => {
    const git = (...args: string[]) => execFileSync('git', ['-C', f.c.projects[0].repoPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args]);
    git('commit', '-q', '--allow-empty', '-m', 'base'); git('branch', 'feat/FIX-1-earlier');
  },
  pr: f => { writeFileSync(join(f.dir, 'prs'), JSON.stringify([{ title: 'FIX-1: earlier work', headRefName: 'feat/elsewhere', body: '' }])); },
  // A finished run's PR that GitHub cannot confirm merged.
  unverified: f => { f.store.save({ id: 'finished', kind: 'ticket', projectId: 'FIX', taskId: 'root', ticketKey: 'FIX-1', threadId: 'finished-thread', messageId: 'm', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Merged', lastPersonalActivity: null, reportPath: join(f.dir, 'finished.json'), prUrls: ['https://github.com/fixture/FIX/pull/7'], command: { workspaceStrategy: { type: 'worktree', branch: 'feat/FIX-1-factory-finished' } } }); },
  difficulty: f => { f.tasks[0].labels = [{ name: 'sf' }]; },
};
const expected: Record<string, { reason: RegExp; conflict?: 'artifacts'; evidence?: ReconcileEvidence }> = {
  thread: { reason: /^Existing T3 thread or branch references this ticket$/, conflict: 'artifacts', evidence: { ...none, threads: ['earlier'] } },
  branch: { reason: /^Existing Git branch references this ticket$/, conflict: 'artifacts', evidence: { ...none, refs: ['refs/heads/feat/FIX-1-earlier'] } },
  pr: { reason: /^Existing open PR references this ticket$/, conflict: 'artifacts', evidence: { ...none, openPR: true } },
  unverified: { reason: /^Previous work could not be verified/, conflict: 'artifacts', evidence: none },
  difficulty: { reason: /needs a native difficulty/ },
};
for (const [name, arrange] of Object.entries(leftovers)) test(`a ticket held back by ${name} ${expected[name].conflict ? 'carries the artifacts code and its evidence' : 'carries no conflict code'} into the queue`, async t => {
  const f = dispatchFixture(t);
  arrange(f);
  await refreshInventory(f.c, f.store, f.t3, f.kanvil);
  const row = JSON.parse(f.store.get('upNext')!).held.find((h: { key: string }) => h.key === 'FIX-1');
  assert.match(row.reason, expected[name].reason);
  assert.deepEqual([row.conflict, row.evidence], [expected[name].conflict, expected[name].evidence]);
});

const reconcileRun = (f: Fixture, overrideLimits: OverrideLimits = ['idle', 'reserve', 'labels']) =>
  cycle(f.c, f.store, { manual: true, model: 'auto', reconcile: 'FIX-1', overrideLimits }, { t3: f.t3, kanvil: f.kanvil });

test('a reconcile run starts for a ticket held back by earlier work, in its own thread and chore branch', async t => {
  const f = dispatchFixture(t);
  leftovers.thread(f);
  assert.equal((await reconcileRun(f)).reason, 'dispatched');
  const [launch] = f.launches as { title: string; workspaceStrategy: { branch: string } }[], [job] = f.store.jobs();
  assert.equal(launch.title, 'Factory reconcile: FIX-1');
  assert.match(launch.workspaceStrategy.branch, /^chore\/factory-reconcile-[0-9a-f]{8}$/);
  assert.deepEqual([job.kind, job.taskId, job.ticketKey, job.reconcile?.threads], ['reconcile', 'root', 'FIX-1', ['earlier']]);
  assert.deepEqual(job.labels, ['sf', 'med'], 'the run keeps the ticket labels that decide its prompt guards and label slots');
});

// A reconcile frees a ticket from an abandoned session by archiving its thread: T3 lists archived threads apart,
// and the queue reads only the active ones. Settling alone leaves the thread referencing the ticket.
for (const archived of [true, false]) test(`${archived ? 'an archived' : 'a settled'} thread that names the ticket ${archived ? 'no longer holds it back' : 'still holds it back'}`, async t => {
  const f = dispatchFixture(t), t3 = new T3(f.c.t3);
  const thread = v2Thread({ id: 'earlier', projectId: 'FIX', title: 'FIX-1 earlier attempt', status: 'completed', settledOverride: 'settled', branch: null, worktreePath: null, ...archived ? { archivedAt: '2026-01-02T00:00:00.000Z' } : {} });
  t.mock.method(t3, 'request', async (route: string) => {
    assert.equal(route, '/api/orchestration/shell');
    return { threads: archived ? [] : [thread], archivedThreads: archived ? [thread] : [], projects: [{ id: 'FIX', title: 'FIX', workspaceRoot: f.c.projects[0].repoPath }] };
  });
  await refreshInventory(f.c, f.store, t3, f.kanvil);
  const queue = JSON.parse(f.store.get('upNext')!);
  assert.deepEqual([queue.tickets.map((row: { key: string }) => row.key), queue.held.map((row: { key: string }) => row.key)], archived ? [['FIX-1'], []] : [[], ['FIX-1']]);
});

// Each refusal leaves nothing launched. Provider capacity and quota bind a reconcile like any manual start.
const refusals: Record<string, { arrange: (f: Fixture, t: TestContext) => Promise<unknown> | void; reason: string; message?: RegExp; overrideLimits?: OverrideLimits }> = {
  'a ticket nothing holds back': { arrange: () => {}, reason: 'reconcile-not-needed' },
  'a second request while one is open': { arrange: async f => { leftovers.thread(f); assert.equal((await reconcileRun(f)).reason, 'dispatched'); f.launches.length = 0; }, reason: 'reconcile-running' },
  'an exhausted allowance': { arrange: (f, t) => {
    leftovers.thread(f);
    t.mock.method(f.t3, 'provider', async () => { const p = f.provider(); p.usageLimits.windows[0].usedPercent = 100; return p; });
  }, reason: 'no-ready-model', message: /quota-exhausted/, overrideLimits: true },
  'a full provider': { arrange: f => {
    leftovers.thread(f);
    f.c.concurrency.codex = 0; writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  }, reason: 'no-ready-model', message: /provider limit is Off/ },
};
for (const [name, refusal] of Object.entries(refusals)) test(`a reconcile request is refused for ${name}`, async t => {
  const f = dispatchFixture(t);
  await refusal.arrange(f, t);
  const result = await reconcileRun(f, refusal.overrideLimits) as { reason: string; message?: string };
  assert.equal(result.reason, refusal.reason);
  if (refusal.message) assert.match(result.message ?? '', refusal.message);
  assert.equal(f.launches.length, 0);
});
