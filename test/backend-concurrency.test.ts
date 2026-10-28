import { v2Thread } from './v2-fixture.ts';
import { T3 } from '../src/clients.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeStatus, log } from '../src/scheduler.ts';
import { dispatchFixture, serviceFixture, deferred } from './dispatch-fixture.ts';
import { cycle } from '../src/scheduler.ts';

for (const held of ['read', 'launch']) test(`independent manual dispatch completes while another ${held} is held`, async t => {
  const f = serviceFixture(t), { internal } = f;
  f.tasks.push(f.task('second', 3, 'todo'));
  const entered = deferred(), release = deferred();
  let first = true;
  if (held === 'read') f.hooks.quota = async refresh => { if (refresh && first) { first = false; entered.resolve(); await release.promise; } };
  else t.mock.method(f.t3, 'launch', async (command: any) => {
    f.launches.push(command);
    if (command.title === 'Factory: FIX-1') { entered.resolve(); await release.promise; }
    return {};
  });
  const a = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', model: 'sol' } });
  let b: Promise<any> | undefined;
  try {
    await entered.promise;
    b = internal.handle({ type: 'dispatch', options: { ticket: 'FIX-3', model: 'sol' } });
    const result = await Promise.race([b, delay(1500, undefined, { ref: false })]);
    assert.equal(result?.data.reason, 'dispatched', 'ticket B must finish while ticket A remains held');
    assert.ok(f.launches.some((command: any) => command.title === 'Factory: FIX-3'));
    const work = (await internal.handle({ type: 'health' })).data;
    assert.ok(work.active || work.operations?.length, 'health retains visibility of the held operation');
  } finally {
    release.resolve(); await Promise.allSettled([a, b]);
    clearTimeout(internal.timer); clearTimeout(internal.statusTimer);
    await internal.idle;
  }
});

