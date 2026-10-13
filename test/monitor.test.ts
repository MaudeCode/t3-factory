import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcile, busyProviders } from '../src/scheduler.ts';
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

test('a run orphaned by a stopped provider session releases its slot through the report path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-orphan-')), store = new Store(dir);
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const base = { kind: 'ticket', projectId: 'project', messageId: 'initial', state: 'running', reason: 'Claude is executing', createdAt: old, prUrls: [], lastExecutionAt: old, lastPersonalActivity: null, command: null, completedAt: null, modelSelection: { instanceId: 'claudeAgent', model: 'claude-fixture' } } as const;
  const discovery: Job = { ...base, id: 'discovery', kind: 'discovery', taskId: null, ticketKey: null, threadId: 'discovery-thread', reportPath: join(dir, 'discovery.json') } as unknown as Job;
  const ticket: Job = { ...base, id: 'ticket', taskId: 'ticket', ticketKey: 'FIX-2', threadId: 'ticket-thread', reportPath: join(dir, 'ticket.json') } as unknown as Job;
  writeFileSync(discovery.reportPath, JSON.stringify({ jobId: 'discovery', status: 'complete', reason: 'Filed nothing new', prUrls: [], createdTaskIds: [] }));
  const orphaned = (id: string) => v2Thread({ id, status: 'queued', activeRunId: 'run-1', updatedAt: old, orphanedRun: true });
  const threads = [orphaned(discovery.threadId), orphaned(ticket.threadId)];
  const c = { monitoringTimeoutMinutes: 30, projects: [{ kaneoId: 'project' }], discovery: { emptyCooldownHours: 1 } } as unknown as Config;
  try {
    store.save(discovery); store.save(ticket);
    await reconcile(c, store, {} as T3, {} as Kaneo, threads, false);
    const jobs = new Map(store.jobs().map(j => [j.id, j]));
    assert.deepEqual([jobs.get('ticket')!.state, jobs.get('ticket')!.reason], ['waiting', 'Turn ended without a completion report; inspect in T3']);
    assert.equal(jobs.get('discovery')!.state, 'complete');
    assert.equal(busyProviders(store.jobs(), threads, new Map(), 30).size, 0, 'neither orphaned run holds a slot');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('runtime handoffs and a waiting snapshot without a human request never journal needs you', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-handoff-')), store = new Store(dir);
  const now = new Date().toISOString();
  const job: Job = { id: 'job', taskId: 'ticket', kind: 'ticket', projectId: 'project', ticketKey: 'FIX-1', threadId: 'owned-thread', messageId: 'initial', state: 'running', reason: 'Claude is executing', createdAt: now, reportPath: join(dir, 'job.json'), prUrls: [], lastPersonalActivity: null, command: null, completedAt: null };
  const c = { monitoringTimeoutMinutes: 30 } as Config;
  const thread = v2Thread({ id: job.threadId, status: 'running', activeRunId: 'run-1', updatedAt: now });
  try {
    store.save(job);
    for (const kind of [null, 'dynamic_tool_call', 'auth_refresh']) {
      thread.status = 'waiting'; thread.activeRunId = null;
      thread.pendingRuntimeRequest = kind ? { kind, createdAt: now } : null;
      await reconcile(c, store, {} as T3, {} as Kaneo, [thread], false);
      assert.equal(store.job(job.id)!.state, 'running', String(kind));
      assert.equal(busyProviders(store.jobs(), [thread], new Map(), 30).has('claudeAgent'), true, 'handoffs keep the execution slot');
    }
    thread.status = 'completed'; thread.pendingRuntimeRequest = null;
    thread.pendingBackgroundTasks = [{ taskId: 'pull-request-watch:1', kind: 'monitor' }];
    await reconcile(c, store, {} as T3, {} as Kaneo, [thread], false);
    assert.equal(store.events().some(e => e.text === 'FIX-1 needs you'), false);
    for (const kind of ['user_input', 'exec_command_approval', 'future_request']) {
      thread.pendingRuntimeRequest = { kind, createdAt: now };
      await reconcile(c, store, {} as T3, {} as Kaneo, [thread], false);
      assert.equal(store.job(job.id)!.state, 'waiting', kind);
      assert.equal(busyProviders(store.jobs(), [thread], new Map(), 30).size, 0);
      thread.pendingRuntimeRequest = null;
      await reconcile(c, store, {} as T3, {} as Kaneo, [thread], false);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
