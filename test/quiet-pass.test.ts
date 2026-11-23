import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { serviceFixture } from './dispatch-fixture.ts';
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

// A live T3 client over a fake socket: one shell snapshot of `threads` and the fixture's provider, then `send` streams shell events.
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
  return { ...f,
    send: async (thread: Thread, location = 'active') => { socket.respond(shellRequest, { kind: 'thread.updated', sequence: sequence++, location, thread }, true); await settle(); },
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
  ['a ticket preparation ending', ['store'], f => f.store.exclusive(['ticket:root'], async () => {})],
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
