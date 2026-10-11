import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { personalActivity } from '../src/scheduler.ts';
import { Store, type Job } from '../src/store.ts';
import type { T3 } from '../src/clients.ts';
import { v2Thread } from './v2-fixture.ts';

test('factory initial prompt is excluded, manual validation replies count, Codex is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-factory-activity-'));
  const store = new Store(dir);
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const reply = new Date(Date.now() - 60_000).toISOString();
  const job = { id: 'job', taskId: null, threadId: 'factory', messageId: 'initial', createdAt: start, state: 'waiting', lastPersonalActivity: null } as Job;
  store.save(job);
  const thread = v2Thread({ id: 'factory', updatedAt: start, latestUserMessageAt: start, status: 'waiting', activeRunId: null, pendingRuntimeRequest: { id: 'request', kind: 'user_input', createdAt: start } });
  let answered = false;
  const t3 = { detail: async () => ({ messages: [{ id: 'initial', role: 'user', createdAt: start }], responses: answered ? [{ createdAt: reply }] : [] }) } as unknown as T3;
  try {
    let result = await personalActivity(t3, [thread], store.jobs(), store);
    assert.equal(result.last, '1970-01-01T00:00:00.000Z');
    answered = true; thread.updatedAt = reply;
    result = await personalActivity(t3, [thread], store.jobs(), store);
    assert.equal(result.last, reply);
    const codex = v2Thread({ id: 'codex', providerInstanceId: 'codex-work', modelSelection: { instanceId: 'codex-work', model: 'test' }, latestUserMessageAt: new Date().toISOString(), status: 'running', activeRunId: 'run' });
    const instances = new Map([['codex-work', 'codex'], ['claude-work', 'claudeAgent']]);
    result = await personalActivity(t3, [codex], store.jobs(), store, 30, 'claudeAgent', instances);
    assert.equal(result.last, reply); assert.equal(result.active, false);
    const custom = v2Thread({ ...codex, id: 'custom', providerInstanceId: 'claude-work', modelSelection: { instanceId: 'claude-work', model: 'test' } });
    assert.equal((await personalActivity(t3, [custom], store.jobs(), store, 30, 'claudeAgent', instances)).active, true, 'a custom instance counts for its driver');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('passive personal monitoring uses actual completion time, not polling time or the old inflated cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-factory-idle-')), store = new Store(dir);
  const completed = new Date(Date.now() - 16 * 60_000).toISOString();
  const thread = v2Thread({ id: 'personal', updatedAt: completed, latestUserMessageAt: new Date(Date.now() - 70 * 60_000).toISOString(), status: 'completed', latestRunCompletedAt: completed, pendingBackgroundTasks: [{ taskId: 'pull-request-watch:1', kind: 'monitor' }] });
  const t3 = { detail: async () => ({ messages: [], responses: [] }) } as unknown as T3;
  try {
    store.set('lastPersonalActivity', new Date().toISOString());
    let result = await personalActivity(t3, [thread], [], store);
    assert.equal(result.active, false); assert.equal(result.last, completed);
    assert.ok(result.idleMinutes >= 16 && result.idleMinutes < 17);
    result = await personalActivity(t3, [thread], [], store);
    assert.equal(result.last, completed, 'polling a passive monitor never renews activity');
    result = await personalActivity(t3, [], [], store);
    assert.equal(result.last, completed, 'retain real activity when a thread leaves the snapshot');
    thread.status = 'running'; thread.activeRunId = 'run-2';
    assert.equal((await personalActivity(t3, [thread], [], store)).active, true);
    thread.status = 'completed'; thread.activeRunId = null; thread.pendingBackgroundTasks = [{ taskId: 'bash-1', kind: 'command' }];
    assert.equal((await personalActivity(t3, [thread], [], store)).active, false, 'local commands do not consume a provider turn');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('finished child agents and local wait commands cannot keep renewing personal provider activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-factory-stale-children-')), store = new Store(dir);
  const completed = new Date(Date.now() - 3_600_000).toISOString();
  const parent = v2Thread({ id: 'parent', status: 'completed', activeRunId: null, updatedAt: completed, latestUserMessageAt: completed, latestRunCompletedAt: completed, pendingBackgroundTasks: [{ taskId: 'task-child', kind: 'subagent', childThreadId: 'child' }] });
  const child = v2Thread({ id: 'child', status: 'idle', activeRunId: null, updatedAt: completed, latestUserMessageAt: completed });
  const command = v2Thread({ id: 'wait', status: 'completed', activeRunId: null, updatedAt: completed, latestUserMessageAt: completed, latestRunCompletedAt: completed, pendingBackgroundTasks: [{ taskId: 'command', kind: 'command', description: 'Wait for the suite or PR' }] });
  let response: string | null = null;
  const t3 = { detail: async () => ({ messages: [], responses: response ? [{ createdAt: response }] : [] }) } as unknown as T3;
  try {
    store.set('lastPersonalActivity.v2', new Date().toISOString());
    for (let poll = 0; poll < 2; poll++) {
      const result = await personalActivity(t3, [parent, child, command], [], store);
      assert.equal(result.active, false, 'completed child records and local commands are not active Claude usage');
      assert.equal(result.last, completed, 'discard the old clock inflated by polling and retain actual activity');
      assert.ok(result.idleMinutes >= 60);
    }
    response = new Date(Date.now() - 60_000).toISOString();
    const answered = v2Thread({ id: 'answered', status: 'waiting', activeRunId: null, updatedAt: response, latestUserMessageAt: completed, latestRunCompletedAt: completed, pendingRuntimeRequest: { kind: 'user_input', createdAt: response } });
    store.set('seenPersonal:answered', response);
    assert.equal((await personalActivity(t3, [answered], [], store)).last, response, 'clock migration rereads human answers even when the old cache saw that thread');
    response = null;
    child.updatedAt = new Date().toISOString();
    assert.equal((await personalActivity(t3, [parent, child], [], store)).active, true, 'a fresh native child without a managed run stays protected');
    child.updatedAt = completed;
    child.status = 'running'; child.activeRunId = 'run';
    assert.equal((await personalActivity(t3, [parent, child], [], store)).active, true, 'a child with a live provider run must still block');
    const live = v2Thread({ id: 'live', status: 'running', activeRunId: 'run', updatedAt: completed, latestUserMessageAt: completed });
    assert.equal((await personalActivity(t3, [live], [], store)).active, true, 'a live personal run blocks');
    live.orphanedRun = true;
    assert.equal((await personalActivity(t3, [live], [], store)).active, false, 'a run orphaned by stopped provider sessions does not');
    parent.pendingBackgroundTasks = [{ taskId: 'unknown-child', kind: 'subagent', childThreadId: 'missing' }];
    assert.equal((await personalActivity(t3, [parent], [], store)).active, true, 'unresolved child activity stays protected');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('designated autonomous workflows and their child runs do not block personal idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-factory-autonomous-')), store = new Store(dir);
  const old = new Date(Date.now() - 3_600_000).toISOString(), now = new Date().toISOString();
  const workflow = v2Thread({ id: 'workflow', status: 'running', activeRunId: 'auto-run', updatedAt: now, latestUserMessageAt: now, pendingBackgroundTasks: [{ taskId: 'child-task', kind: 'subagent', childThreadId: 'child' }] });
  const child = v2Thread({ id: 'child', status: 'running', activeRunId: 'child-run', updatedAt: now, latestUserMessageAt: now });
  const lineageChild = v2Thread({ ...child, id: 'lineage-child', lineage: { parentThreadId: 'workflow', relationshipToParent: 'subagent', rootThreadId: 'workflow' } });
  const personal = v2Thread({ id: 'personal', status: 'completed', activeRunId: null, updatedAt: old, latestUserMessageAt: old, latestRunCompletedAt: old });
  const config = { url: 'http://localhost', credentialFile: '/unused', autonomousThreadIds: [] as string[] };
  const details: string[] = [];
  const t3 = { config, detail: async (id: string) => { details.push(id); return { messages: [], responses: [] }; } } as unknown as T3;
  try {
    const threads = [workflow, child, lineageChild, personal];
    assert.equal((await personalActivity(t3, threads, [], store)).active, true);
    config.autonomousThreadIds = ['workflow']; details.length = 0;
    for (let poll = 0; poll < 2; poll++) {
      const result = await personalActivity(t3, threads, [], store);
      assert.equal(result.active, false, 'autonomous workflow execution is not personal activity');
      assert.equal(result.last, old, 'changing the designation discards its previously inflated clock');
    }
    assert.ok(!details.includes('workflow') && !details.includes('child') && !details.includes('lineage-child'), 'autonomous messages and responses cannot restart the idle timer');
    const fork = v2Thread({ ...lineageChild, id: 'personal-fork', lineage: { parentThreadId: 'workflow', relationshipToParent: 'fork', rootThreadId: 'workflow' } });
    assert.equal((await personalActivity(t3, [...threads, fork], [], store)).active, true, 'a separate personal fork is not an autonomous child');
    personal.status = 'running'; personal.activeRunId = 'personal-run';
    assert.equal((await personalActivity(t3, [workflow, child, personal], [], store)).active, true, 'interactive work still blocks');
    personal.status = 'completed'; personal.activeRunId = null; config.autonomousThreadIds = [];
    assert.equal((await personalActivity(t3, [workflow, child, personal], [], store)).active, true, 'removing the designation restores normal activity checks');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
