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
import { dispatchFixture, deferred } from './dispatch-fixture.ts';

for (const scenario of ['both', 'codex-busy', 'claude-waiting', 'claude-handoff', 'claude-tool-call', 'codex-exhausted', 'codex-offline', 'refresh-exhausted', 'ambiguous', 'unclassified', 'ceiling', 'discovery', 'parallel', 'parallel-partial', 'parallel-dry-run', 'parallel-quota', 'parallel-resumed', 'parallel-lowered', 'parallel-discovery', 'parallel-claude-zero', 'parallel-codex-zero', 'parallel-both-zero', 'parallel-label-limit', 'parallel-label-dry-run', 'manual-fable-empty', 'manual-five-hour-empty', 'manual-fable-refresh-empty', 'manual-fable-reserve', 'truncated-labels', 'missing-sf-confirmation', 'label-ranked', 'label-blocked', 'label-ineligible', 'new-other-project-reference', 'new-project-reference', 'new-open-pr'] as const) {
  test(`provider streams: ${scenario}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-streams-')), repo = join(dir, 'repo'); mkdirSync(repo);
    execFileSync('/usr/bin/git', ['init', '-q', repo]);
    writeFileSync(join(dir, 'prs'), '[]');
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'prs'))}\n`, { mode: 0o755 });
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
    if (scenario.startsWith('parallel-label')) c.projects[0].labelLimits = { app: 2 };
    writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
    const tasks = ['discovery', 'parallel-discovery'].includes(scenario) ? [] : (parallel ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]).map(number => ({ id: `task-${number}`, projectId: 'FIX', title: 'Bounded work', number, status: 'to-do', priority: number === 1 ? 'urgent' : 'high', createdAt: `2026-01-0${number}T00:00:00Z`, labels: [{ name: 'sf' }, ...scenario === 'unclassified' ? [] : [{ name: 'high' }]] }));
    if (scenario.startsWith('parallel-label')) tasks.slice(0, 4).forEach(task => task.labels.push({ name: 'app' }));
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
      shellReads++;
      if (scenario === 'parallel-resumed' && shellReads >= 2) threads.forEach(thread => { thread.status = 'running'; thread.pendingRuntimeRequest = null; });
      if (scenario === 'new-open-pr' && shellReads === 2) writeFileSync(join(dir, 'prs'), JSON.stringify([{ title: 'Implement FIX-1', headRefName: 'fix/delivery', body: '' }]));
      else if (scenario.startsWith('new-') && shellReads === 2) threads.push(v2Thread({ id: 'new-reference', projectId: scenario === 'new-project-reference' ? 'FIX' : 'maintenance', title: 'Investigate FIX-1', branch: 'fix/FIX-1-investigation', status: 'running', activeRunId: 'run' }));
      return { threads: [...threads], projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })) };
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
    if (scenario === 'codex-busy' || scenario.startsWith('claude-')) {
      const driver = scenario === 'codex-busy' ? 'codex' : 'claudeAgent';
      const selected = c.models.find(m => m.model.instanceId === driver)!.model;
      const job: Job = { id: 'old', kind: 'ticket', projectId: 'FIX', taskId: 'old-task', ticketKey: 'FIX-99', threadId: 'old-thread', messageId: 'old-message', createdAt: new Date().toISOString(), state: 'running', reason: '', lastPersonalActivity: null, reportPath: join(dir, 'old-report'), command: null, modelSelection: selected, providerDriver: driver, prUrls: [], completedAt: null };
      store.save(job);
      const kind = scenario === 'claude-waiting' ? 'user_input' : scenario === 'claude-tool-call' ? 'dynamic_tool_call' : null;
      threads.push(v2Thread({ id: job.threadId, title: 'Old factory', projectId: 'FIX', providerInstanceId: driver, modelSelection: selected, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, status: scenario.startsWith('claude-') ? 'waiting' : 'running', activeRunId: scenario.startsWith('claude-') ? null : 'run', pendingRuntimeRequest: kind ? { kind, createdAt: job.createdAt } : null, latestRunCompletedAt: null }));
    }
    if (['parallel-partial', 'parallel-resumed', 'parallel-lowered'].includes(scenario)) {
      const selected = c.models[0].model;
      const count = scenario === 'parallel-partial' ? 1 : 3;
      for (let n = 0; n < count; n++) {
        const job: Job = { id: `existing-${n}`, kind: 'ticket', projectId: 'FIX', taskId: `existing-task-${n}`, ticketKey: `FIX-${90+n}`, threadId: `existing-thread-${n}`, messageId: 'initial', createdAt: new Date().toISOString(), state: 'running', reason: '', lastPersonalActivity: null, reportPath: join(dir, `report-${n}`), command: null, modelSelection: selected, providerDriver: 'codex', prUrls: [], completedAt: null };
        store.save(job);
        threads.push(v2Thread({ id: job.threadId, title: 'Existing run', projectId: 'FIX', providerInstanceId: 'codex', modelSelection: selected, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, status: scenario === 'parallel-resumed' ? 'waiting' : 'running', activeRunId: scenario === 'parallel-resumed' ? null : 'run', pendingRuntimeRequest: scenario === 'parallel-resumed' ? { kind: 'user_input', createdAt: job.createdAt } : null, latestRunCompletedAt: null }));
      }
    }
    try {
      if (scenario.startsWith('new-')) {
        const result = await cycle(c, store, { manual: true, ticket: 'FIX-1', model: 'sol' });
        const related = scenario !== 'new-other-project-reference';
        assert.equal(result.reason, related ? 'ticket-order-or-eligibility-changed' : 'dispatched');
        assert.equal(attempts.length, related ? 0 : 1, 'the final duplicate check uses the ticket project too');
        return;
      }
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
      const result = await cycle(c, store, manualQuota ? { manual: true, ticket: 'FIX-1', model: 'auto', overrideLimits: true } : ['parallel-dry-run', 'parallel-label-dry-run'].includes(scenario) ? { dryRun: true } : {});
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
        if (scenario === 'parallel-label-dry-run') {
          assert.equal(attempts.length, 0);
          const planned = (result as any).streams.flatMap((s: any) => s.planned);
          assert.deepEqual(planned.filter((key: string) => ['FIX-1', 'FIX-2', 'FIX-3', 'FIX-4'].includes(key)).length, 2, 'dry runs count their own planned runs against label limits');
          assert.ok(planned.includes('FIX-5') && planned.includes('FIX-6'));
        } else if (scenario === 'parallel-dry-run') {
          assert.equal(attempts.length, 0);
          assert.equal(store.jobs().length, 0);
          const streams = (result as any).streams;
          assert.equal(streams.find((s: any) => s.driver === 'codex').planned.length, 3);
          assert.equal(streams.find((s: any) => s.driver === 'claudeAgent').planned.length, 2);
          assert.equal(new Set(streams.flatMap((s: any) => s.planned)).size, 5);
        } else {
          const codex = attempts.filter(a => a.modelSelection.instanceId === 'codex');
          const claude = attempts.filter(a => a.modelSelection.instanceId === 'claudeAgent');
          const expectedCounts: Record<string, number[]> = { parallel: [3, 2], 'parallel-partial': [2, 2], 'parallel-quota': [1, 2], 'parallel-resumed': [0, 2], 'parallel-lowered': [0, 2], 'parallel-discovery': [2, 0], 'parallel-claude-zero': [3, 0], 'parallel-codex-zero': [0, 2], 'parallel-both-zero': [0, 0], 'parallel-label-limit': [3, 1] };
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
          if (scenario === 'parallel-label-limit') {
            const keys = attempts.map(a => a.initialMessage.text.match(/Deliver (FIX-\d+):/)?.[1]);
            assert.deepEqual(keys.filter(k => ['FIX-1', 'FIX-2', 'FIX-3', 'FIX-4'].includes(k!)).length, 2, 'only two app runs start at once');
            const next = await cycle(c, store);
            assert.equal(attempts.length, 4, 'a full label holds its remaining tickets');
            assert.ok((next as any).streams.some((s: any) => s.reason === 'label-limit'));
            const waitingApp = () => ['FIX-1', 'FIX-2', 'FIX-3', 'FIX-4'].filter(k => !store.jobs().some(j => j.ticketKey === k));
            for (const options of [{ model: 'auto' }, { model: 'astra' }, { model: 'astra', overrideLimits: ['idle', 'reserve'] as ('idle' | 'reserve')[] }, { model: 'astra', ticket: waitingApp()[0] }, { model: 'auto', ticket: waitingApp()[0] }])
              assert.equal((await cycle(c, store, { manual: true, ...options })).reason, 'label-limit', `a manual start respects label limits: ${JSON.stringify(options)}`);
            assert.equal(attempts.length, 4);
            c.projects[0].labelLimits = { app: { limit: 2, mode: 'full' } };
            writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
            for (const job of store.jobs().filter(j => j.labels?.includes('app'))) { job.state = 'waiting'; store.save(job); }
            await cycle(c, store);
            assert.equal(attempts.length, 4, 'two waiting app runs retain both full-block resource slots');
            for (const model of ['auto', 'astra'])
              assert.equal((await cycle(c, store, { manual: true, model, ticket: waitingApp()[0] })).reason, 'label-limit', 'manual starts also respect full blocks');
            assert.equal((await cycle(c, store, { manual: true, model: 'astra', ticket: waitingApp()[0], overrideLimits: ['labels'] })).reason, 'dispatched', 'overriding label limits exceeds a full label');
            c.projects[0].labelLimits = { app: { limit: 2, mode: 'running' } };
            writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
            await cycle(c, store);
            assert.equal(attempts.length, 6, 'running blocks release human-waiting slots');
          }
          if (scenario === 'parallel') {
            await cycle(c, store);
            assert.equal(attempts.length, 5, 'existing claims fill capacity on the next cycle');
          }
        }
        return;
      }
      const none = ['unclassified', 'ceiling'].includes(scenario);
      const one = ['codex-busy', 'claude-handoff', 'claude-tool-call', 'codex-exhausted', 'codex-offline', 'refresh-exhausted', 'label-ineligible'].includes(scenario);
      assert.equal(attempts.length, none ? 0 : one ? 1 : 2);
      if (none) {
        assert.ok(!store.jobs().some(j => j.kind === 'discovery'), 'unschedulable tickets never trigger discovery instead');
        assert.equal((await cycle(c, store, { manual: true, model: 'astra', ticket: 'FIX-1', overrideLimits: true })).reason, 'no-eligible-ticket', 'manual override cannot bypass classification or difficulty limits');
      }
      if (scenario === 'label-ineligible') assert.match(attempts[0].initialMessage.text, /Deliver FIX-1:/);
      if (one && scenario !== 'label-ineligible') assert.equal(attempts[0].modelSelection.instanceId, scenario.startsWith('claude-') ? 'codex' : 'claudeAgent', 'the other provider continues independently');
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