test('simultaneous requests for the same ticket submit exactly one launch', async t => {
  const f = serviceFixture(t), { internal } = f;
  try {
    const results = await Promise.all([1, 2].map(() => internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', model: 'sol' } })));
    assert.equal(results.filter(r => r.data.reason === 'dispatched').length, 1);
    assert.equal(f.launches.length, 1);
    assert.equal(f.store.jobs().filter(j => !['complete', 'dismissed'].includes(j.state)).length, 1);
  } finally { clearTimeout(internal.timer); clearTimeout(internal.statusTimer); await internal.idle; }
});

for (const manual of [true, false]) test(`connection preflight failure leaves no launch reservation: manual=${manual}`, async t => {
  const f = dispatchFixture(t);
  writeFileSync(f.c.t3.credentialFile, JSON.stringify({ token: 'fixture-token' }));
  t.mock.method(f.t3, 'socketUrl', async () => { throw new Error('Fixture connection preflight failed'); });
  t.mock.method(f.t3, 'launch', T3.prototype.launch);
  if ('prepareLaunch' in f.t3) t.mock.method(f.t3, 'prepareLaunch', T3.prototype.prepareLaunch);
  if (manual) await assert.rejects(f.run(), /Fixture connection preflight failed/);
  else assert.equal((await f.run('auto', false)).reason, 'watching-streams');
  assert.equal(f.launches.length, 0, 'a failed read-only prerequisite must never submit a launch');
  assert.equal(f.store.jobs().length, 0, 'a failed connection cannot retain ticket or execution ownership');
});

test('status keeps recent history bounded and never loads historical prompts', async t => {
  const f = dispatchFixture(t);
  await f.run();
  const base = f.store.jobs()[0];
  for (let i = 0; i < 25; i++) f.store.archiveJob({ ...base, id: `history-${i}`, threadId: `thread-${i}`, state: 'complete', completedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), command: { initialMessage: { text: 'x'.repeat(100_000) } } });
  t.mock.method(f.store, 'history', () => { assert.fail('status must not materialize the entire history'); });
  writeStatus(f.c, f.store);
  const status = JSON.parse(readFileSync(join(f.c.stateDir, 'status.json'), 'utf8'));
  assert.equal(status.recent.length, 15);
  assert.equal(status.recent[0].id, 'history-24');
  assert.ok(status.recent.every((job: any) => !('command' in job)));
});

for (const lane of ['reconcile', 'inventory', 'automatic', 'upstream', 'workspace-cleanup', 'cleanup-inventory', 'session-tickets', 'quota-refresh']) test(`held ${lane} work cannot block dispatch or unrelated Stop`, async t => {
  const f = serviceFixture(t), entered = deferred(), release = deferred();
  const held = f.internal.enqueue(async () => { entered.resolve(); await release.promise; }, false, { reason: lane });
  let stops = 0;
  t.mock.method(f.t3, 'stop', async () => { stops++; });
  try {
    await entered.promise;
    const dispatch = f.internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', model: 'sol' } });
    const result = await Promise.race([dispatch, delay(1500, undefined, { ref: false })]);
    assert.equal(result?.data.reason, 'dispatched', 'background work cannot occupy a dispatch worker');
    const stopped = await f.internal.handle({ type: 'job-stop', jobId: result.data.jobId });
    assert.equal(stopped.code, 0); assert.equal(stops, 1);
    const health = (await f.internal.handle({ type: 'health' })).data;
    assert.ok(health.operations.some((operation: any) => operation.reason === lane));
    assert.equal(health.queueDepth, 0);
  } finally { release.resolve(); await held; }
});

test('automatic assignments prepare and launch independently within configured capacity', async t => {
  const f = dispatchFixture(t), entered = deferred(), release = deferred(), other = deferred();
  f.c.concurrency.codex = 2; writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  f.tasks.push(f.task('second', 3, 'todo'));
  let first = true;
  f.hooks.quota = async refresh => { if (refresh && first) { first = false; entered.resolve(); await release.promise; } };
  t.mock.method(f.t3, 'launch', async (command: any) => { f.launches.push(command); if (command.title === 'Factory: FIX-3') other.resolve(); });
  const run = f.run('auto', false);
  try {
    await entered.promise;
    const launched = await Promise.race([other.promise.then(() => true), delay(1500, false, { ref: false })]);
    assert.equal(launched, true, 'an automatic assignment cannot monopolize another available launch slot');
  } finally { release.resolve(); await run; }
  assert.equal(f.launches.length, 2);
});

test('racing automatic passes reserve the last provider slot exactly once', async t => {
  const f = dispatchFixture(t), both = deferred(), release = deferred();
  f.tasks.push(f.task('second', 3, 'todo'));
  let reads = 0;
  f.hooks.quota = async refresh => { if (refresh && ++reads <= 2) { if (reads === 2) both.resolve(); await release.promise; } };
  const runs = [1, 3].map(number => cycle(f.c, f.store, { ticket: `FIX-${number}` }, { t3: f.t3, kanvil: f.kanvil }));
  try { await both.promise; } finally { release.resolve(); await Promise.all(runs); }
  assert.equal(f.launches.length, 1);
  assert.equal(f.store.jobs().filter(job => job.state === 'dispatching').length, 1);
});

test('racing manual admissions respect the last shared label slot', async t => {
  const f = serviceFixture(t), both = deferred(), release = deferred();
  f.tasks.push(f.task('second', 3, 'todo')); f.c.projects[0].labelLimits = { med: 1 };
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  let reads = 0;
  f.hooks.quota = async refresh => { if (refresh && ++reads <= 2) { if (reads === 2) both.resolve(); await release.promise; } };
  const runs = [1, 3].map(number => f.internal.handle({ type: 'dispatch', options: { ticket: `FIX-${number}`, model: 'sol' } }));
  try { await both.promise; } finally { release.resolve(); await Promise.all(runs); }
  assert.equal(f.launches.length, 1);
  assert.ok((await Promise.all(runs)).some(result => result.data.reason === 'label-limit'));
});

test('a delayed web handoff uses the original receipt deadline without launching', async t => {
  const f = serviceFixture(t), id = '11111111-1111-4111-8111-111111111119';
  mkdirSync(join(f.c.stateDir, 'web-requests'), { recursive: true });
  writeFileSync(join(f.c.stateDir, 'web-requests', `${id}.json`), JSON.stringify({ id, state: 'running', input: {}, createdAt: new Date(Date.now() - 61_000).toISOString() }));
  const result = await f.internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', model: 'sol', requestId: id } });
  assert.equal(result.data.reason, 'manual-deadline-exceeded'); assert.equal(result.data.notLaunched, true);
  assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
});

test('legacy uncertain requests cannot be resent under their original request ID', async t => {
  const f = serviceFixture(t), id = '11111111-1111-4111-8111-111111111118';
  mkdirSync(join(f.c.stateDir, 'web-requests'), { recursive: true });
  writeFileSync(join(f.c.stateDir, 'web-requests', `${id}.json`), JSON.stringify({ id, state: 'uncertain', input: {}, createdAt: new Date().toISOString() }));
  const result = await f.internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', model: 'sol', requestId: id } });
  assert.equal(result.data.uncertain, true); assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
});

test('eligible tickets preserve provider failures instead of reporting no eligible ticket', async t => {
  const f = dispatchFixture(t);
  t.mock.method(f.t3, 'provider', async () => { throw Object.assign(new Error('Fixture provider unavailable'), { code: 'ECONNRESET' }); });
  const result = await f.run('auto');
  assert.equal(result.reason, 'no-ready-model'); assert.match(String(result.message), /Fixture provider unavailable/);
  assert.equal(result.eligible, 1); assert.equal(f.launches.length, 0);
});

test('shutdown drains an owned launch before closing clients and the ledger', async t => {
  const f = serviceFixture(t), entered = deferred(), release = deferred(), events: string[] = [];
  t.mock.method(f.t3, 'launch', async () => { entered.resolve(); await release.promise; events.push('launch-settled'); });
  const close = f.t3.close.bind(f.t3);
  t.mock.method(f.t3, 'close', async () => { events.push('client-closed'); await close(); });
  const run = f.internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', model: 'sol' } });
  await entered.promise;
  const stopping = f.service.stop();
  try { await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, []); }
  finally { release.resolve(); await run; await stopping; }
  assert.deepEqual(events, ['launch-settled', 'client-closed']);
});

