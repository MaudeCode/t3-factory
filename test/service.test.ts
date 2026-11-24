import { mockTracker } from './tracker-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalAgent } from 'node:http';
import { readPhase, ReadContext } from '../src/read-context.ts';
import { serveControl, callControl, commandFor } from '../src/control.ts';

// The control socket is how the CLI and the web server hand work to the running scheduler.
test('commands reach the running scheduler over its socket and fall back without one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-control-'));
  try {
    assert.equal(await callControl(dir, { type: 'health' }), null, 'no socket means the caller does the work itself');
    const seen: unknown[] = [];
    const server = serveControl(dir, async command => { seen.push(command); return command.type === 'dispatch' ? { code: 0, data: { reason: 'dispatched', ticket: (command.options as any).ticket } } : { code: 0, data: { ok: true } }; });
    await new Promise(resolve => server.once('listening', resolve));
    const dispatch = commandFor(['dispatch', '--model', 'opus', '--ticket', 'APP-1', '--override-limits'])!;
    assert.deepEqual(dispatch, { type: 'dispatch', options: { manual: true, model: 'opus', ticket: 'APP-1', overrideLimits: true } });
    assert.deepEqual(await callControl(dir, dispatch), { code: 0, data: { reason: 'dispatched', ticket: 'APP-1' } });
    assert.deepEqual(commandFor(['once']), { type: 'once', options: { dryRun: false, doctor: false } });
    assert.deepEqual(commandFor(['doctor']), { type: 'once', options: { dryRun: false, doctor: true } });
    assert.throws(() => commandFor(['dispatch', '--chain', 'later']), /--chain requires first or all/);
    assert.deepEqual(commandFor(['plan-override', 'p1', '--override', 'idle,labels']), { type: 'plan-override', planId: 'p1', overrideLimits: ['idle', 'labels'] });
    assert.deepEqual(commandFor(['plan-order', 'p2', 'p1']), { type: 'plan-order', planIds: ['p2', 'p1'] });
    assert.deepEqual(commandFor(['plan-override', 'p1']), { type: 'plan-override', planId: 'p1', overrideLimits: [] }, 'no flag respects every limit');
    assert.deepEqual(commandFor(['dispatch', '--epic', 'epic-1', '--model', 'opus', '--override', 'idle']), { type: 'dispatch', options: { manual: true, epic: 'epic-1', model: 'opus', overrideLimits: ['idle'] } });
    for (const other of [['--ticket', 'APP-1'], ['--chain', 'all'], ['--upstream', 'up/stable']]) assert.throws(() => commandFor(['dispatch', '--epic', 'epic-1', ...other]), /--epic cannot be combined/);
    assert.throws(() => commandFor(['dispatch', '--epic']), /--epic requires/);
    assert.deepEqual(commandFor(['dispatch', '--override', 'idle,labels']), { type: 'dispatch', options: { manual: true, overrideLimits: ['idle', 'labels'] } });
    assert.deepEqual(commandFor(['dispatch', '--override', 'providers']), { type: 'dispatch', options: { manual: true, overrideLimits: ['providers'] } });
    assert.deepEqual(commandFor(['dispatch', '--provider', 'codex', '--override-limits']), { type: 'dispatch', options: { manual: true, provider: 'codex', overrideLimits: true } });
    assert.throws(() => commandFor(['dispatch', '--provider', 'other']), /Invalid option/);
    assert.throws(() => commandFor(['dispatch', '--provider', 'codex', '--model', 'sol']), /requires automatic model selection/);
    for (const bad of [[], ['quota']]) assert.throws(() => commandFor(['dispatch', '--override', ...bad]), /--override requires/);
    assert.equal(commandFor(['model-catalog']), undefined);
    assert.deepEqual(commandFor(['job-stop', 'j1']), { type: 'job-stop', jobId: 'j1' });
    assert.deepEqual(commandFor(['job-dismiss', 'j1', '--reset-ticket']), { type: 'job-dismiss', jobId: 'j1', resetTicket: true });
    assert.throws(() => commandFor(['job-dismiss', 'j1', '--force']), /Unknown job-dismiss argument/);
    assert.deepEqual(commandFor(['session-dismiss', 'task-1']), { type: 'session-dismiss', taskId: 'task-1' });
    assert.deepEqual(commandFor(['dispatch', '--upstream', 'UP/Stable']), { type: 'dispatch', options: { manual: true, upstream: 'up/stable' } });
    assert.throws(() => commandFor(['dispatch', '--upstream', 'no-slash']), /requires owner\/repo/);
    for (const args of [['--ticket', 'APP-1'], ['--chain', 'all']]) assert.throws(() => commandFor(['dispatch', '--upstream', 'up/stable', ...args]), /cannot be combined/);
    assert.throws(() => commandFor(['dispatch', '--allow-missing-ready-label']), /Unknown dispatch argument/);
    assert.throws(() => commandFor(['dispatch', '--bogus']), /Unknown dispatch argument/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    globalAgent.destroy(); // The replacement server must receive the next request, not a pooled socket from the old server.
    assert.equal(seen.length, 1);
    // A scheduler that takes the request and then drops the connection leaves the outcome unknown; that is not "no scheduler".
    const dropping = serveControl(dir, async () => new Promise(() => {}));
    await new Promise(resolve => dropping.once('listening', resolve));
    dropping.on('request', req => setTimeout(() => req.socket.destroy(), 50));
    const lost = await callControl(dir, dispatch);
    assert.equal((lost?.data as any)?.uncertain, true, JSON.stringify(lost));
    await new Promise<void>(resolve => { dropping.closeAllConnections(); dropping.close(() => resolve()); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { configSchema, loadConfig } from '../src/config.ts';
import { T3, Kanvil } from '../src/clients.ts';
import { FactoryService } from '../src/service.ts';
import { publicStopCommand, v2Projection, v2Thread } from './v2-fixture.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle, stopJob, reconcile, cleanupNextWorkspace, refreshQuota } from '../src/scheduler.ts';
import { readCleanupCatalog } from '../src/cleanup.ts';
import { dispatchFixture, mockLaunchConnection, serviceFixture } from './dispatch-fixture.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };


for (const model of ['sol', 'auto']) for (const afterOwnership of [false, true]) test(`manual expiry at the durable launch boundary: model=${model}, ownership=${afterOwnership}`, async t => {
  const f = dispatchFixture(t), service = new FactoryService(process.env.T3_FACTORY_CONFIG!), internal = service as any;
  Object.assign(internal, { store: f.store, stateDir: f.c.stateDir, t3: f.t3, kanvil: Promise.resolve(f.kanvil), t3Settings: JSON.stringify(f.c.t3), kanvilSettings: JSON.stringify(f.c.kanvil) });
  for (const method of ['scheduleCleanup', 'scheduleCollection', 'scheduleInventory']) t.mock.method(internal, method, () => {});
  const entered = deferred(), release = deferred();
  if (!afterOwnership) f.hooks.quota = async refresh => { if (refresh) { entered.resolve(); await release.promise; } };
  else t.mock.method(f.t3, 'launch', async (command: unknown) => { f.launches.push(command); entered.resolve(); await release.promise; throw new Error('Lost launch response'); });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const dispatch = internal.handle({ type: 'dispatch', options: { model, ticket: 'FIX-1' } });
    await entered.promise;
    t.mock.timers.tick(60_001); release.resolve();
    const result = await dispatch;
    assert.equal(f.launches.length, afterOwnership ? 1 : 0, 'expiry before ownership must prevent the external launch');
    assert.equal(result.code, 1);
    assert.equal(result.data[afterOwnership ? 'uncertain' : 'notLaunched'], true);
    assert.equal(f.store.jobs().length, afterOwnership ? 1 : 0);
    assert.equal(existsSync(join(f.c.stateDir, 'status.json')), false, 'readers query the Store; a dispatch writes no status file');
  } finally { release.resolve(); await internal.idle; clearTimeout(internal.timer); clearTimeout(internal.statusTimer); }
});


test('scheduler restart recovers accepted operation IDs without resending checks or launches', async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const ids = ['queued', 'checking', 'expired', 'uncertain', 'confirmed'].map((_, i) => `11111111-1111-4111-8111-11111111111${i}`);
  const dir = join(f.c.stateDir, 'web-requests'); mkdirSync(dir, { recursive: true });
  const options = (id: string) => ({ ticket: 'FIX-1', requestId: id, manual: true });
  for (const [i, id] of ids.entries()) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, input: {}, command: options(id), createdAt: new Date().toISOString(), state: i === 2 ? 'done' : i === 3 ? 'uncertain' : 'running',
    progress: { phase: i < 2 ? ['queued', 'checking'][i] : 'launching', stage: 'fixture', acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    ...i === 2 ? { result: { code: 1, data: { reason: 'manual-deadline-exceeded', notLaunched: true } } } : {},
  }));
  const store = new Store(f.c.stateDir);
  store.save({ ...f.job, id: 'known', requestId: ids[4], reason: 'T3 accepted dispatch' }); store.close();
  let checks = 0;
  t.mock.method(internal, 'pass', async () => { checks++; return { reason: 'disabled' }; });
  try {
    await service.start(); await internal.idle;
    const before = checks;
    for (const [i, id] of ids.entries()) {
      const result = await internal.handle({ type: 'dispatch', options: { requestId: id, manual: true, ticket: 'FIX-1' } });
      assert.equal(result.data.reason, ['scheduler-restarted', 'scheduler-restarted', 'manual-deadline-exceeded', 'launch-uncertain', 'dispatched'][i]);
      if (i < 3) assert.equal(result.data.notLaunched, true);
      if (i === 3) assert.equal(result.data.uncertain, true);
    }
    assert.equal(checks, before, 'recovery never executes an accepted request again');
    const collision = await internal.handle({ type: 'dispatch', options: { ...options(ids[0]), ticket: 'FIX-2' } });
    assert.match(collision.data.message, /another command/);
  } finally { await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

// No external services or real workspaces: a completed job without a path still needs the fresh cleanup shell.

async function maintenanceFixture(t: import('node:test').TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-maintenance-')));
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'gpt-6.1-sol' } }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: dir, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
  });
  const path = join(dir, 'config.jsonc'); writeFileSync(path, JSON.stringify(c));
  const thread = v2Thread({ id: 'completed', projectId: 'FIX', status: 'completed', activeRunId: null, updatedAt: '2026-01-01T00:00:00Z', latestUserMessageAt: '2026-01-01T00:00:00Z', latestRunCompletedAt: '2026-01-01T00:00:00Z', worktreePath: null });
  const job: Job = { id: 'completed', kind: 'discovery', projectId: 'FIX', taskId: null, ticketKey: null, threadId: thread.id, messageId: 'initial', createdAt: thread.updatedAt, completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Done', lastPersonalActivity: null, reportPath: join(dir, 'report'), prUrls: [], command: {} };
  const shell = async () => ({ threads: [thread], projects: [{ id: 'FIX', title: 'FIX', workspaceRoot: dir }] });
  t.mock.method(T3.prototype, 'subscribe', async (_: unknown, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())));
  t.mock.method(T3.prototype, 'shell', shell);
  t.mock.method(T3.prototype, 'providers', async () => []);
  t.mock.method(Kanvil.prototype, 'connect', async () => {}); t.mock.method(Kanvil.prototype, 'close', async () => {});
  mockTracker(t, Kanvil.prototype, async (name: string) => {
    if (name === 'labels' || name === 'relations') return [];
    if (name === 'tickets') return { data: { workspaceId: 'workspace', columns: [{ tasks: [] }] }, pagination: { total: 0, totalPages: 1 } };
    throw new Error(name);
  });
  return { dir, c, path, thread, job, shell };
}


