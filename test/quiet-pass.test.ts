import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type DecisionOrigin, type Job, type Plan, type PlanTicket } from '../src/store.ts';
import { deferred, serviceFixture } from './dispatch-fixture.ts';
import { fixtureSocket } from './rpc-fixture.ts';
import { v2Shell, v2Thread } from './v2-fixture.ts';
import type { Thread } from '../src/policy.ts';

// A tickets lane with nothing to start: the only ready-status ticket is blocked by unfinished work and discovery is cooling down.
// Kanvil reports its changes through revision, which the tracker tests own. T3 reports through admissionRevision: stubbed
// here as a counter, or computed by a live client (liveLane) when a test shows which T3 changes move it.
function quietLane(t: TestContext, options: { live?: boolean } = {}) {
  const f = serviceFixture(t), inputs = { views: 1 };
  Object.defineProperty(f.t3, 'admissionRevision', { value: () => options.live === false ? undefined : String(inputs.views) });
  return { ...lane(t, f), inputs };
}
function lane<F extends ReturnType<typeof serviceFixture>>(t: TestContext, f: F) {
  const details: string[] = [];
  f.tasks[1].status = 'in_progress';
  f.store.set('discoveryAfter:FIX', String(Date.now() + 86_400_000));
  t.mock.method(f.t3, 'detail', async (id: string) => { details.push(id); return { messages: [], responses: [] }; });
  Object.defineProperty(f.kanvil, 'synchronized', { get: () => true });
  const pass = (reason = 'timer') => f.internal.pass({}, reason, 0, 'tickets', 'codex');
  // Reads of T3, quota, inventory and Kanvil all land in calls; thread details in details.
  const reads = () => f.calls.length + details.length;
  return { ...f, pass, reads };
}

// A live T3 client over a fake socket: one shell snapshot of `threads` and the fixture's provider, then `send` streams thread updates and `shell` any shell event.
async function liveLane(t: TestContext, threads: Thread[]) {
  const f = lane(t, serviceFixture(t, { liveT3: true }));
  let shellRequest = '', configRequest = '', sequence = 43;
  const ready = Promise.withResolvers<void>(), probed: (() => void)[] = [], bounded = Promise.withResolvers<unknown>();
  // An orphaned-run probe waits for the bounded projection a test answers with; teardown answers that it is unavailable.
  t.mock.method(f.t3, 'request', async (path: string) => { const reply = path.endsWith('/bounded') && await bounded.promise; if (reply) return reply; throw new Error('unavailable'); });
  f.beforeClose.unshift(() => bounded.resolve(undefined));
  const socket = fixtureSocket(t, request => {
    if (request.tag === 'orchestration.subscribeShell') { shellRequest = request.id; return [{ _tag: 'Chunk', requestId: request.id, values: [{ kind: 'snapshot', snapshot: v2Shell(threads) }] }]; }
    if (request.tag === 'subscribeServerConfig') { configRequest = request.id; return [{ _tag: 'Chunk', requestId: request.id, values: [{ type: 'snapshot', config: { providers: [f.provider()] } }] }]; }
    return [{ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: null } }];
  });
  const controller = new AbortController();
  const stream = f.t3.subscribe((item: any) => { if (item.kind === 'providers.updated') ready.resolve(); if (item.kind === 'runtime.probed') probed.shift()?.(); }, controller.signal);
  f.beforeClose.unshift(async () => { controller.abort(); await stream; });
  await ready.promise;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const shell = async (event: Record<string, unknown>) => { socket.respond(shellRequest, event.kind === 'snapshot' ? event : { ...event, sequence: sequence++ }, true); await settle(); };
  return { ...f, shell,
    send: (thread: Thread, location = 'active') => shell({ kind: 'thread.updated', location, thread }),
    snapshot: (shellThreads: Thread[]) => shell({ kind: 'snapshot', snapshot: { ...v2Shell(shellThreads), snapshotSequence: sequence++ } }),
    providers: async (providers: unknown[]) => { socket.respond(configRequest, { type: 'providerStatuses', payload: { providers } }, true); await settle(); },
    probed: () => new Promise<void>(resolve => probed.push(resolve)), bounded,
  };
}
const now = () => new Date().toISOString();
const running = (id: string, overrides: Record<string, unknown> = {}) => v2Thread({ id, status: 'running', activeRunId: `run-${id}`, latestRunCompletedAt: null, updatedAt: now(), ...overrides });

