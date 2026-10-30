import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { T3 } from '../src/clients.ts';
import { readModelQuota } from '../src/models.ts';
import type { Config } from '../src/config.ts';
import { dispatchFixture, deferred } from './dispatch-fixture.ts';
import type { Job } from '../src/store.ts';
import { Store } from '../src/store.ts';
import { cycle, refreshQuota, writeStatus } from '../src/scheduler.ts';
import { readOperation, saveOperation } from '../src/operations.ts';

// Extend the dispatch fixture with the same persisted provider/model rows status consumes.
function quotaFixture(t: Parameters<typeof dispatchFixture>[0]) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = dispatchFixture(t);
  f.c.models.push({ id: 'claude', name: 'Claude', model: { instanceId: 'claudeAgent', model: 'fixture-claude', options: [] }, automatic: true, maxDifficulty: 'high' });
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  const providers = [f.provider('claudeAgent'), f.provider()];
  t.mock.method(f.t3, 'providers', async () => structuredClone(providers));
  t.mock.method(f.t3, 'provider', async (id: string) => structuredClone(providers.find(provider => provider.instanceId === id)!));
  const seed = (reason = 'old model failure', admission = reason) => f.store.set('streams', JSON.stringify(providers.map(provider => ({
    driver: provider.driver, provider: provider.driver === 'codex' ? 'Codex' : 'Claude', reason: admission,
    models: f.c.models.filter(model => model.model.instanceId === provider.instanceId).map(model => ({ id: model.id, name: model.name, reason })), active: [], planned: [],
  }))));
  seed();
  const status = () => writeStatus(f.c, f.store);
  const stream = (driver = 'claudeAgent') => status().streams.find((row: { driver: string }) => row.driver === driver);
  return { ...f, providers, seed, status, stream, refresh: () => refreshQuota(f.c, f.store, f.t3) };
}

for (const mode of ['paused', 'off', 'manual-only'] as const) test(`background quota recovery respects ${mode} without admission`, async t => {
  const f = quotaFixture(t);
  if (mode === 'paused') f.c.enabled = false;
  if (mode === 'off') f.c.concurrency.claude = 0;
  if (mode === 'manual-only') f.c.models[1].automatic = false;
  await f.refresh();
  assert.equal(f.stream().reason, mode === 'paused' ? 'disabled' : mode === 'off' ? 'provider-disabled' : 'no-eligible-model');
  assert.equal(f.stream().models[0].reason, f.stream().reason);
  assert.equal(f.stream().quotaError, undefined);
  assert.equal(f.launches.length, 0);
});

test('one recovered snapshot reevaluates general and model-specific allowance, reserves and missing models', async t => {
  const f = quotaFixture(t), claude = f.providers[0];
  f.c.quota.claude.fable.minRemainingPercent = 40;
  f.c.models.push({ ...f.c.models[1], id: 'specific', name: 'Specific', quotaWindowId: 'model-weekly' });
  f.c.models.push({ ...f.c.models[1], id: 'missing-window', name: 'Missing allowance', quotaWindowId: 'absent' });
  f.c.models.push({ ...f.c.models[1], id: 'missing-model', name: 'Missing model', model: { ...f.c.models[1].model, model: 'absent' } });
  claude.usageLimits.windows[1].usedPercent = 100;
  claude.usageLimits.windows.push({ id: 'model-weekly', usedPercent: 70, windowDurationMins: 10080, resetsAt: claude.usageLimits.windows[1].resetsAt });
  let reads = 0;
  t.mock.method(f.t3, 'provider', async (id: string) => { if (id === 'claudeAgent') reads++; return structuredClone(f.providers.find(provider => provider.instanceId === id)!); });
  await f.refresh();
  const reasons = () => Object.fromEntries(f.stream().models.map((model: { id: string; reason: string }) => [model.id, model.reason]));
  assert.equal(reads, 1, 'every model uses the same provider snapshot');
  assert.equal(reasons().claude, 'quota-exhausted');
  assert.equal(reasons().specific, 'quota-budget', 'specific allowance ignores the general weekly exhaustion');
  assert.match(reasons()['missing-window'], /Model allowance is missing/);
  assert.match(reasons()['missing-model'], /does not advertise model absent/);
  claude.usageLimits.windows[2].usedPercent = 0;
  await f.refresh();
  assert.equal(reasons().specific, 'ready');
  assert.equal(f.stream().reason, 'no-eligible-ticket', 'quota health does not authorize a start');
  claude.status = 'error';
  await f.refresh();
  for (const reason of Object.values(reasons())) assert.match(String(reason), /provider is not ready/);
});

