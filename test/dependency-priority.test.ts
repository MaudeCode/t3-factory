import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { configSchema } from '../src/config.ts';
import { Kaneo, type Task } from '../src/clients.ts';
import { Store } from '../src/store.ts';
import { inventory } from '../src/scheduler.ts';
import { dispatchFixture, deferred } from './dispatch-fixture.ts';

test('blockers inherit downstream label rank and urgency without weakening eligibility', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-dependency-priority-')), repo = join(dir, 'repo');
  mkdirSync(repo); execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const input = parse(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8'));
  input.stateDir = join(dir, 'state'); input.projects[0].repoPath = repo;
  input.projects[0].priorityLabels = ['compatibility', 'security'];
  input.projects[0].readyStatuses = ['to-do'];
  const c = configSchema.parse(input), p = c.projects[0];
  const other = { ...p, key: 'LIB', name: 'Library', kaneoId: 'library', t3Id: 'library', priorityLabels: ['security'] };
  c.projects.push(other);
  const task = (number: number, priority: Task['priority'], names: string[] = []): Task => ({ id: `task-${number}`, projectId: p.kaneoId, number, title: 'Fixture', status: 'to-do', priority, createdAt: '2026-01-01', labels: ['sf', 'med', ...names].map(name => ({ name })) });
  const tasks = [task(19, 'low'), task(20, 'urgent', ['compatibility']), task(21, 'urgent'), task(22, 'high', ['security']), task(18, 'low')];
  const blocks = (source: number, target: number) => ({ sourceTaskId: `task-${source}`, targetTaskId: `task-${target}`, relationType: 'blocks' });
  let relations = [blocks(19, 20)];
  const k = new Kaneo(c.kaneo), store = new Store(c.stateDir), reads = new Map<string, number>();
  const listed: Record<string, unknown>[] = [], fetched: string[] = [];
  let unavailableProject = '';
  t.mock.method(k, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels!.map(label => ({ ...label, taskId: task.id, workspaceId: c.kaneo.workspaceId })));
    if (name === 'list_tasks') {
      listed.push(args);
      if (args.projectId === unavailableProject) throw new Error('Unrelated project unavailable');
      const matching = tasks.filter(task => task.projectId === args.projectId && (!args.status || task.status === args.status));
      const page = Number(args.page);
      return { data: { workspaceId: c.kaneo.workspaceId, columns: [{ tasks: matching.slice((page - 1) * 2, page * 2) }] }, pagination: { total: matching.length, totalPages: Math.ceil(matching.length / 2) } };
    }
    if (name === 'get_task') {
      fetched.push(String(args.taskId));
      const { labels, ...task } = tasks.find(task => task.id === args.taskId)!;
      return task; // Single-task responses omit labels.
    }
    if (name === 'list_project_columns') return [{ slug: 'done', isFinal: true }];
    if (name === 'get_task_relations') { const id = String(args.taskId); reads.set(id, (reads.get(id) ?? 0) + 1); return relations.filter(r => r.sourceTaskId === id || r.targetTaskId === id); }
    throw new Error(name);
  });
  const queue = (key?: string) => { reads.clear(); listed.length = 0; fetched.length = 0; return inventory(c, k, [], [], store, key); };
  try {
    await t.test('named-ticket inventory lists only its project across every page and ignores unrelated listing failures', async () => {
      let q = await queue(`${p.key}-18`);
      assert.equal(q.selected?.key, `${p.key}-18`, 'the requested ticket on the last page is found');
      assert.deepEqual(listed.map(a => [a.projectId, a.status, a.page]), [[p.kaneoId, undefined, 1], [p.kaneoId, undefined, 2], [p.kaneoId, undefined, 3]], 'named inventory must not list unrelated projects');
      unavailableProject = other.kaneoId;
      try { q = await queue(`${p.key}-18`); assert.equal(q.selected?.key, `${p.key}-18`); }
      finally { unavailableProject = ''; }
      q = await queue();
      assert.deepEqual([...new Set(listed.map(a => a.projectId))].sort(), [p.kaneoId, other.kaneoId].sort(), 'unnamed inventory still lists every enabled project');
      assert(listed.every(a => a.status === 'to-do'), 'unnamed inventory reads ready columns only');
      assert.equal(q.selected?.key, `${p.key}-19`, 'full-queue priority ordering is preserved');
    });
    let q = await queue();
    assert.equal(q.selected?.key, `${p.key}-19`, 'unlabeled prerequisite beats both ranked and ordinary work');
    assert.equal(q.selected?.labelRank, 0); assert.equal(q.selected?.priority, 'urgent');
    assert(q.skipped.some(s => s.key === `${p.key}-20` && /blocker/.test(s.reason)));
    assert.equal(tasks[0].priority, 'low'); assert(!tasks[0].labels!.some(l => l.name === 'compatibility'), 'tracker fields stay unchanged');
    p.priorityLabels = [];
    q = await queue(); assert.equal(q.ready.find(t => t.id === 'task-19')?.priority, 'urgent', 'urgency alone is inherited without label preferences');
    p.priorityLabels = ['compatibility', 'security'];

    relations.push(blocks(18, 19));
    q = await queue();
    assert.equal(q.selected?.key, `${p.key}-18`, 'inheritance reaches the first runnable ticket in a chain');
    assert.equal(q.selected?.labelRank, 0); assert.equal(q.selected?.priority, 'urgent');
    assert([...reads.values()].every(n => n === 1), 'each relation snapshot is fetched once per inventory');

    relations = [blocks(19, 20), blocks(19, 22)];
    tasks[1].priority = 'low';
    q = await queue();
    assert.equal(q.ready.find(t => t.id === 'task-19')?.priority, 'low', 'highest label tier wins as a pair; urgency from a lower tier is not combined');
    tasks[1].status = 'done';
    q = await queue();
    assert.equal(q.ready.find(t => t.id === 'task-19')?.labelRank, 1, 'done dependents no longer boost blockers');
    tasks[0].labels!.push({ name: 'compatibility' }); tasks[0].priority = 'urgent';
    q = await queue();
    assert.equal(q.selected?.priority, 'urgent'); assert.equal(q.selected?.labelRank, 0, 'inheritance cannot demote own priority');
    tasks[0].labels = [{ name: 'sf' }, { name: 'med' }]; tasks[0].priority = 'low';

    tasks[1].status = 'to-do'; tasks[1].projectId = other.kaneoId; tasks[1].labels = [{ name: 'security' }]; tasks[1].priority = 'urgent';
    q = await queue();
    assert.equal(q.selected?.key, `${p.key}-19`, 'open dependents can boost a blocker across enabled projects even before readiness/classification');
    assert.equal(q.selected?.labelRank, 0);
    await t.test('named-ticket priority uses complete labels for dependents fetched outside ready columns', async () => {
      tasks[1].status = 'in-progress';
      try {
        const named = await queue(`${p.key}-19`);
        assert.equal(named.selected?.labelRank, 0, 'lazy cross-project reads must retain the associated security label');
        assert.equal(named.selected?.priority, 'urgent');
        assert.deepEqual(fetched, ['task-20']);
      } finally { tasks[1].status = 'to-do'; }
    });
    await t.test('named-ticket dependencies still block across projects and unconfigured final statuses', async () => {
      const saved = relations;
      try {
        for (const projectId of [other.kaneoId, 'external']) {
          tasks[1].projectId = projectId;
          for (const edges of [
            [blocks(20, 19)],
            [{ sourceTaskId: 'task-19', targetTaskId: 'task-20', relationType: 'subtask' }],
            [{ sourceTaskId: 'task-20', targetTaskId: 'task-19', relationType: 'subtask' }, blocks(21, 20)],
            [{ sourceTaskId: 'task-20', targetTaskId: 'task-19', relationType: 'subtask' }, { sourceTaskId: 'task-19', targetTaskId: 'task-20', relationType: 'subtask' }],
          ]) {
            relations = edges;
            const blocked = await queue(`${p.key}-19`);
            assert.equal(blocked.ready.length, 0, 'blockers, children, ancestor blockers and cycles remain ineligible');
            assert(blocked.skipped.some(s => /blocker|children|cycle/.test(s.reason)));
            assert(fetched.includes('task-20') || reads.has('task-20'), 'cross-project dependencies are read by ID');
          }
          relations = [blocks(20, 19)]; tasks[1].status = 'done';
          assert.equal((await queue(`${p.key}-19`)).selected?.key, `${p.key}-19`, 'configured and discovered final statuses release blockers');
          tasks[1].status = 'to-do';
        }
      } finally { relations = saved; tasks[1].projectId = other.kaneoId; tasks[1].status = 'to-do'; }
    });
    other.enabled = false;
    q = await queue();
    assert.equal(q.ready.find(t => t.id === 'task-19')?.labelRank, 1, 'disabled projects do not contribute priority');
    other.enabled = true;
    tasks[0].labels = [{ name: 'med' }];
    q = await queue(); assert(!q.ready.some(t => t.id === 'task-19'), 'inheritance cannot grant readiness');
    tasks[0].labels = [{ name: 'sf' }];
    q = await queue(); assert(!q.ready.some(t => t.id === 'task-19'), 'inheritance cannot grant classification');
    tasks[0].labels = [{ name: 'sf' }, { name: 'med' }];
    relations = [blocks(19, 20), blocks(20, 19)];
    q = await queue(); assert(!q.ready.some(t => ['task-19', 'task-20'].includes(t.id)), 'cycles remain blocked');
    relations.push(blocks(18, 19));
    q = await queue(); assert.equal(q.selected?.key, `${p.key}-18`, 'downstream cycles terminate during priority traversal');
    relations = [];
    q = await queue(); assert.equal(q.ready.find(t => t.id === 'task-19')?.labelRank, undefined, 'removed dependencies clear inherited priority on the next snapshot');
  } finally { store.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

test('inventory dependency fan-out and priority traversal share the six-read bound', async t => {
  const f = dispatchFixture(t), release = deferred(), started = deferred();
  f.tasks.push(f.task('second', 3, 'to-do'), f.task('inherited', 4, 'in-progress'));
  f.relations.splice(0, 1, { sourceTaskId: 'root', targetTaskId: 'inherited', relationType: 'blocks' });
  for (let n = 0; n < 12; n++) { const id = `dep-${n}`; f.tasks.push(f.task(id, n + 10)); f.relations.push({ sourceTaskId: id, targetTaskId: 'second', relationType: 'blocks' }); }
  let active = 0, maximum = 0;
  f.hooks.read = async name => {
    if (name !== 'get_task') return;
    active++; maximum = Math.max(maximum, active); started.resolve();
    await release.promise; active--;
  };
  const pending = inventory(f.c, f.kaneo, [], [], f.store); await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  const simultaneous = active;
  release.resolve(); assert.equal((await pending).ready.length, 2);
  assert.equal(simultaneous, 6); assert.equal(maximum, 6);
});