test('a repeated quiet pass with unchanged inputs makes no reads and returns the stored decision', async t => {
  const f = quietLane(t);
  const first = await f.pass();
  assert.equal(first.reason, 'watching-streams');
  assert.ok(f.calls.some(call => call.startsWith('tickets:')), 'the first pass reads the inventory');
  const reads = f.reads();
  assert.deepEqual(await f.pass(), first);
  assert.equal(f.reads(), reads, 'no inventory, Kanvil, T3 shell, provider or thread-detail read');
});

// Each input that drops the held decision, and the components its pass line names in `miss`.
for (const [input, miss, change] of [
  ['the T3 admission revision', ['t3'], f => { f.inputs.views++; }],
  ['a Kanvil ticket version', ['kanvil'], f => { f.tasks[0].version = 2; f.kanvil.revision++; }],
  ['a job write', ['store'], f => { f.store.save({ id: 'other', kind: 'ticket', projectId: 'FIX', taskId: 'other', ticketKey: 'FIX-9', threadId: 'thread-other', messageId: 'm', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), state: 'complete', reason: 'Done', lastPersonalActivity: null, reportPath: '/dev/null', prUrls: [], command: {} }); }],
  ['the prepared Up next list', ['store'], f => { f.store.set('upNext', JSON.stringify({ tickets: [], held: [] })); }],
  ['the configuration', ['config'], f => { writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify({ ...f.c, idleMinutes: 2 })); }],
  ['T3 and Kanvil together', ['t3', 'kanvil'], f => { f.inputs.views++; f.kanvil.revision++; }],
] satisfies [string, string[], (f: ReturnType<typeof quietLane>) => unknown][]) test(`changing ${input} makes the next pass run in full and names ${miss.join(' and ')} in miss`, async t => {
  const f = quietLane(t);
  await f.pass(); await f.pass();
  const reads = f.reads();
  verbose(t);
  const lines = logLines(t) as { event: string; miss?: string[] }[];
  await change(f);
  await f.pass();
  assert.ok(f.reads() > reads);
  assert.deepEqual(lines.filter(line => line.event === 'pass').map(line => line.miss), [miss]);
});