test('refresh failure retains cached allowance and age, recovers independently, and survives reload', async t => {
  const f = quotaFixture(t);
  await f.refresh();
  const cached = f.stream().quota;
  f.providers[0].usageLimits.checkedAt = new Date(0).toISOString();
  f.providers[1].usageLimits.checkedAt = new Date(0).toISOString();
  t.mock.timers.tick(600_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.refresh();
    assert.match(f.stream().quotaError, /automatic refresh failed.*stale/);
    assert.match(f.stream().models[0].reason, /automatic refresh failed.*stale/);
    assert.deepEqual(f.stream().quota, cached);
  }
  f.providers[0].usageLimits.checkedAt = new Date().toISOString();
  f.providers[0].usageLimits.windows = f.provider('claudeAgent').usageLimits.windows;
  await f.refresh();
  assert.equal(f.stream().quotaError, undefined);
  assert.equal(f.stream().models[0].reason, 'ready');
  assert.notEqual(f.stream().quota.capturedAt, cached.capturedAt);
  assert.match(f.stream('codex').quotaError, /automatic refresh failed.*stale/);
  const reopened = new Store(f.c.stateDir); t.after(() => reopened.close());
  assert.deepEqual(writeStatus(f.c, reopened).streams, f.status().streams);
  assert.equal(f.launches.length, 0);
});

test('quota recovery preserves admission holds while reevaluating current model health', async t => {
  const f = quotaFixture(t);
  for (const hold of ['label-limit', 'waiting-for-idle', 'fixture ticket access failure']) {
    f.seed('old quota refusal', hold);
    await f.refresh();
    assert.equal(f.stream().reason, hold);
    assert.equal(f.stream().models[0].reason, 'ready');
  }
  f.c.models = f.c.models.filter(model => model.id !== 'claude');
  await f.refresh();
  assert.equal(f.stream().quota, undefined);
  assert.deepEqual(f.stream().models, []);
  assert.match(f.stream().quotaError, /No model is configured/);
});

test('quota health recovers while an unrelated shell read remains unavailable', async t => {
  const f = quotaFixture(t);
  t.mock.method(f.t3, 'shell', async () => { throw new Error('fixture shell remains unavailable'); });
  await f.refresh();
  assert.equal(f.stream().quotaError, undefined);
  assert.equal(f.stream().quota.hasAllowance, true);
  assert.match(f.stream().models[0].reason, /shell remains unavailable/);
  assert.match(f.stream().reason, /shell remains unavailable/);
});

test('an active provider reservation remains working after quota recovery', async t => {
  const f = quotaFixture(t);
  assert.equal((await f.run()).reason, 'dispatched');
  await f.refresh();
  assert.equal(f.stream('codex').reason, 'provider-running');
  assert.equal(f.stream('codex').models[0].reason, 'provider-running');
  assert.equal(f.launches.length, 1, 'refresh never replays or starts a run');
});

test('a failed probe cannot clear its active error using an unchanged cached live snapshot', async t => {
  const f = quotaFixture(t);
  await f.refresh();
  const cached = f.stream().quota, stale = structuredClone(f.providers[0]);
  stale.usageLimits.checkedAt = new Date(0).toISOString();
  t.mock.method(f.t3, 'peekProvider', (id: string) => id === 'claudeAgent' ? structuredClone(stale) : undefined);
  t.mock.method(f.t3, 'provider', async () => { throw new Error('fixture probe failed'); });
  await f.refresh();
  assert.match(f.stream().quotaError, /fixture probe failed/);
  assert.deepEqual(f.stream().quota, cached);
});

for (const newer of ['failure', 'exhausted'] as const) test(`older quota success cannot overwrite newer ${newer}`, async t => {
  const f = quotaFixture(t), entered = deferred(), release = deferred();
  let reads = 0;
  t.mock.method(f.t3, 'provider', async (id: string) => {
    const provider = structuredClone(f.providers.find(provider => provider.instanceId === id)!);
    if (id === 'claudeAgent' && ++reads === 1) { entered.resolve(); await release.promise; }
    else if (id === 'claudeAgent') {
      if (newer === 'failure') throw new Error('newer fixture refresh failed');
      provider.usageLimits.windows[0].usedPercent = 100;
    }
    return provider;
  });
  const older = f.refresh();
  await entered.promise;
  let current: unknown;
  try { await f.refresh(); current = f.status().streams; }
  finally { release.resolve(); await older; }
  assert.deepEqual(f.status().streams, current);
  assert.match(f.stream().models[0].reason, newer === 'failure' ? /newer fixture refresh failed/ : /quota-exhausted/);
});

