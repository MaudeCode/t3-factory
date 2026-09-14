import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAssignment, acceptsDifficulty, ticketDifficulty, quotaDecision, providerQuotaSnapshot } from '../src/policy.ts';
import { readModelQuota } from '../src/models.ts';
import { T3 } from '../src/clients.ts';
import type { Config } from '../src/config.ts';

test('budgets are independent pools shared by every model that uses them', async t => {
  const selection = (instanceId: string, model: string) => ({ instanceId, model, options: [] });
  const budget = (reservePercent: number, minRemainingPercent = 0) => ({ reservePercent, minRemainingPercent });
  const c: Pick<Config, 'models' | 'quota'> = { models: [
    { id: 'fable', name: 'Fable', model: selection('claudeAgent', 'claude-fable-5-1'), automatic: true, maxDifficulty: 'high', quotaWindowId: 'seven_day_fable' },
    { id: 'opus', name: 'Opus', model: selection('claudeAgent', 'claude-opus-5'), automatic: true, maxDifficulty: 'high' },
    { id: 'sol', name: 'Sol', model: selection('codex', 'gpt-5.6-sol'), automatic: true, maxDifficulty: 'med' },
    { id: 'astra', name: 'Astra', model: selection('codex', 'gpt-6-astra'), automatic: true, maxDifficulty: 'high' },
  ], quota: { maxAgeSeconds: 300, claude: { fiveHour: budget(40), weekly: budget(70), fable: budget(0, 15) }, codex: { weekly: budget(50) } } };
  let fableUsed = 17, fiveUsed = 0, weeklyUsed = 0, codexUsed = 0, missing = false, advertised = true;
  const t3 = new T3({ url: 'http://127.0.0.1', credentialFile: '/unused' });
  t.mock.method(t3, 'provider', async (driver: string) => {
    const window = (id: string, usedPercent: number, minutes: number) => ({ id, usedPercent, windowDurationMins: minutes, resetsAt: new Date(Date.now() + minutes * 60_000).toISOString() });
    return { driver, enabled: true, installed: true, status: 'ready', models: advertised ? c.models.map(p => ({ slug: p.model.model })) : [], usageLimits: { checkedAt: new Date().toISOString(), windows: driver === 'codex' ? [window('primary', codexUsed, 10080)] : [window('five_hour', fiveUsed, 300), window('seven_day', weeklyUsed, 10080), ...missing ? [] : [window('seven_day_fable', fableUsed, 10080)]] } };
  });
  assert.equal((await readModelQuota(t3, c, [], 'fable')).allowed, true);
  fableUsed = 85;
  assert.equal((await readModelQuota(t3, c, [], 'fable')).allowed, false);
  assert.equal((await readModelQuota(t3, c, [], 'opus')).allowed, true, 'Opus does not use the Fable pool');
  fableUsed = 0; weeklyUsed = 99;
  assert.equal((await readModelQuota(t3, c, [], 'fable')).allowed, true);
  assert.equal((await readModelQuota(t3, c, [], 'opus')).allowed, false);
  fiveUsed = 90;
  assert.equal((await readModelQuota(t3, c, [], 'fable')).allowed, false);
  assert.equal((await readModelQuota(t3, c, [], 'opus')).allowed, false, 'shared five-hour budget constrains both');
  codexUsed = 60;
  assert.equal((await readModelQuota(t3, c, [], 'sol')).allowed, false);
  assert.equal((await readModelQuota(t3, c, [], 'astra')).allowed, false, 'changing models cannot evade a shared budget');
  assert.equal((await readModelQuota(t3, c, [], 'astra', true)).allowed, true, 'explicit manual Codex has no reserve');
  codexUsed = 100;
  assert.equal((await readModelQuota(t3, c, [], 'astra', true)).allowed, false);
  for (const bad of [101, NaN]) { fableUsed = bad; await assert.rejects(readModelQuota(t3, c, [], 'fable')); }
  fableUsed = 17; missing = true; await assert.rejects(readModelQuota(t3, c, [], 'fable'), /missing/);
  missing = false; advertised = false; await assert.rejects(readModelQuota(t3, c, [], 'fable'), /does not advertise/);
});

test('priority, rank, difficulty ceiling and provider capacity select the next claim', () => {
  const preset = (id: string, maxDifficulty: 'low' | 'med' | 'high') => ({ id, name: id, model: { instanceId: id, model: id, options: [] }, automatic: true, maxDifficulty });
  const models = [{ preset: preset('sol', 'med'), driver: 'codex' }, { preset: preset('fable', 'high'), driver: 'claudeAgent' }];
  const ticket = (id: string, priority: string, difficulty?: 'low' | 'med' | 'high') => ({ id, key: id, projectId: 'p', priority, difficulty, createdAt: '2026-01-01' });
  const urgent = ticket('urgent', 'urgent', 'high'), medium = ticket('medium', 'high', 'med');
  assert.equal(selectAssignment([urgent, medium], models, new Set(), null, ['p'])?.preset.id, 'fable', 'urgent work wins even when a higher-ranked model cannot handle it');
  assert.equal(selectAssignment([medium], models, new Set(), null, ['p'])?.preset.id, 'sol');
  assert.equal(selectAssignment([medium], models.toReversed(), new Set(), null, ['p'])?.preset.id, 'fable', 'reordering changes first choice');
  assert.equal(selectAssignment([medium], models, new Set(['codex']), null, ['p'])?.preset.id, 'fable');
  assert.equal(selectAssignment([urgent], [models[0]], new Set(), null, ['p']), undefined);
  assert.equal(selectAssignment([ticket('unclassified', 'urgent')], models, new Set(), null, ['p']), undefined);
  assert.equal(acceptsDifficulty(preset('small', 'low'), ticket('medium', 'high', 'med')), false);
});

const now = Date.parse('2026-09-12T01:00:00Z');
test('Fable ignores the weekly reserve but retains five-hour protection; Opus retains both', () => {
  const config = { maxAgeSeconds: 300, fiveHourReservePercent: 40, weeklyReservePercent: 70 };
  const windows = [{ id: 'five_hour', usedPercent: 0, windowDurationMins: 300 }, { id: 'seven_day', usedPercent: 100, windowDurationMins: 10080, resetsAt: new Date(now + 86_400_000).toISOString() }];
  const data = providerQuotaSnapshot(new Date(now).toISOString(), windows, now);
  assert.equal(quotaDecision(data, config, now, true).allowed, true);
  assert.equal(quotaDecision(data, config, now).allowed, false);
  windows[0].usedPercent = 80;
  windows[0].resetsAt = new Date(now + 5 * 3_600_000).toISOString();
  assert.equal(quotaDecision(providerQuotaSnapshot(new Date(now).toISOString(), windows, now), config, now, true).allowed, false);
});
test('classification requires one recognized difficulty', () => {
  assert.equal(ticketDifficulty([{ name: 'sf' }, { name: 'med' }]), 'med');
  assert.equal(ticketDifficulty([{ name: 'sf' }]), undefined);
  assert.throws(() => ticketDifficulty([{ name: 'med' }, { name: 'high' }]));
});
