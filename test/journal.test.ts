import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, decisionText, type Job } from '../src/store.ts';

const job = (over: Partial<Job> = {}): Job => ({
  id: '11111111-1111-4111-8111-111111111111', kind: 'ticket', projectId: 'p', taskId: 't', ticketKey: 'APP-1', threadId: 'th', messageId: 'm',
  createdAt: '2026-01-01T00:00:00.000Z', state: 'dispatching', reason: 'Dispatch prepared', lastPersonalActivity: null, reportPath: '/tmp/none.json', command: null,
  prUrls: [], completedAt: null, modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [] }, providerDriver: 'claudeAgent', ...over,
});

test('every job write journals creation, state changes, and delivered pull requests once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-journal-'));
  try {
    const store = new Store(dir);
    store.save(job());
    store.save(job({ reason: 'T3 accepted dispatch' })); // same state: no event
    store.save(job({ state: 'running', reason: 'Claude is executing' }));
    store.save(job({ state: 'running', prUrls: ['https://github.com/org/repo/pull/7'] }));
    store.save(job({ state: 'complete', prUrls: ['https://github.com/org/repo/pull/7'], reason: 'Merged.' }));
    const events = store.events(10).toReversed();
    assert.deepEqual(events.map(e => [e.kind, e.text]), [
      ['job.created', 'APP-1 started on claude-opus-5-5'],
      ['job.state', 'APP-1 is running'],
      ['job.pr', 'APP-1 opened org/repo/pull/7'],
      ['job.state', 'APP-1 finished'],
    ]);
    assert.equal(events.at(-1)!.data.reason, 'Merged.');
    assert.equal(store.events(10, job().id).length, 4);
    assert.equal(store.job(job().id)?.state, 'complete');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('decisions are journaled only when their outcome changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-journal-'));
  try {
    const store = new Store(dir);
    const quiet = { reason: 'no-eligible-ticket', at: '2026-01-01T00:00:00.000Z', streams: [{ provider: 'Claude', reason: 'waiting-for-idle' }, { provider: 'Codex', reason: 'provider-disabled' }] };
    store.decide(quiet); store.decide({ ...quiet, at: '2026-01-01T00:01:00.000Z' }); store.decide({ ...quiet, at: '2026-01-01T00:02:00.000Z' });
    store.decide({ reason: 'dispatched', at: '2026-01-01T00:03:00.000Z', ticket: 'APP-2', model: 'gpt-6-astra' });
    store.decide({ reason: 'dispatched', at: '2026-01-01T00:04:00.000Z', ticket: 'APP-3', model: 'gpt-6-astra' });
    store.decide({ reason: 'error', at: '2026-01-01T00:05:00.000Z', message: 'T3 unreachable' });
    assert.deepEqual(store.events(10).toReversed().map(e => e.text), [
      'Claude waiting for idle time; Codex automatic starts off',
      'Check failed: T3 unreachable',
    ], 'dispatches are journaled by the job they create, not again as a check');
    assert.equal(JSON.parse(store.get('lastDecision')!).reason, 'error');
    assert.equal(decisionText({ reason: 'disabled' }), 'Automation paused');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