for (const update of ['exhausted', 'identity', 'missing-model'] as const) test(`connected ${update} update wins over an in-flight quota response`, async t => {
  const f = quotaFixture(t), entered = deferred(), release = deferred();
  let current = structuredClone(f.providers[0]);
  current.usageLimits.checkedAt = new Date(0).toISOString();
  t.mock.method(f.t3, 'peekProvider', (id: string) => id === current.instanceId ? structuredClone(current) : undefined);
  t.mock.method(f.t3, 'provider', async (id: string) => {
    const provider = structuredClone(f.providers.find(provider => provider.instanceId === id)!);
    if (id === 'claudeAgent') { entered.resolve(); await release.promise; }
    return provider;
  });
  const refresh = f.refresh(); await entered.promise;
  current.usageLimits.checkedAt = new Date().toISOString();
  if (update === 'exhausted') current.usageLimits.windows[0].usedPercent = 100;
  if (update === 'identity') current.instanceId = 'replacement';
  if (update === 'missing-model') current.models = [];
  release.resolve(); await refresh;
  assert.match(f.stream().models[0].reason, update === 'exhausted' ? /quota-exhausted/ : update === 'identity' ? /identity changed/ : /does not advertise/);
});

test('an allowance update received while a sibling instance is read wins at publication', async t => {
  const f = quotaFixture(t), entered = deferred(), release = deferred();
  const sibling = { ...f.provider('claudeAgent'), instanceId: 'claude-second' };
  f.providers.push(sibling);
  f.c.models.push({ ...f.c.models[1], id: 'second', model: { ...f.c.models[1].model, instanceId: sibling.instanceId } });
  let current = structuredClone(f.providers[0]);
  t.mock.method(f.t3, 'peekProvider', (id: string) => id === current.instanceId ? structuredClone(current) : undefined);
  t.mock.method(f.t3, 'provider', async (id: string) => {
    if (id === sibling.instanceId) { entered.resolve(); await release.promise; }
    return structuredClone(f.providers.find(provider => provider.instanceId === id)!);
  });
  const refresh = f.refresh(); await entered.promise;
  current.usageLimits.windows[0].usedPercent = 100;
  release.resolve(); await refresh;
  assert.equal(f.stream().models.find((model: { id: string }) => model.id === 'claude').reason, 'quota-exhausted');
  assert.equal(f.stream().models.find((model: { id: string }) => model.id === 'second').reason, 'ready');
});

test('configuration edits prevent an older refresh from publishing an obsolete model constraint', async t => {
  const f = quotaFixture(t), entered = deferred(), release = deferred();
  const before = f.status().streams;
  t.mock.method(f.t3, 'provider', async (id: string) => {
    if (id === 'claudeAgent') { entered.resolve(); await release.promise; }
    return structuredClone(f.providers.find(provider => provider.instanceId === id)!);
  });
  const refresh = f.refresh(); await entered.promise;
  f.c.concurrency.claude = 0;
  release.resolve(); await refresh;
  assert.deepEqual(f.status().streams, before);
  await f.refresh();
  assert.equal(f.stream().reason, 'provider-disabled');
});

test('newer admission publication wins over an older quota refresh', async t => {
  const f = quotaFixture(t), entered = deferred(), release = deferred();
  f.c.enabled = false;
  let reads = 0;
  t.mock.method(f.t3, 'provider', async (id: string) => {
    const provider = structuredClone(f.providers.find(provider => provider.instanceId === id)!);
    if (++reads === 1) { entered.resolve(); await release.promise; }
    else provider.usageLimits.windows[0].usedPercent = 100;
    return provider;
  });
  const older = f.refresh(); await entered.promise;
  let current: unknown;
  try { await cycle(f.c, f.store, {}, { t3: f.t3, kanvil: f.kanvil }); current = f.status().streams; }
  finally { release.resolve(); await older; }
  assert.deepEqual(f.status().streams, current);
});

