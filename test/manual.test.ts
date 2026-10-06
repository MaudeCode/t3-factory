import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, configuredModel } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { Store } from '../src/store.ts';
import { cycle } from '../src/scheduler.ts';
import { saveSettings } from '../src/settings.ts';
import type { Thread } from '../src/policy.ts';
import { v2Thread } from './v2-fixture.ts';

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
    kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    quota: { maxAgeSeconds: 300, fiveHourReservePercent: 40, weeklyReservePercent: 70 },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', enabled: true, key: 'FIX', kaneoId: 'kp', t3Id: 'tp', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] }],
  });
  writeFileSync(c.factorySkill, '# Software factory\nMerge without asking after review and CI.');
  c.models.forEach(m => { m.automatic = false; });
  const file = join(dir, 'config.jsonc'); process.env.T3_FACTORY_CONFIG = file;
  writeFileSync(file, '// preserve this comment\n' + JSON.stringify(c));
  const tasks = [1, 2, 3, 4, 5].map(number => ({ id: `task-${number}`, projectId: 'kp', title: 'Fixture', number, description: '', status: 'to-do', priority: number === 1 ? 'urgent' : 'low', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'high' }] }));
  const store = new Store(c.stateDir); const dispatches: Record<string, any>[] = []; let blocked = true, usedPercent = 99;
  const owned: Thread[] = [];
  let claudeAvailable = true, codexUsed = 20, codexReady = true, codexAdvertised = true, codexStale = false, exhaustOnRefresh = false;
  const providerCalls: string[] = [];
  const personal = v2Thread({ id: 'personal', projectId: 'tp', title: 'Personal work', modelSelection: configuredModel(c, 'opus').model, status: 'running', activeRunId: 'run', latestRunCompletedAt: null, latestUserMessageAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  t.mock.method(T3.prototype, 'providers', async () => ['codex', 'claudeAgent'].map(instanceId => ({ instanceId, driver: instanceId, status: 'ready', enabled: true, installed: true, models: [] })));
  t.mock.method(T3.prototype, 'shell', async () => ({ projects: [{ id: 'tp', title: 'Fixture', workspaceRoot: repo }], threads: [personal, ...owned] }));
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
  t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
  t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks }] }, pagination: { total: tasks.length, totalPages: 1 } };
    if (name === 'get_task') return tasks.find(t => t.id === args.taskId);
    if (name === 'get_task_relations') return blocked && args.taskId === 'task-2' ? [{ sourceTaskId: 'task-1', targetTaskId: 'task-2', relationType: 'blocks' }] : [];
    throw new Error(name);
  });
  try {
    assert.equal((await cycle(c, store)).reason, 'disabled');
    assert.equal((await cycle(c, store, { manual: true, ticket: 'fix-2' })).reason, 'no-eligible-ticket');
    assert.equal((await cycle(c, store, { manual: true, ticket: 'FIX-2', overrideLimits: true })).reason, 'no-eligible-ticket');
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
    providerCalls.length = 0;
    await cycle({ ...c, enabled: true }, store);
    assert.equal(providerCalls.length, 0, 'automatic dispatch waits for the current run');

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
