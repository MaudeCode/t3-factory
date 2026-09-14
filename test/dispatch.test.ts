import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, type Config } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle } from '../src/scheduler.ts';
import type { Thread } from '../src/policy.ts';

for (const scenario of ['both', 'codex-busy', 'claude-waiting', 'codex-exhausted', 'codex-offline', 'refresh-exhausted', 'ambiguous', 'unclassified', 'ceiling', 'discovery'] as const) {
  test(`provider streams: ${scenario}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-streams-')), repo = join(dir, 'repo'); mkdirSync(repo);
    execFileSync('/usr/bin/git', ['init', '-q', repo]);
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
    const oldPath = process.env.PATH, oldConfig = process.env.T3_FACTORY_CONFIG;
    process.env.PATH = `${dir}:${oldPath}`; process.env.T3_FACTORY_CONFIG = join(dir, 'config.jsonc');
    writeFileSync(join(dir, 'discovery.md'), 'Discover and validate useful work.');
    const budget = { reservePercent: 0, minRemainingPercent: 0 };
    const preset = (id: string, provider: string, model: string) => ({ id, name: id, model: { instanceId: provider, model }, automatic: true, maxDifficulty: 'high' });
    const project = (id: string) => ({ name: id, key: id, enabled: true, kaneoId: id, t3Id: id, repoPath: repo, githubRepo: `fixture/${id}`, baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] });
    const c = configSchema.parse({ enabled: true, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
      models: [preset('astra', 'codex', 'gpt-6-astra'), preset('fable', 'claudeAgent', 'claude-fable-5-1'), preset('sol', 'codex', 'gpt-5.6-sol'), preset('opus', 'claudeAgent', 'claude-opus-5')],
      quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
      runtimeMode: 'full-access', stateDir: join(dir, 'state'),
      t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
      kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
      discovery: { promptFile: join(dir, 'discovery.md'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'), projects: [project('FIX'), project('NEXT')],
    });
    if (scenario === 'ceiling') c.models.forEach(m => { m.maxDifficulty = 'low'; });
    writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
    const tasks = scenario === 'discovery' ? [] : [1, 2, 3].map(number => ({ id: `task-${number}`, projectId: 'FIX', title: 'Bounded work', number, status: 'to-do', priority: number === 1 ? 'urgent' : 'high', createdAt: `2026-01-0${number}T00:00:00Z`, labels: [{ name: 'sf' }, ...scenario === 'unclassified' ? [] : [{ name: 'high' }]] }));
    const threads: Thread[] = [], store = new Store(c.stateDir), attempts: Record<string, any>[] = [];
    const providers = ['codex', 'claudeAgent'].map(instanceId => ({ instanceId, driver: instanceId, status: 'ready', installed: true, enabled: true, models: c.models.filter(m => m.model.instanceId === instanceId).map(m => ({ slug: m.model.model })) }));
    t.mock.method(T3.prototype, 'providers', async () => providers);
    t.mock.method(T3.prototype, 'shell', async () => ({ threads, projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })) }));
    t.mock.method(T3.prototype, 'detail', async () => ({ messages: [], activities: [] }));
    t.mock.method(T3.prototype, 'provider', async (instanceId: string, refresh: boolean) => {
      const p = providers.find(p => p.instanceId === instanceId)!;
      const window = (id: string, minutes: number, usedPercent = 0) => ({ id, usedPercent, windowDurationMins: minutes, resetsAt: new Date(Date.now() + minutes * 60_000).toISOString() });
      return { ...p, status: instanceId === 'codex' && scenario === 'codex-offline' ? 'error' : 'ready', usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: instanceId === 'codex' ? [window('primary', 10080, scenario === 'codex-exhausted' || (refresh && scenario === 'refresh-exhausted') ? 100 : 0)] : [window('five_hour', 300), window('seven_day', 10080), window('seven_day_fable', 10080)] } };
    });
    t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
    t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
      if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: tasks.filter(task => task.projectId === args.projectId) }] }, pagination: { total: tasks.length, totalPages: 1 } };
      if (name === 'get_task') return tasks.find(task => task.id === args.taskId);
      if (name === 'get_task_relations') return [];
      throw new Error(name);
    });
    t.mock.method(T3.prototype, 'dispatch', async (command: Record<string, any>) => {
      assert.ok(store.jobs().some(j => j.threadId === command.threadId && j.state === 'dispatching'), 'ownership is durable before RPC');
      attempts.push(command);
      if (scenario === 'ambiguous' && command.modelSelection.instanceId === 'codex') throw new Error('RPC outcome unknown');
      return { sequence: attempts.length };
    });
    if (scenario === 'codex-busy' || scenario === 'claude-waiting') {
      const driver = scenario === 'codex-busy' ? 'codex' : 'claudeAgent';
      const selected = c.models.find(m => m.model.instanceId === driver)!.model;
      const job: Job = { id: 'old', kind: 'ticket', projectId: 'FIX', taskId: 'old-task', ticketKey: 'FIX-99', threadId: 'old-thread', messageId: 'old-message', createdAt: new Date().toISOString(), state: 'running', reason: '', lastPersonalActivity: null, reportPath: join(dir, 'old-report'), command: null, modelSelection: selected, providerDriver: driver, prUrls: [], completedAt: null };
      store.save(job);
      threads.push({ id: job.threadId, title: 'Old factory', projectId: 'FIX', branch: null, worktreePath: null, modelSelection: selected, updatedAt: new Date().toISOString(), latestUserMessageAt: job.createdAt, archivedAt: null, hasPendingApprovals: false, hasPendingUserInput: scenario === 'claude-waiting', session: { status: 'running', providerName: driver, updatedAt: job.createdAt }, latestTurn: { state: 'running', completedAt: null } });
    }
    try {
      const result = await cycle(c, store);
      const none = ['unclassified', 'ceiling'].includes(scenario);
      const one = ['codex-busy', 'codex-exhausted', 'codex-offline', 'refresh-exhausted'].includes(scenario);
      assert.equal(attempts.length, none ? 0 : one ? 1 : 2);
      if (none) {
        assert.ok(!store.jobs().some(j => j.kind === 'discovery'), 'unschedulable tickets never trigger discovery instead');
        assert.equal((await cycle(c, store, { manual: true, model: 'astra', ticket: 'FIX-1', overrideLimits: true })).reason, 'no-eligible-ticket', 'manual override cannot bypass classification or difficulty limits');
      }
      if (one) assert.equal(attempts[0].modelSelection.instanceId, 'claudeAgent', 'Claude continues independently');
      if (attempts.length === 2) {
        assert.equal(attempts[0].modelSelection.model, 'gpt-6-astra', 'highest-ranked model gets first choice');
        assert.equal(attempts[1].modelSelection.instanceId, 'claudeAgent');
        assert.notEqual(attempts[0].threadId, attempts[1].threadId);
        assert.notEqual(attempts[0].bootstrap.prepareWorktree.branch, attempts[1].bootstrap.prepareWorktree.branch);
        if (scenario === 'discovery') assert.notEqual(attempts[0].bootstrap.createThread.projectId, attempts[1].bootstrap.createThread.projectId);
        else { assert.match(attempts[0].message.text, /Deliver FIX-1:/); assert.match(attempts[1].message.text, /Deliver FIX-2:/); }
      }
      for (const command of attempts) {
        assert.deepEqual(command.modelSelection, command.bootstrap.createThread.modelSelection);
        assert.ok(command.message.text.includes(`The user selected ${command.modelSelection.model};`));
        if (scenario !== 'discovery') assert.match(command.message.text, /approval-check/);
      }
      if (scenario === 'claude-waiting') assert.equal(store.jobs().find(j => j.id === 'old')!.state, 'waiting');
      if (scenario === 'unclassified') assert.equal((result as any).skipped.length, 3);
      if (['both', 'ambiguous', 'discovery'].includes(scenario)) {
        await cycle(c, store);
        assert.equal(attempts.length, 2, 'pending ownership keeps both provider slots and cannot duplicate work');
      }
    } finally {
      store.close(); process.env.PATH = oldPath;
      if (oldConfig === undefined) delete process.env.T3_FACTORY_CONFIG; else process.env.T3_FACTORY_CONFIG = oldConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
