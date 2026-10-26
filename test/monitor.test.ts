import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcile, busyProviders } from '../src/scheduler.ts';
import { Store, type Job } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import { T3, type Kanvil } from '../src/clients.ts';
import { publicStopCommand, v2Projection, v2Thread } from './v2-fixture.ts';

test('stalled monitor is stopped and confirmed before parking; dry runs and active turns are preserved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-monitor-')), store = new Store(dir);
  const old = new Date(Date.now() - 86_400_000).toISOString();
  const reportPath = join(dir, 'reports', 'job.json');
  const job: Job = { id: 'job', taskId: 'ticket', kind: 'ticket', projectId: 'project', ticketKey: 'FIX-1', threadId: 'owned-thread', messageId: 'initial', state: 'running', reason: 'Claude is executing', createdAt: old, reportPath, prUrls: [], lastExecutionAt: old, lastPersonalActivity: null, command: null, completedAt: null };
  const thread = v2Thread({ id: job.threadId, updatedAt: old, status: 'completed', latestRunCompletedAt: old, pendingBackgroundTasks: [{ taskId: 'pull-request-watch:1', kind: 'monitor' }] });
  const commands: unknown[] = [];
  let fresh = thread;
  const t3 = { stop: T3.prototype.stop, request: async () => ({ projection: v2Projection(thread) }), shell: async () => ({ threads: [fresh] }), dispatch: async (command: unknown) => { publicStopCommand.parse(command); commands.push(command); } } as unknown as T3;
  const c = { monitoringTimeoutMinutes: 30 } as Config;
  try {
    store.save(job);
    await reconcile(c, store, t3, {} as Kanvil, [thread], false);
    assert.equal(commands.length, 0); assert.equal(existsSync(reportPath), false);
    fresh = v2Thread({ ...thread, status: 'running', activeRunId: 'resumed-run' });
    await reconcile(c, store, t3, {} as Kanvil, [thread]);
    assert.equal(commands.length, 0, 'a fresh shell showing resumed work prevents automatic monitor stop');
    fresh = thread;
    await reconcile(c, store, t3, {} as Kanvil, [thread]);
    assert.equal(commands.length, 1);
    assert.equal((commands[0] as { type: string }).type, 'thread.pull-request.watch');
    assert.equal((commands[0] as { threadId: string }).threadId, job.threadId);
    assert.equal(store.jobs()[0].state, 'running', 'keep the slot until T3 confirms the stop');
    thread.status = 'interrupted'; thread.pendingBackgroundTasks = [];
    await reconcile(c, store, t3, {} as Kanvil, [thread]);
    assert.equal(store.jobs()[0].state, 'waiting');
    assert.match(store.jobs()[0].reason, /Merge authorization and required human validation still apply/);
    thread.status = 'running'; thread.activeRunId = 'run-2'; thread.pendingBackgroundTasks = [{ taskId: 'pull-request-watch:1', kind: 'monitor' }];
    await reconcile(c, store, t3, {} as Kanvil, [thread]);
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
  const orphaned = (id: string) => v2Thread({ id, status: 'queued', activeRunId: 'run-1', updatedAt: old, orphanedRun: true, pendingRuntimeRequest: { kind: 'dynamic_tool_call', createdAt: old } });
  const threads = [orphaned(discovery.threadId), orphaned(ticket.threadId)];
  const c = { monitoringTimeoutMinutes: 30, projects: [{ kanvilId: 'project' }], discovery: { emptyCooldownHours: 1 } } as unknown as Config;
  try {
    store.save(discovery); store.save(ticket);
    await reconcile(c, store, {} as T3, {} as Kanvil, threads, false);
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
      await reconcile(c, store, {} as T3, {} as Kanvil, [thread], false);
      assert.equal(store.job(job.id)!.state, 'running', String(kind));
      assert.equal(busyProviders(store.jobs(), [thread], new Map(), 30).has('claudeAgent'), true, 'handoffs keep the execution slot');
    }
    thread.status = 'completed'; thread.pendingRuntimeRequest = null;
    thread.pendingBackgroundTasks = [{ taskId: 'pull-request-watch:1', kind: 'monitor' }];
    await reconcile(c, store, {} as T3, {} as Kanvil, [thread], false);
    assert.equal(store.events().some(e => e.text === 'FIX-1 needs you'), false);
    for (const kind of ['user_input', 'exec_command_approval', 'future_request']) {
      thread.pendingRuntimeRequest = { kind, createdAt: now };
      await reconcile(c, store, {} as T3, {} as Kanvil, [thread], false);
      assert.equal(store.job(job.id)!.state, 'waiting', kind);
      assert.equal(busyProviders(store.jobs(), [thread], new Map(), 30).size, 0);
      thread.pendingRuntimeRequest = null;
      await reconcile(c, store, {} as T3, {} as Kanvil, [thread], false);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// A settled turn with pending local commands is waiting for their completion notification, not for a person.
const commandVariants = ['report', 'missing', 'settled', 'worker', 'active', 'human', 'monitor', 'expired-monitor', 'awaiting', 'invalid', 'mismatch', 'unverified', 'stopped', 'orphaned', 'empty'] as const;
for (const variant of commandVariants) test(`command-only reconciliation: ${variant}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-command-'));
  let store = new Store(dir);
  const old = '2026-01-01T00:00:00Z', fresh = new Date().toISOString();
  const job: Job = { id: 'job', kind: 'discovery', projectId: 'project', taskId: null, ticketKey: null, threadId: 'owned', messageId: 'initial', state: 'running', reason: 'executing', createdAt: old, reportPath: join(dir, 'report'), prUrls: [], lastPersonalActivity: null, command: null, completedAt: null };
  const thread = v2Thread({ id: 'owned', pendingBackgroundTasks: variant === 'empty' ? [] : [{ taskId: 'server', kind: 'command' }] });
  if (variant === 'settled') thread.settledOverride = 'settled';
  if (variant === 'worker') thread.pendingBackgroundTasks.push({ taskId: 'worker', kind: 'future_kind' });
  if (variant === 'active') thread.activeRunId = 'active';
  if (variant === 'human') thread.pendingRuntimeRequest = { kind: 'user_input', createdAt: old };
  if (variant === 'monitor' || variant === 'expired-monitor') thread.pendingBackgroundTasks.push({ taskId: 'pull-request-watch:1', kind: 'monitor' });
  if (variant === 'monitor') thread.updatedAt = thread.latestRunCompletedAt = fresh;
  if (variant === 'stopped') thread.status = 'interrupted';
  if (variant === 'orphaned') Object.assign(thread, { status: 'queued', activeRunId: 'run-1', orphanedRun: true });
  const report = { jobId: job.id, status: 'complete', reason: 'Finished', prUrls: [], createdTaskIds: [] as string[] };
  if (variant === 'awaiting') report.status = 'awaiting-human';
  if (variant === 'mismatch') report.jobId = 'another-job';
  if (variant === 'unverified') report.createdTaskIds = ['foreign'];
  const c = { projects: [{ kanvilId: 'project' }], monitoringTimeoutMinutes: 30, discovery: { emptyCooldownHours: 1 } } as Config;
  const kanvil = { task: async () => ({ id: 'foreign', projectId: 'elsewhere', number: 1, title: 'Fixture', createdAt: old, priority: 'low', status: 'todo' }) } as unknown as Kanvil;
  const t3 = { shell: async () => { throw new Error('reconcile must not read T3'); }, dispatch: async () => { throw new Error('reconcile must not stop or launch'); } } as unknown as T3;
  const reported = !['missing', 'stopped', 'orphaned', 'empty', 'expired-monitor', 'monitor'].includes(variant);
  try {
    if (reported) writeFileSync(job.reportPath, JSON.stringify(variant === 'invalid' ? {} : report));
    store.save(job);
    // Repeat across a store reopen: a background wait never decays into a human wait.
    for (let pass = 0; pass < 2; pass++) {
      await reconcile(c, store, t3, kanvil, [thread], false);
      if (pass === 0) { store.close(); store = new Store(dir); }
    }
    const saved = store.job(job.id)!;
    const expected = ({ report: 'complete', missing: 'running', settled: 'dismissed', worker: 'running', active: 'running', human: 'waiting', monitor: 'running', 'expired-monitor': 'running', awaiting: 'waiting', invalid: 'waiting', mismatch: 'waiting', unverified: 'waiting', stopped: 'waiting', orphaned: 'waiting', empty: 'waiting' })[variant];
    if (['missing', 'expired-monitor'].includes(variant)) {
      assert.deepEqual(store.events().filter(e => e.text.endsWith('needs you')).map(e => e.text), [], 'a background wait never journals needs you');
      assert.equal(saved.reason, 'Waiting for background commands');
    }
    assert.equal(saved.state, expected);
    if (['stopped', 'orphaned', 'empty'].includes(variant)) assert.equal(saved.reason, 'Turn ended without a completion report; inspect in T3');
    if (variant === 'invalid') assert.match(saved.reason, /invalid|expected/i);
    if (variant === 'mismatch') assert.equal(saved.reason, 'Completion report job ID mismatch');
    if (variant === 'unverified') assert.equal(saved.reason, 'Discovery report includes another project');
    assert.equal(busyProviders(store.jobs(), [thread], new Map(), 30).size, ['missing', 'worker', 'active', 'monitor', 'expired-monitor'].includes(variant) ? 1 : 0, 'unfinished running jobs retain capacity during command waits');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const answer of ['structured-input', 'message'] as const) test(`an answered awaiting-human report does not describe a later command wait: ${answer}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-answered-')), store = new Store(dir);
  const old = '2026-01-01T00:00:00Z', asked = new Date(Date.now() - 60_000);
  const job: Job = { id: 'job', kind: 'ticket', projectId: 'project', taskId: 'task', ticketKey: 'FIX-1', threadId: 'owned', messageId: 'initial', state: 'running', reason: 'Claude is executing', createdAt: old, reportPath: join(dir, 'report'), prUrls: [], lastPersonalActivity: null, command: null, completedAt: null };
  const c = { projects: [{ kanvilId: 'project' }], monitoringTimeoutMinutes: 30 } as Config;
  const t3 = { shell: async () => { throw new Error('reconcile must not read T3'); }, dispatch: async () => { throw new Error('reconcile must not stop or launch'); } } as unknown as T3;
  const thread = v2Thread({ id: 'owned', status: 'running', activeRunId: 'run-1' });
  const needsYou = () => store.events().filter(e => e.text === 'FIX-1 needs you').length;
  try {
    store.save(job);
    writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'awaiting-human', reason: 'Choose a layout', prUrls: [] }));
    utimesSync(job.reportPath, asked, asked);
    if (answer === 'structured-input') thread.pendingRuntimeRequest = { kind: 'user_input', createdAt: asked.toISOString() };
    else Object.assign(thread, { status: 'completed', activeRunId: null });
    await reconcile(c, store, t3, {} as Kanvil, [thread], false);
    assert.deepEqual([store.job(job.id)!.state, needsYou()], ['waiting', 1], 'the open question is a human wait');
    // The answer resumes the turn; T3 may not record a structured-input answer as a user message.
    if (answer === 'message') thread.latestUserMessageAt = new Date().toISOString();
    Object.assign(thread, { status: 'running', activeRunId: 'run-2', pendingRuntimeRequest: null });
    if (answer === 'structured-input') await reconcile(c, store, t3, {} as Kanvil, [thread], false);
    Object.assign(thread, { status: 'completed', activeRunId: null, pendingBackgroundTasks: [{ taskId: 'validation', kind: 'command' }] });
    await reconcile(c, store, t3, {} as Kanvil, [thread], false);
    assert.equal(needsYou(), 1, 'the answered report never journals needs you again');
    assert.deepEqual([store.job(job.id)!.state, store.job(job.id)!.reason], ['running', 'Waiting for background commands']);
    writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'awaiting-human', reason: 'Approve the migration', prUrls: [] }));
    // The new report follows the answer even when the filesystem and resume clock share a tick.
    const rewrittenAt = new Date(Math.max(Date.parse(store.job(job.id)!.resumedAt ?? old), Date.parse(thread.latestUserMessageAt ?? old)) + 1000);
    utimesSync(job.reportPath, rewrittenAt, rewrittenAt);
    await reconcile(c, store, t3, {} as Kanvil, [thread], false);
    assert.deepEqual([store.job(job.id)!.state, store.job(job.id)!.reason, needsYou()], ['waiting', 'Approve the migration', 2], 'a new awaiting-human report is a human wait');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a deleted thread dismisses its run; an archived or never-seen thread keeps the slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-deleted-')), store = new Store(dir);
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const base = { kind: 'ticket', projectId: 'project', messageId: 'initial', state: 'running', reason: 'Claude is executing', createdAt: old, prUrls: [], lastPersonalActivity: null, command: null, completedAt: null, reportPath: join(dir, 'none.json') } as const;
  const seen = (id: string) => ({ ...base, id, taskId: id, ticketKey: id, threadId: `${id}-thread`, thread: { title: id, status: 'interrupted', branch: `feat/${id}`, worktreePath: join(dir, id), updatedAt: old, pending: null, background: [] } }) as unknown as Job;
  const unseen = { ...base, id: 'unseen', taskId: 'unseen', ticketKey: 'unseen', threadId: 'unseen-thread' } as unknown as Job;
  const archived = v2Thread({ id: 'archived-thread', status: 'interrupted', updatedAt: old });
  const t3 = { shell: async (includeArchived: boolean) => ({ threads: includeArchived ? [archived] : [] }) } as unknown as T3;
  try {
    for (const job of [seen('deleted'), seen('archived'), unseen]) store.save(job);
    await reconcile({ monitoringTimeoutMinutes: 30 } as Config, store, t3, {} as Kanvil, []);
    const jobs = new Map(store.jobs().map(j => [j.id, j]));
    assert.deepEqual([jobs.get('deleted')!.state, jobs.get('deleted')!.dismissedBranch], ['dismissed', 'feat/deleted']);
    assert.equal(jobs.get('archived')!.state, 'dispatching');
    assert.equal(jobs.get('unseen')!.state, 'dispatching', 'a launch T3 never showed may still land');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
