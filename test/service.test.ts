import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.deepEqual(commandFor(['once']), { type: 'wake', reason: 'once' });
    assert.equal(commandFor(['once', '--dry-run']), undefined, 'dry runs stay local');
    assert.equal(commandFor(['model-catalog']), undefined);
    assert.deepEqual(commandFor(['job-stop', 'j1']), { type: 'job-stop', jobId: 'j1' });
    assert.throws(() => commandFor(['dispatch', '--bogus']), /Unknown dispatch argument/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(seen.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { configSchema } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { FactoryService } from '../src/service.ts';
import { v2Thread } from './v2-fixture.ts';

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
    assert.deepEqual(await callControl(c.stateDir, { type: 'health' }), { code: 0, data: { ok: true, pid: process.pid } });
    release();
    const result = await dispatch;
    assert.equal(result?.code, 0, JSON.stringify(result));
    assert.equal((result?.data as any).reason, 'dispatched');
    assert.equal((result?.data as any).ticket, 'FIX-2');
    assert.equal(launches.length, 1);
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