// A ticket lock moves the store revision only when it goes away after an admission read saw it held.
for (const [name, steps, bumps] of [
  ['a lock nobody checked', s => { s.tryLock('ticket:a')!(); }, 0],
  ['a lock an admission read saw', s => { const release = s.tryLock('ticket:a')!; assert.equal(s.isLocked('ticket:a'), true); release(); }, 1],
  ['a lock seen while a second holder waits', async s => {
    const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>(), revisions: number[] = [];
    const a = s.exclusive(['ticket:a'], () => first.promise), b = s.exclusive(['ticket:a'], async () => { revisions.push(s.revision); await second.promise; });
    assert.equal(s.isLocked('ticket:a'), true);
    const start = s.revision; first.resolve(); await a;
    while (!revisions.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(revisions[0], start, 'the lock is still held, so the first release changes nothing');
    second.resolve(); await b;
  }, 1],
] satisfies [string, (s: Store) => unknown, number][]) test(`releasing ${name} moves the store revision by ${bumps}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-locks-')), store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const before = store.revision;
  await steps(store);
  assert.equal(store.revision - before, bumps);
});

// Plan notes and every job field outside JOB_INPUTS are display only: the row keeps them, the store revision does not move.
const planTicket = (key: string, note?: string): PlanTicket => ({ id: key, key, title: key, projectId: 'FIX', status: 'todo', priority: 'medium', createdAt: '2026-01-01T00:00:00.000Z', runnable: true, blockedBy: [], done: false, ...note ? { note } : {} });
const activePlan = (note: string, changes: Partial<Plan> = {}): Plan => ({ id: 'plan', createdAt: '2026-01-01T00:00:00.000Z', target: planTicket('FIX-2', note), tickets: [planTicket('FIX-1', note)], model: 'auto', overrideLimits: false, state: 'active', ...changes });
const runningJob = (at: string, changes: Partial<Job> = {}): Job => ({ id: 'job', kind: 'ticket', projectId: 'FIX', taskId: 'running', ticketKey: 'FIX-9', threadId: 'thread-running', messageId: 'm', createdAt: '2026-01-01T00:00:00.000Z', state: 'running', reason: 'Claude is executing', lastPersonalActivity: null, reportPath: '/dev/null', prUrls: [], completedAt: null, lastExecutionAt: at, thread: { title: 'Run', status: 'running', branch: 'b', worktreePath: '/w', updatedAt: at, pending: null, background: [] }, ...changes });
for (const [name, write, bumps] of [
  ['a plan whose notes alone change', activePlan('quota-reserve'), 0],
  ['a plan whose state changes', activePlan('personal-provider-running', { state: 'cancelled' }), 1],
  ['a plan whose ticket list changes', activePlan('personal-provider-running', { tickets: [] }), 1],
  ['a plan whose target changes', activePlan('personal-provider-running', { target: { ...planTicket('FIX-2'), done: true } }), 1],
  ['a running job whose progress timestamps alone change', runningJob('2026-01-01T00:01:00.000Z'), 0],
  ['a running job whose state changes', runningJob('2026-01-01T00:00:00.000Z', { state: 'waiting' }), 1],
  // Display and maintenance fields: no admission reader looks at them.
  ...Object.entries({
    workspaceCleanupAttemptedAt: '2026-01-01T00:05:00.000Z', workspaceCleanupError: 'Worktree has uncommitted changes', workspaceCleanupBlockedAt: '2026-01-01T00:05:00.000Z',
    workspaceCleanup: { path: '/w', branch: 'b', head: 'abc' }, workspaceCleanedAt: '2026-01-01T00:06:00.000Z', commandStop: { status: 'requested', requestedAt: '2026-01-01T00:05:00.000Z' },
    reason: 'Waiting on pull request checks and review', thread: { title: 'Run', status: 'ready', branch: 'b', worktreePath: '/w', updatedAt: '2026-01-01T00:00:00.000Z', pending: 'checks', background: ['ci'] },
    prUrls: ['https://github.com/o/r/pull/1'], resumedAt: '2026-01-01T00:05:00.000Z',
  }).map(([field, value]) => [`a running job whose ${field} alone changes`, runningJob('2026-01-01T00:00:00.000Z', { [field]: value }), 0] as [string, Job, number]),
  // Admission inputs: JOB_INPUTS in src/store.ts names each one's reader.
  ...Object.entries({
    state: 'complete', taskId: 'other', labels: ['app'], modelSelection: { instanceId: 'codex', model: 'gpt', options: [] }, providerDriver: 'codex',
    completedAt: '2026-01-01T00:05:00.000Z', dismissedAt: '2026-01-01T00:05:00.000Z', upstream: { name: 'Up', repo: 'o/up', base: 'v1', candidate: 'v2' },
    repair: { workflow: 'CI', runId: 1, runUrl: 'https://github.com/o/r/actions/runs/1', sha: 'abc', failedJobs: ['test'] }, lastPersonalActivity: '2026-01-01T00:05:00.000Z',
  }).map(([field, value]) => [`a running job whose ${field} changes`, runningJob('2026-01-01T00:00:00.000Z', { [field]: value }), 1] as [string, Job, number]),
] satisfies [string, Plan | Job, number][]) test(`saving ${name} moves the store revision by ${bumps}`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-saves-')), store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.savePlan(activePlan('personal-provider-running')); store.save(runningJob('2026-01-01T00:00:00.000Z'));
  const before = store.revision;
  if ('tickets' in write) store.savePlan(write); else store.save(write);
  assert.equal(store.revision - before, bumps);
  assert.deepEqual('tickets' in write ? store.plan(write.id) : store.job(write.id), write, 'the row holds what was saved');
});

test('a plan note flapping between hold reasons and a running job advancing its progress timestamps leave the held decision', async t => {
  const f = quietLane(t);
  f.store.savePlan(activePlan('personal-provider-running', { tickets: [], target: { ...planTicket('FIX-8', 'personal-provider-running'), runnable: false } }));
  f.store.save(runningJob(now(), { taskId: 'elsewhere', ticketKey: 'FIX-8' }));
  const first = await f.pass();
  await f.pass();
  const reads = f.reads();
  verbose(t);
  const lines = logLines(t) as { event: string; skipped?: true; miss?: string[] }[];
  for (const note of ['quota-reserve', 'personal-provider-running', 'quota-reserve']) {
    const plan = f.store.plan('plan')!;
    f.store.savePlan({ ...plan, target: { ...plan.target!, note } });
    const at = now();
    f.store.save({ ...f.store.job('job')!, lastExecutionAt: at, thread: { ...f.store.job('job')!.thread!, updatedAt: at } });
    assert.deepEqual(await f.pass(), first);
  }
  assert.equal(f.reads(), reads, 'no cycle: no inventory, Kanvil, T3 shell, provider or thread-detail read');
  assert.deepEqual(lines.filter(line => line.event === 'pass').map(line => [line.skipped, line.miss]), [[true, undefined], [true, undefined], [true, undefined]]);
});

test('a blocked cleanup attempt on a finished job leaves the held decision and that job changing state drops it', async t => {
  const f = quietLane(t);
  f.store.save(runningJob(now(), { taskId: 'old', ticketKey: 'FIX-7', state: 'complete', completedAt: now(), reason: 'Delivered', workspaceCleanup: { path: '/w', branch: 'b', head: 'abc' } }));
  const first = await f.pass();
  await f.pass();
  const reads = f.reads();
  verbose(t);
  const lines = logLines(t) as { event: string; skipped?: true; miss?: string[] }[];
  const at = now();
  f.store.save({ ...f.store.job('job')!, workspaceCleanupAttemptedAt: at, workspaceCleanupError: 'Worktree has uncommitted changes', workspaceCleanupBlockedAt: at, reason: 'Cleanup blocked' });
  assert.deepEqual(await f.pass(), first);
  assert.equal(f.reads(), reads, 'no cycle: no inventory, Kanvil, T3 shell, provider or thread-detail read');
  f.store.save({ ...f.store.job('job')!, state: 'dismissed', dismissedAt: now() });
  await f.pass();
  assert.ok(f.reads() > reads);
  assert.deepEqual(lines.filter(line => line.event === 'pass').map(line => [line.skipped, line.miss]), [[true, undefined], [undefined, ['store']]]);
});

test('background work that takes and releases a ticket lock nobody checked leaves the held decision', async t => {
  const f = quietLane(t);
  const first = await f.pass();
  await f.pass();
  const reads = f.reads();
  verbose(t);
  const lines = logLines(t) as { event: string; skipped?: true; miss?: string[] }[];
  await f.store.exclusive(['ticket:root'], async () => {});
  assert.deepEqual(await f.pass(), first);
  assert.equal(f.reads(), reads, 'no cycle: no inventory, Kanvil, T3 shell, provider or thread-detail read');
  assert.deepEqual(lines.filter(line => line.event === 'pass').map(line => [line.skipped, line.miss]), [[true, undefined]]);
});

test('a pass that left out a locked candidate runs in full once that lock goes away and names store in miss', async t => {
  const f = quietLane(t);
  f.tasks[1].status = 'done'; // root is ready, so only its lock keeps this lane quiet
  const release = f.store.tryLock('ticket:root')!;
  const first = await f.pass();
  assert.deepEqual(await f.pass(), first, 'the lock is still held');
  const reads = f.reads();
  verbose(t);
  const lines = logLines(t) as { event: string; miss?: string[] }[];
  release();
  await f.pass();
  assert.ok(f.reads() > reads);
  assert.deepEqual(lines.filter(line => line.event === 'pass').map(line => line.miss), [['store']]);
});

test('a lane held by a preparation\'s label reservation runs in full once that preparation fails and names store in miss', async t => {
  const f = quietLane(t);
  f.tasks[1].status = 'done';
  f.c.projects[0].labelLimits = { app: 1 }; f.tasks[0].labels!.push({ name: 'app' });
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  // A manual start holds root's lock and the only app slot while it prepares its launch, then fails.
  const preparing = Promise.withResolvers<void>(), fail = Promise.withResolvers<void>();
  t.mock.method(f.t3, 'prepareLaunch', async () => { preparing.resolve(); await fail.promise; throw new Error('Fixture connection failed'); });
  const manual = f.run().catch((error: Error) => ({ reason: error.message }));
  await preparing.promise;
  const first = await f.pass();
  assert.equal((first.streams as { driver: string; reason: string }[]).find(s => s.driver === 'codex')!.reason, 'label-limit');
  assert.deepEqual(await f.pass(), first, 'the preparation still holds the slot');
  const reads = f.reads();
  verbose(t);
  const lines = logLines(t) as { event: string; miss?: string[] }[];
  fail.resolve();
  assert.notEqual((await manual).reason, 'dispatched');
  assert.equal(f.store.jobs().length, 0);
  lines.length = 0;
  await f.pass();
  assert.ok(f.reads() > reads);
  assert.deepEqual(lines.filter(line => line.event === 'pass').map(line => line.miss), [['store']]);
});

test('a running thread streaming messages leaves the admission revision and the held decision', async t => {
  const thread = running('streaming'), f = await liveLane(t, [thread, v2Thread({ id: 'idle' })]);
  const first = await f.pass();
  await f.pass();
  const reads = f.reads(), revisions = new Set<string | undefined>();
  for (let item = 3; item < 8; item++) {
    await f.send({ ...thread, updatedAt: now(), latestUserMessageAt: now(), itemCount: item, visibleItemCount: item,
      latestVisibleMessage: { role: 'assistant', text: `Part ${item}` }, tokenUsage: { inputTokens: item * 1000, outputTokens: item * 100 } } as Thread);
    assert.deepEqual(await f.pass(), first);
    assert.equal(f.reads(), reads, 'no inventory, reconcile, Kanvil, T3 shell, provider or thread-detail read');
    revisions.add(f.t3.admissionRevision());
  }
  assert.equal(revisions.size, 1);
});

for (const [change, apply] of Object.entries({
  'a thread starts running': f => f.send(running('idle')),
  'a thread stops': f => f.send({ ...running('streaming'), status: 'completed', activeRunId: null, latestRunCompletedAt: now() }),
  'a thread is archived': f => f.send(v2Thread({ id: 'idle', archivedAt: now() }), 'archive'),
  'orphanedRun flips': async f => {
    // The stalled thread's run is still active; its provider session stopped.
    const probed = f.probed();
    f.bounded.resolve({ projection: { runs: [{ id: 'run-stalled', status: 'running' }], providerSessions: [{ status: 'stopped' }] } });
    await probed;
  },
  "a provider's status": f => f.providers([{ ...f.provider(), status: 'error' }]),
  "a provider's quota": f => { const provider = f.provider(); provider.usageLimits.windows[0].usedPercent = 40; return f.providers([provider]); },
} satisfies Record<string, (f: Awaited<ReturnType<typeof liveLane>>) => Promise<unknown> | void>)) test(`${change} changes the admission revision and the next pass runs in full`, async t => {
  const f = await liveLane(t, [running('streaming'), v2Thread({ id: 'idle' }), running('stalled', { updatedAt: '2026-01-01T00:00:00.000Z' })]);
  await f.pass(); await f.pass();
  const reads = f.reads(), revision = f.t3.admissionRevision();
  await apply(f);
  assert.notEqual(f.t3.admissionRevision(), revision);
  await f.pass();
  assert.ok(f.reads() > reads);
});

// Every admission input outside the passes above. Each case starts from the same shell and changes one thing.
const project = { id: 'project-2', title: 'Other project', workspaceRoot: '/tmp/other-repo' };
for (const [change, apply] of Object.entries({
  'a pending runtime request': f => f.send(v2Thread({ id: 'idle', pendingRuntimeRequest: { kind: 'user_input', createdAt: now() } })),
  'a background task': f => f.send(v2Thread({ id: 'idle', pendingBackgroundTasks: [{ taskId: 'task', kind: 'monitor' }] })),
  'a pull request link': f => f.send(v2Thread({ id: 'idle', pullRequests: [{ url: 'https://github.com/fixture/repo/pull/1', source: 'explicit' }] })),
  'a branch': f => f.send(v2Thread({ id: 'idle', branch: 'fixture-branch' })),
  'a worktree': f => f.send(v2Thread({ id: 'idle', worktreePath: '/tmp/fixture-worktree' })),
  'lineage': f => f.send(v2Thread({ id: 'idle', lineage: { rootThreadId: 'parent', parentThreadId: 'parent', relationshipToParent: 'subagent' } })),
  'a settled override': f => f.send(v2Thread({ id: 'idle', settledOverride: 'settled' })),
  'a pin': f => f.send(v2Thread({ id: 'idle', pinnedAt: now() })),
  'the auto-settle flag': f => f.send(v2Thread({ id: 'idle', autoSettleDisabledAt: now() })),
  'a title': f => f.send(v2Thread({ id: 'idle', title: 'Renamed' })),
  'the provider instance': f => f.send(v2Thread({ id: 'idle', providerInstanceId: 'codex' })),
  'the model': f => f.send(v2Thread({ id: 'idle', modelSelection: { instanceId: 'claudeAgent', model: 'claude-other' } })),
  'a thread is removed': f => f.shell({ kind: 'thread.removed', threadId: 'idle' }),
  'a project is added': f => f.shell({ kind: 'project.updated', project }),
  'a project changes': f => f.shell({ kind: 'project.updated', project: { ...v2Shell().projects[0], title: 'Renamed project' } }),
  'a project is removed': f => f.shell({ kind: 'project.removed', projectId: 'project-1' }),
  'a snapshot differs': f => f.snapshot([v2Thread({ id: 'idle', title: 'Renamed' })]),
} satisfies Record<string, (f: Awaited<ReturnType<typeof liveLane>>) => Promise<unknown>>)) test(`${change} changes the admission revision`, async t => {
  const f = await liveLane(t, [v2Thread({ id: 'idle' })]), revision = f.t3.admissionRevision();
  await apply(f);
  assert.notEqual(f.t3.admissionRevision(), revision);
});

test('a snapshot with the same admission content leaves the admission revision', async t => {
  const f = await liveLane(t, [v2Thread({ id: 'idle' })]), revision = f.t3.admissionRevision();
  await f.snapshot([v2Thread({ id: 'idle', updatedAt: now(), latestUserMessageAt: now(), itemCount: 9 })]);
  assert.equal(f.t3.admissionRevision(), revision);
});

test('a thread moving back from the archive changes the admission revision', async t => {
  const f = await liveLane(t, [v2Thread({ id: 'idle' })]);
  await f.send(v2Thread({ id: 'idle', archivedAt: now() }), 'archive');
  const revision = f.t3.admissionRevision();
  await f.send(v2Thread({ id: 'idle' }));
  assert.notEqual(f.t3.admissionRevision(), revision);
});

test('a cleared orphan verdict changes the admission revision', async t => {
  const f = await liveLane(t, [running('stalled', { updatedAt: '2026-01-01T00:00:00.000Z' })]), probed = f.probed();
  f.t3.admissionRevision();
  f.bounded.resolve({ projection: { runs: [{ id: 'run-stalled', status: 'running' }], providerSessions: [{ status: 'stopped' }] } });
  await probed;
  const revision = f.t3.admissionRevision();
  // New activity replaces the probed reading; the verdict for it is unknown until the grace period passes again.
  await f.send(running('stalled'));
  assert.notEqual(f.t3.admissionRevision(), revision);
});

test('a full pass still runs once the recheck interval passes', async t => {
  const f = quietLane(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await f.pass();
  let reads = f.reads();
  t.mock.timers.tick(299_000); await f.pass();
  assert.equal(f.reads(), reads, 'max(pollSeconds 60, 300) seconds have not passed');
  verbose(t);
  const lines = logLines(t) as { event: string; miss?: string[] }[];
  t.mock.timers.tick(2_000); await f.pass();
  assert.ok(f.reads() > reads);
  assert.deepEqual(lines.filter(line => line.event === 'pass').map(line => line.miss), [['deadline']]);
});

for (const deadline of ['idle window', 'quota reset'] as const) test(`a full pass runs at the ${deadline} deadline before the recheck interval`, async t => {
  const f = quietLane(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  if (deadline === 'idle window') {
    // idleMinutes is 1, and the owner last used Codex 30 seconds ago.
    f.store.set('personalActivityScope.codex', '[]');
    f.store.set('lastPersonalActivity.codex.v3', new Date(Date.now() - 30_000).toISOString());
  } else {
    const resetsAt = new Date(Date.now() + 30_000).toISOString(), provider = f.provider;
    const soon = () => { const p = provider(); p.usageLimits.windows[0].resetsAt = resetsAt; return p; };
    t.mock.method(f.t3, 'providers', async () => { f.calls.push('providers'); return [soon()]; });
    t.mock.method(f.t3, 'provider', async () => { f.calls.push('quota'); return soon(); });
  }
  const first = await f.pass();
  if (deadline === 'idle window') assert.equal((first.streams as { driver: string; reason: string }[]).find(s => s.driver === 'codex')!.reason, 'waiting-for-idle');
  const reads = f.reads();
  t.mock.timers.tick(29_000); await f.pass();
  assert.equal(f.reads(), reads);
  t.mock.timers.tick(2_000); await f.pass();
  assert.ok(f.reads() > reads);
});

test('a lane whose views are not live always runs in full', async t => {
  const f = quietLane(t, { live: false });
  await f.pass();
  const reads = f.reads();
  await f.pass();
  assert.ok(f.reads() > reads);
});

function logLines(t: TestContext) {
  const lines: { event: string }[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(JSON.parse(line)); });
  return lines;
}
const lanePass = (f: ReturnType<typeof quietLane>) => f.internal.enqueue(() => f.pass(), false, { reason: 'tickets:codex' });

test('a quiet pass and its work event write nothing to the log by default', async t => {
  const f = quietLane(t, { live: false }), lines = logLines(t);
  await lanePass(f);
  assert.deepEqual(lines.map(line => line.event), ['pass'], 'the first pass of a lane is a change');
  lines.length = 0;
  await lanePass(f);
  assert.deepEqual(lines, []);
});

test('an outcome change or a slow pass writes one line', async t => {
  const f = quietLane(t, { live: false });
  await lanePass(f);
  const lines = logLines(t);
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify({ ...f.c, idleMinutes: 2, enabled: false }));
  await lanePass(f);
  assert.deepEqual(lines.map(line => [line.event, (line as { outcome?: string }).outcome]), [['pass', 'disabled']]);
  lines.length = 0;
  let clock = 0;
  t.mock.method(performance, 'now', () => clock += 6_000);
  await lanePass(f);
  assert.deepEqual(lines.map(line => line.event), ['pass']);
});

function verbose(t: TestContext) {
  const previous = process.env.T3_FACTORY_LOG_VERBOSE;
  process.env.T3_FACTORY_LOG_VERBOSE = '1';
  t.after(() => { if (previous === undefined) delete process.env.T3_FACTORY_LOG_VERBOSE; else process.env.T3_FACTORY_LOG_VERBOSE = previous; });
}

test('T3_FACTORY_LOG_VERBOSE=1 restores the work, pass and decision lines', async t => {
  const f = quietLane(t, { live: false });
  await lanePass(f);
  const lines = logLines(t);
  verbose(t);
  await lanePass(f);
  assert.deepEqual(lines.map(line => line.event).sort(), ['decision', 'pass', 'work']);
});

test('a skipped pass writes no line, and a dropped held decision names what changed on the line its new outcome writes', async t => {
  const f = quietLane(t), lines = logLines(t) as { event: string; outcome?: string; miss?: string[] }[];
  await lanePass(f);
  lines.length = 0;
  await lanePass(f);
  assert.equal(lines.length, 0, 'the skipped pass decided the same');
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify({ ...f.c, enabled: false }));
  await lanePass(f);
  assert.deepEqual(lines.map(line => [line.outcome, line.miss]), [['disabled', ['config']]]);
});

// The web process watches the database through its own connection (Store.watch): a held pass must commit nothing it would see.
test('a pass that returns its held decision commits nothing and takes no decision sequence', async t => {
  const f = quietLane(t), observer = new Store(f.c.stateDir);
  t.after(() => observer.close());
  const first = await f.pass();
  const version = observer.dataVersion(), sequence = f.store.get('decisionSequence');
  assert.deepEqual(await f.pass(), first);
  assert.equal(observer.dataVersion(), version, 'another connection sees no commit');
  assert.equal(f.store.get('decisionSequence'), sequence);
});

test('a pass that runs after a held pass records its result under the next decision sequence', async t => {
  const f = quietLane(t);
  await f.pass();
  const previous = JSON.parse(f.store.get('lastDecision')!).checks.codex.origin.sequence;
  await f.pass();
  f.inputs.views++;
  const result = await f.pass();
  const check = JSON.parse(f.store.get('lastDecision')!).checks.codex;
  assert.equal(check.origin.sequence, previous + 1);
  assert.equal(check.reason, result.reason);
});

test('two lanes that start A then B select B when B finishes first', async t => {
  const f = quietLane(t), entered = deferred(), release = deferred();
  let reads = 0;
  f.hooks.shell = async () => { if (++reads === 1) { entered.resolve(); await release.promise; } };
  const a = f.internal.pass({}, 'timer', 0, 'tickets', 'codex');
  await entered.promise;
  const b = await f.internal.pass({}, 'timer', 0, 'tickets', 'claudeAgent');
  release.resolve(); await a;
  const decision = f.store.currentDecision();
  assert.equal((decision?.origin as DecisionOrigin).providerDriver, 'claudeAgent');
  assert.equal(decision?.reason, b.reason);
});

for (const cause of ['an unreadable configuration', 'a failed tracker connection'] as const) test(`${cause} before the cycle is still recorded as an error decision`, async t => {
  const f = quietLane(t);
  if (cause === 'an unreadable configuration') writeFileSync(process.env.T3_FACTORY_CONFIG!, '{');
  else f.internal.kanvil = Promise.reject(new Error('fixture tracker offline'));
  await assert.rejects(f.pass());
  const decision = f.store.currentDecision();
  assert.equal(decision?.reason, 'error');
  assert.equal((decision?.origin as DecisionOrigin).providerDriver, 'codex');
});
