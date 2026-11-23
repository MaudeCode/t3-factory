import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { serviceFixture } from './dispatch-fixture.ts';

// A tickets lane with nothing to start: the only ready-status ticket is blocked by unfinished work and discovery is cooling down.
// T3 and Kanvil report their changes through liveRevision and revision, which the protocol and tracker tests own.
function quietLane(t: TestContext, options: { live?: boolean } = {}) {
  const f = serviceFixture(t), inputs = { views: 1 }, details: string[] = [];
  f.tasks[1].status = 'in_progress';
  f.store.set('discoveryAfter:FIX', String(Date.now() + 86_400_000));
  Object.defineProperty(f.t3, 'liveRevision', { value: () => options.live === false ? undefined : inputs.views });
  t.mock.method(f.t3, 'detail', async (id: string) => { details.push(id); return { messages: [], responses: [] }; });
  Object.defineProperty(f.kanvil, 'synchronized', { get: () => true });
  const pass = (reason = 'timer') => f.internal.pass({}, reason, 0, 'tickets', 'codex');
  // Reads of T3, quota, inventory and Kanvil all land in calls; thread details in details.
  const reads = () => f.calls.length + details.length;
  return { ...f, inputs, pass, reads };
}

test('a repeated quiet pass with unchanged inputs makes no reads and returns the stored decision', async t => {
  const f = quietLane(t);
  const first = await f.pass();
  assert.equal(first.reason, 'watching-streams');
  assert.ok(f.calls.some(call => call.startsWith('tickets:')), 'the first pass reads the inventory');
  const reads = f.reads();
  assert.deepEqual(await f.pass(), first);
  assert.equal(f.reads(), reads, 'no inventory, Kanvil, T3 shell, provider or thread-detail read');
});

for (const [input, change] of Object.entries({
  "a thread's updatedAt or a provider snapshot (T3 live revision)": (f: ReturnType<typeof quietLane>) => { f.inputs.views++; },
  'a Kanvil ticket version': (f: ReturnType<typeof quietLane>) => { f.tasks[0].version = 2; f.kanvil.revision++; },
  'a job write': (f: ReturnType<typeof quietLane>) => { f.store.save({ id: 'other', kind: 'ticket', projectId: 'FIX', taskId: 'other', ticketKey: 'FIX-9', threadId: 'thread-other', messageId: 'm', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), state: 'complete', reason: 'Done', lastPersonalActivity: null, reportPath: '/dev/null', prUrls: [], command: {} }); },
  'a ticket preparation ending': async (f: ReturnType<typeof quietLane>) => { await f.store.exclusive(['ticket:root'], async () => {}); },
  'the prepared Up next list': (f: ReturnType<typeof quietLane>) => { f.store.set('upNext', JSON.stringify({ tickets: [], held: [] })); },
  'the configuration': (f: ReturnType<typeof quietLane>) => { writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify({ ...f.c, idleMinutes: 2 })); },
})) test(`changing ${input} makes the next pass run in full`, async t => {
  const f = quietLane(t);
  await f.pass(); await f.pass();
  const reads = f.reads();
  await change(f);
  await f.pass();
  assert.ok(f.reads() > reads);
});

test('a full pass still runs once the recheck interval passes', async t => {
  const f = quietLane(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await f.pass();
  let reads = f.reads();
  t.mock.timers.tick(299_000); await f.pass();
  assert.equal(f.reads(), reads, 'max(pollSeconds 60, 300) seconds have not passed');
  t.mock.timers.tick(2_000); await f.pass();
  assert.ok(f.reads() > reads);
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

test('T3_FACTORY_LOG_VERBOSE=1 restores the work, pass and decision lines', async t => {
  const f = quietLane(t, { live: false });
  await lanePass(f);
  const lines = logLines(t), previous = process.env.T3_FACTORY_LOG_VERBOSE;
  process.env.T3_FACTORY_LOG_VERBOSE = '1';
  t.after(() => { if (previous === undefined) delete process.env.T3_FACTORY_LOG_VERBOSE; else process.env.T3_FACTORY_LOG_VERBOSE = previous; });
  await lanePass(f);
  assert.deepEqual(lines.map(line => line.event).sort(), ['decision', 'pass', 'work']);
});
