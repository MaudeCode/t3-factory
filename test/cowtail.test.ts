import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, type Job, type Plan } from '../src/store.ts';
import { CowtailNotifier, cowtailSettings, type CowtailSettings } from '../src/cowtail.ts';
import { configSchema, loadConfig } from '../src/config.ts';

const PR = 'https://github.com/org/repo/pull/7', TOKEN = 'cts_fixture-token';
const job = (over: Partial<Job> = {}): Job => ({
  id: '11111111-1111-4111-8111-111111111111', kind: 'ticket', projectId: 'p', taskId: 't', ticketKey: 'APP-1', threadId: 'th', messageId: 'm',
  createdAt: '2026-01-01T00:00:00.000Z', state: 'running', reason: 'Claude is executing', lastPersonalActivity: null, reportPath: '/tmp/none.json', command: null,
  prUrls: [], completedAt: null, modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [] }, providerDriver: 'claudeAgent', ...over,
});
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 'plan-1', createdAt: '2026-01-01T00:00:00.000Z', epic: { id: 'epic-1', title: 'Phone alerts' }, tickets: [], model: 'opus', overrideLimits: false, state: 'active', ...over,
});

function fixture(request: (url: URL, init: RequestInit) => Promise<Response> = async () => new Response('{}'), settings: () => CowtailSettings | undefined = () => ({ url: 'https://cowtail.example.com', token: TOKEN })) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-cowtail-')), store = new Store(dir), sent: { url: string; init: RequestInit; body: any }[] = [];
  store.onEvent = new CowtailNotifier(store, settings, (async (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return request(url, init);
  }) as typeof fetch).notify;
  return { store, sent, [Symbol.dispose]() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

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

test('a no-work completion, a dismissal and a cancelled or dispatched plan post nothing', () => {
  using f = fixture();
  f.store.save(job());
  f.store.save(job({ state: 'complete', reason: 'No work' }));
  f.store.save(job({ id: '22222222-2222-4222-8222-222222222222', taskId: 't2' }));
  f.store.save(job({ id: '22222222-2222-4222-8222-222222222222', taskId: 't2', state: 'dismissed', prUrls: [PR] }));
  f.store.savePlan(plan());
  f.store.savePlan(plan({ state: 'cancelled' }));
  const target = { id: 't3', key: 'APP-3', title: 'Run', projectId: 'p', status: 'todo', priority: 'high', createdAt: '2026-01-01T00:00:00.000Z', runnable: true, blockedBy: [], done: false };
  f.store.savePlan(plan({ id: 'plan-2', epic: undefined, queued: true, target }));
  f.store.savePlan(plan({ id: 'plan-2', epic: undefined, queued: true, target, state: 'done' }));
  assert.deepEqual(f.store.events(20).filter(e => e.kind.endsWith('.state')).map(e => e.text).toReversed(),
    ['APP-1 finished', 'APP-1 was dismissed', 'Epic Phone alerts cancelled', 'Run APP-3 dispatched']);
  assert.deepEqual(f.sent, []);
});

test('a finished Epic posts one done item for today', () => {
  using f = fixture();
  f.store.savePlan(plan());
  f.store.savePlan(plan({ state: 'done', finishedAt: '2026-01-02T00:00:00.000Z' }));
  assert.deepEqual(f.sent.map(s => s.body), [{ kind: 'done', urgency: 'today', title: 'Epic Phone alerts finished', dedupeKey: 't3-factory:plan.state:plan-1:done' }]);
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
    assert.deepEqual(parse('https://cowtail.example.com', TOKEN).data?.cowtail, { url: 'https://cowtail.example.com' });
    assert.equal(parse(undefined, undefined).data?.cowtail, undefined);
    assert.match(parse('https://cowtail.example.com', undefined).error!.message, /needs COWTAIL_TOKEN/);
    assert.match(parse(undefined, TOKEN).error!.message, /needs cowtail\.url/);
  } finally { if (saved === undefined) delete process.env.COWTAIL_TOKEN; else process.env.COWTAIL_TOKEN = saved; }
});
