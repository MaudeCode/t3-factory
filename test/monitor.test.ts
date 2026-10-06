import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcile } from '../src/scheduler.ts';
import { Store, type Job } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import type { T3, Kaneo } from '../src/clients.ts';
import { v2Thread } from './v2-fixture.ts';

test('stalled monitor is stopped and confirmed before parking; dry runs and active turns are preserved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-monitor-')), store = new Store(dir);
  const old = new Date(Date.now() - 86_400_000).toISOString();
  const reportPath = join(dir, 'reports', 'job.json');
  const job: Job = { id: 'job', taskId: 'ticket', kind: 'ticket', projectId: 'project', ticketKey: 'FIX-1', threadId: 'owned-thread', messageId: 'initial', state: 'running', reason: 'Claude is executing', createdAt: old, reportPath, prUrls: [], lastExecutionAt: old, lastPersonalActivity: null, command: null, completedAt: null };
  const thread = v2Thread({ id: job.threadId, updatedAt: old, status: 'completed', latestRunCompletedAt: old, pendingBackgroundTasks: [{ taskId: 'pull-request-watch:1', kind: 'monitor' }] });
  const commands: unknown[] = [];
  const t3 = { shell: async () => ({ threads: [thread] }), dispatch: async (command: unknown) => { commands.push(command); } } as unknown as T3;
  const c = { monitoringTimeoutMinutes: 30 } as Config;
  try {
    store.save(job);
    await reconcile(c, store, t3, {} as Kaneo, [thread], false);
    assert.equal(commands.length, 0); assert.equal(existsSync(reportPath), false);
    await reconcile(c, store, t3, {} as Kaneo, [thread]);
    assert.equal(commands.length, 1);
    assert.equal((commands[0] as { type: string }).type, 'thread.stop');
    assert.equal((commands[0] as { threadId: string }).threadId, job.threadId);
    assert.equal(store.jobs()[0].state, 'running', 'keep the slot until T3 confirms the stop');
    thread.status = 'interrupted'; thread.pendingBackgroundTasks = [];
    await reconcile(c, store, t3, {} as Kaneo, [thread]);
    assert.equal(store.jobs()[0].state, 'waiting');
    assert.match(store.jobs()[0].reason, /Merge authorization and required human validation still apply/);
    thread.status = 'running'; thread.activeRunId = 'run-2'; thread.pendingBackgroundTasks = [{ taskId: 'pull-request-watch:1', kind: 'monitor' }];
    await reconcile(c, store, t3, {} as Kaneo, [thread]);
    assert.equal(store.jobs()[0].state, 'running'); assert.equal(commands.length, 1, 'never stop a resumed active turn');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
