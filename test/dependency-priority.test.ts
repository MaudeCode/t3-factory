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
  t.mock.method(k, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels!.map(label => ({ ...label, taskId: task.id, workspaceId: c.kaneo.workspaceId })));
    if (name === 'list_tasks') return { data: { workspaceId: c.kaneo.workspaceId, columns: [{ tasks: tasks.filter(task => task.projectId === args.projectId) }] }, pagination: { total: tasks.length, totalPages: 1 } };
    if (name === 'get_task_relations') { const id = String(args.taskId); reads.set(id, (reads.get(id) ?? 0) + 1); return relations.filter(r => r.sourceTaskId === id || r.targetTaskId === id); }
    throw new Error(name);
  });
  const queue = () => { reads.clear(); return inventory(c, k, [], [], store); };
  try {
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
