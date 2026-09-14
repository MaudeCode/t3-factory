import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveAt, quotaDecision, providerQuotaSnapshot, selectTicket, executing, waiting, mentionsTicket, type Thread } from '../src/policy.ts';
import { Store, type Job } from '../src/store.ts';
import { configSchema } from '../src/config.ts';

const now = Date.parse('2026-09-06T01:00:00Z');
const quota = { snapshotFile: '/tmp/fake.json', maxAgeSeconds: 600, fiveHourReservePercent: 40, weeklyReservePercent: 70 };
function snapshot(used = 10) { return { entries: [{ provider: 'claude', updatedAt: new Date(now).toISOString(), primary: { usedPercent: used, windowMinutes: 300, resetsAt: new Date(now + 300 * 60_000).toISOString() }, secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: new Date(now + 10080 * 60_000).toISOString() } }] }; }
test('both reserves decay by time remaining, with boundaries clamped', () => {
  assert.equal(reserveAt(40, now + 150 * 60_000, 300 * 60_000, now), 20);
  assert.equal(reserveAt(70, now + 5040 * 60_000, 10080 * 60_000, now), 35);
  assert.equal(reserveAt(40, now, 300, now), 0);
  assert.equal(reserveAt(70, now - 1, 100, now), 0);
  assert.equal(reserveAt(40, now + 1000, 100, now), 40);
});
test('quota rejects stale, expired, missing, ambiguous and invalid data', () => {
  assert.equal(quotaDecision(snapshot(), quota, now).allowed, true);
  assert.equal(quotaDecision(snapshot(60), quota, now).allowed, false);
  assert.throws(() => quotaDecision(snapshot(), quota, now + 601_000), /stale/);
  assert.throws(() => quotaDecision({ entries: [] }, quota, now));
  assert.throws(() => quotaDecision({ entries: [...snapshot().entries, ...snapshot().entries] }, quota, now));
  const expired = snapshot(); expired.entries[0].primary.resetsAt = new Date(now).toISOString();
  assert.throws(() => quotaDecision(expired, quota, now), /expired/);
  assert.throws(() => quotaDecision(snapshot(101), quota, now));
});
test('near-reset quota can dispatch below the original 40% reserve', () => {
  const s = snapshot(95); s.entries[0].primary.resetsAt = new Date(now + 10 * 60_000).toISOString();
  assert.equal(quotaDecision(s, quota, now).allowed, true);
});
test('explicit zero-use inactive windows keep full reserves; absent windows never imply zero', () => {
  const windows = [{ id: 'five_hour', usedPercent: 0, windowDurationMins: 300 }, { id: 'seven_day', usedPercent: 0, windowDurationMins: 10080 }];
  const q = quotaDecision(providerQuotaSnapshot(new Date(now).toISOString(), windows, now), quota, now);
  assert.equal(q.allowed, true); assert.deepEqual(q.windows.map(w => w.reserved), [40, 70]);
  assert.throws(() => quotaDecision(providerQuotaSnapshot(new Date(now).toISOString(), [], now), quota, now));
});
test('global priority wins, then largest eligible project, then rotation and oldest', () => {
  const task = (id: string, p: string, priority: string) => ({ id, key: id, projectId: p, priority, createdAt: '2026-01-01' });
  const tasks = [task('A-1', 'A', 'high'), task('A-2', 'A', 'high'), task('B-1', 'B', 'urgent')];
  assert.equal(selectTicket(tasks, 'B', ['A', 'B'])?.key, 'B-1');
  assert.equal(selectTicket([...tasks.slice(0, 2), task('B-2', 'B', 'high')], 'A', ['A', 'B'])?.projectId, 'A');
  assert.equal(selectTicket([tasks[0], task('B-2', 'B', 'high')], 'A', ['A', 'B'])?.projectId, 'B');
});
test('a running session awaiting input releases the slot; a manual resume takes it', () => {
  const t = { session: { status: 'running' }, latestTurn: { state: 'running' }, hasPendingApprovals: false, hasPendingUserInput: true } as Thread;
  assert.equal(waiting(t), true); assert.equal(executing(t), false);
  t.hasPendingUserInput = false; assert.equal(executing(t), true);
  t.hasPendingUserInput = true; t.backgroundLiveness = 'working';
  assert.equal(waiting(t), false); assert.equal(executing(t), true);
  t.backgroundLiveness = null; t.hasPendingUserInput = false; t.session!.status = 'error';
  assert.equal(executing(t), false);
});
test('an old passive monitor is not execution, but a live turn or background worker is', () => {
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const t = { session: { status: 'ready', updatedAt: old }, latestTurn: { state: 'completed', completedAt: old }, updatedAt: old, hasPendingApprovals: false, hasPendingUserInput: false, backgroundLiveness: 'monitoring' } as Thread;
  assert.equal(executing(t), false, 'the overnight monitor must not hold the slot forever');
  t.updatedAt = new Date().toISOString(); assert.equal(executing(t), true, 'fresh CI monitoring retains the slot');
  t.updatedAt = old; t.session!.status = 'running'; assert.equal(executing(t), true);
  t.session!.status = 'ready'; t.backgroundLiveness = 'working'; assert.equal(executing(t), true);
  t.session!.status = 'stopped'; t.backgroundLiveness = 'monitoring'; assert.equal(executing(t), false);
});
test('ticket ownership matches exact numbers in branches and titles', () => {
  assert.equal(mentionsTicket('fix/APP-13-bug', 'APP-13'), true);
  assert.equal(mentionsTicket('APP-130', 'APP-13'), false);
  assert.equal(mentionsTicket('TOAPP-13', 'APP-13'), false);
});
test('job ownership survives reopen and prohibits duplicate ticket jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-factory-test-'));
  try {
    const a = new Store(dir); const job = { id: 'job1', taskId: 'ticket1', state: 'dispatching' } as Job;
    a.save(job); a.close(); const b = new Store(dir);
    assert.equal(b.jobs()[0].state, 'dispatching');
    assert.throws(() => b.save({ ...job, id: 'job2' })); b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('unknown settings are rejected instead of silently weakening policy', () => {
  assert.throws(() => configSchema.parse({ enabled: true, typo: 1 }));
});
