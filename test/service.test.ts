import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalAgent } from 'node:http';
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

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

// No external services or real workspaces: a completed job without a path still needs the fresh cleanup shell.
async function maintenanceFixture(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-maintenance-'));
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

test('manual dispatch passes pending background work without interrupting the active pass', { timeout: 10000 }, async t => {
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
    assert.deepEqual(await internal.handle({ type: 'health' }), { code: 0, data: { ok: true, pid: process.pid } });
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
    assert.deepEqual(events, ['start', 'stop', 'cancel', 'doctor', 'config', 'dry', 'dispatch-0', 'dispatch-1', 'quota', 'dispatch-2', 'dispatch-3', 'dispatch-4', 'dispatch-5']);
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
      if (++reads === 2) { events.push('cleanup-start'); entered.resolve(); await release.promise; }
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
    assert.equal(reads, 2, 'the queued command cannot reconcile while cleanup holds the writer');
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
  t.mock.method(T3.prototype, 'terminals', async () => []);
  t.mock.method(T3.prototype, 'removeWorktree', async (_: string, path: string) => { git('worktree', 'remove', path); });
  try {
    await service.start(); await internal.handle({ type: 'once', options: { dryRun: true } });
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
    await service.start(); await internal.handle({ type: 'once', options: { dryRun: true } });
    internal.store.save(f.job);
    Object.assign(f.thread, { orphanedRun: true });
    if (failedDispatch) await assert.rejects(internal.handle({ type: 'dispatch', options: { model: 'unknown' } }), /Unknown model/);
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

// The service runs passes in series: a manual dispatch sent while a pass is running waits for it and
// never sees a store-claim error; T3 events and commands coalesce into one queued pass.
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
  const internal = service as any, backgroundDone = deferred(), queueUpdated = deferred();
  const pass = internal.pass.bind(internal);
  t.mock.method(internal, 'pass', async (options: unknown, reason: string, queueWaitMs: number) => {
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
    assert.deepEqual(await callControl(c.stateDir, { type: 'health' }), { code: 0, data: { ok: true, pid: process.pid } });
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
    assert.ok(shellReads >= 3 && shellReads <= 6, `start, dispatch, final check, and one coalesced pass: ${shellReads} shell reads`);
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
    const bFailed = assert.rejects(b, /fixture failure/);
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
    await service.start(); await internal.handle({ type: 'once', options: { dryRun: true } });
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