test('an owned automatic launch cannot make another checking assignment survive shutdown', async t => {
  const f = serviceFixture(t), owned = deferred(), reading = deferred(), releaseOwned = deferred(), releaseRead = deferred();
  f.tasks.push(f.task('second', 3, 'todo')); f.c.concurrency.codex = 2;
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  let refreshes = 0;
  f.hooks.quota = async refresh => { if (refresh && ++refreshes === 2) { reading.resolve(); await releaseRead.promise; } };
  t.mock.method(f.t3, 'launch', async (command: any) => { f.launches.push(command); if (command.title === 'Factory: FIX-1') { owned.resolve(); await releaseOwned.promise; } });
  const run = f.internal.enqueue(() => f.internal.pass({}, 'automatic-fixture', 0), false);
  await Promise.all([owned.promise, reading.promise]);
  const stopping = f.service.stop();
  try {
    releaseRead.resolve();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.launches.length, 1, 'shutdown must cancel unowned assignments even while a sibling owns a launch');
  } finally { releaseRead.resolve(); releaseOwned.resolve(); await run; await stopping; }
  assert.equal(f.launches.length, 1);
});

for (const projectId of ['OTHER', 'FIX']) test(`final validation scopes event changes to relevant projects: ${projectId}`, async t => {
  const f = dispatchFixture(t), client = f.kanvil as any;
  Object.assign(client, { watching: true, connected: true });
  client.projectStreams.set('FIX', { connected: true, ready: Promise.withResolvers<void>() });
  f.hooks.quota = async refresh => { if (refresh) client.applyChange({ id: '99', projectId, ticketId: projectId === 'FIX' ? 'root' : 'changed', type: 'ticket.updated' }); };
  const result = await f.run();
  assert.equal(result.reason, projectId === 'FIX' ? 'ticket-changed-before-dispatch' : 'dispatched');
  assert.equal(f.launches.length, projectId === 'FIX' ? 0 : 1);
});