test('an empty quota refresh cannot suppress the first admission publication', async t => {
  const f = quotaFixture(t), entered = deferred(), release = deferred();
  f.c.enabled = false; f.store.set('streams', '[]');
  let reads = 0;
  t.mock.method(f.t3, 'providers', async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; }
    return structuredClone(f.providers);
  });
  const admission = cycle(f.c, f.store, {}, { t3: f.t3, kanvil: f.kanvil });
  await entered.promise;
  try { await f.refresh(); }
  finally { release.resolve(); await admission; }
  assert.equal(f.status().streams.length, 2);
});

test('scoped admission initializes an Off provider for background quota recovery', async t => {
  const f = quotaFixture(t);
  f.c.enabled = false; f.c.concurrency.claude = 0; f.store.set('streams', '[]');
  const scoped = () => cycle(f.c, f.store, {}, { t3: f.t3, kanvil: f.kanvil, workKind: 'tickets', providerDriver: 'codex' });
  await scoped();
  assert.equal(f.status().streams.length, 2, 'scoped publication must initialize both provider rows on fresh state');
  assert.equal(f.stream().reason, 'provider-disabled');
  await f.refresh();
  assert.equal(f.stream().quota.hasAllowance, true, 'the Off provider remains visible to background refresh');
  const sibling = f.stream();
  await scoped();
  assert.deepEqual(f.stream(), sibling, 'scoped admission cannot replace existing sibling status');
  assert.equal(f.launches.length, 0);
});

test('background quota recovery retires stale live reasons while paused and capacity is Off', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = dispatchFixture(t);
  f.c.enabled = false; f.c.concurrency.claude = 0;
  f.c.models.push({ id: 'claude', name: 'Claude', automatic: false, maxDifficulty: 'high', model: { instanceId: 'claudeAgent', model: 'fixture-claude', options: [] } });
  const failure = 'Quota automatic refresh failed: Claude quota snapshot is stale. No run was started.';
  f.store.set('streams', JSON.stringify([{ driver: 'claudeAgent', provider: 'Claude', reason: failure, quotaError: failure, models: [{ id: 'claude', name: 'Claude', reason: failure }], active: [], planned: [] }]));
  f.store.decide({ reason: 'error', at: new Date().toISOString(), message: failure });
  const history = f.store.events(), decision = f.store.currentDecision();
  const operation = { id: '957584e9-3a41-4491-a6b8-e25341b53489', input: { ticket: 'FIX-1' }, state: 'failed' as const, createdAt: new Date().toISOString(), result: { code: 1, data: { reason: 'error', message: failure } } };
  saveOperation(f.c.stateDir, operation);
  t.mock.method(f.t3, 'providers', async () => [f.provider('claudeAgent')]);
  t.mock.method(f.t3, 'provider', async () => f.provider('claudeAgent'));
  await refreshQuota(f.c, f.store, f.t3);
  const status = writeStatus(f.c, f.store), stream = status.streams[0];
  assert.equal(stream.quotaError, undefined);
  assert.equal(stream.reason, 'provider-disabled', 'recovered allowance must retire the stale live failure without enabling starts');
  assert.equal(stream.models[0].reason, 'provider-disabled');
  assert.ok(stream.quota.hasAllowance);
  assert.equal(status.enabled, false);
  assert.equal(f.c.models[1].automatic, false);
  assert.deepEqual(status.decision, decision);
  assert.deepEqual(f.store.events(), history);
  assert.deepEqual(readOperation(f.c.stateDir, operation.id), operation, 'terminal manual outcomes are historical');
  assert.equal(f.launches.length, 0);
});

test('execution heartbeats do not force a new provider quota probe', async t => {
  const f = dispatchFixture(t), at = Date.now(); let forced = 0;
  const job: Job = { id: 'active', kind: 'ticket', projectId: 'FIX', taskId: 'active-task', ticketKey: 'FIX-9', threadId: 'active-thread', messageId: 'message', state: 'running', reason: 'Executing', createdAt: new Date(at - 10_000).toISOString(), lastExecutionAt: new Date(at).toISOString(), lastPersonalActivity: null, completedAt: null, reportPath: '/unused', command: null, prUrls: [], modelSelection: f.c.models[0].model };
  t.mock.method(f.t3, 'provider', async (_id: string, refresh: boolean) => { const provider = f.provider(); if (refresh) forced++; provider.usageLimits.checkedAt = new Date(refresh ? at + 1000 : at - 1000).toISOString(); return provider; });
  assert.equal((await readModelQuota(f.t3, f.c, [job], 'sol')).hasAllowance, true);
  assert.equal(forced, 0, 'an unchanged reservation must not invalidate quota on each execution heartbeat');
});

