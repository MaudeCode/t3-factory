import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { Store } from '../src/store.ts';
import { cycle, runPlans, cancelPlan } from '../src/scheduler.ts';
import type { Thread } from '../src/policy.ts';
import { v2Thread } from './v2-fixture.ts';
import { dispatchFixture, deferred } from './dispatch-fixture.ts';

// FIX-50 is blocked by FIX-49, FIX-48, and FIX-47; FIX-48 is blocked by FIX-13. The user may run the first
// runnable blocker, or the whole chain in priority order within the run limits, then FIX-50.
test('a blocked manual ticket offers its chain, runs the first blocker, or runs the whole chain to the target', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-chain-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  const oldPath = process.env.PATH, oldConfig = process.env.T3_FACTORY_CONFIG;
  process.env.PATH = `${dir}:${oldPath}`; process.env.T3_FACTORY_CONFIG = join(dir, 'config.jsonc');
  writeFileSync(join(dir, 'discovery.md'), 'Discover.'); writeFileSync(join(dir, 'skill'), '# Software factory');
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null, concurrency: { claude: 2, codex: 1 },
    models: [{ id: 'opus', name: 'Opus', model: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, automatic: true, maxDifficulty: 'high' }, { id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'gpt-5.6-sol' }, automatic: false, maxDifficulty: 'high' }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'discovery.md'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kaneoId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'], priorityLabels: ['security'] }],
  });
  writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
  const task = (number: number, priority: string, labels: string[]) => ({ id: `task-${number}`, projectId: 'FIX', title: `Work ${number}`, number, status: 'to-do', priority, createdAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`, labels: labels.map(name => ({ name })) });
  const tasks = [task(50, 'urgent', ['sf', 'med']), task(49, 'low', ['sf', 'low']), task(48, 'high', ['sf', 'med']), task(47, 'medium', ['low', 'bug']), task(13, 'low', ['sf', 'low', 'security'])];
  const relations = [
    { sourceTaskId: 'task-49', targetTaskId: 'task-50', relationType: 'blocks' }, { sourceTaskId: 'task-48', targetTaskId: 'task-50', relationType: 'blocks' },
    { sourceTaskId: 'task-47', targetTaskId: 'task-50', relationType: 'blocks' }, { sourceTaskId: 'task-13', targetTaskId: 'task-48', relationType: 'blocks' },
  ];
  const providers = ['claudeAgent', 'codex'].map(instanceId => ({ instanceId, driver: instanceId, status: 'ready', installed: true, enabled: true, models: c.models.filter(m => m.model.instanceId === instanceId).map(m => ({ slug: m.model.model })) }));
  const threads: Thread[] = [];
  t.mock.method(T3.prototype, 'shell', async () => ({ threads, projects: [{ id: 'FIX', title: 'FIX', workspaceRoot: repo }] }));
  t.mock.method(T3.prototype, 'providers', async () => providers);
  t.mock.method(T3.prototype, 'provider', async (instanceId: string) => ({ ...providers.find(p => p.instanceId === instanceId)!, usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: instanceId === 'codex' ? [{ id: 'primary', usedPercent: 0, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 10080 * 60_000).toISOString() }] : [{ id: 'five_hour', usedPercent: 0, windowDurationMins: 300, resetsAt: new Date(Date.now() + 300 * 60_000).toISOString() }, { id: 'seven_day', usedPercent: 0, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 10080 * 60_000).toISOString() }] } }));
  t.mock.method(T3.prototype, 'detail', async () => ({ messages: [], responses: [] }));
  const launches: Record<string, any>[] = [];
  t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => {
    launches.push(command);
    // The launched thread shows up as running, so its slot counts and its ticket is owned.
    threads.push(v2Thread({ id: command.threadId, projectId: 'FIX', title: command.title, providerInstanceId: command.modelSelection.instanceId, modelSelection: command.modelSelection, status: 'running', activeRunId: 'run', latestRunCompletedAt: null, updatedAt: new Date().toISOString() }));
    return { ok: true };
  });
  t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
  t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: tasks.filter(x => !args.status || x.status === args.status) }] }, pagination: { total: tasks.length, totalPages: 1 } };
    if (name === 'get_task') { const { labels, ...task } = tasks.find(task => task.id === args.taskId)!; return task; } // Kaneo's single-task read carries no labels
    if (name === 'get_task_relations') return relations.filter(r => r.sourceTaskId === args.taskId || r.targetTaskId === args.taskId);
    throw new Error(name);
  });
  const store = new Store(c.stateDir);
  const finish = (key: string) => { tasks.find(x => `FIX-${x.number}` === key)!.status = 'done'; const job = store.jobs().find(j => j.ticketKey === key)!; job.state = 'complete'; store.save(job); threads.splice(threads.findIndex(x => x.id === job.threadId), 1); };
  try {
    // Paused, the queue still projects: FIX-13 and FIX-49 are ready, FIX-48 follows FIX-13, FIX-50 stays held because FIX-47 lacks the ready label.
    assert.equal((await cycle(c, store)).reason, 'disabled');
    const projected = JSON.parse(store.get('upNext')!);
    assert.deepEqual(projected.tickets.map((x: any) => [x.key, x.after]), [['FIX-13', []], ['FIX-49', []], ['FIX-48', ['FIX-13']]]);
    assert.deepEqual(projected.held.map((x: any) => x.key), ['FIX-50']);
    const ask = await cycle(c, store, { manual: true, ticket: 'FIX-50', model: 'auto', overrideLimits: true });
    assert.equal(ask.reason, 'blocked-ticket-plan-required');
    const tree = ask.tree as any;
    assert.equal(tree.target.key, 'FIX-50');
    assert.deepEqual(tree.tickets.map((x: any) => [x.key, x.blockedBy.map((id: string) => tree.tickets.find((y: any) => y.id === id).key)]).sort(), [['FIX-13', []], ['FIX-47', []], ['FIX-48', ['FIX-13']], ['FIX-49', []]]);
    assert.deepEqual(tree.target.blockedBy.length, 3);
    assert.equal(launches.length, 0, 'asking starts nothing');

    // First: the highest-priority blocker that can start now. FIX-13 carries the top priority label, so it goes before urgent-by-field tickets.
    const first = await cycle(c, store, { manual: true, ticket: 'FIX-50', model: 'opus', overrideLimits: true, chain: 'first' });
    assert.equal(first.reason, 'dispatched');
    assert.deepEqual(first.chain, { target: 'FIX-50', picked: 'FIX-13' });
    assert.equal(launches.length, 1);
    finish('FIX-13');

    // All: a chain that fills the free slots now and continues as tickets unblock, then the target.
    const started = await cycle(c, store, { manual: true, ticket: 'FIX-50', model: 'auto', overrideLimits: true, chain: 'all' });
    assert.equal(started.reason, 'plan-started', JSON.stringify(started));
    const planId = started.planId as string;
    assert.deepEqual(launches.slice(1).map(l => l.title), ['Factory: FIX-48', 'Factory: FIX-47'], 'two Claude slots: the two highest-priority unblocked blockers; FIX-47 runs despite lacking the ready label');
    assert.match(launches[2].initialMessage.text, /explicitly confirmed this run without the sf readiness label/);
    assert.match(launches[2].workspaceStrategy.branch, /^fix\/FIX-47-factory-[0-9a-f]{8}$/, 'a bug ticket gets a fix branch');
    assert.match(launches[1].workspaceStrategy.branch, /^chore\/FIX-48-factory-/, 'no kind label falls back to chore');
    assert.equal(store.plan(planId)!.tickets.find(x => x.key === 'FIX-49')!.note, 'Waiting for a free Claude slot');
    const instances = new Map(providers.map(p => [p.instanceId, p.driver]));
    assert.equal((await runPlans(c, store, new T3(c.t3), new Kaneo(c.kaneo), instances, threads)).length, 0, 'nothing more fits while both slots are busy');
    finish('FIX-48');
    await runPlans(c, store, new T3(c.t3), new Kaneo(c.kaneo), instances, threads);
    assert.deepEqual(launches.slice(3).map(l => l.title), ['Factory: FIX-49']);
    assert.match(launches[1].initialMessage.text, /Manual dispatch/, 'the launches made as the user chose the chain are manual');
    assert.doesNotMatch(launches[3].initialMessage.text, /Manual dispatch/, 'a continuation keeps the automatic policy');
    assert.match(launches[3].initialMessage.text, /Started by a chain the user requested/);
    finish('FIX-47'); finish('FIX-49');
    await runPlans(c, store, new T3(c.t3), new Kaneo(c.kaneo), instances, threads);
    assert.deepEqual(launches.slice(4).map(l => l.title), ['Factory: FIX-50'], 'the target starts once every ticket ahead of it is done');
    finish('FIX-50');
    await runPlans(c, store, new T3(c.t3), new Kaneo(c.kaneo), instances, threads);
    assert.equal(store.plan(planId)!.state, 'done');
    assert.throws(() => cancelPlan(store, planId), /not active/);
    assert.deepEqual(store.events(20).filter(e => e.kind.startsWith('plan.')).map(e => e.text).toReversed(), ['Chain to FIX-50 started with 3 tickets ahead of it', 'Chain to FIX-50 finished']);
  } finally {
    store.close();
    process.env.PATH = oldPath; process.env.T3_FACTORY_CONFIG = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared dependency ancestors reuse reads without becoming cycles', async t => {
  const f = dispatchFixture(t);
  for (const [n, id] of ['left', 'right', 'shared'].entries()) f.tasks.push(f.task(id, n + 3));
  f.relations.splice(0, f.relations.length, ...[
    ['left', 'root'], ['right', 'root'], ['shared', 'left'], ['shared', 'right'],
  ].map(([sourceTaskId, targetTaskId]) => ({ sourceTaskId, targetTaskId, relationType: 'subtask' })));
  assert.equal((await f.run()).reason, 'dispatched');
  assert.equal(f.calls.filter(x => x === 'get_task_relations:shared:true').length, 1, 'shared ancestor reads are cached independently of the ancestry path');
});

test('dependency ancestor cycles still refuse dispatch', async t => {
  const f = dispatchFixture(t);
  f.relations.splice(0, 1, { sourceTaskId: 'blocker', targetTaskId: 'root', relationType: 'subtask' }, { sourceTaskId: 'root', targetTaskId: 'blocker', relationType: 'subtask' });
  assert.equal((await f.run()).reason, 'blocked-ticket-plan-required');
  assert.equal(f.launches.length, 0);
});

test('independent final dependency reads fan out with a bound of six', async t => {
  const f = dispatchFixture(t), release = deferred(), started = deferred();
  for (let n = 0; n < 12; n++) { const id = `dep-${n}`; f.tasks.push(f.task(id, n + 3)); f.relations.push({ sourceTaskId: id, targetTaskId: 'root', relationType: 'blocks' }); }
  let active = 0, maximum = 0;
  f.hooks.read = async (name, id, final) => {
    if (final && name === 'get_task' && id.startsWith('dep-')) {
      active++; maximum = Math.max(maximum, active); started.resolve();
      await release.promise; active--;
    }
  };
  const pending = f.run(); await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  const simultaneous = active;
  release.resolve(); assert.equal((await pending).reason, 'dispatched');
  assert.equal(simultaneous, 6, 'independent dependencies must start together up to the read bound');
  assert.equal(maximum, 6, 'dependency reads cannot exceed the bound');
  for (let n = 0; n < 12; n++) assert.equal(f.calls.filter(x => x === `get_task:dep-${n}:true`).length, 1);
});
