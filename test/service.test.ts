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
import { v2Thread } from './v2-fixture.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle } from '../src/scheduler.ts';

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
test('the service answers dispatches during a pass and folds wake-ups into one queued pass', async t => {
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
    // Let the queued wake-ups drain: the T3 events and the explicit wake were one queued pass, not three.
    await new Promise(resolve => setTimeout(resolve, 1200));
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
    tasks.push({ id: 'task-3', projectId: 'FIX', title: 'New work', number: 3, status: 'to-do', priority: 'urgent', createdAt: '2026-01-02T00:00:00Z', labels: [{ name: 'sf' }, { name: 'low' }] });
    await new Promise(resolve => setTimeout(resolve, 600));
    const later = JSON.parse(readFileSync(join(c.stateDir, 'status.json'), 'utf8'));
    assert.deepEqual(later.upNext.tickets.map((t: any) => t.key), ['FIX-3', 'FIX-1']);
  } finally {
    await service.stop();
    process.env.PATH = oldPath; process.env.T3_FACTORY_CONFIG = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
