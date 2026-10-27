import test from 'node:test';
import assert from 'node:assert/strict';
import { inventory, upNext, blockerTree } from '../src/scheduler.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

test('queue projections retain actual labels and metadata for ready, dependency-projected and held tickets', async t => {
  const f = dispatchFixture(t);
  f.tasks[1].status = 'todo';
  f.tasks[1].priority = 'low';
  f.tasks[1].labels!.push({ name: 'blocker-only' });
  f.tasks[0].labels!.push({ name: 'root-only' });
  f.tasks.push({ ...f.task('held', 3, 'todo'), labels: [{ name: 'sf' }, { name: 'bug' }] });
  const queue = await inventory(f.c, f.kanvil, [], [], f.store);
  const result = upNext(f.c, f.store, queue);
  const root = result.tickets.find(t => t.id === 'root')!;
  const blocker = result.tickets.find(t => t.id === 'blocker')!;
  assert.deepEqual(root.labels, ['sf', 'med', 'root-only'], 'projected tickets retain their own actual tags');
  assert.deepEqual(blocker.labels, ['sf', 'med', 'blocker-only']);
  assert.equal(blocker.priority, 'high', 'effective queue priority still inherits');
  assert.deepEqual(result.held.map(h => [h.key, h.projectId, h.priority, h.labels, h.difficulty]), [['FIX-3', 'FIX', 'high', ['sf', 'bug'], undefined]], 'held tickets carry metadata even without a difficulty label');
});

test('run snapshots retain freshly validated ticket labels and priority across storage', async t => {
  const f = dispatchFixture(t);
  f.hooks.read = async (name, _id, final) => {
    if (final && name === 'ticket' && _id === 'root') {
      f.tasks[0].priority = 'urgent';
      f.tasks[0].labels!.push({ name: 'fresh' });
    }
  };
  assert.equal((await f.run()).reason, 'dispatched');
  const job = f.store.jobs()[0];
  assert.equal(job.priority, 'urgent', 'snapshot uses final tracker read rather than stale inventory priority');
  assert.deepEqual(job.labels, ['sf', 'med', 'fresh'], 'snapshot uses complete associated labels from final validation');
});


test('ticket projections preserve native automation readiness independently of labels', async t => {
  const f = dispatchFixture(t);
  f.tasks[0].automationReady = true;
  f.tasks[1].status = 'todo';
  f.tasks[1].automationReady = true;
  f.tasks.push({ ...f.task('held', 3, 'todo'), automationReady: true, labels: [{ name: 'sf' }] });
  const result = upNext(f.c, f.store, await inventory(f.c, f.kanvil, [], [], f.store));
  assert.equal(result.tickets.find(t => t.id === 'root')?.automationReady, true, 'projected dependency ticket retains native readiness');
  assert.equal(result.tickets.find(t => t.id === 'blocker')?.automationReady, true, 'ready queue ticket retains native readiness');
  assert.equal(result.held.find(t => t.key === 'FIX-3')?.automationReady, true, 'held tickets retain native content readiness independently of eligibility');
  const notReady = upNext(f.c, f.store, { ready: [], skipped: [{ key: 'FIX-4', reason: 'held', ticket: { id: 'not-ready', key: 'FIX-4', projectId: 'FIX', priority: 'high', createdAt: '2026-01-01', labels: [{ name: 'sf' }], automationReady: false } }] });
  assert.equal(notReady.held[0].automationReady, false, 'sf label cannot make a native false ticket automation ready');
  const tree = await blockerTree(f.c, f.kanvil, 'root');
  assert.equal(tree.target.automationReady, true);
  assert.equal(tree.tickets[0].automationReady, true, 'dependency details retain native readiness');
});
