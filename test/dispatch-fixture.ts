import { mockTracker } from './tracker-fixture.ts';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.ts';
import { T3, Kanvil, type Task } from '../src/clients.ts';
import { Store } from '../src/store.ts';
import { cycle } from '../src/scheduler.ts';
import { FactoryService } from '../src/service.ts';
import type { Thread } from '../src/policy.ts';

export const deferred = <T = void>() => Promise.withResolvers<T>();
export function mockLaunchConnection(t: TestContext, target: T3 = T3.prototype) {
  if (!('prepareLaunch' in target)) return;
  t.mock.method(target, 'prepareLaunch', async function(this: T3) { return { check: () => {}, launch: (command: unknown) => this.launch(command), close: async () => {} }; });
}
// Shared synthetic dispatch setup for read ordering, freshness, failures, and quota probes.
export function dispatchFixture(t: TestContext) {
  const beforeClose: (() => void | Promise<void>)[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'factory-reads-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'prs'), '[]');
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncat '${join(dir, 'prs')}'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH, oldConfig = process.env.T3_FACTORY_CONFIG;
  process.env.PATH = `${dir}:${oldPath}`; process.env.T3_FACTORY_CONFIG = join(dir, 'config.jsonc');
  writeFileSync(join(dir, 'skill'), '# Software factory');
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: true, pollSeconds: 60, idleMinutes: 1, maxWaitingPRs: null, runtimeMode: 'full-access',
    discovery: { promptFile: join(dir, 'skill'), emptyCooldownHours: 24 },
    models: [{ id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'fixture-sol' }, automatic: true, maxDifficulty: 'high' }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    stateDir: join(dir, 'state'), t3: { url: 'http://localhost', credentialFile: join(dir, 'unused') },
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
  });
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  const task = (id: string, number: number, status = 'done'): Task => ({ id, number, projectId: 'FIX', title: 'Fixture', priority: 'high', status, createdAt: '2026-01-01', labels: [{ name: 'sf' }, { name: 'med' }] });
  const tasks = [task('root', 1, 'todo'), task('blocker', 2)];
  const relations = [{ sourceTaskId: 'blocker', targetTaskId: 'root', relationType: 'blocks' }];
  const threads: Thread[] = [], calls: string[] = [], launches: unknown[] = [];
  const store = new Store(c.stateDir), t3 = new T3(c.t3), kanvil = new Kanvil(c.kanvil);
  mockLaunchConnection(t, t3);
  const hooks = {
    shell: async (_final: boolean) => {}, providers: async () => {},
    quota: async (_refresh: boolean) => {}, read: async (_name: string, _id: string, _final: boolean) => {},
  };
  let shellReads = 0, labelReads = 0;
  let final = false;
  t.mock.method(t3, 'shell', async () => { const isFinal = ++shellReads > 1; if (isFinal) final = true; calls.push(`shell:${isFinal}`); await hooks.shell(isFinal); return { threads: [...threads], projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })) }; });
  const provider = () => ({ instanceId: 'codex', driver: 'codex', status: 'ready', installed: true, enabled: true, models: [{ slug: 'fixture-sol' }], usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: [{ id: 'primary', usedPercent: 0, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] } });
  t.mock.method(t3, 'providers', async () => { calls.push('providers'); await hooks.providers(); return [provider()]; });
  t.mock.method(t3, 'provider', async (_id: string, refresh: boolean) => { calls.push(`quota:${refresh}`); await hooks.quota(refresh); return provider(); });
  t.mock.method(t3, 'launch', async (command: unknown) => { assert.equal(store.jobs().find(job => job.threadId === (command as { threadId: string }).threadId)?.state, 'dispatching', 'durable ownership precedes launch'); launches.push(command); return {}; });
  mockTracker(t, kanvil, async (name: string, args: Record<string, unknown>) => {
    const id = String(args.taskId ?? '');
    const isFinal = name === 'labels' ? ++labelReads > 1 : final;
    calls.push(`${name}:${id}:${isFinal}`); await hooks.read(name, id, isFinal);
    if (name === 'labels') return tasks.flatMap(t => t.labels!.map(l => ({ ...l, taskId: t.id, workspaceId: 'workspace' })));
    if (name === 'tickets') return { data: { workspaceId: 'workspace', columns: [{ tasks: structuredClone(tasks.filter(t => t.projectId === args.projectId && (!args.status || t.status === args.status))) }] }, pagination: { totalPages: 1, total: tasks.length } };
    if (name === 'ticket') { const { labels, ...found } = tasks.find(t => t.id === id)!; return structuredClone(found); }
    if (name === 'relations') return structuredClone(relations.filter(r => r.sourceTaskId === id || r.targetTaskId === id));
    if (name === 'columns') return [{ slug: 'done', isFinal: true }];
    throw new Error(name);
  });
  t.after(async () => { for (const close of beforeClose) await close(); store.close(); process.env.PATH = oldPath; if (oldConfig === undefined) delete process.env.T3_FACTORY_CONFIG; else process.env.T3_FACTORY_CONFIG = oldConfig; rmSync(dir, { recursive: true, force: true }); });
  return { c, dir, store, t3, kanvil, calls, hooks, tasks, task, relations, threads, launches, provider, beforeClose,
    run: (model = 'sol', manual = true) => cycle(c, store, manual ? { manual: true, model, ticket: 'FIX-1' } : {}, { t3, kanvil }),
  };
}

export function serviceFixture(t: TestContext) {
  const f = dispatchFixture(t), service = new FactoryService(process.env.T3_FACTORY_CONFIG!), internal = service as any;
  Object.assign(internal, { store: f.store, stateDir: f.c.stateDir, t3: f.t3, kanvil: Promise.resolve(f.kanvil), t3Settings: JSON.stringify(f.c.t3), kanvilSettings: JSON.stringify(f.c.kanvil) });
  for (const method of ['scheduleCleanup', 'scheduleCollection', 'scheduleInventory']) t.mock.method(internal, method, () => {});
  f.beforeClose.push(async () => {
    if ('idle' in internal) await service.stop();
    else { internal.stopped = true; clearTimeout(internal.timer); await internal.queue; }
  });
  return { ...f, service, internal };
}