// Gates stay unresolved until the independent starts have been observed.
test('dispatch read phases overlap independent reads and deduplicate fresh snapshots', async t => {
  const f = dispatchFixture(t), initial = deferred(), shellStarted = deferred(), finalShell = deferred(), finalStarted = deferred();
  f.hooks.shell = async final => { if (final) { finalStarted.resolve(); await finalShell.promise; } else { shellStarted.resolve(); await initial.promise; } };
  const pending = f.run();
  await shellStarted.promise;
  const providersOverlapped = f.calls.includes('providers');
  initial.resolve();
  await finalStarted.promise;
  // Flush only work already scheduled by this phase, without a timing threshold.
  await new Promise(resolve => setImmediate(resolve));
  const labelsOverlapped = f.calls.includes('list_workspace_labels::true'), dependenciesOverlapped = f.calls.includes('get_task_relations:root:true');
  finalShell.resolve();
  assert.equal((await pending).reason, 'dispatched');
  assert(providersOverlapped, 'provider read must start before the initial shell resolves');
  assert(labelsOverlapped, 'final labels must start before the final shell resolves');
  assert(dependenciesOverlapped, 'final dependencies must start before the final shell resolves');
  assert(f.calls.includes('quota:true'), 'the selected provider still receives a forced refresh');
  assert.equal(f.calls.filter(x => x.startsWith('list_workspace_labels:')).length, 2, 'one complete label snapshot per phase');
  for (const phase of ['false', 'true']) assert.equal(f.calls.filter(x => x === `get_task_relations:root:${phase}`).length, 1, 'blockers and children share a relation read');
  assert.equal(f.calls.filter(x => x === 'get_task:blocker:true').length, 1);
});

