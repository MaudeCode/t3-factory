import test from 'node:test';
import assert from 'node:assert/strict';
import { Kaneo, listTasks } from '../src/clients.ts';

const task = { id: 'task', projectId: 'project', title: 'Fixture', number: 1, status: 'to-do', priority: 'high', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'app' }, { name: 'med' }, { name: 'contracts' }] };
const kaneo = () => new Kaneo({ url: 'https://tracker.example.test', workspaceId: 'workspace', readyLabel: 'sf' });
const label = (name: string, taskId: string | null = 'task') => ({ name, taskId, workspaceId: 'workspace', deletionStartedAt: null });

test('readiness and difficulty use full associated labels, not a capped task-list preview', async t => {
  const k = kaneo();
  let labels: {name: string; taskId: string | null; workspaceId: string; deletionStartedAt: string | null}[] = ['sec', 'high', 'app', 'web', 'contracts', 'sf'].map(n => label(n));
  t.mock.method(k, 'call', async (name: string) => {
    if (name === 'list_workspace_labels') return labels;
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: [task] }] }, pagination: { totalPages: 1, total: 1 } };
    throw new Error(name);
  });
  assert.deepEqual((await listTasks(k, 'project'))[0].labels?.map(l => l.name), ['sec', 'high', 'app', 'web', 'contracts', 'sf']);
  labels = [label('sf', null), label('sf', 'other-task'), label('high'), { ...label('sf'), deletionStartedAt: '2026-01-02T00:00:00Z' }];
  assert.deepEqual((await listTasks(k, 'project'))[0].labels?.map(l => l.name), ['high'], 'templates, another task, pending deletions, and stale previews cannot confer readiness');
});

test('label read failures and cross-workspace data fail closed', async t => {
  const k = kaneo();
  let response: unknown = [];
  let unavailable = false;
  t.mock.method(k, 'call', async (name: string) => {
    if (name === 'list_workspace_labels') { if (unavailable) throw new Error('Label service unavailable'); return response; }
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: [task] }] }, pagination: { totalPages: 1, total: 1 } };
    throw new Error(name);
  });
  response = [{ ...label('sf'), workspaceId: 'another-workspace' }];
  await assert.rejects(listTasks(k, 'project'), /workspace/i);
  response = [{ name: 'sf' }];
  await assert.rejects(listTasks(k, 'project'));
  unavailable = true;
  await assert.rejects(listTasks(k, 'project'), /Label service unavailable/);
});
