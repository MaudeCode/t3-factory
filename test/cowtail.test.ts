import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, type Job, type Plan } from '../src/store.ts';
import { CowtailNotifier, cowtailSettings, type CowtailSettings } from '../src/cowtail.ts';
import { configSchema, loadConfig } from '../src/config.ts';
import { saveSettings } from '../src/settings.ts';

const PR = 'https://github.com/org/repo/pull/7', TOKEN = 'cts_fixture-token', URL_ = 'https://cowtail.example.com';
const DEFAULTS = { needsYou: 'today', failed: 'today', quotaHold: 'today', noPr: 'today', finished: 'whenever' } as const;
const UNCONFIRMED = 'Dismissed because T3 could not confirm the launch';
const job = (over: Partial<Job> = {}): Job => ({
  id: '11111111-1111-4111-8111-111111111111', kind: 'ticket', projectId: 'p', taskId: 't', ticketKey: 'APP-1', threadId: 'th', messageId: 'm',
  createdAt: '2026-01-01T00:00:00.000Z', state: 'running', reason: 'Claude is executing', lastPersonalActivity: null, reportPath: '/tmp/none.json', command: null,
  prUrls: [], completedAt: null, modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [] }, providerDriver: 'claudeAgent', ...over,
});
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 'plan-1', createdAt: '2026-01-01T00:00:00.000Z', epic: { id: 'epic-1', title: 'Phone alerts' }, tickets: [], model: 'opus', overrideLimits: false, state: 'active', ...over,
});

