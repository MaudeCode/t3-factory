import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketDetail } from '../src/ticket-detail.ts';
import { KanvilTaskNotFound } from '../src/clients.ts';

const config = { kanvil: { url: 'https://tracker.example/' }, projects: [{ key: 'APP', kanvilId: 'p-app' }] } as never;
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id, projectId: 'p-app', key: id.toUpperCase(), number: 1, title: `Title of ${id}`, description: 'Body', priority: 'high', status: 'todo', createdAt: '2026-01-01T00:00:00Z',
  labels: [{ name: 'feat' }], difficulty: 'med', automationReady: false, holdReason: 'On hold', kind: 'feature', scopes: ['web'], epicId: 'e1',
  acceptanceCriteria: '- one', readiness: { ready: false, reasons: [{ code: 'hold', message: 'Ticket is on hold' }] },
  // Tracker rows carry more than the browser should see.
  version: 7, assigneeId: 'person-1', createdBy: 'person-2', claim: { workerId: 'w' }, customFields: { secret: 'value' }, ...extra,
});
function tracker() {
  const reads: string[] = [];
  const tasks: Record<string, ReturnType<typeof task>> = { 'APP-1': task('app-1'), 'app-1': task('app-1'), blocker: task('blocker', { key: 'APP-2', status: 'done' }), dependent: task('dependent', { key: 'APP-3' }), elsewhere: task('elsewhere', { key: 'LIB-7', projectId: 'p-lib' }) };
  return {
    reads,
    task: async (id: string) => { reads.push(id); if (id === 'hidden') throw new Error('Kanvil request failed (HTTP 403, forbidden)'); if (!tasks[id]) throw new KanvilTaskNotFound('missing'); return tasks[id]; },
    relations: async () => [
      { sourceTaskId: 'blocker', targetTaskId: 'app-1', relationType: 'blocks' }, { sourceTaskId: 'hidden', targetTaskId: 'app-1', relationType: 'blocks' },
      { sourceTaskId: 'app-1', targetTaskId: 'dependent', relationType: 'blocks' }, { sourceTaskId: 'app-1', targetTaskId: 'elsewhere', relationType: 'blocks' }, { sourceTaskId: 'app-1', targetTaskId: 'other', relationType: 'related' },
    ],
    epics: async () => [{ id: 'e1', workspaceId: 'w', title: 'Epic one', archived: false }],
  } as never;
}

// Left out: a blocker the tracker refuses to show, a dependent in a project Factory is not configured for, and a non-blocking relation.
test('a ticket read returns only the allowlisted fields, with its readable blockers, dependents and Epic', async () => {
  const detail = await ticketDetail(config, tracker(), 'app-1');
  assert.deepEqual(detail, {
    id: 'app-1', projectId: 'p-app', inbox: false, key: 'APP-1', title: 'Title of app-1', status: 'todo', priority: 'high', difficulty: 'med', kind: 'feature', labels: ['feat'], scopes: ['web'],
    description: 'Body', acceptanceCriteria: '- one', automationReady: false, holdReason: 'On hold', readiness: ['Ticket is on hold'],
    blockedBy: [{ key: 'APP-2', title: 'Title of blocker', done: true }], blocks: [{ key: 'APP-3', title: 'Title of dependent', done: false }],
    epic: 'Epic one', createdAt: '2026-01-01T00:00:00Z', url: 'https://tracker.example/projects/p-app/tickets/app-1',
  });
});

test('a key outside the configured projects, a malformed key and a missing ticket are all not found', async () => {
  const kanvil = tracker();
  assert.equal(await ticketDetail(config, kanvil, 'LIB-1'), null);
  assert.equal(await ticketDetail(config, kanvil, 'APP'), null);
  assert.equal(await ticketDetail(config, kanvil, '../APP-1'), null);
  assert.deepEqual((kanvil as { reads: string[] }).reads, [], 'none of them reaches the tracker');
  assert.equal(await ticketDetail(config, kanvil, 'APP-9'), null);
});

test('a report in a configured inbox is read and marked; a key that resolves outside Factory is not found', async () => {
  const withInbox = { kanvil: { url: 'https://tracker.example/' }, projects: [{ key: 'APP', kanvilId: 'p-app', inbox: { kanvilId: 'p-in' } }] } as never;
  const kanvil = {
    task: async (id: string) => { if (id === 'IN-1') return task('in-1', { key: 'IN-1', projectId: 'p-in', epicId: undefined }); if (id === 'LIB-1') return task('lib-1', { key: 'LIB-1', projectId: 'p-lib' }); throw new KanvilTaskNotFound('missing'); },
    relations: async () => [], epics: async () => [],
  } as never;
  const report = await ticketDetail(withInbox, kanvil, 'in-1');
  assert.deepEqual([report?.key, report?.inbox, report?.projectId], ['IN-1', true, 'p-in']);
  assert.equal(await ticketDetail(withInbox, kanvil, 'LIB-1'), null);
});
