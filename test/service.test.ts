import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalAgent } from 'node:http';
import { readPhase } from '../src/read-context.ts';
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
    assert.deepEqual(commandFor(['dispatch', '--override', 'idle,labels']), { type: 'dispatch', options: { manual: true, overrideLimits: ['idle', 'labels'] } });
    for (const bad of [[], ['quota']]) assert.throws(() => commandFor(['dispatch', '--override', ...bad]), /--override requires/);
    assert.equal(commandFor(['model-catalog']), undefined);
    assert.deepEqual(commandFor(['job-stop', 'j1']), { type: 'job-stop', jobId: 'j1' });
    assert.deepEqual(commandFor(['session-dismiss', 'task-1']), { type: 'session-dismiss', taskId: 'task-1' });
    assert.deepEqual(commandFor(['dispatch', '--upstream', 'UP/Stable']), { type: 'dispatch', options: { manual: true, upstream: 'up/stable' } });
    assert.throws(() => commandFor(['dispatch', '--upstream', 'no-slash']), /requires owner\/repo/);
    for (const args of [['--ticket', 'APP-1'], ['--chain', 'all'], ['--allow-missing-ready-label']]) assert.throws(() => commandFor(['dispatch', '--upstream', 'up/stable', ...args]), /cannot be combined/);
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
import { configSchema } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { FactoryService } from '../src/service.ts';
import { publicStopCommand, v2Projection, v2Thread } from './v2-fixture.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle, stopJob } from '../src/scheduler.ts';
import { readCleanupCatalog } from '../src/cleanup.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

for (const model of ['sol', 'auto']) for (const afterOwnership of [false, true]) test(`manual expiry at the durable launch boundary: model=${model}, ownership=${afterOwnership}`, async t => {
  const f = dispatchFixture(t), service = new FactoryService(process.env.T3_FACTORY_CONFIG!), internal = service as any;
  Object.assign(internal, { store: f.store, stateDir: f.c.stateDir, t3: f.t3, kaneo: Promise.resolve(f.kaneo), t3Settings: JSON.stringify(f.c.t3), kaneoSettings: JSON.stringify(f.c.kaneo) });
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
  } finally { release.resolve(); await internal.queue; clearTimeout(internal.timer); }
});

test('manual deadline exposes queued work and expires without a late launch', async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred();
  const id = '11111111-1111-4111-8111-111111111111';
  let dispatches = 0;
  t.mock.method(internal, 'pass', async (_: unknown, reason: string) => {
    if (reason === 'start') { entered.resolve(); await release.promise; }
    else dispatches++;
    return { reason: 'dispatched' };
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await service.start(); await entered.promise;
    const dispatch = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', requestId: id } });
    const health = (await internal.handle({ type: 'health' })).data;
    assert.equal(health.queueDepth, 1, 'health names pending scheduler work');
    assert.equal(health.active.reason, 'start');
    const file = join(f.c.stateDir, 'web-requests', `${id}.json`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).progress.phase, 'queued');
    t.mock.timers.tick(60_001);
    const result = await dispatch;
    assert.equal(result.data.reason, 'manual-deadline-exceeded');
    assert.equal(result.data.notLaunched, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'done');
    release.resolve(); await internal.queue;
    assert.equal(dispatches, 0, 'expired queue entries never enter the dispatch pass');
    assert.deepEqual(await internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', requestId: id } }), result, 'same ID recovers its durable outcome');
    assert.equal(dispatches, 0);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('queued manual deadline settles before its held predecessor', async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(); let settled = false, dispatches = 0;
  t.mock.method(internal, 'pass', async (_: unknown, reason: string) => {
    if (reason === 'start') { entered.resolve(); await release.promise; } else dispatches++;
    return { reason: 'dispatched' };
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await service.start(); await entered.promise;
    const dispatch = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1' } }).then((r: any) => { settled = true; return r; });
    t.mock.timers.tick(60_001); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'the queued request gets a bounded not-launched outcome while its predecessor is held');
    assert.equal((await dispatch).data.notLaunched, true);
    release.resolve(); await internal.queue; assert.equal(dispatches, 0);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
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
    await service.start(); await internal.queue;
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
    kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kaneoId: 'FIX', t3Id: 'FIX', repoPath: dir, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] }],
  });
  const path = join(dir, 'config.jsonc'); writeFileSync(path, JSON.stringify(c));
  const thread = v2Thread({ id: 'completed', projectId: 'FIX', status: 'completed', activeRunId: null, updatedAt: '2026-01-01T00:00:00Z', latestUserMessageAt: '2026-01-01T00:00:00Z', latestRunCompletedAt: '2026-01-01T00:00:00Z', worktreePath: null });
  const job: Job = { id: 'completed', kind: 'discovery', projectId: 'FIX', taskId: null, ticketKey: null, threadId: thread.id, messageId: 'initial', createdAt: thread.updatedAt, completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Done', lastPersonalActivity: null, reportPath: join(dir, 'report'), prUrls: [], command: {} };
  const shell = async () => ({ threads: [thread], projects: [{ id: 'FIX', title: 'FIX', workspaceRoot: dir }] });
  t.mock.method(T3.prototype, 'subscribe', async (_: unknown, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())));
  t.mock.method(T3.prototype, 'shell', shell);
  t.mock.method(T3.prototype, 'providers', async () => []);
  t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
  t.mock.method(Kaneo.prototype, 'call', async (name: string) => {
    if (name === 'list_workspace_labels' || name === 'get_task_relations') return [];
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: [] }] }, pagination: { total: 0, totalPages: 1 } };
    throw new Error(name);
  });
  return { dir, c, path, thread, job, shell };
}