function fixture(request: (url: URL, init: RequestInit) => Promise<Response> = async () => new Response('{}'), settings: () => CowtailSettings | undefined = () => ({ url: URL_, token: TOKEN, events: DEFAULTS })) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-cowtail-')), store = new Store(dir), sent: { url: string; init: RequestInit; body: any }[] = [];
  const notifier = new CowtailNotifier(store, settings, (async (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return request(url, init);
  }) as typeof fetch);
  store.onEvent = notifier.notify;
  return { store, sent, notifier, [Symbol.dispose]() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const OTHER = '22222222-2222-4222-8222-222222222222';
const quotaCheck = (store: Store, at: string, reason = 'quota-budget') =>
  store.decisionRecorder({ workKind: 'tickets', providerDriver: 'codex' })({ reason: 'watching-streams', at, eligible: 1, streams: [{ driver: 'codex', provider: 'Codex', reason }] });

test('a run that needs the owner and then merges its PR posts one question and one done item', () => {
  using f = fixture();
  f.store.save(job());
  f.store.save(job({ state: 'waiting', reason: 'Merge PR #7?', prUrls: [PR] }));
  f.store.save(job({ state: 'running', reason: 'Owner answered', prUrls: [PR] }));
  f.store.save(job({ state: 'complete', reason: '', prUrls: [PR], completedAt: '2026-01-01T01:00:00.000Z' }));
  assert.deepEqual(f.sent.map(s => s.body), [
    { kind: 'question', urgency: 'today', title: 'APP-1 needs you', body: 'Merge PR #7?', links: [{ label: 'org/repo/pull/7', url: PR }],
      dedupeKey: `t3-factory:job.state:${job().id}:waiting`, context: { ticketKey: 'APP-1', projectId: 'p' } },
    { kind: 'done', urgency: 'whenever', title: 'APP-1 finished', links: [{ label: 'org/repo/pull/7', url: PR }],
      dedupeKey: `t3-factory:job.state:${job().id}:complete`, context: { ticketKey: 'APP-1', projectId: 'p' } },
  ]);
  for (const { url, init } of f.sent) {
    assert.equal(url, 'https://cowtail.example.com/api/items');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  }
});

test('a run that ends without a PR or an unconfirmed launch posts for today; an owner dismissal or a cancelled or dispatched plan posts nothing', () => {
  using f = fixture();
  const owner = '33333333-3333-4333-8333-333333333333';
  f.store.save(job());
  f.store.save(job({ state: 'complete', reason: 'No work' }));
  f.store.save(job({ id: OTHER, taskId: 't2' }));
  f.store.save(job({ id: OTHER, taskId: 't2', state: 'dismissed', reason: UNCONFIRMED }));
  f.store.save(job({ id: owner, taskId: 't3' }));
  f.store.save(job({ id: owner, taskId: 't3', state: 'dismissed', reason: 'Dismissed by the owner', prUrls: [PR] }));
  f.store.savePlan(plan());
  f.store.savePlan(plan({ state: 'cancelled' }));
  const target = { id: 't3', key: 'APP-3', title: 'Run', projectId: 'p', status: 'todo', priority: 'high', createdAt: '2026-01-01T00:00:00.000Z', runnable: true, blockedBy: [], done: false };
  f.store.savePlan(plan({ id: 'plan-2', epic: undefined, queued: true, target }));
  f.store.savePlan(plan({ id: 'plan-2', epic: undefined, queued: true, target, state: 'done' }));
  assert.deepEqual(f.sent.map(s => s.body), [
    { kind: 'done', urgency: 'today', title: 'APP-1 finished without a PR', body: 'No work', dedupeKey: `t3-factory:job.state:${job().id}:complete`, context: { ticketKey: 'APP-1', projectId: 'p' } },
    { kind: 'failure', urgency: 'today', title: 'APP-1 was dismissed', body: UNCONFIRMED, dedupeKey: `t3-factory:job.state:${OTHER}:dismissed`, context: { ticketKey: 'APP-1', projectId: 'p' } },
  ]);
});

test('a finished Epic posts one done item for the inbox', () => {
  using f = fixture();
  f.store.savePlan(plan());
  f.store.savePlan(plan({ state: 'done', finishedAt: '2026-01-02T00:00:00.000Z' }));
  assert.deepEqual(f.sent.map(s => s.body), [{ kind: 'done', urgency: 'whenever', title: 'Epic Phone alerts finished', dedupeKey: 't3-factory:plan.state:plan-1:done' }]);
});

test('a failed dispatch and a new quota hold each post one item for today', () => {
  using f = fixture();
  f.store.record('dispatch.failed', 'Dispatch of APP-1 failed', { requestId: 'req-1', stage: 't3.shell', message: 'T3 unreachable', ticketKey: 'APP-1', projectId: 'p', state: 'failed' });
  quotaCheck(f.store, '2026-01-01T02:00:00.000Z'); quotaCheck(f.store, '2026-01-01T02:05:00.000Z');
  assert.deepEqual(f.sent.map(s => s.body), [
    { kind: 'failure', urgency: 'today', title: 'Dispatch of APP-1 failed', body: 't3.shell: T3 unreachable', dedupeKey: 't3-factory:dispatch.failed:req-1:failed', context: { ticketKey: 'APP-1', projectId: 'p' } },
    { kind: 'fyi', urgency: 'today', title: 'Codex work held for quota', body: 'waiting for budget', dedupeKey: 't3-factory:quota.hold:codex:2026-01-01T02:00:00.000Z:held' },
  ]);
});

for (const urgency of ['off', 'whenever', 'today', 'now'] as const) test(`every event set to ${urgency} ${urgency === 'off' ? 'posts nothing while the test button still posts' : 'posts its fixed kind at that urgency'}`, async () => {
  const events = { needsYou: urgency, failed: urgency, quotaHold: urgency, noPr: urgency, finished: urgency };
  using f = fixture(undefined, () => ({ url: URL_, token: TOKEN, events }));
  f.store.save(job());
  f.store.save(job({ state: 'waiting', reason: 'Question' }));
  f.store.save(job({ state: 'complete', reason: 'Merged', prUrls: [PR] }));
  f.store.save(job({ id: OTHER, taskId: 't2' }));
  f.store.save(job({ id: OTHER, taskId: 't2', state: 'complete', reason: 'No work' }));
  f.store.save(job({ id: '33333333-3333-4333-8333-333333333333', taskId: 't3' }));
  f.store.save(job({ id: '33333333-3333-4333-8333-333333333333', taskId: 't3', state: 'dismissed', reason: UNCONFIRMED }));
  f.store.record('dispatch.failed', 'Dispatch of APP-1 failed', { requestId: 'req-1', stage: 'queued', message: 'Deadline', state: 'failed' });
  quotaCheck(f.store, '2026-01-01T02:00:00.000Z');
  f.store.savePlan(plan());
  f.store.savePlan(plan({ state: 'done' }));
  assert.deepEqual(f.sent.map(s => [s.body.kind, s.body.urgency]), urgency === 'off' ? []
    : ['question', 'done', 'done', 'failure', 'failure', 'fyi', 'done'].map(kind => [kind, urgency]));
  if (urgency === 'off') assert.deepEqual(await f.notifier.test(), { ok: true }, 'the test button ignores the settings');
});

test('the test button posts one fyi item now and reports each outcome without the token', async () => {
  const replies: (() => Response)[] = [() => new Response('{}'), () => new Response('', { status: 503 }), () => { throw new Error(`connect failed for ${URL_} with Bearer ${TOKEN}`); }];
  using f = fixture(async () => replies.shift()!());
  assert.deepEqual(await f.notifier.test(), { ok: true });
  const { dedupeKey, ...item } = f.sent[0]!.body;
  assert.deepEqual(item, { kind: 'fyi', urgency: 'now', title: 'Test notification from t3 Factory' });
  assert.ok(Number.isFinite(Date.parse(dedupeKey.replace(/^t3-factory:test:/, ''))), dedupeKey);
  assert.deepEqual(await f.notifier.test(), { ok: false, status: 503, message: 'Cowtail item post returned HTTP 503' });
  const failed = await f.notifier.test();
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(`${TOKEN}|cowtail\\.example\\.com`));
  using off = fixture(undefined, () => undefined);
  assert.deepEqual(await off.notifier.test(), { ok: false, reason: 'not-configured' });
  assert.deepEqual(off.sent, []);
});