test('status stage bursts coalesce without losing current operation progress', async t => {
  const f = serviceFixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  const set = f.store.set.bind(f.store);
  t.mock.method(f.store, 'set', (key: string, value: string) => { if (key === 'serviceWork') writes++; set(key, value); });
  for (let n = 0; n < 50; n++) f.internal.publishWork();
  assert.equal(writes, 0);
  t.mock.timers.tick(100);
  assert.equal(writes, 1, 'one status publication handles the entire stage burst');
});

test('service validates its configured path independently of the CLI environment', async t => {
  const f = serviceFixture(t), other = join(f.dir, 'other-config.jsonc');
  writeFileSync(other, JSON.stringify({ ...f.c, enabled: false }));
  process.env.T3_FACTORY_CONFIG = other;
  const result = await f.internal.handle({ type: 'dispatch', options: { ticket: 'FIX-1', model: 'sol' } });
  assert.equal(result.data.reason, 'dispatched', 'the service must validate the path it actually loaded');
  assert.equal(f.launches.length, 1);
});

test('decision logging stays bounded without dropping the complete stored decision', t => {
  let output = '';
  t.mock.method(console, 'log', (value: string) => { output = value; });
  log('decision', { reason: 'watching-streams', eligible: 0, skipped: Array.from({ length: 100 }, (_, number) => ({ key: `FIX-${number}`, reason: 'Held', ticket: { description: 'fixture-body'.repeat(1000) } })) });
  const event = JSON.parse(output);
  assert.equal(event.skippedCount, 100); assert.equal(event.skipped.length, 5);
  assert.ok(output.length < 1500); assert.doesNotMatch(output, /fixture-body/);
});

test('late session metadata writes preserve dismissal and consumption tombstones', t => {
  const f = dispatchFixture(t);
  const row = { taskId: 'session-ticket', projectId: 'FIX', key: 'FIX-1', number: 1, title: 'Old metadata', priority: 'high', status: 'todo', labels: [], createdAt: '2026-01-01', firstSeenAt: '2026-01-01', refreshedAt: '2026-01-01', sources: [] };
  f.store.saveSessionTicket(row);
  f.store.saveSessionTicket({ ...row, dismissedAt: '2026-01-02', consumed: { jobId: 'owned', at: '2026-01-02' } });
  f.store.saveSessionTicket({ ...row, title: 'New metadata' });
  const saved = f.store.sessionTicket(row.taskId)!;
  assert.equal(saved.title, 'New metadata'); assert.equal(saved.dismissedAt, '2026-01-02'); assert.equal(saved.consumed?.jobId, 'owned');
});