test('manual dispatch passes pending background work without interrupting an indivisible active mutation', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  let active = 0, maximum = 0;
  t.mock.method(internal, 'pass', async (_options: unknown, reason: string) => {
    maximum = Math.max(maximum, ++active); events.push(reason);
    if (reason === 'start') { entered.resolve(); await release.promise; }
    active--; return { reason: 'dispatched' };
  });
  t.mock.method(T3.prototype, 'providers', async () => { events.push('quota'); assert.equal(active, 0); return []; });
  const configure = internal.configure.bind(internal);
  t.mock.method(internal, 'configure', () => { events.push('cleanup'); return configure(); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await service.start(); await entered.promise;
    service.wake('config'); service.wake('kaneo');
    t.mock.timers.tick(150_000); // The display refresh is now pending behind the active pass.
    internal.scheduleCleanup(); t.mock.timers.tick(0);
    const dispatch = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1' } });
    const health = await internal.handle({ type: 'health' });
    assert.equal(health.data.ok, true); assert.equal(health.data.pid, process.pid);
    assert.equal(health.data.active.reason, 'start'); assert.equal(health.data.queueDepth, 4);
    assert.deepEqual(events, ['start']);
    release.resolve(); await dispatch; await internal.queue;
    assert.deepEqual(events, ['start', 'dispatch', 'config', 'quota', 'cleanup']);
    assert.equal(maximum, 1);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('foreground FIFO permits a background item after every three foreground commands', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  t.mock.method(internal, 'pass', async (options: any, reason: string) => {
    events.push(options.ticket ?? reason);
    if (reason === 'start') { entered.resolve(); await release.promise; }
    return { reason: 'dispatched' };
  });
  t.mock.method(T3.prototype, 'providers', async () => { events.push('quota'); return []; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await service.start(); await entered.promise;
    service.wake('config'); t.mock.timers.tick(150_000);
    const job = internal.store.job.bind(internal.store), plan = internal.store.plan.bind(internal.store);
    t.mock.method(internal.store, 'job', (id: string) => { events.push('stop'); return job(id); });
    t.mock.method(internal.store, 'plan', (id: string) => { events.push('cancel'); return plan(id); });
    const commands = [
      assert.rejects(internal.handle({ type: 'job-stop', jobId: 'missing' }), /not active/),
      assert.rejects(internal.handle({ type: 'plan-cancel', planId: 'missing' }), /not active/),
      internal.handle({ type: 'once', options: { ticket: 'doctor', doctor: true } }),
      internal.handle({ type: 'once', options: { ticket: 'dry', dryRun: true } }),
      ...Array.from({ length: 6 }, (_, n) => internal.handle({ type: 'dispatch', options: { ticket: `dispatch-${n}` } })),
    ];
    release.resolve(); await Promise.all(commands); await internal.queue;
    assert.deepEqual(events, ['start', 'stop', 'cancel', 'doctor', 'config', 'dry', 'dispatch-0', 'dispatch-1', 'quota', 'dispatch-2', 'dispatch-3', 'dispatch-4', 'quota', 'dispatch-5']);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a prioritized stop uses T3 settings changed while the active pass was blocked', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  t.mock.method(internal, 'pass', async (_: unknown, reason: string) => {
    events.push(reason);
    if (reason === 'start') { entered.resolve(); await release.promise; }
    return { reason: 'disabled' };
  });
  const next = { ...f.c, t3: { ...f.c.t3, url: 'http://127.0.0.1:4773', credentialFile: join(f.dir, 'new-unused-credential') } };
  t.mock.method(T3.prototype, 'dispatch', async function(this: T3, command: any) {
    publicStopCommand.parse(command);
    assert.equal(command.type, 'run.interrupt');
    assert.equal(command.runId, 'fresh-run');
    assert.equal(command.holdQueue, true);
    assert.deepEqual(this.config, next.t3, 'stop must use the current endpoint and credential path');
    events.push('stop');
  });
  t.mock.method(T3.prototype, 'request', async () => ({ projection: { thread: { id: f.thread.id, activeProviderThreadId: null, pullRequests: [] }, runs: [{ id: 'fresh-run', status: 'waiting' }], providerThreads: [], turnItems: [] } }));
  try {
    await service.start(); await entered.promise;
    internal.store.save({ ...f.job, state: 'running', completedAt: null });
    writeFileSync(f.path, JSON.stringify(next)); service.wake('config');
    const stopping = internal.handle({ type: 'job-stop', jobId: f.job.id });
    release.resolve(); assert.equal((await stopping).code, 0); await internal.queue;
    assert.equal(internal.store.job(f.job.id).state, 'running');
    assert.match(internal.store.job(f.job.id).reason, /Stop requested/);
    assert.deepEqual(events, ['start', 'stop', 'config']);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('wake bursts coalesce and changes during an active background pass get a fresh pass after rejection', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), next = deferred(), releaseNext = deferred(), events: string[] = [];
  t.mock.method(internal, 'pass', async (_: unknown, reason: string) => {
    events.push(reason);
    if (reason === 'start') { entered.resolve(); await release.promise; throw new Error('Synthetic background failure'); }
    if (reason === 'config') { next.resolve(); await releaseNext.promise; }
    return { reason: 'dispatched' };
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await service.start(); await entered.promise;
    service.wake('config'); service.wake('kaneo'); service.wake('timer');
    release.resolve(); await next.promise;
    internal.onShellItem({ type: 'thread.meta-updated' });
    internal.onShellItem({ type: 'thread.created' });
    t.mock.timers.tick(750);
    service.wake('kaneo');
    releaseNext.resolve(); await internal.queue;
    assert.deepEqual(events, ['start', 'config', 't3']);
  } finally { release.resolve(); releaseNext.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('stop drains accepted foreground commands and failures before closing resources', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  let reads = 0;
  t.mock.method(T3.prototype, 'shell', async () => {
    events.push('pass');
    if (++reads === 1) { entered.resolve(); await release.promise; }
    return f.shell();
  });
  t.mock.method(Kaneo.prototype, 'close', async () => { events.push('close-client'); });
  const close = Store.prototype.close;
  t.mock.method(Store.prototype, 'close', function(this: Store) { events.push('close-store'); close.call(this); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stopping: Promise<void> | undefined;
  try {
    await service.start(); await entered.promise;
    service.wake('config'); internal.scheduleCleanup(); t.mock.timers.tick(0);
    const failed = assert.rejects(internal.handle({ type: 'job-stop', jobId: 'missing' }), /not active/);
    const dry = internal.handle({ type: 'once', options: { dryRun: true } }).then((r: any) => { events.push('dry-result'); return r; });
    t.mock.method(T3.prototype, 'subscribe', async () => { events.push('new-stream'); });
    writeFileSync(f.path, JSON.stringify({ ...f.c, t3: { ...f.c.t3, url: 'http://127.0.0.1:4773' } }));
    stopping = service.stop().then(() => { events.push('stopped'); });
    assert.deepEqual(events, ['pass'], 'stop must wait for the active pass');
    const late = internal.handle({ type: 'dispatch', options: {} });
    assert.equal((await internal.handle({ type: 'health' })).code, 0);
    service.wake('after-stop'); internal.onShellItem({ type: 'thread.created' });
    release.resolve(); await failed; await dry; await stopping;
    assert.equal((await late).code, 1, 'new commands are refused after stop');
    assert.deepEqual(events, ['pass', 'pass', 'dry-result', 'close-client', 'close-store', 'stopped']);
    t.mock.timers.tick(300_000);
    assert.equal(events.at(-1), 'stopped', 'no background maintenance or timers restart after shutdown');
  } finally { release.resolve(); await (stopping ?? service.stop()); rmSync(f.dir, { recursive: true, force: true }); }
});

test('pass diagnostics separate queue wait from active duration', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), logs: any[] = [];
  let clock = 0, reads = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(console, 'log', (line: string) => { logs.push(JSON.parse(line)); });
  t.mock.method(T3.prototype, 'shell', async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; }
    else clock += 7;
    return f.shell();
  });
  try {
    await service.start(); await entered.promise;
    const command = internal.handle({ type: 'once', options: { dryRun: true } });
    clock = 5000; release.resolve(); await command;
    const diagnostic = logs.find(l => l.event === 'pass' && l.reason === 'once');
    assert.equal(diagnostic.queueWaitMs, 5000);
    assert.equal(diagnostic.ms, 7);
    assert.equal(diagnostic.outcome, 'disabled');
    assert.deepEqual(Object.keys(diagnostic).sort(), ['time', 'event', 'reason', 'outcome', 'ms', 'queueWaitMs'].sort());
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

for (const siblingFails of [false, true]) test(`shutdown drains ready-column polls before closing the shared client: sibling failure=${siblingFails}`, { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  t.mock.method(internal, 'pass', async () => ({ reason: 'disabled' }));
  if (siblingFails) writeFileSync(f.path, JSON.stringify({ ...f.c, projects: [...f.c.projects, { ...f.c.projects[0], key: 'OTHER', kaneoId: 'OTHER', t3Id: 'OTHER', githubRepo: 'fixture/OTHER' }] }));
  t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, 'list_tasks');
    if (args.projectId === 'OTHER') throw new Error('Synthetic poll failure');
    entered.resolve(); await release.promise;
    events.push('poll-finished');
    return { data: { workspaceId: 'workspace', columns: [{ tasks: [] }] }, pagination: { total: 0, totalPages: 1 } };
  });
  t.mock.method(Kaneo.prototype, 'close', async () => { events.push('close-client'); });
  let stopping: Promise<void> | undefined;
  try {
    await service.start();
    const poll = internal.checkKaneo(); await entered.promise;
    stopping = service.stop().then(() => { events.push('stopped'); });
    await internal.queue;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [], 'the client must remain open while the poll is using it');
    release.resolve(); await poll; await stopping;
    assert.deepEqual(events, ['poll-finished', 'close-client', 'stopped']);
  } finally { release.resolve(); await (stopping ?? service.stop()); rmSync(f.dir, { recursive: true, force: true }); }
});

test('service dispatch returns before blocked cleanup and queued commands run between maintenance items', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  try {
    await service.start();
    await internal.handle({ type: 'once', options: { dryRun: true } });
    internal.store.save(f.job);
    internal.store.save({ ...f.job, id: 'second', threadId: 'second' });
    let reads = 0;
    t.mock.method(T3.prototype, 'shell', async () => {
      reads++;
      if (internal.active?.reason === 'workspace-cleanup' && !events.includes('cleanup-start')) { events.push('cleanup-start'); entered.resolve(); await release.promise; }
      return { ...(await f.shell()), threads: [f.thread, { ...f.thread, id: 'second' }] };
    });
    const dispatch = internal.handle({ type: 'dispatch', options: {} }).then((r: any) => { events.push('dispatch-result'); return r; });
    const first = await Promise.race([dispatch.then(() => 'dispatch'), entered.promise.then(() => 'cleanup')]);
    assert.equal(first, 'dispatch', 'dispatch must return before cleanup starts');
    assert.equal((await dispatch).data.reason, 'no-eligible-ticket');
    await entered.promise;
    const command = internal.handle({ type: 'once', options: { dryRun: true } }).then(() => events.push('queued-command'));
    const original = Store.prototype.save, secondDone = deferred();
    t.mock.method(Store.prototype, 'save', function(this: Store, job: Job) {
      if (job.workspaceCleanedAt) events.push(`cleaned-${job.id}`);
      const result = original.call(this, job); if (job.id === 'second' && job.workspaceCleanedAt) secondDone.resolve(); return result;
    });
    assert.equal(internal.store.job('completed').workspaceCleanedAt, undefined);
    const heldReads = reads;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads, heldReads, 'the queued command cannot reconcile while cleanup holds the writer');
    release.resolve(); await command;
    await secondDone.promise;
    assert.ok(internal.store.job('second').workspaceCleanedAt);
    assert.ok(events.indexOf('queued-command') > events.indexOf('cleaned-completed'));
    assert.ok(events.indexOf('queued-command') < events.indexOf('cleaned-second'), events.join(', '));
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an ordinary pass renews a sweep while its cleanup continuation is queued', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred();
  const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-qb', 'main'); writeFileSync(join(f.dir, 'merged'), 'merged'); git('add', 'merged');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'merged');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  const branch = 'chore/FIX-1-factory', tree = join(f.dir, 'tree');
  git('worktree', 'add', '-qb', branch, tree);
  Object.assign(f.thread, { branch, worktreePath: tree });
  f.job.command = { workspaceStrategy: { type: 'worktree', branch } };
  t.mock.method(T3.prototype, 'dispatch', async (command: any) => {
    assert.equal(command.type, 'thread.metadata.update');
    entered.resolve(); await release.promise;
    Object.assign(f.thread, { worktreePath: null, branch: null });
  });
  t.mock.method(T3.prototype, 'request', async () => ({ projection: v2Projection(f.thread) }));
  t.mock.method(T3.prototype, 'terminals', async () => []);
  t.mock.method(T3.prototype, 'removeWorktree', async (_: string, path: string) => { git('worktree', 'remove', path); });
  try {
    await service.start(); await internal.queue;
    await internal.handle({ type: 'once', options: { dryRun: true } });
    internal.store.save(f.job);
    await internal.handle({ type: 'dispatch', options: {} });
    await entered.promise;
    // The pass waits behind detach. Detach then queues its continuation before the pass asks for a new sweep.
    const ordinary = internal.handle({ type: 'once', options: {} });
    release.resolve(); await ordinary;
    await new Promise(resolve => setTimeout(resolve, 20)); await internal.queue;
    assert.ok(internal.store.job(f.job.id).workspaceCleanedAt, 'the intervening ordinary pass must advance the detached workspace');
    assert.equal(existsSync(tree), false);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
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
    await service.start(); await internal.queue;
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
    await new Promise(resolve => setTimeout(resolve, 20)); await internal.queue;
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

for (const options of [{ manual: true }, { manual: true, model: 'sol' }, { dryRun: true }, { doctor: true }, {}]) {
  test(`standalone cleanup compatibility: ${JSON.stringify(options)}`, async t => {
    const f = await maintenanceFixture(t), store = new Store(f.c.stateDir);
    try {
      store.save(f.job);
      store.save({ ...f.job, id: 'reporting', threadId: f.thread.id, state: 'running', completedAt: null });
      writeFileSync(f.job.reportPath, JSON.stringify({ jobId: 'reporting', status: 'awaiting-human', reason: 'Needs a verdict', prUrls: [] }));
      await cycle(f.c, store, options, { t3: new T3(f.c.t3), kaneo: new Kaneo(f.c.kaneo) });
      assert.equal(!!store.job(f.job.id)?.workspaceCleanedAt, Object.keys(options).length === 0, 'only ordinary once performs cleanup inline');
      assert.equal(store.job('reporting')?.state, 'waiting', 'report and capacity reconciliation still runs');
    } finally { store.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
}

// The shared writer yields an active read batch, while T3 wake bursts still coalesce.
test('the service answers dispatches during a pass and folds wake-ups into one queued pass', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-service-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  const oldPath = process.env.PATH, oldConfig = process.env.T3_FACTORY_CONFIG;
  process.env.PATH = `${dir}:${oldPath}`; process.env.T3_FACTORY_CONFIG = join(dir, 'config.jsonc');
  writeFileSync(join(dir, 'discovery.md'), 'Discover.'); writeFileSync(join(dir, 'skill'), '# Software factory');
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  // Automation is on but no model takes tickets by itself, so passes read the queue without starting anything.
  const c = configSchema.parse({ enabled: true, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'opus', name: 'Opus', model: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, automatic: false, maxDifficulty: 'high' }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'discovery.md'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kaneoId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] }],
  });
  writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
  const tasks = [1, 2].map(number => ({ id: `task-${number}`, projectId: 'FIX', title: 'Work', number, status: 'to-do', priority: 'high', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'high' }] }));
  const providers = [{ instanceId: 'claudeAgent', driver: 'claudeAgent', status: 'ready', installed: true, enabled: true, models: [{ slug: 'claude-opus-5' }] }];
  let shellReads = 0, release: () => void = () => {}, listed: Record<string, unknown>[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  let emit: (item: unknown) => void = () => {};
  t.mock.method(T3.prototype, 'subscribe', (onItem: (item: unknown) => void, signal: AbortSignal) => { emit = onItem; return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); });
  t.mock.method(T3.prototype, 'shell', async () => { if (++shellReads === 1) await gate; return { threads: [v2Thread({ id: 'personal', projectId: 'FIX' })], projects: [{ id: 'FIX', title: 'FIX', workspaceRoot: repo }] }; });
  t.mock.method(T3.prototype, 'providers', async () => providers);
  t.mock.method(T3.prototype, 'provider', async () => ({ ...providers[0], usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: [{ id: 'five_hour', usedPercent: 0, windowDurationMins: 300, resetsAt: new Date(Date.now() + 300 * 60_000).toISOString() }, { id: 'seven_day', usedPercent: 0, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 10080 * 60_000).toISOString() }] } }));
  t.mock.method(T3.prototype, 'detail', async () => ({ messages: [], responses: [] }));
  const launches: Record<string, any>[] = [];
  t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => { launches.push(command); return { ok: true }; });
  let connects = 0;
  t.mock.method(Kaneo.prototype, 'connect', async () => { connects++; }); t.mock.method(Kaneo.prototype, 'close', async () => {});
  t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'list_tasks') { listed.push(args); return { data: { workspaceId: 'workspace', columns: [{ tasks }] }, pagination: { total: tasks.length, totalPages: 1 } }; }
    if (name === 'get_task') return tasks.find(task => task.id === args.taskId);
    if (name === 'get_task_relations') return [];
    throw new Error(name);
  });
  const service = new FactoryService(process.env.T3_FACTORY_CONFIG, { kaneoPollMs: 60 });
  const internal = service as any, backgroundDone = deferred(), queueUpdated = deferred(), passReasons: string[] = [];
  const pass = internal.pass.bind(internal);
  t.mock.method(internal, 'pass', async (options: unknown, reason: string, queueWaitMs: number) => {
    passReasons.push(reason);
    const result = await pass(options, reason, queueWaitMs);
    if (reason === 't3' || reason === 'test') backgroundDone.resolve();
    const status = JSON.parse(readFileSync(join(c.stateDir, 'status.json'), 'utf8'));
    if (status.upNext?.tickets.some((ticket: any) => ticket.key === 'FIX-3')) queueUpdated.resolve();
    return result;
  });
  try {
    await service.start(); // The start pass is now blocked inside its first shell read.
    const dispatch = callControl(c.stateDir, { type: 'dispatch', options: { manual: true, model: 'opus', ticket: 'FIX-2', overrideLimits: true } });
    for (const item of [{ kind: 'snapshot', snapshot: {} }, { kind: 'synchronized' }, { type: 'thread.meta-updated', aggregateId: 'x', sequence: 1 }, { type: 'thread.created', aggregateId: 'y', sequence: 2 }]) emit(item);
    await callControl(c.stateDir, { type: 'wake', reason: 'test' });
    const dry = callControl(c.stateDir, { type: 'once', options: { dryRun: true } });
    const health = await callControl(c.stateDir, { type: 'health' });
    assert.equal(health?.code, 0); assert.equal((health?.data as any).ok, true); assert.equal((health?.data as any).pid, process.pid);
    assert.equal((health?.data as any).active.reason, 'start'); assert.equal((health?.data as any).queueDepth, 3);
    release();
    const result = await dispatch;
    assert.equal(result?.code, 0, JSON.stringify(result));
    assert.equal((result?.data as any).reason, 'dispatched');
    assert.equal((result?.data as any).ticket, 'FIX-2');
    assert.equal(launches.length, 1);
    assert.equal((await dry)?.code, 0, 'a dry run over the socket returns its decision');
    // Observe a coalesced background pass rather than assume it finished after a sleep.
    await backgroundDone.promise; clearTimeout(internal.settle); await internal.queue;
    const status = JSON.parse(readFileSync(join(c.stateDir, 'status.json'), 'utf8'));
    assert.equal(status.jobs.length, 1);
    assert.deepEqual(passReasons, ['start', 'dispatch', 'once', 'test'], 'suspension retries reads without duplicating passes or wake bursts');
    assert.equal(connects, 1, 'one Kaneo client serves every pass');
    assert.ok(listed.some(a => a.status === 'to-do'), 'automatic passes read ready columns only');
    assert.ok(listed.some(a => a.status === undefined), 'a named ticket is read from every column');
    assert.ok(existsSync(join(c.stateDir, 'control.sock')));
    assert.deepEqual(status.upNext.tickets.map((t: any) => [t.key, t.model]), [['FIX-1', null]], 'up next lists the remaining ready ticket; no automatic model takes it');
    assert.ok(status.streams.every((s: any) => s.quota || s.quotaError), 'every provider shows an allowance or why not');
    // A ticket appearing in Kaneo is noticed by the poll and reaches the queue without a timer or a T3 event.
    await internal.checkKaneo();
    tasks.push({ id: 'task-3', projectId: 'FIX', title: 'New work', number: 3, status: 'to-do', priority: 'urgent', createdAt: '2026-01-02T00:00:00Z', labels: [{ name: 'sf' }, { name: 'low' }] });
    await queueUpdated.promise;
    const later = JSON.parse(readFileSync(join(c.stateDir, 'status.json'), 'utf8'));
    assert.deepEqual(later.upNext.tickets.map((t: any) => t.key), ['FIX-3', 'FIX-1']);
  } finally {
    await service.stop();
    process.env.PATH = oldPath; process.env.T3_FACTORY_CONFIG = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual submission checks stay FIFO and serial across a refusal and an error', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), seen: string[] = [];
  let active = 0, maximum = 0;
  t.mock.method(internal, 'pass', async (options: any, reason: string) => {
    if (reason !== 'dispatch') return { reason: 'disabled' };
    maximum = Math.max(maximum, ++active); seen.push(options.ticket);
    try {
      if (options.ticket === 'FIX-1') { entered.resolve(); await release.promise; return { reason: 'quota-exhausted', ticket: options.ticket }; }
      if (options.ticket === 'FIX-2') throw new Error('fixture failure');
      return { reason: 'dispatched', ticket: options.ticket };
    } finally { active--; }
  });
  try {
    await service.start(); await internal.queue;
    const a = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1' } });
    await entered.promise;
    const b = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-2' } });
    const bFailed = b.then((r: any) => { assert.equal(r.code, 1); assert.match(r.data.message, /fixture failure/); assert.equal(r.data.notLaunched, true); });
    const c = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-3' } });
    assert.deepEqual(seen, ['FIX-1']);
    release.resolve();
    assert.equal((await a).data.reason, 'quota-exhausted');
    await bFailed;
    assert.equal((await c).data.ticket, 'FIX-3');
    assert.deepEqual(seen, ['FIX-1', 'FIX-2', 'FIX-3']);
    assert.equal(maximum, 1);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

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

test('command Stop is deferred behind dispatch, serialized, and confirmed after restart without resending', { timeout: 15000 }, async t => {
  const f = await maintenanceFixture(t), tree = join(f.dir, 'tree'), branch = 'chore/FIX-1-factory';
  const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(f.dir, 'file'), 'released'); git('add', 'file');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'released');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD')); git('worktree', 'add', '-qb', branch, tree);
  Object.assign(f.thread, { branch, worktreePath: tree, pendingBackgroundTasks: [{ taskId: 'server', kind: 'command' }] });
  f.job.command = { workspaceStrategy: { branch } };
  writeFileSync(f.job.reportPath, JSON.stringify({ jobId: f.job.id, status: 'complete', reason: 'Finished', prUrls: [] }));
  const entered = deferred(), release = deferred(); let stops = 0;
  t.mock.method(T3.prototype, 'request', async () => ({ projection: v2Projection(f.thread, {
    runs: [{ id: 'completed-run', status: 'completed' }], providerThreads: [{ id: 'provider', pendingBackgroundTasks: f.thread.pendingBackgroundTasks }], messages: [], runtimeRequests: [],
  }) }));
  t.mock.method(T3.prototype, 'dispatch', async (command: any) => {
    if (command.type === 'run.interrupt') { publicStopCommand.parse(command); stops++; entered.resolve(); await release.promise; }
    else if (command.type === 'thread.metadata.update') { f.thread.worktreePath = null; f.thread.branch = null; }
    else throw new Error(command.type);
  });
  let service = new FactoryService(f.path), internal = service as any;
  try {
    await service.start(); await internal.queue;
    await internal.handle({ type: 'once', options: { dryRun: true } });
    internal.store.save(f.job);
    const dispatch = internal.handle({ type: 'dispatch', options: {} });
    assert.equal(await Promise.race([dispatch.then(() => 'dispatch'), entered.promise.then(() => 'stop')]), 'dispatch');
    await entered.promise;
    assert.equal(internal.store.job(f.job.id).commandStop.status, 'requested');
    let commandFinished = false;
    const queued = internal.handle({ type: 'once', options: { dryRun: true } }).then(() => { commandFinished = true; });
    assert.equal(commandFinished, false, 'maintenance retains the one service writer');
    release.resolve(); await queued; await service.stop();
    service = new FactoryService(f.path); internal = service as any;
    await service.start(); await internal.handle({ type: 'once', options: { dryRun: true } });
    assert.equal(stops, 1);
    const saved = internal.store.job(f.job.id); saved.workspaceCleanupBlockedAt = '2026-01-01T00:00:00Z'; internal.store.save(saved);
    f.thread.pendingBackgroundTasks = [];
    const confirmed = deferred(), original = Store.prototype.save;
    t.mock.method(Store.prototype, 'save', function(this: Store, job: Job) {
      const result = original.call(this, job); if (job.commandStop?.status === 'confirmed') confirmed.resolve(); return result;
    });
    await internal.handle({ type: 'once', options: {} }); await confirmed.promise;
    assert.equal(stops, 1, 'restart observes settlement instead of repeating interruption');
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('cleanup inspection is serialized with dispatch and queued inspection cancellation makes no workspace calls', async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred();
  let reads = 0;
  t.mock.method(internal, 'pass', async () => { entered.resolve(); await release.promise; return { reason: 'disabled' }; });
  t.mock.method(T3.prototype, 'shell', async () => { reads++; return f.shell(); });
  t.mock.method(T3.prototype, 'removeWorktree', async () => { assert.fail('Inspection never removes worktrees'); });
  try {
    await service.start(); await entered.promise;
    const id = '00000000-0000-4000-8000-000000000042';
    const inspection = internal.handle({ type: 'cleanup', input: { type: 'inspect', projectId: 'FIX', path: f.dir, inspectionId: id } });
    const rejected = assert.rejects(inspection, /abort/i);
    assert.equal(reads, 0, 'inspection waits behind the active pass');
    const cancelled = await internal.handle({ type: 'cleanup-cancel', inspectionId: id });
    assert.equal(cancelled.data.cancelled, true);
    release.resolve(); await rejected; assert.equal(reads, 0);
    const result = await internal.handle({ type: 'cleanup', input: { type: 'inventory' } });
    assert.equal(result.code, 0); assert.equal(reads, 0, 'cached inventory does not start a synchronous inspection');
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('cleanup page reads return stored inventory without waiting for the writer or external discovery', async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  internal.store = new Store(f.c.stateDir); internal.stateDir = f.c.stateDir; internal.t3 = new T3(f.c.t3); internal.t3Settings = JSON.stringify(f.c.t3);
  let discoveries = 0; t.mock.method(T3.prototype, 'shell', async () => { discoveries++; return f.shell(); });
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
    assert.equal(discoveries, 0, 'the page read never waits for T3 discovery');
  } finally {
    release.resolve(); await writer; await read; await service.stop(); rmSync(f.dir, { recursive: true, force: true });
  }
});


test('run completion refreshes one maintained cleanup catalog and explicit refresh discovers external worktrees', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' });
  git('init', '-qb', 'main'); writeFileSync(join(f.dir, 'tracked'), 'fixture'); git('add', 'tracked'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const tree = join(f.dir, 'tree'); git('worktree', 'add', '-qb', 'feature', tree);
  f.thread.worktreePath = tree; f.thread.branch = 'feature';
  const entered = deferred(), release = deferred();
  let closed = false;
  const close = async () => { if (closed) return; closed = true; release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); };
  t.after(close);
  t.mock.method(internal, 'pass', async () => { entered.resolve(); await release.promise; return { reason: 'disabled' }; });
  try {
    await service.start(); await entered.promise;
    let publication = deferred(), count = 0;
    const set = internal.store.set.bind(internal.store);
    t.mock.method(internal.store, 'set', (key: string, value: string) => { set(key, value); if (key === 'cleanupCatalog') { count++; publication.resolve(); } });
    const job = { ...f.job, state: 'running', thread: { title: 'Fixture', status: 'completed', worktreePath: tree, branch: 'feature', updatedAt: f.thread.updatedAt, pending: null, background: [] } };
    internal.store.save(job); internal.store.save({ ...job, reason: 'Another update in the same pass' });
    release.resolve(); await publication.promise;
    assert.equal(count, 1, 'writes in one pass coalesce into one discovery');
    assert.equal(readCleanupCatalog(f.c, internal.store).items.find(item => item.path === tree)!.state, 'active');
    publication = deferred();
    await internal.enqueue(async () => internal.store.save({ ...job, state: 'complete' }));
    await publication.promise;
    const finished = readCleanupCatalog(f.c, internal.store).items.find(item => item.path === tree)!;
    assert.equal(finished.jobs[0].state, 'complete'); assert.notEqual(finished.next!.group, 'protected');
    const external = join(f.dir, 'external'); git('worktree', 'add', '-qb', 'external', external);
    publication = deferred();
    const response = await internal.handle({ type: 'cleanup', input: { type: 'inventory', refresh: true } });
    assert.equal(response.data.refreshing, true);
    assert.ok(!response.data.items.some((item: any) => item.path === external), 'refresh returns the current snapshot immediately');
    await publication.promise;
    assert.ok(readCleanupCatalog(f.c, internal.store).items.some(item => item.path === external), 'background discovery finds worktrees outside Factory');
  } finally { await close(); }
});

test('active cycle yields its drained read batch to manual dispatch and Stop before inventory', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  let first = true;
  t.mock.method(T3.prototype, 'shell', async () => {
    if (first) { first = false; entered.resolve(); await release.promise; events.push('batch-drained'); }
    return f.shell();
  });
  const call = Kaneo.prototype.call;
  t.mock.method(Kaneo.prototype, 'call', async function(this: Kaneo, name: string, args: any) {
    if (name === 'list_tasks') events.push('inventory');
    return call.call(this, name, args);
  });
  const pass = internal.pass.bind(internal);
  t.mock.method(internal, 'pass', async (options: any, reason: string, wait: number) => {
    if (reason === 'dispatch') { events.push('manual'); return { reason: 'dispatched' }; }
    return pass(options, reason, wait);
  });
  try {
    await service.start(); await entered.promise;
    const job = internal.store.job.bind(internal.store);
    t.mock.method(internal.store, 'job', (id: string) => { events.push('stop'); return job(id); });
    const manual = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1' } });
    const stop = assert.rejects(internal.handle({ type: 'job-stop', jobId: 'missing' }), /not active/);
    release.resolve(); await Promise.all([manual, stop]); await internal.queue;
    assert.deepEqual(events.slice(0, 4), ['batch-drained', 'manual', 'stop', 'inventory']);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('foreground cancellation drains all active cycle siblings before handing off and retries the read', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), cancelled = deferred(), drain = deferred(), events: string[] = [];
  let reads = 0, live = 0;
  t.mock.method(T3.prototype, 'shell', () => readPhase('fixture.shell', async signal => {
    if (++reads === 1) {
      live++; entered.resolve();
      try { await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => { cancelled.resolve(); reject(signal!.reason); }, { once: true })); }
      finally { await drain.promise; live--; events.push('drained'); }
    }
    return f.shell();
  }));
  const pass = internal.pass.bind(internal);
  t.mock.method(internal, 'pass', async (options: any, reason: string, wait: number) => {
    if (reason === 'dispatch') { assert.equal(live, 0); events.push('manual'); return { reason: 'dispatched' }; }
    return pass(options, reason, wait);
  });
  try {
    await service.start(); await entered.promise;
    const manual = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1' } });
    await cancelled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(events, [], 'cancellation cannot release an undrained reader');
    drain.resolve(); await manual; await internal.queue;
    assert.deepEqual(events, ['drained', 'manual']); assert.ok(reads >= 2, 'the cancelled snapshot is read again');
  } finally { drain.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

for (const kind of ['cleanup-inventory', 'session-tickets', 'quota-refresh']) test(`${kind} yields through its service scheduling entry point`, { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  const entered = deferred(), release = deferred(), events: string[] = [];
  let held = false;
  t.mock.method(internal, 'pass', async (_: unknown, reason: string) => { if (reason === 'dispatch') events.push('manual'); return { reason: 'disabled' }; });
  const hold = async () => { if (!held) { held = true; entered.resolve(); await release.promise; events.push('batch'); } };
  t.mock.method(T3.prototype, 'shell', async () => { await hold(); return f.shell(); });
  t.mock.method(T3.prototype, 'sessions', async () => { await hold(); return []; });
  t.mock.method(T3.prototype, 'providers', async () => { await hold(); return []; });
  const set = Store.prototype.set;
  t.mock.method(Store.prototype, 'set', function(this: Store, key: string, value: string) {
    if ((kind === 'cleanup-inventory' && key === 'cleanupCatalog') || (kind === 'session-tickets' && key === 'sessionTickets:at') || (kind === 'quota-refresh' && key === 'streams')) events.push('publish');
    set.call(this, key, value);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await service.start(); await internal.queue;
    if (kind === 'cleanup-inventory') { internal.scheduleInventory(); t.mock.timers.tick(0); }
    else if (kind === 'session-tickets') { internal.scheduleCollection(); t.mock.timers.tick(0); }
    else t.mock.timers.tick(150_000);
    await entered.promise;
    const manual = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1' } });
    release.resolve(); await manual; await internal.queue;
    assert.deepEqual(events, ['batch', 'manual', 'publish']);
  } finally { release.resolve(); await service.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('large active inventory retains finished ticket batches when a command interrupts a later batch', { timeout: 10000 }, async t => {
  const f = dispatchFixture(t), service = new FactoryService(process.env.T3_FACTORY_CONFIG!), internal = service as any;
  Object.assign(internal, { store: f.store, stateDir: f.c.stateDir, t3: f.t3, kaneo: Promise.resolve(f.kaneo), t3Settings: JSON.stringify(f.c.t3), kaneoSettings: JSON.stringify(f.c.kaneo) });
  f.c.enabled = false; writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  f.tasks.splice(0, f.tasks.length, ...Array.from({ length: 120 }, (_, i) => f.task(`task-${i}`, i + 1, 'to-do'))); f.relations.length = 0;
  for (const method of ['scheduleCleanup', 'scheduleCollection', 'scheduleInventory']) t.mock.method(internal, method, () => {});
  const entered = deferred(), release = deferred(), events: string[] = [];
  f.hooks.read = async (name, id) => {
    if (name !== 'get_task_relations') return;
    events.push(id);
    if (id === 'task-12' && !events.includes('manual')) { entered.resolve(); await release.promise; }
  };
  const pass = internal.pass.bind(internal);
  t.mock.method(internal, 'pass', async (options: any, reason: string, wait: number) => {
    if (reason === 'dispatch') { events.push('manual'); return { reason: 'dispatched' }; }
    const result = await pass(options, reason, wait);
    if (reason === 'test') {
      assert.equal(events.filter(e => e === 'task-0').length, 1, 'completed batches are retained through suspension');
      assert.ok(events.indexOf('manual') < events.indexOf('task-18'), 'the next batch starts after the command');
    }
    return result;
  });
  try {
    service.wake('test'); await entered.promise;
    const manual = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-999' } });
    release.resolve(); await manual; await internal.queue;
    assert.equal(f.launches.length, 0);
    assert.equal(JSON.parse(f.store.get('upNext')!).tickets.length, 120);
  } finally { release.resolve(); await internal.queue; clearTimeout(internal.timer); }
});

test('large cleanup projection yields, retains Git discovery, and publishes current thread activity', { timeout: 10000 }, async t => {
  const f = await maintenanceFixture(t), service = new FactoryService(f.path), internal = service as any;
  execFileSync('/usr/bin/git', ['init', '-q', f.dir]);
  const oldPath = process.env.PATH, bin = join(f.dir, 'bin'), scans = join(f.dir, 'git-scans'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'scan\\n' >> '${scans}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  const threads = Array.from({ length: 256 }, (_, i) => ({ ...f.thread, id: `thread-${i}`, worktreePath: join(f.dir, `tree-${i}`) }));
  t.mock.method(T3.prototype, 'shell', async () => ({ ...(await f.shell()), threads: structuredClone(threads) }));
  let projected = 0, atCommand = 0, sent = false, manual: Promise<any> | undefined;
  t.mock.method(internal, 'pass', async (_: unknown, reason: string) => {
    if (reason === 'dispatch') { atCommand = projected; threads[200].activeRunId = 'resumed'; }
    return { reason: 'disabled' };
  });
  try {
    await service.start(); await internal.queue;
    const published = deferred(), get = internal.store.get.bind(internal.store), set = internal.store.set.bind(internal.store);
    t.mock.method(internal.store, 'get', (key: string) => {
      if (key.startsWith('cleanupSize:')) {
        projected++;
        if (!sent) { sent = true; manual = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1' } }); }
      }
      return get(key);
    });
    t.mock.method(internal.store, 'set', (key: string, value: string) => { set(key, value); if (key === 'cleanupCatalog') published.resolve(); });
    await internal.handle({ type: 'cleanup', input: { type: 'inventory', refresh: true } });
    await published.promise; await manual; await internal.queue;
    assert.ok(atCommand > 0 && atCommand < threads.length, 'a command runs between projection batches');
    const row = readCleanupCatalog(f.c, internal.store, 0, 1000).items.find(item => item.path === threads[200].worktreePath)!;
    assert.equal(row.state, 'active', 'the projection refreshes mutable activity after suspension');
    assert.ok(row.bindings[0].activeRunId);
    assert.equal(readFileSync(scans, 'utf8').trim().split('\n').length, 1, 'projection invalidation does not repeat completed Git discovery');
  } finally { await service.stop(); process.env.PATH = oldPath; rmSync(f.dir, { recursive: true, force: true }); }
});

test('an owned background launch keeps the writer through an uncertain response', { timeout: 10000 }, async t => {
  const f = dispatchFixture(t), service = new FactoryService(process.env.T3_FACTORY_CONFIG!), internal = service as any;
  Object.assign(internal, { store: f.store, stateDir: f.c.stateDir, t3: f.t3, kaneo: Promise.resolve(f.kaneo), t3Settings: JSON.stringify(f.c.t3), kaneoSettings: JSON.stringify(f.c.kaneo) });
  for (const method of ['scheduleCleanup', 'scheduleCollection', 'scheduleInventory']) t.mock.method(internal, method, () => {});
  const entered = deferred(), release = deferred(), events: string[] = [];
  t.mock.method(f.t3, 'launch', (command: unknown) => readPhase('fixture.launch', async signal => {
    assert.equal(signal, undefined, 'durable launch ownership ends disposable read cancellation');
    f.launches.push(command); events.push('launch'); entered.resolve(); await release.promise;
    events.push('uncertain'); throw new Error('Lost launch response');
  }));
  const pass = internal.pass.bind(internal);
  t.mock.method(internal, 'pass', async (options: any, reason: string, wait: number) => {
    if (reason === 'dispatch') { events.push('manual'); return { reason: 'dispatched' }; }
    return pass(options, reason, wait);
  });
  try {
    service.wake('test'); await entered.promise;
    const manual = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-999' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['launch']);
    release.resolve(); await manual; await internal.queue;
    assert.deepEqual(events, ['launch', 'uncertain', 'manual']);
    assert.equal(f.launches.length, 1); assert.equal(f.store.jobs()[0].state, 'dispatching');
  } finally { release.resolve(); await internal.queue; clearTimeout(internal.timer); }
});
