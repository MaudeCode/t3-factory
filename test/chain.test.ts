import { mockTracker } from './tracker-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.ts';
import { T3, Kanvil } from '../src/clients.ts';
import { Store } from '../src/store.ts';
import { cycle, runPlans, cancelPlan, refreshInventory, writeStatus } from '../src/scheduler.ts';
import type { OverrideLimits } from '../src/config.ts';
import type { Thread } from '../src/policy.ts';
import { v2Thread } from './v2-fixture.ts';
import { mockLaunchConnection, dispatchFixture, deferred } from './dispatch-fixture.ts';

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
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' },
    discovery: { promptFile: join(dir, 'discovery.md'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'], priorityLabels: ['security'] }],
  });
  writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
  const task = (number: number, priority: string, labels: string[]) => ({ id: `task-${number}`, projectId: 'FIX', title: `Work ${number}`, number, status: 'todo', priority, createdAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`, labels: labels.map(name => ({ name })) });
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
  mockLaunchConnection(t);
  t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => {
    launches.push(command);
    // The launched thread shows up as running, so its slot counts and its ticket is owned.
    threads.push(v2Thread({ id: command.threadId, projectId: 'FIX', title: command.title, providerInstanceId: command.modelSelection.instanceId, modelSelection: command.modelSelection, status: 'running', activeRunId: 'run', latestRunCompletedAt: null, updatedAt: new Date().toISOString() }));
    return { ok: true };
  });
  t.mock.method(Kanvil.prototype, 'connect', async () => {}); t.mock.method(Kanvil.prototype, 'close', async () => {});
  mockTracker(t, Kanvil.prototype, async (name: string, args: Record<string, unknown>) => {
    if (name === 'labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'tickets') return { data: { workspaceId: 'workspace', columns: [{ tasks: tasks.filter(x => !args.status || x.status === args.status) }] }, pagination: { total: tasks.length, totalPages: 1 } };
    if (name === 'ticket') { const { labels, ...task } = tasks.find(task => task.id === args.taskId)!; return task; } // Kanvil's single-task read carries no labels
    if (name === 'relations') return relations.filter(r => r.sourceTaskId === args.taskId || r.targetTaskId === args.taskId);
    throw new Error(name);
  });
  const store = new Store(c.stateDir);
  const finish = (key: string) => { tasks.find(x => `FIX-${x.number}` === key)!.status = 'done'; const job = store.jobs().find(j => j.ticketKey === key)!; job.state = 'complete'; store.save(job); threads.splice(threads.findIndex(x => x.id === job.threadId), 1); };
  try {
    // Paused, the queue still projects: FIX-13, FIX-47 and FIX-49 are ready, FIX-48 follows FIX-13, and FIX-50 follows its direct blockers.
    assert.equal((await cycle(c, store)).reason, 'disabled');
    const projected = JSON.parse(store.get('upNext')!);
    assert.deepEqual(projected.tickets.map((x: any) => [x.key, x.after]), [['FIX-13', []], ['FIX-47', []], ['FIX-49', []], ['FIX-48', ['FIX-13']], ['FIX-50', ['FIX-49', 'FIX-48', 'FIX-47']]]);
    assert.deepEqual(projected.held, []);
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
    const started = await cycle(c, store, { manual: true, ticket: 'FIX-50', model: 'auto', overrideLimits: ['idle', 'reserve', 'labels'], chain: 'all' });
    assert.equal(started.reason, 'plan-started', JSON.stringify(started));
    const planId = started.planId as string;
    assert.deepEqual(launches.slice(1).map(l => l.title), ['Factory: FIX-48', 'Factory: FIX-47'], 'two Claude slots: the two highest-priority unblocked blockers; FIX-47 runs despite lacking the ready label');
    assert.doesNotMatch(launches[2].initialMessage.text, /readiness label/);
    assert.match(launches[2].workspaceStrategy.branch, /^fix\/FIX-47-factory-[0-9a-f]{8}$/, 'a bug ticket gets a fix branch');
    assert.match(launches[1].workspaceStrategy.branch, /^chore\/FIX-48-factory-/, 'no kind label falls back to chore');
    assert.equal(store.plan(planId)!.tickets.find(x => x.key === 'FIX-49')!.note, 'Waiting for a free Claude slot');
    const instances = new Map(providers.map(p => [p.instanceId, p.driver]));
    assert.equal((await runPlans(c, store, new T3(c.t3), new Kanvil(c.kanvil), instances, threads)).length, 0, 'nothing more fits while both slots are busy');
    finish('FIX-48');
    await runPlans(c, store, new T3(c.t3), new Kanvil(c.kanvil), instances, threads);
    assert.deepEqual(launches.slice(3).map(l => l.title), ['Factory: FIX-49']);
    assert.match(launches[1].initialMessage.text, /Manual dispatch/, 'the launches made as the user chose the chain are manual');
    assert.doesNotMatch(launches[3].initialMessage.text, /Manual dispatch/, 'a continuation keeps the automatic policy');
    assert.match(launches[3].initialMessage.text, /Started by a chain the user requested/);
    finish('FIX-47'); finish('FIX-49');
    await runPlans(c, store, new T3(c.t3), new Kanvil(c.kanvil), instances, threads);
    assert.deepEqual(launches.slice(4).map(l => l.title), ['Factory: FIX-50'], 'the target starts once every ticket ahead of it is done');
    finish('FIX-50');
    await runPlans(c, store, new T3(c.t3), new Kanvil(c.kanvil), instances, threads);
    assert.equal(store.plan(planId)!.state, 'done');
    assert.throws(() => cancelPlan(store, planId), /not active/);
    assert.deepEqual(store.events(20).filter(e => e.kind.startsWith('plan.')).map(e => e.text).toReversed(), ['Chain to FIX-50 started with 3 tickets ahead of it', 'Chain to FIX-50 finished']);
  } finally {
    store.close();
    process.env.PATH = oldPath; process.env.T3_FACTORY_CONFIG = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every launch of a chain applies the overrides chosen when it started: the launches made as the user chooses it, and the ones that follow.
const startChain = async (f: ReturnType<typeof dispatchFixture>, options: { provider?: 'codex'; overrideLimits: OverrideLimits }) => {
  f.tasks[1].status = 'todo';
  const result = await cycle(f.c, f.store, { manual: true, ticket: 'FIX-1', model: 'auto', ...options, chain: 'all' }, { t3: f.t3, kanvil: f.kanvil });
  assert.equal(result.reason, 'plan-started', JSON.stringify(result));
  return result.planId as string;
};
const finishBlocker = (f: ReturnType<typeof dispatchFixture>) => {
  const blocker = f.store.jobs().find(job => job.ticketKey === 'FIX-2')!; blocker.state = 'complete'; f.store.save(blocker); f.tasks[1].status = 'done';
};
const advance = (f: ReturnType<typeof dispatchFixture>) => runPlans(f.c, f.store, f.t3, f.kanvil, new Map([['codex', 'codex']]), f.threads);
const setConfig = (f: ReturnType<typeof dispatchFixture>, change: () => void) => { change(); writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c)); };

test('a chain with the provider override runs every launch past provider capacity, and its forced provider survives', async t => {
  const f = dispatchFixture(t);
  setConfig(f, () => { f.c.models[0].automatic = false; f.c.concurrency.codex = 0; });
  const planId = await startChain(f, { provider: 'codex', overrideLimits: true });
  assert.equal(f.store.plan(planId)!.provider, 'codex');
  assert.equal(f.launches.length, 1, 'the first blocker starts with its provider set to Off');
  finishBlocker(f);
  await advance(f);
  assert.equal(f.launches.length, 2, 'the target starts later under the same override');
  assert.equal((f.launches[1] as any).modelSelection.instanceId, 'codex');
});

test('a running chain shows a ticket\'s hold until it is lifted', async t => {
  const f = dispatchFixture(t);
  const planId = await startChain(f, { overrideLimits: true });
  const target = () => f.store.plan(planId)!.target!;
  f.tasks[0].holdReason = 'waiting on legal';
  await advance(f);
  assert.match(target().hold ?? '', /waiting on legal/);
  f.tasks[0].holdReason = null;
  await advance(f);
  assert.equal(target().hold, undefined);
});

test('a chain without the provider override waits for capacity at every launch', async t => {
  const f = dispatchFixture(t);
  setConfig(f, () => { f.c.concurrency.codex = 0; });
  const planId = await startChain(f, { overrideLimits: ['idle', 'reserve', 'labels'] });
  assert.equal(f.launches.length, 0);
  assert.equal(f.store.plan(planId)!.tickets[0].note, 'Waiting for a free Codex slot');
  setConfig(f, () => { f.c.concurrency.codex = 1; });
  await advance(f);
  assert.equal(f.launches.length, 1, 'the blocker starts when a slot opens');
  finishBlocker(f);
  setConfig(f, () => { f.c.concurrency.codex = 0; });
  await advance(f);
  assert.equal(f.launches.length, 1, 'a later launch still waits');
});

for (const [name, overrideLimits, launches] of [['with', ['labels'], 2], ['without', ['idle'], 1]] as const) test(`a chain ${name} the label override ${name === 'with' ? 'passes a full label' : 'waits for the label'} on a later launch`, async t => {
  const f = dispatchFixture(t);
  const planId = await startChain(f, { overrideLimits: [...overrideLimits] });
  assert.equal(f.launches.length, 1);
  finishBlocker(f);
  // Another run holds the only slot for the label the target carries.
  const held = { ...f.store.jobs()[0], id: 'other', taskId: 'other', ticketKey: 'FIX-9', threadId: 'other-thread', state: 'waiting' as const, labels: ['med'] };
  f.store.save(held);
  setConfig(f, () => { f.c.projects[0].labelLimits = { med: { limit: 1, mode: 'full' } }; });
  await advance(f);
  assert.equal(f.launches.length, launches);
  if (launches === 1) assert.match(f.store.plan(planId)!.target!.note ?? '', /free med slot/);
});

test('shared dependency ancestors reuse reads without becoming cycles', async t => {
  const f = dispatchFixture(t);
  for (const [n, id] of ['left', 'right', 'shared'].entries()) f.tasks.push(f.task(id, n + 3));
  f.relations.splice(0, f.relations.length, ...[
    ['left', 'root'], ['right', 'root'], ['shared', 'left'], ['shared', 'right'],
  ].map(([sourceTaskId, targetTaskId]) => ({ sourceTaskId, targetTaskId, relationType: 'subtask' })));
  assert.equal((await f.run()).reason, 'dispatched');
  assert.equal(f.calls.filter(x => x === 'relations:shared:true').length, 1, 'shared ancestor reads are cached independently of the ancestry path');
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
    if (final && name === 'ticket' && id.startsWith('dep-')) {
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
  for (let n = 0; n < 12; n++) assert.equal(f.calls.filter(x => x === `ticket:dep-${n}:true`).length, 1);
});

test('cancelling a chain during suspended final validation cannot launch or restore the plan', async t => {
  const f = dispatchFixture(t), { ReadContext } = await import('../src/read-context.ts');
  const target = { ...f.tasks[0], key: 'FIX-1', projectId: 'FIX', difficulty: 'med' as const, labels: [], runnable: true, blockedBy: [], done: false };
  f.store.savePlan({ id: 'chain', createdAt: new Date().toISOString(), target, tickets: [], model: 'sol', overrideLimits: [], state: 'active' });
  let cancelled = false;
  f.hooks.quota = async refresh => { if (refresh && !cancelled) { cancelPlan(f.store, 'chain'); cancelled = true; } };
  const context = new ReadContext();
  const results = await context.run(() => runPlans(f.c, f.store, f.t3, f.kanvil, new Map([['codex', 'codex']]), []));
  assert.equal(cancelled, true);
  assert.equal(f.launches.length, 0);
  assert.equal(f.store.plan('chain')!.state, 'cancelled');
  assert.equal(results[0].reason, 'plan-cancelled-before-dispatch');
});

// Epics: a plan with no target that follows its members. Every scenario starts through the real dispatch path.
const epicFixture = (t: test.TestContext, ...members: string[]) => {
  const f = dispatchFixture(t);
  f.relations.splice(0);
  f.tasks.splice(0, f.tasks.length, ...members.map((id, n) => f.task(id, n + 1, 'todo')));
  f.epics.push({ id: 'epic', title: 'Launch', archived: false, members: [...members], restrictedCount: 0 });
  setConfig(f, () => { f.c.concurrency.codex = 5; });
  return f;
};
const limits: OverrideLimits = ['idle', 'reserve', 'labels'];
const startEpic = (f: ReturnType<typeof dispatchFixture>, options: Record<string, unknown> = {}) => cycle(f.c, f.store, { manual: true, epic: 'epic', model: 'auto', overrideLimits: limits, ...options } as any, { t3: f.t3, kanvil: f.kanvil }) as Promise<Record<string, any>>;
const titles = (f: ReturnType<typeof dispatchFixture>) => f.launches.map(l => (l as any).title.replace('Factory: ', '')).toSorted();
const finishTicket = (f: ReturnType<typeof dispatchFixture>, id: string, status = 'done') => {
  f.tasks.find(task => task.id === id)!.status = status;
  const job = f.store.jobs().find(job => job.taskId === id);
  if (job) { job.state = 'complete'; f.store.save(job); }
};
const blocks = (f: ReturnType<typeof dispatchFixture>, source: string, target: string) => f.relations.push({ sourceTaskId: source, targetTaskId: target, relationType: 'blocks' });
const plan = (f: ReturnType<typeof dispatchFixture>) => f.store.plans().at(-1)!;
const foreign = (f: ReturnType<typeof dispatchFixture>, id: string, status = 'todo') => { const task = { ...f.task(id, 7, status), projectId: 'OTHER', key: 'OTHER-7' }; f.tasks.push(task); return task; };

test('an Epic starts every free member at once and the rest as their blockers finish, then ends without an extra launch', async t => {
  const f = epicFixture(t, 'a', 'b', 'c');
  blocks(f, 'a', 'c');
  const started = await startEpic(f, { model: 'sol' });
  assert.equal(started.reason, 'plan-started', JSON.stringify(started));
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-2'], 'both free members start in the same pass');
  assert.equal(plan(f).target, undefined);
  assert.deepEqual(plan(f).epic, { id: 'epic', title: 'Launch', restrictedCount: 0 });
  await advance(f);
  assert.equal(f.launches.length, 2, 'a blocked member waits');
  finishTicket(f, 'a'); await advance(f);
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-2', 'FIX-3'], 'it starts once its blocker is finished in Kanvil');
  assert.equal((f.launches[2] as any).modelSelection.model, 'fixture-sol', 'a later launch keeps the chosen model');
  assert.match((f.launches[2] as any).initialMessage.text, /Started by a chain the user requested/);
  finishTicket(f, 'b'); finishTicket(f, 'c'); await advance(f);
  assert.equal(plan(f).state, 'done');
  assert.equal(f.launches.length, 3, 'a plan with no target launches nothing extra');
  assert.deepEqual(f.store.events(20).filter(e => e.kind.startsWith('plan.')).map(e => e.text).toReversed(), ['Epic Launch started with 3 tickets', 'Epic Launch finished']);
});

test('an Epic applies its overrides on every pass, and limits it did not override still cap it', async t => {
  const f = epicFixture(t, 'a', 'b', 'c');
  blocks(f, 'a', 'c');
  setConfig(f, () => { f.c.concurrency.codex = 1; });
  await startEpic(f);
  assert.deepEqual(titles(f), ['FIX-1'], 'one provider slot starts one ticket');
  assert.equal(plan(f).tickets.find(ticket => ticket.id === 'b')!.note, 'Waiting for a free Codex slot');
  const overridden = epicFixture(t, 'a', 'b', 'c');
  blocks(overridden, 'a', 'c');
  setConfig(overridden, () => { overridden.c.concurrency.codex = 1; });
  await startEpic(overridden, { overrideLimits: true });
  assert.deepEqual(titles(overridden), ['FIX-1', 'FIX-2'], 'the provider override passes capacity at the start');
  finishTicket(overridden, 'a'); await advance(overridden);
  assert.deepEqual(titles(overridden), ['FIX-1', 'FIX-2', 'FIX-3'], 'and on a later pass');
});

test('an Epic plan follows membership, and a failed member read keeps its last list and records the error', async t => {
  const f = epicFixture(t, 'a', 'b');
  blocks(f, 'a', 'b');
  await startEpic(f);
  assert.deepEqual(titles(f), ['FIX-1']);
  f.tasks.push(f.task('late', 3, 'todo'));
  f.epics[0].members.push('late');
  f.epics[0].members.splice(f.epics[0].members.indexOf('b'), 1);
  await advance(f);
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-3'], 'a ticket added mid-run joins on the next pass');
  assert.deepEqual(plan(f).tickets.map(ticket => ticket.id).toSorted(), ['a', 'late'], 'a removed ticket without a run leaves');
  f.epics[0].members.splice(0, 1);
  await advance(f);
  assert.deepEqual(plan(f).tickets.map(ticket => ticket.id).toSorted(), ['a', 'late'], 'a removed ticket with a run stays until it finishes');
  f.epics[0].members.unshift('a');
  f.hooks.epics = async () => { throw new Error('Kanvil unavailable'); };
  finishTicket(f, 'a'); finishTicket(f, 'late'); await advance(f);
  assert.equal(plan(f).state, 'active', 'an unreadable Epic cannot finish');
  assert.deepEqual(plan(f).tickets.map(ticket => [ticket.id, ticket.done]).toSorted(), [['a', true], ['late', true]], 'the last list stays and keeps advancing');
  f.tasks.find(task => task.id === 'late')!.status = 'todo'; await advance(f);
  assert.match(plan(f).tickets.find(ticket => ticket.id === 'late')!.note ?? '', /Kanvil unavailable/, 'the error is recorded in the ticket note');
  f.hooks.epics = async () => {};
  await advance(f);
  assert.doesNotMatch(plan(f).tickets.find(ticket => ticket.id === 'late')!.note ?? '', /Kanvil unavailable/, 'a later good read clears the error');
  finishTicket(f, 'late'); await advance(f);
  assert.equal(plan(f).state, 'done');
});

test('a blocker outside the Epic joins the plan, and a cancelled member cannot stall it', async t => {
  const f = epicFixture(t, 'a', 'b', 'gone', 'c');
  f.tasks.find(task => task.id === 'gone')!.status = 'cancelled';
  f.tasks.push(f.task('outsider', 9, 'todo'));
  blocks(f, 'outsider', 'a'); blocks(f, 'gone', 'b'); blocks(f, 'c', 'a');
  const started = await startEpic(f);
  assert.equal(started.reason, 'plan-started', JSON.stringify(started));
  const outsider = plan(f).tickets.find(ticket => ticket.id === 'outsider')!;
  assert.equal(outsider.outside, true);
  assert.equal(plan(f).tickets.find(ticket => ticket.id === 'b')!.outside, undefined);
  assert.equal(plan(f).tickets.some(ticket => ticket.id === 'gone'), false, 'a cancelled member has nothing left to run');
  assert.deepEqual(titles(f), ['FIX-2', 'FIX-4', 'FIX-9'], 'a cancelled blocker releases its dependent, through the launch checks too');
  finishTicket(f, 'outsider'); finishTicket(f, 'c', 'cancelled'); await advance(f);
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-2', 'FIX-4', 'FIX-9'], 'the member waits for its blocker outside the Epic');
  finishTicket(f, 'a', 'cancelled'); finishTicket(f, 'b'); await advance(f);
  assert.equal(plan(f).state, 'done', 'cancelled members count as finished');
});

test('only an unfinished ticket that cannot start blocks an Epic, and the automatic-runs switch does not', async t => {
  const f = epicFixture(t, 'a', 'b', 'c');
  Object.assign(f.tasks.find(task => task.id === 'c')!, { status: 'done', automationReady: false });
  setConfig(f, () => { f.c.enabled = false; });
  const started = await startEpic(f);
  assert.equal(started.reason, 'plan-started', JSON.stringify(started));
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-2']);
});

test('a ticket that loses readiness mid-run waits while the running Epic continues', async t => {
  const f = epicFixture(t, 'a', 'b', 'c');
  blocks(f, 'a', 'b'); blocks(f, 'a', 'c');
  assert.equal((await startEpic(f)).reason, 'plan-started');
  f.tasks.find(task => task.id === 'c')!.automationReady = false;
  finishTicket(f, 'a'); await advance(f);
  assert.equal(plan(f).state, 'active');
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-2'], 'the rest start and the unready ticket does not');
});

for (const [name, setup, reason, text] of [
  ['an archived Epic', f => { f.epics[0].archived = true; }, 'epic-archived', /archived/],
  ['an Epic with no unfinished members', f => { f.tasks[0].status = 'done'; f.tasks[1].status = 'cancelled'; }, 'epic-no-unfinished', /no unfinished/],
  ['an Epic with a member in a missing project', f => { foreign(f, 'other'); f.epics[0].members.push('other'); }, 'epic-project-not-included', /OTHER-7 \(OTHER\)/],
  ['an Epic with an outside blocker in a missing project', f => { foreign(f, 'other'); blocks(f, 'other', 'a'); }, 'epic-project-not-included', /OTHER-7 \(OTHER\)/],
  ['an Epic with a member in a disabled project', f => { setConfig(f, () => { f.c.projects.push({ ...f.c.projects[0], name: 'Paused', key: 'OFF', kanvilId: 'OFF', t3Id: 'OFF', enabled: false }); }); f.tasks.push({ ...f.task('off', 3, 'todo'), projectId: 'OFF' }); f.epics[0].members.push('off'); }, 'epic-project-not-included', /OFF-3 \(Paused\)/],
  ['an Epic with restricted tickets', f => { f.epics[0].restrictedCount = 2; }, 'epic-restricted-tickets', /2 tickets/],
  ['an Epic with a member without automation readiness', f => { f.tasks[1].automationReady = false; }, 'epic-tickets-not-ready', /FIX-2 \(Agent work is not enabled in Kanvil\)/],
  ['an Epic with a member on hold', f => { f.tasks[1].holdReason = 'waiting on legal'; }, 'epic-tickets-not-ready', /FIX-2 \(Ticket is on hold: waiting on legal\)/],
  ['an Epic with an outside blocker on hold', f => { f.tasks.push({ ...f.task('outsider', 9, 'todo'), holdReason: 'waiting on legal' }); blocks(f, 'outsider', 'a'); }, 'epic-tickets-not-ready', /FIX-9/],
] as [string, (f: ReturnType<typeof dispatchFixture>) => void, string, RegExp][]) test(`starting ${name} is refused with every override and creates no plan`, async t => {
  const f = epicFixture(t, 'a', 'b');
  setup(f);
  const refused = await startEpic(f, { overrideLimits: true });
  assert.equal(refused.reason, reason, JSON.stringify(refused));
  assert.match(refused.message, text);
  assert.equal(f.store.plans().length, 0);
  assert.equal(f.launches.length, 0);
  await refreshInventory(f.c, f.store, f.t3, f.kanvil);
  const row = writeStatus(f.c, f.store).epics.find(row => row.id === 'epic');
  if (row) assert.deepEqual([row.startBlock?.reason, row.startBlock?.message], [refused.reason, refused.message], 'the page and the start path share one answer');
});

test('an Epic with an active plan is refused, a finished ticket in a missing project blocks nothing, and status follows both', async t => {
  const f = epicFixture(t, 'a');
  foreign(f, 'other', 'done'); f.epics[0].members.push('other');
  await refreshInventory(f.c, f.store, f.t3, f.kanvil);
  const open = writeStatus(f.c, f.store).epics[0];
  assert.equal(open.startBlock, null);
  assert.deepEqual(open.tickets.map(ticket => [ticket.key, ticket.runnable, ticket.readiness?.ready, ticket.labels]), [['FIX-1', true, true, ['sf', 'med']]], 'the page filters Epic rows by these labels');
  assert.equal((await startEpic(f)).reason, 'plan-started');
  const refused = await startEpic(f);
  assert.equal(refused.reason, 'epic-already-running');
  assert.equal(f.store.plans().length, 1);
  const running = writeStatus(f.c, f.store).epics[0];
  assert.deepEqual([running.startBlock?.reason, running.startBlock?.message], [refused.reason, refused.message]);
  assert.equal(running.planId, plan(f).id);
});

test('a running Epic stays active and reports hidden tickets until none remain', async t => {
  const f = epicFixture(t, 'a');
  await startEpic(f);
  f.epics[0].restrictedCount = 1;
  finishTicket(f, 'a'); await advance(f);
  assert.equal(plan(f).state, 'active');
  assert.equal(plan(f).epic!.restrictedCount, 1);
  f.epics[0].restrictedCount = 0; await advance(f);
  assert.equal(plan(f).state, 'done');
});

for (const [name, leave] of [
  ['joins from a missing project', f => { foreign(f, 'late'); f.epics[0].members.push('late'); }],
  ['has its project disabled', f => {
    setConfig(f, () => { f.c.projects.push({ ...f.c.projects[0], name: 'Paused', key: 'OFF', kanvilId: 'OFF', t3Id: 'OFF', enabled: false }); });
    f.tasks.push({ ...f.task('late', 8, 'todo'), projectId: 'OFF' }); f.epics[0].members.push('late');
  }],
] as [string, (f: ReturnType<typeof dispatchFixture>) => void][]) test(`a ticket that ${name} mid-run waits with its note while the rest of the Epic continues`, async t => {
  const f = epicFixture(t, 'a', 'dependent', 'free');
  blocks(f, 'a', 'free');
  await startEpic(f);
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-2']);
  leave(f);
  blocks(f, 'late', 'dependent');
  await advance(f);
  const ticket = plan(f).tickets.find(ticket => ticket.id === 'late')!;
  assert.equal(ticket.runnable, false);
  assert.equal(ticket.note, 'Its project is not included in the factory');
  finishTicket(f, 'a'); finishTicket(f, 'dependent'); await advance(f);
  assert.deepEqual(titles(f), ['FIX-1', 'FIX-2', 'FIX-3'], 'other tickets continue');
  finishTicket(f, 'free'); await advance(f);
  assert.equal(plan(f).state, 'active', 'the Epic stays active until that ticket is finished elsewhere');
  finishTicket(f, 'late'); await advance(f);
  assert.equal(plan(f).state, 'done');
});

const automaticPass = (f: ReturnType<typeof dispatchFixture>) => cycle(f.c, f.store, {}, { t3: f.t3, kanvil: f.kanvil, workKind: 'tickets' });
const heldReason = (f: ReturnType<typeof dispatchFixture>, key = 'FIX-1') => JSON.parse(f.store.get('upNext')!).held.find((row: any) => row.key === key)?.reason;
for (const held of [undefined, false, true]) test(`holdEpicTicketsUntilStarted ${held}: ${held ? 'an unstarted Epic waits but a named start works' : 'an unstarted Epic stays schedulable'}`, async t => {
  const f = epicFixture(t, 'a');
  f.tasks[0].epicId = 'epic';
  if (held !== undefined) setConfig(f, () => { (f.c as any).holdEpicTicketsUntilStarted = held; });
  await automaticPass(f);
  if (!held) { assert.deepEqual(titles(f), ['FIX-1']); return; }
  assert.equal(titles(f).includes('FIX-1'), false);
  assert.match(heldReason(f), /Waits for its Epic to start/);
  assert.equal((await f.run()).reason, 'dispatched', 'a named start is unaffected');
});

test('holding unstarted Epics leaves members of an archived Epic to ordinary scheduling', async t => {
  const f = epicFixture(t, 'a');
  f.tasks[0].epicId = 'epic'; f.epics[0].archived = true;
  setConfig(f, () => { (f.c as any).holdEpicTicketsUntilStarted = true; });
  await automaticPass(f);
  assert.deepEqual(titles(f), ['FIX-1'], 'an archived Epic can never start, so holding for it would strand the ticket');
});

for (const [name, holdBefore, holdAfter, archived, launched] of [
  ['the setting turns on', false, true, false, false],
  ['the ticket joins an unstarted Epic', true, true, false, false],
  ['the ticket joins an archived Epic', true, true, true, true],
  ['the setting stays off', false, false, false, true],
] as const) test(`an automatic pass on a prepared queue rechecks the unstarted-Epic hold when ${name}`, async t => {
  const f = epicFixture(t, 'a');
  f.epics[0].archived = archived;
  setConfig(f, () => { f.c.holdEpicTicketsUntilStarted = holdBefore; });
  await refreshInventory(f.c, f.store, f.t3, f.kanvil);
  assert.equal(JSON.parse(f.store.get('upNext')!).tickets[0].key, 'FIX-1', 'the queue was prepared before the change');
  f.tasks[0].epicId = 'epic';
  setConfig(f, () => { f.c.holdEpicTicketsUntilStarted = holdAfter; });
  await cycle(f.c, f.store, {}, { t3: f.t3, kanvil: f.kanvil, workKind: 'tickets', backgroundInventory: true });
  assert.equal(titles(f).includes('FIX-1'), launched);
});

for (const joined of [false, true]) test(`whatever the setting, a running Epic keeps a member ${joined ? 'that has not joined its plan yet' : 'from its plan'} out of automatic passes`, async t => {
  const f = epicFixture(t, 'a', 'b');
  const node = { id: 'a', key: 'FIX-1', title: 'Fixture', projectId: 'FIX', status: 'todo', priority: 'high', createdAt: '2026-01-01', difficulty: 'med' as const, runnable: true, blockedBy: [], done: false };
  if (joined) f.tasks[0].epicId = 'epic';
  f.store.savePlan({ id: 'running', createdAt: new Date().toISOString(), epic: { id: 'epic', title: 'Launch' }, tickets: joined ? [] : [node], model: 'sol', overrideLimits: [], state: 'active' });
  await automaticPass(f);
  assert.deepEqual(titles(f), ['FIX-2'], 'other tickets still start');
  assert.match(heldReason(f), /Runs with its Epic/);
});
