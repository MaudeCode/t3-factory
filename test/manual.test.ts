import { mockTracker } from './tracker-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, configuredModel } from '../src/config.ts';
import { T3, Kanvil } from '../src/clients.ts';
import { Store } from '../src/store.ts';
import { cycle } from '../src/scheduler.ts';
import { saveSettings } from '../src/settings.ts';
import type { Thread } from '../src/policy.ts';
import { v2Thread } from './v2-fixture.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

test('manual override runs the specified ticket/model while paused, but retains dependency and duplicate guards', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-manual-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  const oldPath = process.env.PATH, oldConfig = process.env.T3_FACTORY_CONFIG;
  process.env.PATH = `${dir}:${oldPath}`;
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    model: { instanceId: 'claudeAgent', model: 'claude-opus-5' },
    fable: { enabled: true, model: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'),
    t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'token') },
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' },
    quota: { maxAgeSeconds: 300, fiveHourReservePercent: 40, weeklyReservePercent: 70 },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', enabled: true, key: 'FIX', kanvilId: 'kp', t3Id: 'tp', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
  });
  const other = { ...c.projects[0], name: 'Library', key: 'LIB', kanvilId: 'library', t3Id: 'library' };
  c.projects.push(other);
  writeFileSync(c.factorySkill, '# Software factory\nMerge without asking after review and CI.');
  c.models.forEach(m => { m.automatic = false; });
  const file = join(dir, 'config.jsonc'); process.env.T3_FACTORY_CONFIG = file;
  writeFileSync(file, '// preserve this comment\n' + JSON.stringify(c));
  const tasks = [1, 2, 3, 4, 5].map(number => ({ id: `task-${number}`, projectId: 'kp', title: 'Fixture', number, description: '', status: 'todo', priority: number === 1 ? 'urgent' : 'low', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'high' }] }));
  const store = new Store(c.stateDir); const dispatches: Record<string, any>[] = []; let blocked = true, usedPercent = 99;
  const owned: Thread[] = [];
  let claudeAvailable = true, codexUsed = 20, codexReady = true, codexAdvertised = true, codexStale = false, exhaustOnRefresh = false;
  const providerCalls: string[] = [];
  const listed: Record<string, unknown>[] = [];
  let unrelatedUnavailable = false;
  const personal = v2Thread({ id: 'personal', projectId: 'tp', title: 'Personal work', modelSelection: configuredModel(c, 'opus').model, status: 'running', activeRunId: 'run', latestRunCompletedAt: null, latestUserMessageAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  t.mock.method(T3.prototype, 'providers', async () => ['codex', 'claudeAgent'].map(instanceId => ({ instanceId, driver: instanceId, status: 'ready', enabled: true, installed: true, models: [] })));
  t.mock.method(T3.prototype, 'shell', async () => ({ projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })), threads: [personal, ...owned] }));
  t.mock.method(T3.prototype, 'detail', async () => ({ messages: [], responses: [] }));
  t.mock.method(T3.prototype, 'provider', async (instanceId: string, refresh: boolean) => {
    providerCalls.push(instanceId);
    if (instanceId === 'codex') return { driver: 'codex', status: codexReady ? 'ready' : 'error', enabled: true, installed: true,
      models: codexAdvertised ? [{ slug: c.models.find(p => p.id === 'sol')!.model.model }, { slug: c.models.find(p => p.id === 'astra')!.model.model }] : [],
      usageLimits: { checkedAt: new Date(codexStale ? 0 : Date.now() + 1000).toISOString(), windows: [
        { id: 'primary', usedPercent: refresh && exhaustOnRefresh ? 100 : codexUsed, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
      ] } };
    if (!claudeAvailable) throw new Error('Claude offline');
    return { driver: 'claudeAgent', status: 'ready', enabled: true, installed: true, models: [{ slug: configuredModel(c, 'opus').model.model }, { slug: configuredModel(c, 'fable').model.model }], usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: [
    { id: 'five_hour', usedPercent, windowDurationMins: 300, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    { id: 'seven_day', usedPercent, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    { id: 'seven_day_fable', usedPercent, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
  ] } };
  });
  t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => { dispatches.push(command); return { threadId: command.threadId }; });
  t.mock.method(Kanvil.prototype, 'connect', async () => {}); t.mock.method(Kanvil.prototype, 'close', async () => {});
  mockTracker(t, Kanvil.prototype, async (name: string, args: Record<string, unknown>) => {
    if (name === 'labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'tickets') {
      listed.push(args);
      if (unrelatedUnavailable && args.projectId === other.kanvilId) throw new Error('Unrelated project unavailable');
      const matching = tasks.filter(task => task.projectId === args.projectId && (!args.status || task.status === args.status));
      return { data: { workspaceId: 'workspace', columns: [{ tasks: matching }] }, pagination: { total: matching.length, totalPages: 1 } };
    }
    if (name === 'ticket') return tasks.find(t => t.id === args.taskId);
    if (name === 'relations') return blocked && args.taskId === 'task-2' ? [{ sourceTaskId: 'task-1', targetTaskId: 'task-2', relationType: 'blocks' }] : [];
    throw new Error(name);
  });
  try {
    assert.equal((await cycle(c, store)).reason, 'disabled');
    await t.test('named explicit and automatic model requests keep eligibility outcomes without unrelated project reads', async () => {
      const preset = configuredModel(c, 'opus');
      preset.automatic = true;
      try {
        for (const model of ['opus', 'auto']) {
          const options = { manual: true, model, ticket: 'fix-1', overrideLimits: true, dryRun: true };
          listed.length = 0;
          assert.equal((await cycle(c, store, options)).reason, 'would-dispatch');
          assert.deepEqual(listed.map(a => [a.projectId, a.status]), [['kp', undefined]]);
          unrelatedUnavailable = true;
          assert.equal((await cycle(c, store, options)).reason, 'would-dispatch', 'an unrelated listing outage cannot block the request');
          assert.equal((await cycle(c, store, { ...options, ticket: 'FIX-999' })).reason, 'no-eligible-ticket');
          tasks[0].status = 'done';
          const closed = await cycle(c, store, options);
          assert.equal(closed.reason, 'no-eligible-ticket');
          assert.match(JSON.stringify(closed.skipped), /Ticket is done/);
          tasks[0].status = 'todo';
          tasks[0].labels = [{ name: 'high' }];
          assert.equal((await cycle(c, store, options)).reason, 'would-dispatch', 'native-ready tickets need no sf label');
          tasks[0].labels = [{ name: 'sf' }];
          assert.equal((await cycle(c, store, options)).reason, 'no-eligible-ticket', 'difficulty remains mandatory');
          tasks[0].labels = [{ name: 'sf' }, { name: 'high' }];
          other.enabled = false;
          if (model === 'auto') assert.equal((await cycle(c, store, { ...options, ticket: 'LIB-1' })).reason, 'no-eligible-ticket');
          else await assert.rejects(cycle(c, store, { ...options, ticket: 'LIB-1' }), /not enabled/);
          if (model === 'auto') assert.equal((await cycle(c, store, { ...options, ticket: 'UNKNOWN-1' })).reason, 'no-eligible-ticket');
          else await assert.rejects(cycle(c, store, { ...options, ticket: 'UNKNOWN-1' }), /not enabled/);
          other.enabled = true;
          unrelatedUnavailable = false;
        }
        assert.equal(dispatches.length, 0, 'dry-run probes never launch');
      } finally {
        preset.automatic = false; unrelatedUnavailable = false; other.enabled = true;
        tasks[0].status = 'todo'; tasks[0].labels = [{ name: 'sf' }, { name: 'high' }];
      }
    });
    assert.equal((await cycle(c, store, { manual: true, ticket: 'fix-2' })).reason, 'blocked-ticket-plan-required', 'a blocked ticket is offered as a chain, not started');
    assert.equal((await cycle(c, store, { manual: true, ticket: 'FIX-2', overrideLimits: true })).reason, 'blocked-ticket-plan-required');
    assert.equal(dispatches.length, 0);
    blocked = false;
    const result = await cycle(c, store, { manual: true, ticket: 'fix-2', model: 'fable', overrideLimits: true });
    assert.equal(result.reason, 'dispatched'); assert.equal(dispatches.length, 1);
    assert.equal(store.jobs()[0].ticketKey, 'FIX-2'); assert.equal(dispatches[0].modelSelection.model, 'claude-fable-5-1');
    assert.equal(JSON.parse(readFileSync(file, 'utf8').split('\n').slice(1).join('\n')).enabled, false);
    owned.push({ ...personal, id: store.jobs()[0].threadId });
    assert.equal((await cycle(c, store, { manual: true, overrideLimits: true, ticket: 'FIX-2' })).reason, 'no-eligible-ticket', 'manual dispatch still rejects duplicate ownership');
    assert.equal((await cycle(c, store, { manual: true, overrideLimits: true, ticket: 'FIX-1', model: 'opus' })).reason, 'dispatched', 'a different ticket can start while the first is executing');
    assert.equal(dispatches.length, 2);
    assert.equal(new Set(dispatches.map(d => d.threadId)).size, 2);
    assert.equal(new Set(dispatches.map(d => d.workspaceStrategy.branch)).size, 2);
    usedPercent = 0;
    assert.equal((await cycle({ ...c, enabled: true }, store)).reason, 'watching-streams');

    claudeAvailable = false;
    providerCalls.length = 0;
    for (const model of ['sol', 'astra'] as const) await assert.rejects(cycle(c, store, { model }), /manual dispatch/);
    codexUsed = 100;
    assert.equal((await cycle(c, store, { manual: true, model: 'sol', ticket: 'FIX-3', overrideLimits: true })).reason, 'codex-quota-exhausted');
    codexUsed = 20; codexReady = false;
    await assert.rejects(cycle(c, store, { manual: true, model: 'sol', ticket: 'FIX-3' }), /Codex provider is not ready/);
    codexReady = true; codexAdvertised = false;
    await assert.rejects(cycle(c, store, { manual: true, model: 'sol', ticket: 'FIX-3' }), /does not advertise/);
    codexAdvertised = true; codexStale = true;
    await assert.rejects(cycle(c, store, { manual: true, model: 'astra', ticket: 'FIX-3' }), /snapshot is stale/);
    codexStale = false; exhaustOnRefresh = true;
    assert.equal((await cycle(c, store, { manual: true, model: 'sol', ticket: 'FIX-3' })).reason, 'codex-quota-exhausted', 'recheck Codex quota at dispatch boundary');
    assert.equal(dispatches.length, 2, 'invalid Codex readiness/quota never dispatches');
    exhaustOnRefresh = false;
    for (const [model, ticket] of [['sol', 'FIX-3'], ['astra', 'FIX-4']] as const) {
      assert.equal((await cycle(c, store, { manual: true, model, ticket })).reason, 'dispatched', 'manual Codex does not require Claude quota or inactivity');
      const sent = dispatches.at(-1)!;
      assert.deepEqual(sent.modelSelection, c.models.find(p => p.id === model)!.model);
      assert.deepEqual(sent.modelSelection, c.models.find(p => p.id === model)!.model);
      assert.match(sent.initialMessage.text, new RegExp(c.models.find(p => p.id === model)!.model.model));
      assert.doesNotMatch(sent.initialMessage.text, /Fable-first|this Claude runtime/);
      assert.match(sent.initialMessage.text, /\$software-factory/);
      assert.match(sent.initialMessage.text, /Manual run validation/);
    }
    assert.equal(new Set(dispatches.map(d => d.threadId)).size, 4);
    assert.ok(providerCalls.every(id => id === 'codex'), 'Codex dispatch only queries Codex quota');
    assert.equal((await cycle(c, store, { manual: true, model: 'sol', ticket: 'FIX-3' })).reason, 'no-eligible-ticket', 'Codex retains duplicate guards');
    claudeAvailable = true;
    const before = dispatches.length;
    await cycle({ ...c, enabled: true }, store);
    assert.equal(dispatches.length, before, 'automatic dispatch waits for the current run');

    const custom = configSchema.parse({ ...c, models: [...c.models, { id: 'quick-review', name: 'Quick review', model: { ...configuredModel(c, 'sol').model, options: [{ id: 'reasoningEffort', value: 'low' }, { id: 'serviceTier', value: 'priority' }] } }] });
    writeFileSync(file, '// preserve this comment\n' + JSON.stringify(custom));
    assert.equal((await cycle(custom, store, { manual: true, model: 'quick-review', ticket: 'FIX-5' })).reason, 'dispatched', 'user-created presets are dispatchable without hardcoded aliases');
    assert.deepEqual(dispatches.at(-1)!.modelSelection, custom.models.at(-1)!.model);
    await assert.rejects(cycle(custom, store, { model: 'quick-review' }), /manual dispatch/);
    await assert.rejects(cycle(c, store, { manual: true, model: 'removed-preset' }), /Unknown model/);
    assert.deepEqual(configSchema.parse(JSON.parse(JSON.stringify(custom))), custom, 'configuration normalization is stable across reloads');
    assert.throws(() => configSchema.parse({ ...c, models: [] }), /Too small/);
    assert.throws(() => configSchema.parse({ ...c, models: [{ ...c.models[0], id: 'auto' }] }));
    assert.throws(() => configSchema.parse({ ...c, models: [c.models[0], c.models[0]] }));
    assert.equal(configSchema.parse({ ...c, models: c.models.filter(p => p.id !== 'fable') }).models.some(p => p.id === 'fable'), false);
    const { models, ...legacy } = c;
    const migrated = configSchema.parse({ ...legacy, quota: { maxAgeSeconds: 300, fiveHourReservePercent: 40, weeklyReservePercent: 70 }, model: configuredModel(c, 'opus').model, codex: { sol: { ...configuredModel(c, 'sol').model, options: [{ id: 'reasoningEffort', value: 'ultra' }] }, astra: configuredModel(c, 'astra').model } });
    assert.equal(configuredModel(migrated, 'sol').model.options[0].value, 'ultra', 'migration preserves existing model choices');
    writeFileSync(file, '// preserve this comment\n' + JSON.stringify(c));

    const edited = { ...c, idleMinutes: 45 }; saveSettings({ base: c, config: edited }, file);
    assert.ok(readFileSync(file, 'utf8').includes('// preserve this comment'));
    assert.throws(() => saveSettings({ base: c, config: { ...c, idleMinutes: 60 } }, file), /changed/);
    const saved = readFileSync(file, 'utf8');
    assert.throws(() => saveSettings({ base: edited, config: { ...edited, idleMinutes: -1 } }, file));
    assert.equal(readFileSync(file, 'utf8'), saved, 'invalid settings never replace the working config');
  } finally {
    store.close(); process.env.PATH = oldPath;
    if (oldConfig === undefined) delete process.env.T3_FACTORY_CONFIG; else process.env.T3_FACTORY_CONFIG = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual explicit and automatic model final checks use one fresh label and relation snapshot', async t => {
  for (const model of ['sol', 'auto']) await t.test(model, async t => {
    const f = dispatchFixture(t);
    assert.equal((await f.run(model)).reason, 'dispatched');
    assert.equal(f.calls.filter(x => x === 'ticket:root:true').length, 1, 'final validation reads the selected ticket with its full native labels once');
    assert.equal(f.calls.filter(x => x === 'relations:root:true').length, 1, 'blockers and children share the final relation snapshot');
  });
});
