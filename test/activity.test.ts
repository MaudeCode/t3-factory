import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { personalActivity } from '../src/scheduler.ts';
import { Store, type Job } from '../src/store.ts';
import type { T3 } from '../src/clients.ts';
import type { Thread } from '../src/policy.ts';

test('factory initial prompt is excluded, manual validation replies count, Codex is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-factory-activity-'));
  const store = new Store(dir);
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const reply = new Date(Date.now() - 60_000).toISOString();
  const job = { id: 'job', taskId: null, threadId: 'factory', messageId: 'initial', createdAt: start, state: 'waiting', lastPersonalActivity: null } as Job;
  store.save(job);
  const thread = { id: 'factory', updatedAt: start, latestUserMessageAt: start, session: { status: 'running', providerName: 'claudeAgent' }, modelSelection: { instanceId: 'claudeAgent' }, hasPendingUserInput: true, hasPendingApprovals: false } as Thread;
  let answered = false;
  const t3 = { detail: async () => ({ messages: [{ id: 'initial', role: 'user', createdAt: start }], activities: answered ? [{ kind: 'user-input.resolved', createdAt: reply }] : [] }) } as unknown as T3;
  try {
    let result = await personalActivity(t3, [thread], store.jobs(), store);
    assert.equal(result.last, '1970-01-01T00:00:00.000Z');
    answered = true; thread.updatedAt = reply;
    result = await personalActivity(t3, [thread], store.jobs(), store);
    assert.equal(result.last, reply);
    const codex = { ...thread, id: 'codex', session: { ...thread.session!, providerName: 'codex' }, modelSelection: { instanceId: 'codex', model: 'test' }, latestUserMessageAt: new Date().toISOString(), hasPendingUserInput: false };
    result = await personalActivity(t3, [codex], store.jobs(), store);
    assert.equal(result.last, reply); assert.equal(result.active, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('passive personal monitoring uses actual completion time, not polling time or the old inflated cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-factory-idle-')), store = new Store(dir);
  const completed = new Date(Date.now() - 16 * 60_000).toISOString();
  const thread = { id: 'personal', modelSelection: { instanceId: 'claudeAgent' }, updatedAt: completed, latestUserMessageAt: new Date(Date.now() - 70 * 60_000).toISOString(), session: { status: 'ready', providerName: 'claudeAgent', updatedAt: completed }, latestTurn: { state: 'completed', completedAt: completed }, backgroundLiveness: 'monitoring', hasPendingUserInput: false, hasPendingApprovals: false } as Thread;
  const t3 = { detail: async () => ({ messages: [], activities: [] }) } as unknown as T3;
  try {
    store.set('lastPersonalActivity', new Date().toISOString());
    let result = await personalActivity(t3, [thread], [], store);
    assert.equal(result.active, false); assert.equal(result.last, completed);
    assert.ok(result.idleMinutes >= 16 && result.idleMinutes < 17);
    result = await personalActivity(t3, [thread], [], store);
    assert.equal(result.last, completed, 'polling a passive monitor never renews activity');
    result = await personalActivity(t3, [], [], store);
    assert.equal(result.last, completed, 'retain real activity when a thread leaves the snapshot');
    thread.session!.status = 'running'; thread.latestTurn!.state = 'running';
    assert.equal((await personalActivity(t3, [thread], [], store)).active, true);
    thread.session!.status = 'ready'; thread.latestTurn!.state = 'completed'; thread.backgroundLiveness = 'working';
    assert.equal((await personalActivity(t3, [thread], [], store)).active, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
