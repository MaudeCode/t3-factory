import test from 'node:test';
import { queueOrder, branchKind } from '../src/policy.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveAt, quotaDecision, providerQuotaSnapshot, selectTicket, executing, providerExecuting, waiting, stalledMonitor, mentionsTicket, threadSchema, subagentDescendants } from '../src/policy.ts';
import { v2Thread } from './v2-fixture.ts';
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
test('v2 thread status classifies every run state', () => {
  const executingStatuses = ['preparing', 'queued', 'starting', 'running'];
  const terminalStatuses = ['idle', 'completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'];
  for (const status of executingStatuses) {
    const t = v2Thread({ status });
    assert.equal(executing(t), true, status); assert.equal(waiting(t), false, status); assert.equal(stalledMonitor(t), false, status);
  }
  for (const status of terminalStatuses) {
    const t = v2Thread({ status });
    assert.equal(executing(t), false, status); assert.equal(waiting(t), false, status); assert.equal(stalledMonitor(t), false, status);
  }
  const t = v2Thread({ status: 'waiting' });
  assert.equal(waiting(t), false); assert.equal(executing(t), true); assert.equal(stalledMonitor(t), false);
  assert.equal(executing(v2Thread({ status: 'completed', activeRunId: 'run-2' })), true, 'an active run executes whatever the latest run reports');
  assert.throws(() => threadSchema.parse(v2Thread({ status: 'paused' })), 'an unknown status is an incompatible contract');
  assert.equal(threadSchema.parse(v2Thread()).status, 'completed');
});
test('internal requests hold execution capacity; only human requests wait for a person', () => {
  for (const status of ['running', 'waiting', 'completed']) {
    for (const kind of ['dynamic_tool_call', 'auth_refresh', 'user_input', 'exec_command_approval', 'future_request']) {
      const t = v2Thread({ status, pendingRuntimeRequest: { kind, createdAt: new Date().toISOString() }, pendingBackgroundTasks: [{ taskId: 'watch', kind: 'monitor' }] });
      const human = !['dynamic_tool_call', 'auth_refresh'].includes(kind);
      assert.equal(waiting(t), human, `${status}/${kind}`);
      assert.equal(executing(t), !human, `${status}/${kind}`);
      assert.equal(providerExecuting(t, new Map()), !human, `${status}/${kind}`);
      assert.equal(stalledMonitor(t), false, 'pending requests cannot be stopped as stalled monitors');
    }
  }
  const localCommand = v2Thread({ status: 'waiting', pendingRuntimeRequest: { kind: 'user_input', createdAt: new Date().toISOString() }, pendingBackgroundTasks: [{ taskId: 'local', kind: 'command' }] });
  assert.equal(executing(localCommand), false);
  assert.equal(providerExecuting(localCommand, new Map()), false, 'local commands never count as provider execution');
});
test('a pending runtime request releases the slot; a resume or background worker takes it', () => {
  const request = { id: 'request-1', kind: 'user_input', createdAt: '2026-01-01T00:00:00.000Z' };
  const t = v2Thread({ status: 'running', activeRunId: 'run-1', pendingRuntimeRequest: request });
  assert.equal(waiting(t), true); assert.equal(executing(t), false);
  t.pendingRuntimeRequest = null; assert.equal(executing(t), true);
  t.pendingRuntimeRequest = request; t.status = 'completed'; t.activeRunId = null;
  t.pendingBackgroundTasks = [{ taskId: 'bash-1', kind: 'command' }];
  assert.equal(waiting(t), true); assert.equal(executing(t), false);
  for (const kind of ['subagent', 'background_task', 'future_kind']) {
    assert.equal(executing(v2Thread({ pendingBackgroundTasks: [{ taskId: 'task-1', kind }] })), true, kind);
  }
  t.pendingBackgroundTasks = []; t.pendingRuntimeRequest = null; t.status = 'failed';
  assert.equal(executing(t), false);
});
test('an orphaned run does not execute, but its background worker still does', () => {
  const t = v2Thread({ status: 'queued', activeRunId: 'run-1', orphanedRun: true });
  assert.equal(threadSchema.parse(t).orphanedRun, true);
  assert.equal(executing(t), false); assert.equal(providerExecuting(t, new Map()), false);
  assert.equal(waiting(t), false); assert.equal(stalledMonitor(t), false);
  t.pendingBackgroundTasks = [{ taskId: 'task-1', kind: 'background_task' }];
  assert.equal(executing(t), true); assert.equal(providerExecuting(t, new Map()), true);
  t.pendingBackgroundTasks = []; t.orphanedRun = false;
  assert.equal(executing(t), true); assert.equal(providerExecuting(t, new Map()), true);
});
test('an old passive monitor is not execution, but a live run or background worker is', () => {
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const monitor = [{ taskId: 'pull-request-watch:1', description: 'Watching pull request #1', kind: 'monitor' }];
  const t = v2Thread({ status: 'completed', updatedAt: old, latestRunCompletedAt: old, pendingBackgroundTasks: monitor });
  assert.equal(stalledMonitor(t), true);
  assert.equal(executing(t), false, 'the overnight monitor must not hold the slot forever');
  assert.equal(executing(t, 30, false), false, 'a passive watcher never counts as personal execution');
  t.updatedAt = new Date().toISOString(); assert.equal(executing(t), true, 'fresh CI monitoring retains the slot');
  assert.equal(stalledMonitor(t), false);
  t.updatedAt = old; t.latestRunCompletedAt = new Date().toISOString();
  assert.equal(stalledMonitor(t), false, 'a recently completed run renews the monitor');
  t.latestRunCompletedAt = old; t.status = 'running'; t.activeRunId = 'run-2';
  assert.equal(executing(t), true); assert.equal(stalledMonitor(t), false);
  t.status = 'completed'; t.activeRunId = null; t.pendingBackgroundTasks = [...monitor, { taskId: 'bash-1', kind: 'command' }];
  assert.equal(executing(t), false); assert.equal(stalledMonitor(t), false, 'mixed local commands never authorize monitor timeout cancellation');
  t.status = 'interrupted'; t.pendingBackgroundTasks = monitor;
  assert.equal(executing(t), false); assert.equal(stalledMonitor(t), false, 'a stopped thread has nothing left to stop');
  t.status = 'idle'; assert.equal(stalledMonitor(t), true, 'a watch on a thread without runs can stall too');
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
test('subagent descendants are transitive, exclude other relationships, and tolerate cycles', () => {
  const child = (id: string, parentThreadId: string, relationshipToParent = 'subagent') => v2Thread({ id, lineage: { rootThreadId: 'root', parentThreadId, relationshipToParent } });
  const threads = [child('root', 'grandchild'), child('child', 'root'), child('grandchild', 'child'), child('fork', 'root', 'fork'), child('fork-child', 'fork'), child('foreign', 'other'), v2Thread({ id: 'plain' })];
  assert.deepEqual(subagentDescendants(threads, 'root').map(t => t.id), ['child', 'grandchild']);
  assert.deepEqual(subagentDescendants(threads, 'plain'), []);
});

test('the up-next order rotates projects the way dispatch does', () => {
  const t = (key: string, projectId: string, priority: string, createdAt: string) => ({ id: key, key, projectId, priority, createdAt });
  const order = queueOrder([t('A-2', 'A', 'high', '2026-01-02'), t('A-1', 'A', 'high', '2026-01-01'), t('B-1', 'B', 'high', '2026-01-03'), t('A-3', 'A', 'low', '2026-01-01')], 'A', ['A', 'B']);
  // Within a tier the project holding more tickets goes first; the rotation only breaks ties.
  assert.deepEqual(order.map(x => x.key), ['A-1', 'B-1', 'A-2', 'A-3']);
  assert.deepEqual(queueOrder([], null, ['A']), []);
});

test('branch prefixes follow the ticket kind label in conventional-commit terms', () => {
  const labels = (...names: string[]) => names.map(name => ({ name }));
  assert.equal(branchKind(labels('sf', 'high', 'bug')), 'fix');
  assert.equal(branchKind(labels('sec', 'med')), 'fix');
  assert.equal(branchKind(labels('feat')), 'feat');
  assert.equal(branchKind(labels('ux')), 'feat');
  assert.equal(branchKind(labels('perf')), 'perf');
  assert.equal(branchKind(labels('docs')), 'docs');
  assert.equal(branchKind(labels('high', 'app')), 'chore', 'no kind label falls back to chore');
});

test('terminal command-only work releases execution while workers and handoffs stay protected', () => {
  const command = { taskId: 'server', kind: 'command' };
  const t = v2Thread({ pendingBackgroundTasks: [command] });
  assert.equal(executing(t), false, 'a completed run with only a local command is not executing');
  assert.equal(providerExecuting(t, new Map()), false);
  for (const kind of ['subagent', 'background_task', 'future_kind']) {
    t.pendingBackgroundTasks = [command, { taskId: 'worker', kind }];
    assert.equal(executing(t), true, kind);
  }
  t.pendingBackgroundTasks = [command]; t.activeRunId = 'run';
  assert.equal(executing(t), true);
  t.activeRunId = null; t.pendingRuntimeRequest = { kind: 'dynamic_tool_call', createdAt: t.updatedAt };
  assert.equal(executing(t), true);
  t.pendingRuntimeRequest.kind = 'user_input';
  assert.equal(waiting(t), true); assert.equal(executing(t), false);
});
