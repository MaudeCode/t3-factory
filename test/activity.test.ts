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
    assert.equal((await personalActivity(t3, [thread], [], store)).active, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