test('a rejected post leaves the store write standing and logs one scrubbed error', async t => {
  const logged: string[] = [], failure = Promise.withResolvers<void>();
  t.mock.method(console, 'log', (line: string) => { if (line.includes('cowtail-error')) { logged.push(line); failure.resolve(); } });
  using f = fixture(async () => { throw new Error(`connect failed for https://cowtail.example.com with Bearer ${TOKEN}`); });
  f.store.save(job());
  f.store.save(job({ state: 'waiting', reason: 'Question' }));
  assert.equal(f.store.job(job().id)?.state, 'waiting');
  assert.equal(f.sent.length, 1);
  await failure.promise;
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /\[redacted URL\].*\[redacted\]/);
  assert.doesNotMatch(logged[0]!, new RegExp(`${TOKEN}|cowtail\\.example\\.com`));
});

test('without Cowtail settings a run that needs the owner posts nothing', () => {
  using f = fixture(undefined, () => cowtailSettings({}, undefined));
  f.store.save(job());
  f.store.save(job({ state: 'waiting', reason: 'Question', prUrls: [PR] }));
  assert.deepEqual(f.sent, []);
});

test('Cowtail turns on with both its URL and token, stays off with neither, and names the missing one', () => {
  const base = loadConfig(fileURLToPath(new URL('../config.example.jsonc', import.meta.url))), saved = process.env.COWTAIL_TOKEN;
  const parse = (url: string | undefined, token: string | undefined) => {
    if (token === undefined) delete process.env.COWTAIL_TOKEN; else process.env.COWTAIL_TOKEN = token;
    return configSchema.safeParse({ ...base, ...url ? { cowtail: { url } } : {} });
  };
  try {
    assert.deepEqual(parse('https://cowtail.example.com', TOKEN).data?.cowtail, { url: 'https://cowtail.example.com', events: DEFAULTS });
    process.env.COWTAIL_TOKEN = TOKEN;
    assert.equal(configSchema.safeParse({ ...base, cowtail: { url: URL_, events: { finished: 'loud' } } }).success, false);
    assert.deepEqual(configSchema.parse({ ...base, cowtail: { url: URL_, events: { finished: 'off' } } }).cowtail?.events, { ...DEFAULTS, finished: 'off' });
    assert.equal(parse(undefined, undefined).data?.cowtail, undefined);
    assert.match(parse('https://cowtail.example.com', undefined).error!.message, /needs COWTAIL_TOKEN/);
    assert.match(parse(undefined, TOKEN).error!.message, /needs cowtail\.url/);
  } finally { if (saved === undefined) delete process.env.COWTAIL_TOKEN; else process.env.COWTAIL_TOKEN = saved; }
});

test('a delivery choice saved from Settings lands in config.jsonc', () => {
  const example = loadConfig(fileURLToPath(new URL('../config.example.jsonc', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'factory-cowtail-settings-')), file = join(dir, 'config.jsonc'), saved = process.env.COWTAIL_TOKEN;
  process.env.COWTAIL_TOKEN = TOKEN;
  try {
    writeFileSync(file, JSON.stringify({ ...example, cowtail: { url: URL_ } }));
    const base = loadConfig(file);
    saveSettings({ base, config: { ...base, cowtail: { ...base.cowtail!, events: { ...base.cowtail!.events, quotaHold: 'now' } } } }, file);
    assert.deepEqual(loadConfig(file).cowtail?.events, { ...DEFAULTS, quotaHold: 'now' });
    assert.match(readFileSync(file, 'utf8'), /"quotaHold": "now"/);
  } finally {
    if (saved === undefined) delete process.env.COWTAIL_TOKEN; else process.env.COWTAIL_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