for (const change of ['blocker', 'child', 'sf', 'difficulty', 'status', 'open-pr', 'thread', 'config', 'read-failure', 'mapping'] as const) {
  test(`final dispatch reads fail closed after inventory: ${change}`, async t => {
    const f = dispatchFixture(t);
    f.hooks.shell = async final => {
      if (!final) return;
      if (change === 'blocker') f.tasks[1].status = 'in-progress';
      if (change === 'child') { f.tasks[1].status = 'to-do'; f.relations.splice(0, 1, { sourceTaskId: 'root', targetTaskId: 'blocker', relationType: 'subtask' }); }
      if (change === 'sf') f.tasks[0].labels = [{ name: 'med' }];
      if (change === 'difficulty') f.tasks[0].labels = [{ name: 'sf' }, { name: 'low' }];
      if (change === 'status') f.tasks[0].status = 'done';
      if (change === 'open-pr') writeFileSync(join(f.dir, 'prs'), JSON.stringify([{ title: 'FIX-1 delivery', headRefName: 'fix/work', body: '' }]));
      if (change === 'thread') f.threads.push(v2Thread({ id: 'new', projectId: 'FIX', title: 'FIX-1', status: 'running', activeRunId: 'run' }));
      if (change === 'config') writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify({ ...f.c, idleMinutes: 2 }));
    };
    f.hooks.read = async (name, _id, final) => { if (change === 'read-failure' && final && name === 'get_task_relations') throw new Error('Required relation read failed'); };
    if (change === 'mapping') t.mock.method(f.t3, 'provider', async (_id: string, refresh: boolean) => {
      const p = f.provider();
      if (refresh) {
        p.driver = 'claudeAgent';
        p.usageLimits.windows = [{ id: 'five_hour', usedPercent: 0, windowDurationMins: 300, resetsAt: new Date(Date.now() + 300 * 60_000).toISOString() }, { id: 'seven_day', usedPercent: 0, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 10080 * 60_000).toISOString() }];
      }
      return p;
    });
    const result = await f.run('auto'), last = (result.dispatches as { reason: string; message?: string }[])[0];
    if (change === 'read-failure') { assert.equal(last.reason, 'error'); assert.match(last.message!, /Required relation read failed/); }
    else assert.equal(last.reason, ['open-pr', 'thread'].includes(change) ? 'ticket-order-or-eligibility-changed' : change === 'config' ? 'configuration-changed-before-dispatch' : change === 'mapping' ? 'provider-mapping-changed' : 'ticket-changed-before-dispatch');
    assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
  });
}

