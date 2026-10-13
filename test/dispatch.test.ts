import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, type Config } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle } from '../src/scheduler.ts';
import type { Thread } from '../src/policy.ts';
import { v2Thread } from './v2-fixture.ts';

for (const scenario of ['both', 'codex-busy', 'claude-waiting', 'codex-exhausted', 'codex-offline', 'refresh-exhausted', 'ambiguous', 'unclassified', 'ceiling', 'discovery', 'parallel', 'parallel-partial', 'parallel-dry-run', 'parallel-quota', 'parallel-resumed', 'parallel-lowered', 'parallel-discovery', 'parallel-claude-zero', 'parallel-codex-zero', 'parallel-both-zero', 'manual-fable-empty', 'manual-five-hour-empty', 'manual-fable-refresh-empty', 'manual-fable-reserve', 'truncated-labels', 'missing-sf-confirmation', 'label-ranked', 'label-blocked', 'label-ineligible'] as const) {
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
    writeFileSync(c.factorySkill, '# Software factory\nMerge without asking after review and CI.');
    const manualQuota = scenario.startsWith('manual-fable') || scenario === 'manual-five-hour-empty';
    const parallel = scenario.startsWith('parallel');
    if (manualQuota) { c.models = c.models.filter(m => m.model.instanceId === 'claudeAgent'); c.models[0].quotaWindowId = 'seven_day_fable'; c.quota.claude.fable.minRemainingPercent = 15; }
    if (parallel) c.concurrency = { claude: 2, codex: scenario === 'parallel-lowered' ? 1 : 3 };
    if (scenario === 'parallel-claude-zero' || scenario === 'parallel-both-zero') c.concurrency.claude = 0;
    if (scenario === 'parallel-codex-zero' || scenario === 'parallel-both-zero') c.concurrency.codex = 0;
    if (scenario === 'ceiling') c.models.forEach(m => { m.maxDifficulty = 'low'; });
    if (scenario.startsWith('label-')) c.projects[0].priorityLabels = ['compatibility', 'security'];
    writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
    const tasks = ['discovery', 'parallel-discovery'].includes(scenario) ? [] : (parallel ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]).map(number => ({ id: `task-${number}`, projectId: 'FIX', title: 'Bounded work', number, status: 'to-do', priority: number === 1 ? 'urgent' : 'high', createdAt: `2026-01-0${number}T00:00:00Z`, labels: [{ name: 'sf' }, ...scenario === 'unclassified' ? [] : [{ name: 'high' }]] }));
    if (scenario === 'truncated-labels') tasks.forEach(task => { task.labels = ['app', 'web', 'contracts', 'sec', 'med', 'sf'].map(name => ({ name })); });
    if (scenario === 'missing-sf-confirmation') tasks.forEach(task => { task.labels = [{ name: 'high' }]; });
    if (scenario.startsWith('label-')) {
      tasks[1].labels.push({ name: 'compatibility' }); tasks[1].priority = 'low';
      tasks[2].labels.push({ name: 'security' });
      if (scenario === 'label-ineligible') { tasks[1].labels = [{ name: 'compatibility' }, { name: 'high' }]; tasks[2].labels = [{ name: 'security' }, { name: 'sf' }]; }
    }
    const threads: Thread[] = [], store = new Store(c.stateDir), attempts: Record<string, any>[] = [];
    const providers = ['codex', 'claudeAgent'].map(instanceId => ({ instanceId, driver: instanceId, status: 'ready', installed: true, enabled: true, models: c.models.filter(m => m.model.instanceId === instanceId).map(m => ({ slug: m.model.model })) }));
    t.mock.method(T3.prototype, 'providers', async () => providers);
    let shellReads = 0;
    t.mock.method(T3.prototype, 'shell', async () => {
      // The pass reads the shell once and each dispatch re-reads it just before launch: the second read is the first dispatch's final check.
      if (scenario === 'parallel-resumed' && ++shellReads >= 2) threads.forEach(thread => { thread.status = 'running'; thread.pendingRuntimeRequest = null; });
      return { threads, projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })) };
    });
    t.mock.method(T3.prototype, 'detail', async () => ({ messages: [], responses: [] }));
    t.mock.method(T3.prototype, 'provider', async (instanceId: string, refresh: boolean) => {
      const p = providers.find(p => p.instanceId === instanceId)!;
      const window = (id: string, minutes: number, usedPercent = 0) => ({ id, usedPercent, windowDurationMins: minutes, resetsAt: new Date(Date.now() + minutes * 60_000).toISOString() });
      return { ...p, status: instanceId === 'codex' && scenario === 'codex-offline' ? 'error' : 'ready', usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: instanceId === 'codex' ? [window('primary', 10080, scenario === 'codex-exhausted' || (refresh && scenario === 'refresh-exhausted') || (scenario === 'parallel-quota' && attempts.some(a => a.modelSelection.instanceId === 'codex')) ? 100 : 0)] : [window('five_hour', 300, scenario === 'manual-five-hour-empty' ? 100 : 0), window('seven_day', 10080), window('seven_day_fable', 10080, scenario === 'manual-fable-empty' || (scenario === 'manual-fable-refresh-empty' && refresh) ? 100 : scenario === 'manual-fable-reserve' ? 99 : 0)] } };
    });
    t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
    t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
      if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: tasks.filter(task => task.projectId === args.projectId).map(task => scenario === 'truncated-labels' ? { ...task, labels: task.labels.slice(0, 3) } : task) }] }, pagination: { total: tasks.length, totalPages: 1 } };
      if (name === 'get_task') return tasks.find(task => task.id === args.taskId);
      if (name === 'get_task_relations') return (scenario === 'missing-sf-confirmation' && args.taskId === 'task-2' || scenario === 'label-blocked' && ['task-1', 'task-2'].includes(String(args.taskId))) ? [{ sourceTaskId: 'task-1', targetTaskId: 'task-2', relationType: 'blocks' }] : [];
      throw new Error(name);
    });
    t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => {
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
      threads.push(v2Thread({ id: job.threadId, title: 'Old factory', projectId: 'FIX', providerInstanceId: driver, modelSelection: selected, updatedAt: new Date().toISOString(), latestUserMessageAt: job.createdAt, status: scenario === 'claude-waiting' ? 'waiting' : 'running', activeRunId: scenario === 'claude-waiting' ? null : 'run', latestRunCompletedAt: null }));
    }
    if (['parallel-partial', 'parallel-resumed', 'parallel-lowered'].includes(scenario)) {
      const selected = c.models[0].model;
      const count = scenario === 'parallel-partial' ? 1 : 3;
      for (let n = 0; n < count; n++) {
        const job: Job = { id: `existing-${n}`, kind: 'ticket', projectId: 'FIX', taskId: `existing-task-${n}`, ticketKey: `FIX-${90+n}`, threadId: `existing-thread-${n}`, messageId: 'initial', createdAt: new Date().toISOString(), state: 'running', reason: '', lastPersonalActivity: null, reportPath: join(dir, `report-${n}`), command: null, modelSelection: selected, providerDriver: 'codex', prUrls: [], completedAt: null };
        store.save(job);
        threads.push(v2Thread({ id: job.threadId, title: 'Existing run', projectId: 'FIX', providerInstanceId: 'codex', modelSelection: selected, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, status: scenario === 'parallel-resumed' ? 'waiting' : 'running', activeRunId: scenario === 'parallel-resumed' ? null : 'run', latestRunCompletedAt: null }));
      }
    }
    try {
      if (scenario === 'missing-sf-confirmation') {
        const options = { manual: true, ticket: 'FIX-1', model: 'auto', overrideLimits: true };
        const warning = await cycle(c, store, options);
        assert.equal(warning.reason, 'ready-label-confirmation-required');
        assert.equal((warning as any).requiredLabel, 'sf');
        assert.equal((await cycle(c, store, { ...options, model: 'opus' })).reason, 'ready-label-confirmation-required');
        assert.equal(attempts.length, 0);
        await assert.rejects(cycle(c, store, { allowMissingReadyLabel: true, ticket: 'FIX-1' }), /specific manual ticket/);
        await assert.rejects(cycle(c, store, { manual: true, allowMissingReadyLabel: true }), /specific manual ticket/);
        const confirmed = { ...options, allowMissingReadyLabel: true };
        assert.equal((await cycle(c, store, confirmed)).reason, 'dispatched');
        assert.equal(attempts.length, 1);
        assert.match(attempts[0].initialMessage.text, /explicitly confirmed this run without the sf readiness label/);
        assert.match(attempts[0].initialMessage.text, /\$software-factory/);
        assert.match(attempts[0].initialMessage.text, /Manual run validation/);
        assert.equal((await cycle(c, store, confirmed)).reason, 'no-eligible-ticket', 'confirmation cannot bypass ownership');
        const blocked = await cycle(c, store, { ...confirmed, ticket: 'FIX-2' });
        assert.equal(blocked.reason, 'blocked-ticket-plan-required', 'a blocked ticket is offered as a chain instead of refused');
        assert.deepEqual((blocked as any).tree.tickets.map((x: any) => x.key), ['FIX-1']);
        tasks[2].labels = [];
        assert.equal((await cycle(c, store, { ...confirmed, ticket: 'FIX-3' })).reason, 'no-eligible-ticket', 'classification remains required');
        tasks[2].labels = [{ name: 'high' }]; tasks[2].status = 'done';
        assert.equal((await cycle(c, store, { ...confirmed, ticket: 'FIX-3' })).reason, 'no-eligible-ticket', 'status remains required');
        assert.equal(attempts.length, 1);
        return;
      }
      const result = await cycle(c, store, manualQuota ? { manual: true, ticket: 'FIX-1', model: 'auto', overrideLimits: true } : scenario === 'parallel-dry-run' ? { dryRun: true } : {});
      if (manualQuota) {
        assert.equal(attempts.length, scenario === 'manual-five-hour-empty' ? 0 : 1);
        if (attempts.length) {
          assert.equal(attempts[0].modelSelection.model, scenario === 'manual-fable-reserve' ? 'claude-fable-5-1' : 'claude-opus-5');
          assert.match(attempts[0].initialMessage.text, /Manual run validation/, 'automatic model selection does not turn a manual launch into an automatic run');
        }
        if (scenario === 'manual-fable-empty') {
          assert.equal((await cycle(c, store, { manual: true, ticket: 'FIX-2', model: 'fable', overrideLimits: true })).reason, 'quota-exhausted');
          assert.equal(attempts.length, 1);
        }
        return;
      }
      if (parallel) {
        if (scenario === 'parallel-dry-run') {
          assert.equal(attempts.length, 0);
          assert.equal(store.jobs().length, 0);
          const streams = (result as any).streams;
          assert.equal(streams.find((s: any) => s.driver === 'codex').planned.length, 3);
          assert.equal(streams.find((s: any) => s.driver === 'claudeAgent').planned.length, 2);
          assert.equal(new Set(streams.flatMap((s: any) => s.planned)).size, 5);
        } else {
          const codex = attempts.filter(a => a.modelSelection.instanceId === 'codex');
          const claude = attempts.filter(a => a.modelSelection.instanceId === 'claudeAgent');
          const expectedCounts: Record<string, number[]> = { parallel: [3, 2], 'parallel-partial': [2, 2], 'parallel-quota': [1, 2], 'parallel-resumed': [0, 2], 'parallel-lowered': [0, 2], 'parallel-discovery': [2, 0], 'parallel-claude-zero': [3, 0], 'parallel-codex-zero': [0, 2], 'parallel-both-zero': [0, 0] };
          const expected = expectedCounts[scenario];
          assert.deepEqual([codex.length, claude.length], expected);
          assert.equal(new Set(attempts.map(a => a.threadId)).size, attempts.length);
          assert.equal(new Set(attempts.map(a => a.workspaceStrategy.branch)).size, attempts.length);
          assert.ok(attempts.every(a => a.workspaceStrategy.type === 'worktree' && a.initialMessage.text), 'lowering limits must never stop work');
          if (scenario === 'parallel-both-zero') {
            assert.ok((result as any).streams.every((s: any) => s.reason === 'provider-disabled'));
            assert.equal((await cycle(c, store, { manual: true, ticket: 'FIX-1', model: 'astra', overrideLimits: true })).reason, 'dispatched');
            assert.equal((await cycle(c, store, { manual: true, ticket: 'FIX-2', model: 'fable', overrideLimits: true })).reason, 'dispatched');
          }
          if (scenario === 'parallel-discovery') assert.equal(new Set(attempts.map(a => a.projectId)).size, attempts.length);
          if (scenario === 'parallel') {
            await cycle(c, store);
            assert.equal(attempts.length, 5, 'existing claims fill capacity on the next cycle');
          }
        }
        return;
      }
      const none = ['unclassified', 'ceiling'].includes(scenario);
      const one = ['codex-busy', 'codex-exhausted', 'codex-offline', 'refresh-exhausted', 'label-ineligible'].includes(scenario);
      assert.equal(attempts.length, none ? 0 : one ? 1 : 2);
      if (none) {
        assert.ok(!store.jobs().some(j => j.kind === 'discovery'), 'unschedulable tickets never trigger discovery instead');
        assert.equal((await cycle(c, store, { manual: true, model: 'astra', ticket: 'FIX-1', overrideLimits: true })).reason, 'no-eligible-ticket', 'manual override cannot bypass classification or difficulty limits');
      }
      if (scenario === 'label-ineligible') assert.match(attempts[0].initialMessage.text, /Deliver FIX-1:/);
      if (one && scenario !== 'label-ineligible') assert.equal(attempts[0].modelSelection.instanceId, 'claudeAgent', 'Claude continues independently');
      if (attempts.length === 2) {
        assert.equal(attempts[0].modelSelection.model, 'gpt-6-astra', 'highest-ranked model gets first choice');
        assert.equal(attempts[1].modelSelection.instanceId, 'claudeAgent');
        assert.notEqual(attempts[0].threadId, attempts[1].threadId);
        assert.notEqual(attempts[0].workspaceStrategy.branch, attempts[1].workspaceStrategy.branch);
        if (scenario === 'discovery') assert.notEqual(attempts[0].projectId, attempts[1].projectId);
        else if (scenario.startsWith('label-')) {
          assert.match(attempts[0].initialMessage.text, scenario === 'label-ranked' ? /Deliver FIX-2:/ : /Deliver FIX-1:/);
          assert.match(attempts[1].initialMessage.text, /Deliver FIX-3:/);
        }
        else { assert.match(attempts[0].initialMessage.text, /Deliver FIX-1:/); assert.match(attempts[1].initialMessage.text, /Deliver FIX-2:/); }
      }
      for (const command of attempts) {
        const project = c.projects.find(p => p.t3Id === command.projectId)!;
        assert.deepEqual(command.workspaceStrategy, { type: 'worktree', baseRef: project.baseBranch, branch: command.workspaceStrategy.branch, startFromOrigin: true });
        assert.equal(command.initialMessage.messageId, store.jobs().find(j => j.threadId === command.threadId)!.messageId);
        assert.ok(command.initialMessage.text.includes(`The user selected ${command.modelSelection.model};`));
        if (scenario !== 'discovery') {
          assert.ok(command.initialMessage.text.includes(readFileSync(c.factorySkill, 'utf8').trim()), 'T3 receives the current configured skill');
          assert.match(command.initialMessage.text, /Automatic run visual validation/);
        }
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