test('shutdown aborts and drains the shared Kanvil subscription before closing the store', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  let subscription: Promise<void> | undefined;
  t.mock.method(Kanvil.prototype, 'subscribe', async (_onChange: unknown, signal: AbortSignal) => {
    entered.resolve();
    subscription = (async () => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      events.push('stream-aborted'); await release.promise; events.push('stream-drained');
    })();
    await subscription;
  });
  t.mock.method(Kanvil.prototype, 'close', async () => { await subscription; events.push('close-client'); });
  let stopped = false;
  try {
    await service.start(); await entered.promise; await internal.idle;
    const stopping = service.stop().then(() => { events.push('stopped'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['stream-aborted']);
    release.resolve(); await stopping; stopped = true;
    assert.deepEqual(events, ['stream-aborted', 'stream-drained', 'close-client', 'stopped']);
  } finally { release.resolve(); if (!stopped) await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});


for (const failedDispatch of [false, true]) test(`maintenance survives ${failedDispatch ? 'failed' : 'accepted'} dispatch and restart with paused automation`, { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t);
  let service = new FactoryService(f.path), internal = service as any;
  const blocked = deferred();
  const original = Store.prototype.save;
  let blocks = 0;
  t.mock.method(Store.prototype, 'save', function(this: Store, job: Job) {
    const result = original.call(this, job);
    if (job.workspaceCleanupBlockedAt) { blocks++; blocked.resolve(); }
    return result;
  });
  try {
    await service.start(); await internal.idle;
    await internal.handle({ type: 'once', options: { dryRun: true } });
    internal.store.save(f.job);
    Object.assign(f.thread, { orphanedRun: true });
    if (failedDispatch) { const failed = await internal.handle({ type: 'dispatch', options: { model: 'unknown' } }); assert.equal(failed.code, 1); assert.match(failed.data.message, /Unknown model/); }
    else assert.equal((await internal.handle({ type: 'dispatch', options: {} })).data.reason, 'no-eligible-ticket');
    await blocked.promise;
    const saved = internal.store.job(f.job.id);
    assert.match(saved.workspaceCleanupError, /orphaned T3 run/);
    const decision = JSON.parse(internal.store.get('lastDecision'));
    assert.equal(decision.reason, failedDispatch ? 'error' : 'no-eligible-ticket', 'cleanup cannot overwrite the dispatch outcome');
    await service.stop();
    service = new FactoryService(f.path); internal = service as any;
    await service.start();
    await internal.handle({ type: 'once', options: { dryRun: true } });
    await new Promise(resolve => setTimeout(resolve, 20)); await internal.idle;
    assert.equal(blocks, 1, 'restart retains cleanup backoff');
    assert.equal(internal.store.job(f.job.id).workspaceCleanupBlockedAt, saved.workspaceCleanupBlockedAt);
    // Expire the durable retry boundary, then an ordinary paused pass resumes maintenance.
    const retried = deferred();
    t.mock.method(Store.prototype, 'save', function(this: Store, job: Job) {
      const result = original.call(this, job); if (job.workspaceCleanedAt) retried.resolve(); return result;
    });
    Object.assign(f.thread, { orphanedRun: false });
    t.mock.method(Date, 'now', () => Date.parse(saved.workspaceCleanupBlockedAt) + 16 * 60_000);
    await internal.handle({ type: 'once', options: {} }); await retried.promise;
    assert.ok(internal.store.job(f.job.id).workspaceCleanedAt);
  } finally { await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});


test('paused service startup performs pending maintenance without a manual request', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), store = new Store(f.c.stateDir);
  store.save(f.job); store.close();
  const done = deferred(), original = Store.prototype.save;
  t.mock.method(Store.prototype, 'save', function(this: Store, job: Job) { const result = original.call(this, job); if (job.workspaceCleanedAt) done.resolve(); return result; });
  const service = new FactoryService(f.path);
  try { await service.start(); await done.promise; }
  finally { await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});


