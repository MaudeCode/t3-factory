import test from 'node:test';
import assert from 'node:assert/strict';
import { T3 } from '../src/clients.ts';
import { readModelQuota } from '../src/models.ts';
import type { Config } from '../src/config.ts';
import { dispatchFixture } from './dispatch-fixture.ts';
import type { Job } from '../src/store.ts';

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
      if (message.tag === 'server.refreshProviders' && message.payload.refreshModels === true) {
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
  assert.deepEqual(requests.filter(r => r.tag === 'server.refreshProviders').map(r => r.payload), [{ instanceId: 'claudeAgent', refreshModels: true }]);

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