test('coalescing is per lane and a failed lane cannot block another lane', async t => {
  const f = serviceFixture(t), entered = deferred(), release = deferred();
  let blockedRuns = 0, independentRuns = 0;
  const blocked = async () => { blockedRuns++; if (blockedRuns === 1) { entered.resolve(); await release.promise; throw new Error('Fixture lane failure'); } };
  f.internal.runLane('held', blocked);
  try {
    await entered.promise;
    for (let n = 0; n < 20; n++) f.internal.runLane('held', blocked);
    f.internal.runLane('independent', async () => { independentRuns++; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(independentRuns, 1); assert.equal(blockedRuns, 1);
  } finally { release.resolve(); await f.internal.idle; }
  assert.equal(blockedRuns, 2, 'the held domain gets one follow-up despite the failure and wake burst');
});

test('unavailable automatic lanes leave unnamed manual starts and explicit chains independent', async t => {
  const f = serviceFixture(t);
  f.c.concurrency = { claude: 0, codex: 10 };
  f.c.models[0].automatic = false;
  f.c.upstream = { enabled: true, promptFile: f.c.factorySkill, checkMinutes: 60 };
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  const ticket = { id: 'root', key: 'FIX-1', title: 'Fixture', projectId: 'FIX', status: 'todo', priority: 'high', createdAt: '2026-01-01', difficulty: 'med' as const, automationReady: true, runnable: true, blockedBy: [], done: false };
  f.store.savePlan({ id: 'explicit-chain', createdAt: new Date().toISOString(), target: ticket, tickets: [], model: 'sol', overrideLimits: [], state: 'active' });
  for (let n = 3; n < 515; n++) { f.tasks.push({ ...f.task(`ready-${n}`, n, 'todo'), version: 1, readiness: { ready: true, reasons: [] } }); f.relations.push({ sourceTaskId: 'blocker', targetTaskId: `ready-${n}`, relationType: 'blocks' }); }
  const admissions: string[] = [], pass = f.internal.pass.bind(f.internal);
  t.mock.method(f.internal, 'pass', async (...args: any[]) => {
    if (args[3]) { admissions.push(`${args[3]}:${args[4]}`); return { reason: 'fixture' }; }
    return pass(...args);
  });
  for (const kind of ['tickets', 'upstream', 'chains']) f.internal.scheduleAdmissions('fixture', kind);
  await f.internal.idle;
  assert.deepEqual(admissions, ['chains:codex'], 'manual-only models and zero-capacity providers cannot start automatic RPC/inventory loops');
  f.store.savePlan({ ...f.store.plan('explicit-chain')!, state: 'cancelled' });
  const result = await f.internal.handle({ type: 'dispatch', options: { ticket: '', model: 'sol', dryRun: true, overrideLimits: ['idle', 'reserve'] } });
  assert.equal(result.data.reason, 'would-dispatch', 'the actual unnamed manual path remains available');
});

test('streamed thread counters do not restart all backend domains', async t => {
  const f = serviceFixture(t), wakes: string[] = [];
  let invalidations = 0;
  t.mock.method(f.internal, 'wake', (reason: string) => wakes.push(reason));
  t.mock.method(f.t3, 'invalidateShell', () => { invalidations++; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const thread = v2Thread({ id: 'streaming', status: 'running', activeRunId: 'run' });
  f.internal.onShellItem({ kind: 'thread.updated', thread }); t.mock.timers.tick(25);
  for (let n = 0; n < 100; n++) {
    f.internal.onShellItem({ kind: 'thread.updated', thread: { ...thread, updatedAt: new Date(n).toISOString(), itemCount: n, visibleItemCount: n, latestVisibleMessage: { text: `Token ${n}` }, lastVisitedAt: new Date(n).toISOString(), opens: n } });
    t.mock.timers.tick(25);
  }
  assert.deepEqual(wakes, ['t3'], 'streaming content and visit counters must not continuously restart expensive scheduling and collection');
  assert.equal(invalidations, 101, 'manual final reads must still see the latest shell');
  f.internal.onShellItem({ kind: 'thread.updated', thread: { ...thread, status: 'waiting', pendingRuntimeRequest: { kind: 'user_input', createdAt: new Date().toISOString() } } });
  t.mock.timers.tick(25);
  assert.deepEqual(wakes, ['t3', 't3'], 'a real run or human-request transition still wakes work immediately');
});

test('zero provider capacity still observes completed explicit chains without launching', async t => {
  const f = serviceFixture(t);
  f.c.concurrency = { claude: 0, codex: 0 };
  f.c.enabled = false; f.c.models[0].automatic = false;
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  f.tasks[0].status = 'done';
  const target = { id: 'root', key: 'FIX-1', title: 'Fixture', projectId: 'FIX', status: 'todo', priority: 'high', createdAt: '2026-01-01', difficulty: 'med' as const, runnable: true, blockedBy: [], done: false };
  f.store.savePlan({ id: 'completed-chain', createdAt: new Date().toISOString(), target, tickets: [], model: 'sol', overrideLimits: [], state: 'active' });
  f.internal.scheduleAdmissions('fixture', 'chains'); await f.internal.idle;
  assert.equal(f.store.plan('completed-chain')?.state, 'done');
  assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
});

test('fallback maintenance continues without admission and is not postponed by thread wakes', async t => {
  const f = serviceFixture(t), reasons: string[] = [];
  f.c.enabled = false; f.c.concurrency = { claude: 0, codex: 0 }; f.c.models[0].automatic = false; f.c.pollSeconds = 15;
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c)); f.internal.pollSeconds = 15;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wake = f.internal.wake.bind(f.internal), runLane = f.internal.runLane.bind(f.internal);
  t.mock.method(f.internal, 'wake', (reason: string) => { reasons.push(reason); wake(reason); });
  t.mock.method(f.internal, 'runLane', (name: string, work: () => Promise<void>) => { if (/^(tickets|chains|upstream):/.test(name)) runLane(name, work); });
  t.mock.method(f.internal, 'pass', async () => { assert.fail('unavailable admission must not be needed to schedule maintenance'); });
  f.internal.wake('start'); await f.internal.idle;
  for (let n = 0; n < 14; n++) { t.mock.timers.tick(1000); f.internal.wake('t3'); await f.internal.idle; }
  t.mock.timers.tick(1000); await f.internal.idle;
  assert.equal(reasons.filter(reason => reason === 'timer').length, 1, 'manual-only startup still needs its own fallback timer');
  t.mock.timers.tick(15000); await f.internal.idle;
  assert.equal(reasons.filter(reason => reason === 'timer').length, 2, 'fallback must rearm independently of successful admissions');
  f.c.pollSeconds = 30; writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  f.internal.onConfigChange('config.jsonc'); await f.internal.idle;
  t.mock.timers.tick(15000); await f.internal.idle;
  assert.equal(reasons.filter(reason => reason === 'timer').length, 2, 'configuration edits must replace the previous cadence');
  t.mock.timers.tick(15000); await f.internal.idle;
  assert.equal(reasons.filter(reason => reason === 'timer').length, 3);
});

test('manual Codex dispatch does not read activity for an idle rule it never enforces', async t => {
  const f = dispatchFixture(t);
  f.threads.push(v2Thread({ id: 'personal', projectId: 'FIX', providerInstanceId: 'codex', modelSelection: { instanceId: 'codex', model: 'fixture-sol' }, status: 'completed', activeRunId: null, updatedAt: new Date().toISOString() }));
  t.mock.method(f.t3, 'detail', async () => { assert.fail('waived idle checks cannot block a manual dispatch on unrelated conversation reads'); });
  const result = await f.run();
  assert.equal(result.reason, 'dispatched');
});

test('warm unnamed selection uses prepared queue hints and validates only the selected ticket', async t => {
  const f = dispatchFixture(t);
  const { inventory, upNext } = await import('../src/scheduler.ts');
  const queue = await inventory(f.c, f.kanvil, f.threads, [], f.store);
  f.store.set('upNext', JSON.stringify(upNext(f.c, f.store, queue)));
  t.mock.method(f.kanvil, 'tasks', async () => { assert.fail('warm unnamed starts must not rescan project inventories'); });
  const result = await cycle(f.c, f.store, { manual: true, model: 'sol', ticket: '' }, { t3: f.t3, kanvil: f.kanvil, backgroundInventory: true });
  assert.equal(result.reason, 'dispatched');
  assert.equal(result.ticket, 'FIX-1');
  assert.equal(f.launches.length, 1);
});

for (const manual of [true, false]) test(`standalone passes refresh persisted hints before selecting new work: manual=${manual}`, async t => {
  const f = dispatchFixture(t), { inventory, upNext } = await import('../src/scheduler.ts');
  f.tasks[0].status = 'done';
  f.store.set('upNext', JSON.stringify(upNext(f.c, f.store, await inventory(f.c, f.kanvil, [], [], f.store))));
  f.tasks[0].status = 'todo';
  const result = await cycle(f.c, f.store, manual ? { manual: true, model: 'sol', ticket: '' } : {}, { t3: f.t3, kanvil: f.kanvil });
  assert.equal(result.reason, 'dispatched');
  assert.equal(f.store.jobs()[0].ticketKey, 'FIX-1', 'newly eligible tickets must beat discovery and cannot be hidden by an old empty projection');
});

test('an upstream admission cannot erase the background inventory used by unnamed starts', async t => {
  const f = dispatchFixture(t), { inventory, upNext } = await import('../src/scheduler.ts');
  const catalogue = JSON.stringify(upNext(f.c, f.store, await inventory(f.c, f.kanvil, [], [], f.store)));
  f.store.set('upNext', catalogue);
  await cycle(f.c, f.store, {}, { t3: f.t3, kanvil: f.kanvil, workKind: 'upstream', backgroundInventory: true });
  assert.equal(f.store.get('upNext'), catalogue, 'only the background inventory publisher may replace its catalogue');
  const result = await cycle(f.c, f.store, { manual: true, model: 'sol', ticket: '' }, { t3: f.t3, kanvil: f.kanvil, backgroundInventory: true });
  assert.equal(result.reason, 'dispatched', 'the next unnamed start must still find its prepared ticket');
  assert.equal(result.ticket, 'FIX-1');
});

test('prepared admission reads label occupancy once instead of reloading jobs for every queued ticket', async t => {
  const f = dispatchFixture(t), { inventory, upNext } = await import('../src/scheduler.ts');
  for (let i = 3; i < 203; i++) f.tasks.push(f.task(`queued-${i}`, i, 'todo'));
  f.store.set('upNext', JSON.stringify(upNext(f.c, f.store, await inventory(f.c, f.kanvil, [], [], f.store))));
  let reads = 0; const summaries = f.store.jobSummaries.bind(f.store);
  t.mock.method(f.store, 'jobSummaries', () => { reads++; return summaries(); });
  const result = await cycle(f.c, f.store, {}, { t3: f.t3, kanvil: f.kanvil, backgroundInventory: true, deferReconcile: true, deferCleanup: true });
  assert.equal(result.reason, 'dispatched');
  assert.ok(reads <= 20, `200 extra hints must not amplify ledger reads; observed ${reads}`);
  assert.equal(f.launches.length, 1);
});

test('a warm service uses its GitHub connection instead of spawning the CLI for PR checks', async t => {
  const f = dispatchFixture(t); let reads = 0;
  writeFileSync(join(f.dir, 'gh'), '#!/bin/sh\necho "Unexpected GitHub CLI process on warm dispatch" >&2\nexit 1\n', { mode: 0o755 });
  const clients = { t3: f.t3, kanvil: f.kanvil, github: { pullRequests: async () => { reads++; return []; } } };
  await assert.doesNotReject(async () => { assert.equal((await cycle(f.c, f.store, { manual: true, model: 'sol', ticket: 'FIX-1' }, clients)).reason, 'dispatched'); }, 'a connected service must not invoke the GitHub CLI for fresh PR reads');
  assert.ok(reads > 0); assert.equal(f.launches.length, 1);
});

test('final ancestry checks do not enumerate the selected ticket siblings', async t => {
  const f = dispatchFixture(t); f.tasks.push(f.task('parent', 3));
  f.relations.push({ sourceTaskId: 'parent', targetTaskId: 'root', relationType: 'subtask' });
  const relations = f.kanvil.relations.bind(f.kanvil); let checked = false;
  t.mock.method(f.kanvil, 'relations', async (id, fresh, children, known) => {
    if (id === 'parent' && fresh) { checked = true; assert.equal(children, false, 'ancestor blocker checks must not paginate unrelated children'); }
    return relations(id, fresh, children, known);
  });
  assert.equal((await f.run()).reason, 'dispatched'); assert.equal(checked, true);
});

test('trusted live quota avoids a foreground provider probe within configured freshness', async t => {
  const f = dispatchFixture(t), quote = f.provider();
  quote.usageLimits.checkedAt = new Date(Date.now() - 5000).toISOString();
  t.mock.method(f.t3, 'peekProvider', () => quote);
  t.mock.method(f.t3, 'provider', async () => { assert.fail('a current connected allowance must not force provider discovery'); });
  const { readModelQuota } = await import('../src/models.ts');
  const quota = await readModelQuota(f.t3, f.c, [], 'sol', true, true);
  assert.equal(quota.hasAllowance, true);
});

test('a live allowance exhaustion arriving during checks prevents the reservation', async t => {
  const f = dispatchFixture(t), quote = f.provider();
  t.mock.method(f.t3, 'peekProvider', () => structuredClone(quote));
  f.hooks.read = async (name, id, final) => { if (final && name === 'ticket' && id === 'root') quote.usageLimits.windows[0].usedPercent = 100; };
  const result = await f.run();
  assert.equal(result.reason, 'codex-quota-exhausted');
  assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
});

test('prepared selection rechecks selected-repository branches and moves to the next hint', async t => {
  const f = dispatchFixture(t), { inventory, upNext } = await import('../src/scheduler.ts');
  f.tasks.push(f.task('second-hint', 3, 'todo'));
  const queue = await inventory(f.c, f.kanvil, [], [], f.store); f.store.set('upNext', JSON.stringify(upNext(f.c, f.store, queue)));
  const repo = f.c.projects[0].repoPath;
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  execFileSync('git', ['-C', repo, 'branch', 'fix/FIX-1-existing']);
  t.mock.method(f.kanvil, 'tasks', async () => { assert.fail('stale hints must not trigger a queue-wide scan'); });
  const result = await cycle(f.c, f.store, { manual: true, model: 'sol', ticket: '' }, { t3: f.t3, kanvil: f.kanvil, backgroundInventory: true });
  assert.equal(result.reason, 'dispatched'); assert.equal(result.ticket, 'FIX-3', 'a newly conflicting branch must prevent the old hint from launching');
  assert.equal(f.launches.length, 1);
});

test('parallel warm requests prepare distinct hints without repeating the selected read', async t => {
  const f = serviceFixture(t), { inventory, upNext } = await import('../src/scheduler.ts'), first = deferred(), release = deferred(), second = deferred();
  f.tasks.push(f.task('parallel-hint', 3, 'todo'));
  const queue = await inventory(f.c, f.kanvil, [], [], f.store); f.store.set('upNext', JSON.stringify(upNext(f.c, f.store, queue))); f.calls.length = 0;
  const quote = f.provider(); quote.usageLimits.checkedAt = new Date(Date.now() - 5000).toISOString();
  t.mock.method(f.t3, 'peekProvider', () => structuredClone(quote));
  t.mock.method(f.t3, 'launch', async (command: any) => { f.launches.push(command); if (command.title === 'Factory: FIX-1') { first.resolve(); await release.promise; } else second.resolve(); });
  const runs = [1, 2].map(() => f.internal.handle({ type: 'dispatch', options: { ticket: '', model: 'sol' } }));
  try {
    await first.promise;
    assert.equal(await Promise.race([second.promise.then(() => true), delay(1500, false, { ref: false })]), true);
    assert.equal(f.calls.filter(call => call.startsWith('ticket:root:')).length, 1, 'another request must pick a distinct preparation hint before remote checks');
  } finally { release.resolve(); await Promise.allSettled(runs); }
  assert.equal(f.launches.length, 2);
});