test('stale quota automatically bypasses the T3 probe cache over RPC', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const old = new Date(Date.now() - 600_000).toISOString();
  let checkedAt = old, failedRefreshes = 0;
  const requests: { tag: string; payload: Record<string, unknown> }[] = [];
  const provider = () => ({
    instanceId: 'claudeAgent', driver: 'claudeAgent', status: 'ready', enabled: true, installed: true,
    models: [{ slug: 'claude-test' }],
    usageLimits: { checkedAt, windows: [
      { id: 'five_hour', usedPercent: 20, windowDurationMins: 300, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      { id: 'seven_day', usedPercent: 20, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    ] },
  });
  class FixtureSocket extends EventTarget {
    readyState = 1;
    send(data: string) {
      const message = JSON.parse(data);
      if (message._tag !== 'Request') return;
      requests.push(message);
      if (message.tag === 'server.refreshProviders') {
        if (failedRefreshes > 0) failedRefreshes--;
        else checkedAt = new Date().toISOString();
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        _tag: 'Exit', requestId: message.id, exit: { _tag: 'Success', value: { providers: [provider()] } },
      }) })));
    }
    close() { this.readyState = 3; }
  }
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = originalSocket; });
  const t3 = new T3({ url: 'http://localhost', credentialFile: '/unused' });
  t.mock.method(t3, 'socketUrl', async () => 'ws://fixture');
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c: Pick<Config, 'models' | 'quota'> = {
    models: [{ id: 'opus', name: 'Opus', automatic: true, maxDifficulty: 'high', model: { instanceId: 'claudeAgent', model: 'claude-test', options: [] } }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
  };
  assert.equal((await readModelQuota(t3, c, [], 'opus')).hasAllowance, true);
  assert.notEqual(checkedAt, old);
  assert.deepEqual(requests.filter(r => r.tag === 'server.refreshProviders').map(r => r.payload), [{ instanceId: 'claudeAgent', workspaceSnapshotsOnDemand: true }]);

  requests.length = 0;
  await readModelQuota(t3, c, [], 'opus');
  assert.equal(requests.some(r => r.tag === 'server.refreshProviders'), false, 'fresh quota avoids unnecessary probes');

  // A later read expires the shared snapshot without resetting another caller's cache.
  checkedAt = old; failedRefreshes = 1; requests.length = 0; t.mock.timers.tick(1001);
  assert.equal((await readModelQuota(t3, c, [], 'opus')).hasAllowance, true, 'retry a transient probe failure automatically');
  assert.equal(requests.filter(r => r.tag === 'server.refreshProviders').length, 2);

  checkedAt = old; failedRefreshes = 1; requests.length = 0; t.mock.timers.tick(1001);
  assert.equal((await readModelQuota(t3, c, [], 'opus', true, true)).hasAllowance, true, 'dispatch-boundary refresh also retries a transient failure');
  assert.equal(requests.filter(r => r.tag === 'server.refreshProviders').length, 2);

  checkedAt = old; failedRefreshes = 5; requests.length = 0;
  t.mock.timers.tick(1001);
  await assert.rejects(readModelQuota(t3, c, [], 'opus'), /automatic refresh failed.*snapshot is stale/);
  assert.equal(requests.filter(r => r.tag === 'server.refreshProviders').length, 2, 'failed refresh stays bounded and never permits stale quota');
});

for (const probe of ['retry', 'exhausted', 'stale'] as const) test(`concurrent final dispatch retains forced quota policy: ${probe}`, async t => {
  const f = dispatchFixture(t);
  let forced = 0;
  t.mock.method(f.t3, 'provider', async (_id: string, refresh: boolean) => {
    const p = f.provider();
    if (refresh) {
      forced++;
      if (probe === 'stale' || probe === 'retry' && forced === 1) p.usageLimits.checkedAt = new Date(0).toISOString();
      if (probe === 'exhausted') p.usageLimits.windows[0].usedPercent = 100;
    }
    return p;
  });
  if (probe === 'stale') await assert.rejects(f.run(), /automatic refresh failed.*stale/);
  else assert.equal((await f.run()).reason, probe === 'retry' ? 'dispatched' : 'codex-quota-exhausted');
  assert.equal(forced, probe === 'exhausted' ? 1 : 2, 'only the selected provider is refreshed with the existing retry bound');
  assert.equal(f.launches.length, probe === 'retry' ? 1 : 0);
});