test('the running scheduler applies a due schedule timer and records it', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t);
  writeFileSync(f.path, JSON.stringify({ ...f.c, enabled: true, schedule: { offAt: '2026-01-01T00:00:00Z' } }));
  const applied = deferred(), original = Store.prototype.record;
  t.mock.method(Store.prototype, 'record', function(this: Store, kind: string, text: string, ...rest: []) { original.call(this, kind, text, ...rest); if (text === 'Automation and queued runs turned off by the schedule') applied.resolve(); });
  const service = new FactoryService(f.path);
  try {
    await service.start(); await applied.promise;
    const c = loadConfig(f.path);
    assert.deepEqual([c.enabled, c.queue.enabled, c.schedule.offAt], [false, false, null]);
  } finally { await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

for (const options of [{ manual: true }, { manual: true, model: 'sol' }, { dryRun: true }, { doctor: true }, {}]) {
  test(`standalone cleanup compatibility: ${JSON.stringify(options)}`, async t => {
    const f = await maintenanceFixture(t), store = new Store(f.c.stateDir);
    try {
      store.save(f.job);
      store.save({ ...f.job, id: 'reporting', threadId: f.thread.id, state: 'running', completedAt: null });
      writeFileSync(f.job.reportPath, JSON.stringify({ jobId: 'reporting', status: 'awaiting-human', reason: 'Needs a verdict', prUrls: [] }));
      await cycle(f.c, store, options, { t3: new T3(f.c.t3), kanvil: new Kanvil(f.c.kanvil) });
      assert.equal(!!store.job(f.job.id)?.workspaceCleanedAt, Object.keys(options).length === 0, 'only ordinary once performs cleanup inline');
      assert.equal(store.job('reporting')?.state, 'manual' in options ? 'running' : 'waiting', 'manual starts leave unrelated reconciliation to its independent worker');
    } finally { store.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
}

// The shared writer yields an active read batch, while T3 wake bursts still coalesce.

test('rejected or uncertain Stops preserve ownership and never record a false success or retry', async t => {
  const f = await maintenanceFixture(t), store = new Store(f.c.stateDir), t3 = new T3(f.c.t3);
  const job = { ...f.job, state: 'running' as const, completedAt: null };
  t.mock.method(t3, 'request', async () => ({ projection: { thread: { id: f.thread.id, activeProviderThreadId: null, pullRequests: [] }, runs: [{ id: 'fresh-run', status: 'running' }], providerThreads: [], turnItems: [] } }));
  try {
    for (const error of [new Error('Connection lost; outcome unknown'), { _tag: 'StopRejected', detail: 'Public command rejected' }]) {
      store.save(job); let attempts = 0;
      t.mock.method(t3, 'dispatch', async (command: unknown) => { publicStopCommand.parse(command); attempts++; throw error; });
      await assert.rejects(stopJob(f.c, store, t3, job.id), /Stop not confirmed: (Connection lost; outcome unknown|StopRejected: Public command rejected)/);
      assert.equal(attempts, 1);
      assert.equal(store.job(job.id)!.state, 'running');
      assert.equal(store.job(job.id)!.reason, job.reason);
      assert.equal(store.events().some(e => e.kind === 'job.stop'), false);
    }
  } finally { store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});


test('cleanup page reads return stored inventory without waiting for the writer or external discovery', async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  internal.store = new Store(f.c.stateDir); internal.stateDir = f.c.stateDir; internal.t3 = new T3(f.c.t3); internal.t3Settings = JSON.stringify(f.c.t3);
  const discoveryRelease = deferred(); let discoveryFinished = false;
  t.mock.method(T3.prototype, 'shell', async () => { await discoveryRelease.promise; discoveryFinished = true; return f.shell(); });
  const entered = deferred(), release = deferred();
  const writer = internal.enqueue(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let returned = false;
  const read = internal.handle({ type: 'cleanup', input: { type: 'inventory', limit: 6 } }).then((result: any) => { returned = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(returned, true, 'opening Cleanup cannot wait behind a deletion or scheduler pass');
    const result = await read;
    assert.equal(result.code, 0);
    assert.equal(discoveryFinished, false, 'the page response finishes while its independent T3 discovery remains held');
  } finally {
    release.resolve(); discoveryRelease.resolve(); await writer; await read; await service.stop(); rmSync(f.dir, { recursive: true, force: true });
  }
});



// A real worktree and job behind the maintained catalog. Fake timers and Date drive the refresh spacing; each refresh is counted when it starts.
async function catalogFixture(t: import('node:test').TestContext) {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' });
  git('init', '-qb', 'main'); writeFileSync(join(f.dir, 'tracked'), 'fixture'); git('add', 'tracked'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const tree = join(f.dir, 'tree'); git('worktree', 'add', '-qb', 'feature', tree);
  f.thread.worktreePath = tree; f.thread.branch = 'feature';
  const job: Job = { ...f.job, state: 'waiting', completedAt: null, thread: { title: 'Fixture', status: 'completed', worktreePath: tree, branch: 'feature', updatedAt: f.thread.updatedAt, pending: null, background: [] } } as Job;
  const seed = new Store(f.c.stateDir); seed.save(job); seed.close();
  // Discovery reads T3 with a fresh shell; a test holds it there to keep a refresh running.
  let hold: ReturnType<typeof deferred> | undefined, held = deferred();
  t.mock.method(T3.prototype, 'shell', async (fresh?: boolean) => { if (fresh && hold) { held.resolve(); await hold.promise; } return f.shell(); });
  t.mock.method(T3.prototype, 'terminals', async () => []);
  for (const method of ['scheduleCleanup', 'scheduleCollection', 'scheduleQuota']) t.mock.method(internal, method, () => {});
  const refreshes: number[] = [], set = Store.prototype.set;
  t.mock.method(Store.prototype, 'set', function (this: Store, key: string, value: string) { if (key === 'cleanupCatalogAttempt') refreshes.push(Date.now() - started); return set.call(this, key, value); });
  const started = Date.parse('2026-01-03T00:00:00Z');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started });
  // Moves the clock to `ms` after start and waits until every worker it woke has finished.
  const advance = async (ms: number) => { t.mock.timers.tick(started + ms - Date.now()); await internal.idle; };
  const refreshing = () => JSON.parse(internal.store.get('cleanupCatalogRefresh') ?? '{}').refreshing;
  const holdNext = () => { hold = deferred(); held = deferred(); return { started: held.promise, release: () => { const gate = hold!; hold = undefined; gate.resolve(); } }; };
  t.after(async () => { hold?.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); });
  await service.start(); await advance(0);
  return { ...f, git, tree, job, service, internal, refreshes, advance, refreshing, holdNext };
}


test('job lifecycle changes coalesce cleanup catalog refreshes to one every 30 seconds', { timeout: 10000 }, async t => {
  const f = await catalogFixture(t);
  assert.deepEqual(f.refreshes, [0], 'the first refresh after start runs at once');
  assert.equal(f.refreshing(), false);
  await f.advance(1000);
  for (let i = 0; i < 10; i++) f.internal.store.save({ ...f.job, state: i === 9 ? 'complete' : i % 2 ? 'waiting' : 'running' });
  assert.equal(f.refreshing(), false, 'a waiting background refresh is not shown as refreshing');
  const read = await f.internal.handle({ type: 'cleanup', input: { type: 'inventory' } });
  assert.equal(read.data.items.find((item: any) => item.path === f.tree).jobs[0].state, 'complete', 'the read shows the finished job before the rescan');
  await f.advance(29_999);
  assert.deepEqual(f.refreshes, [0], 'no refresh inside the 30-second window');
  const running = f.holdNext();
  t.mock.timers.tick(1); await running.started;
  assert.deepEqual(f.refreshes, [0, 30_000], 'ten lifecycle changes cause one refresh');
  assert.equal(f.refreshing(), true, 'a running refresh is shown as refreshing');
  f.internal.store.save({ ...f.job, state: 'dismissed' });
  running.release(); await f.internal.idle;
  await f.advance(59_999);
  assert.deepEqual(f.refreshes, [0, 30_000], 'a change during a refresh waits 30 seconds from that refresh start');
  await f.advance(60_000);
  assert.deepEqual(f.refreshes, [0, 30_000, 60_000], 'one follow-up refresh');
  f.internal.store.save({ ...f.job, state: 'running' });
  await f.service.stop();
  await f.advance(120_000);
  assert.deepEqual(f.refreshes, [0, 30_000, 60_000], 'stopping the service drops the waiting refresh');
});


test('owner and configuration refreshes run at once and absorb a waiting background refresh', { timeout: 10000 }, async t => {
  const f = await catalogFixture(t);
  await f.advance(1000);
  f.internal.store.save({ ...f.job, state: 'complete' });
  const external = join(f.dir, 'external'); f.git('worktree', 'add', '-qb', 'external', external);
  const response = await f.internal.handle({ type: 'cleanup', input: { type: 'inventory', refresh: true } });
  assert.equal(response.data.refreshing, true);
  assert.equal(f.refreshing(), true, 'an owner refresh shows as refreshing at once');
  assert.ok(!response.data.items.some((item: any) => item.path === external), 'refresh returns the current snapshot immediately');
  await f.advance(1000);
  assert.deepEqual(f.refreshes, [0, 1000], 'the owner refresh runs at once');
  assert.ok(readCleanupCatalog(f.c, f.internal.store).items.some(item => item.path === external), 'the refresh discovers worktrees outside Factory');
  await f.advance(2000);
  f.internal.store.save({ ...f.job, state: 'dismissed' });
  f.internal.wake('config'); await f.advance(2000);
  assert.deepEqual(f.refreshes, [0, 1000, 2000], 'a configuration change refreshes at once');
  await f.advance(59_999);
  assert.deepEqual(f.refreshes, [0, 1000, 2000], 'each immediate refresh absorbed the waiting background refresh');
});

test('the stored operations view changes only when an operation starts, changes stage or ends', async t => {
  const f = serviceFixture(t), context = new ReadContext(), release = deferred();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const writes: any[] = [], set = f.store.set.bind(f.store);
  t.mock.method(f.store, 'set', (key: string, value: string) => { if (key === 'serviceWork' && f.store.get(key) !== value) writes.push(JSON.parse(value)); set(key, value); });
  const settle = (ms: number) => { for (let n = 0; n < ms / 250; n++) t.mock.timers.tick(250); };
  f.internal.publishWork(); settle(1000);
  const idle = writes.length;
  settle(5000);
  assert.equal(writes.length, idle, 'nothing is written with no operation in flight');
  const done = f.internal.enqueue(() => release.promise, false, { reason: 'fixture', context });
  try {
    settle(1000);
    assert.equal(writes.length, idle + 1, 'the start is written');
    for (let n = 0; n < 5; n++) { context.setStage('kanvil.read'); context.setStage('queued'); settle(1000); }
    assert.equal(writes.length, idle + 1, 'time passing and a stage that returns within the second write nothing');
    const [operation] = writes.at(-1).operations;
    assert.equal(operation.ageMs, undefined, 'readers derive age from startedAt');
    assert.ok(operation.startedAt && operation.stage === 'queued');
    context.setStage('t3.read'); settle(1000);
    assert.equal(writes.length, idle + 2, 'a stage change is written within a second');
    assert.equal(writes.at(-1).active.stage, 't3.read');
  } finally { release.resolve(); await done; }
  settle(1000);
  assert.equal(writes.length, idle + 3, 'the end is written');
  assert.deepEqual(writes.at(-1).operations, []);
});

test('health reports each operation\'s live age and the event-loop delay', async t => {
  const f = serviceFixture(t), release = deferred();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const done = f.internal.enqueue(() => release.promise, false, { reason: 'fixture' });
  try {
    t.mock.timers.tick(3000);
    const health = (await f.internal.handle({ type: 'health' })).data;
    assert.equal(health.operations[0].ageMs, 3000);
    assert.equal(typeof health.eventLoop.maxMs, 'number');
    assert.equal(typeof health.eventLoop.p99Ms, 'number');
  } finally { release.resolve(); await done; }
});

// On a long-lived database nearly every job is dismissed with its workspace cleaned up. The paths that run on every pass
// read only the rows they use, so a whole-table read fails this fixture.
test('reconcile, cleanup, quota refresh, the pass tail and the source lanes read only the jobs they use', async t => {
  const f = serviceFixture(t), at = new Date().toISOString();
  Object.assign(f.c, { upstream: { enabled: true, promptFile: f.c.factorySkill, checkMinutes: 360 }, repair: { ...f.c.repair, enabled: true } });
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  const job = (id: string, state: Job['state'], extra: Partial<Job> = {}): Job => ({ id, kind: 'ticket', projectId: 'FIX', taskId: `task-${id}`, ticketKey: 'FIX-1', threadId: `thread-${id}`, messageId: 'm', createdAt: at, state, reason: 'Fixture', lastPersonalActivity: null, completedAt: null, reportPath: join(f.dir, `${id}.json`), prUrls: [], command: null, modelSelection: f.c.models[0].model, ...extra });
  f.store.save(job('live', 'running'));
  // Its cleanup is not yet due; the cleanup module's own reads are out of this test's scope.
  f.store.save(job('finished', 'complete', { completedAt: at, workspaceCleanupBlockedAt: at }));
  f.store.save(job('settled', 'dismissed', { dismissedAt: at, workspaceCleanedAt: at }));
  f.threads.push(v2Thread({ id: 'thread-live', projectId: 'FIX', status: 'running', activeRunId: 'run-live' }));
  f.store.set('streams', JSON.stringify([{ driver: 'codex', provider: 'Codex', reason: 'ready', active: [], planned: [], models: [] }]));
  const filtered = f.store.jobSummaries.bind(f.store);
  t.mock.method(f.store, 'jobs', () => assert.fail('whole-table jobs() read'));
  t.mock.method(f.store, 'jobSummaries', (filter?: Parameters<Store['jobSummaries']>[0]) => filter ? filtered(filter) : assert.fail('whole-table jobSummaries() read'));

  await reconcile(f.c, f.store, f.t3, f.kanvil, f.threads, true, false);
  assert.deepEqual(['live', 'finished', 'settled'].map(id => f.store.job(id)!.state), ['running', 'complete', 'dismissed']);
  assert.equal(await cleanupNextWorkspace(f.c, f.store, f.t3, f.kanvil, new Set()), false);
  // Paused, so the idle rule's activity read, which classifies every job, does not run.
  assert.equal(await refreshQuota({ ...f.c, enabled: false }, f.store, f.t3), true);
  assert.equal((await f.internal.pass({}, 'test', 0, 'chains')).reason, 'plans-checked');

  const lanes = new Map<string, Promise<void>>();
  t.mock.method(f.internal, 'runLane', (name: string, work: () => Promise<void>) => { if (['reconcile', 'upstream-sources', 'repair-sources'].includes(name)) lanes.set(name, work()); });
  t.mock.method(f.internal, 'scheduleAdmissions', () => {});
  t.mock.method(f.internal, 'triage', () => {});
  f.internal.wake('test'); clearTimeout(f.internal.timer);
  assert.deepEqual([...lanes.keys()], ['reconcile', 'upstream-sources', 'repair-sources']);
  await Promise.all(lanes.values());
});