test('a failed final read drains other reads before closing the dispatch phase', async t => {
  const f = dispatchFixture(t), release = deferred(), started = deferred(), failure = deferred();
  f.hooks.quota = async refresh => { if (refresh) { started.resolve(); await release.promise; } };
  f.hooks.read = async (name, _id, final) => { if (name === 'get_task' && _id === 'root') { failure.resolve(); throw new Error('Task unavailable'); } };
  let ended = false;
  const pending = f.run().then(() => { ended = true; }, e => { ended = true; throw e; });
  const rejected = assert.rejects(pending, /Task unavailable/);
  await started.promise; await failure.promise;
  await new Promise(resolve => setImmediate(resolve));
  const endedBeforeRelease = ended;
  release.resolve(); await rejected;
  assert.equal(endedBeforeRelease, false, 'phase cannot finish while a started quota read is unresolved');
  assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
});

test('initial dispatch read failures drain the independent shell before returning', async t => {
  const f = dispatchFixture(t), release = deferred(), started = deferred();
  f.hooks.shell = async () => { started.resolve(); await release.promise; };
  f.hooks.providers = async () => { throw new Error('Providers unavailable'); };
  let ended = false;
  const pending = f.run().finally(() => { ended = true; });
  const rejected = assert.rejects(pending, /Providers unavailable/);
  await started.promise; await new Promise(resolve => setImmediate(resolve));
  const endedBeforeRelease = ended;
  release.resolve(); await rejected;
  assert.equal(endedBeforeRelease, false);
  assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
});

for (const failed of ['shell', 'task', 'labels', 'relations', 'columns', 'pull-requests'] as const) test(`required final read failure prevents launch: ${failed}`, async t => {
  const f = dispatchFixture(t);
  f.hooks.shell = async final => {
    if (!final) return;
    if (failed === 'shell') throw new Error('Read unavailable');
    if (failed === 'pull-requests') writeFileSync(join(f.dir, 'prs'), 'unavailable');
  };
  if (failed === 'columns') f.tasks[1].projectId = 'external';
  f.hooks.read = async (name, _id, final) => {
    if (final && name === ({ task: 'get_task', labels: 'list_workspace_labels', relations: 'get_task_relations', columns: 'list_project_columns' } as Record<string, string>)[failed]) throw new Error('Read unavailable');
  };
  // Inventory also needs external final statuses, so allow that first read.
  if (failed === 'columns') {
    let reads = 0;
    f.hooks.read = async name => { if (name === 'list_project_columns' && ++reads > 1) throw new Error('Read unavailable'); };
  }
  await assert.rejects(f.run(), failed === 'pull-requests' ? /Unexpected token|JSON/ : /Read unavailable/);
  assert.equal(f.launches.length, 0); assert.equal(f.store.jobs().length, 0);
});

test('automatic dispatch keeps ownership and launches serial while reads overlap', async t => {
  const f = dispatchFixture(t), release = deferred(), started = deferred();
  f.c.concurrency.codex = 2;
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(f.c));
  f.tasks.push(f.task('next', 3, 'to-do'));
  t.mock.method(f.t3, 'launch', async (command: unknown) => {
    assert(f.store.jobs().every(j => ['dispatching', 'running'].includes(j.state)));
    f.launches.push(command);
    if (f.launches.length === 1) { started.resolve(); await release.promise; }
    return {};
  });
  const pending = f.run('auto', false); await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  const before = [f.launches.length, f.store.jobs().length];
  release.resolve(); assert.equal((await pending).reason, 'dispatched');
  assert.deepEqual(before, [1, 1], 'the second dispatch cannot prepare ownership or launch until the first launch settles');
  assert.equal(f.launches.length, 2);
  assert.equal(new Set(f.store.jobs().map(j => j.taskId)).size, 2);
});
