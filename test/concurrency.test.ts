import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig } from '../src/config.ts';
import { saveSettings } from '../src/settings.ts';
import { busyProviders, fullLabel } from '../src/scheduler.ts';
import type { Job } from '../src/store.ts';
import { v2Thread } from './v2-fixture.ts';

test('run limits default safely for old settings and persist independent edits', () => {
  const { concurrency, ...legacy } = loadConfig(fileURLToPath(new URL('../config.example.jsonc', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'factory-concurrency-')), file = join(dir, 'config.jsonc');
  try {
    writeFileSync(file, JSON.stringify(legacy));
    const base = loadConfig(file);
    assert.deepEqual(base.concurrency, { claude: 1, codex: 1 });
    const next = { ...base, concurrency: { claude: 3, codex: 2 } };
    saveSettings({ base, config: next }, file);
    assert.deepEqual(loadConfig(file).concurrency, next.concurrency);
    assert.throws(() => saveSettings({ base, config: next }, file), /Settings changed/);
    const paused = { ...next, concurrency: { claude: 0, codex: 0 } };
    saveSettings({ base: next, config: paused }, file);
    assert.deepEqual(loadConfig(file).concurrency, { claude: 0, codex: 0 });
    for (const value of [-1, 1.5, Infinity])
      assert.throws(() => configSchema.parse({ ...base, concurrency: { claude: value, codex: 1 } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('capacity counts active, resumed and uncertain runs but releases waiting and completed runs', () => {
  const job = (id: string, state: Job['state'], driver = 'codex') => ({ id, threadId: id, state, providerDriver: driver }) as Job;
  const limits = { claude: 2, codex: 3 }, instances = new Map<string, string>();
  const jobs = [job('a', 'running'), job('b', 'dispatching'), job('wait', 'waiting'), job('done', 'complete')];
  assert.equal(busyProviders(jobs, [], instances, 30, limits).has('codex'), false);
  const resumed = v2Thread({ id: 'wait', providerInstanceId: 'codex', modelSelection: { instanceId: 'codex', model: 'fixture' }, status: 'running', activeRunId: 'run' });
  assert.equal(busyProviders(jobs, [resumed], instances, 30, limits).has('codex'), true);
  assert.equal(busyProviders(jobs, [], instances, 30, limits, new Map([['codex', 1]])).has('codex'), true);
  assert.deepEqual([...busyProviders([...jobs, job('unknown', 'dispatching', 'unknown')], [], instances, 30, limits)].sort(), ['claudeAgent', 'codex']);
});

test('full label blocks retain waiting resource reservations independently of provider capacity', () => {
  const c = loadConfig(fileURLToPath(new URL('../config.example.jsonc', import.meta.url)));
  const projectId = c.projects[0].kaneoId;
  // Structured limits are the new opt-in; numbers retain running-only behavior.
  c.projects[0].labelLimits = { app: { limit: 2, mode: 'full' }, web: 2 };
  const jobs = ['one', 'two'].map(id => ({ id, threadId: id, projectId, state: 'waiting', labels: ['app', 'web'], providerDriver: 'codex' }) as Job);
  const ticket = { projectId, labels: [{ name: 'app' }] };
  const threads = jobs.map(j => v2Thread({ id: j.threadId, pendingRuntimeRequest: { kind: 'user_input' }, pendingBackgroundTasks: [{ kind: 'command', taskId: 'simulator' }] }));
  for (const snapshot of [[], threads]) {
    assert.equal(fullLabel(c, jobs, snapshot, ticket), 'app', 'two human-waiting app runs must block a third resource user');
    assert.equal(fullLabel(c, jobs, snapshot, { projectId, labels: [{ name: 'web' }] }), undefined, 'a running block releases waiting jobs');
    assert.equal(fullLabel(c, jobs, snapshot, { ...ticket, projectId: 'another-project' }), undefined);
    assert.equal(busyProviders(jobs, snapshot, new Map(), 30).has('codex'), false, 'provider capacity still releases human waits');
  }
  for (const state of ['complete', 'dismissed'] as const) {
    jobs[0].state = state;
    assert.equal(fullLabel(c, jobs, threads, ticket), undefined, `${state} frees a full-block slot`);
  }
  jobs[0].state = 'dispatching';
  assert.equal(fullLabel(c, jobs, [], ticket), 'app', 'uncertain dispatches retain reservations');
  jobs[0].projectId = 'another-project';
  assert.equal(fullLabel(c, jobs, [], ticket), undefined, 'only the same project counts');
});

test('label block modes validate and persist alongside legacy numeric limits', () => {
  const base = loadConfig(fileURLToPath(new URL('../config.example.jsonc', import.meta.url)));
  base.projects[0].labelLimits = { app: 2, web: 1 };
  const dir = mkdtempSync(join(tmpdir(), 'factory-label-modes-')), file = join(dir, 'config.jsonc');
  try {
    writeFileSync(file, JSON.stringify(base));
    const input = structuredClone(base);
    input.projects[0].labelLimits.app = { limit: 2, mode: 'full' };
    const next = configSchema.parse(input);
    saveSettings({ base, config: next }, file);
    assert.deepEqual(loadConfig(file).projects[0].labelLimits, { app: { limit: 2, mode: 'full' }, web: 1 });
    const running = structuredClone(next);
    running.projects[0].labelLimits.app = { limit: 0, mode: 'running' };
    saveSettings({ base: next, config: running }, file);
    assert.deepEqual(loadConfig(file).projects[0].labelLimits.app, { limit: 0, mode: 'running' });
    for (const invalid of [{ limit: -1, mode: 'full' }, { limit: 1.5, mode: 'full' }, { limit: 2, mode: 'unknown' }, { limit: 2 }, { limit: 2, mode: 'full', extra: true }]) {
      assert.throws(() => configSchema.parse({ ...input, projects: [{ ...input.projects[0], labelLimits: { app: invalid } }] }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished command waits retain capacity before and after automatic resumption', () => {
  for (const driver of ['claudeAgent', 'codex']) {
    const jobs = Array.from({ length: 4 }, (_, i) => ({ id: `job-${i}`, threadId: `thread-${i}`, state: 'running', providerDriver: driver }) as Job);
    const threads = jobs.map(j => v2Thread({ id: j.threadId, providerInstanceId: driver, modelSelection: { instanceId: driver, model: 'fixture' }, status: 'completed', activeRunId: null, pendingBackgroundTasks: [{ taskId: 'pr-watch', kind: 'command' }] }));
    const blocked = () => busyProviders(jobs, threads, new Map(), 30, { claude: 4, codex: 4 }).has(driver);
    assert.equal(blocked(), true, `${driver}: four unfinished command waits must block a fifth automatic job`);
    threads[0].status = 'running'; threads[0].activeRunId = 'resumed-run'; threads[0].pendingBackgroundTasks = [];
    assert.equal(blocked(), true, `${driver}: automatic resumption must keep the same reservation`);
    jobs[0].state = 'complete';
    assert.equal(blocked(), false, `${driver}: verified completion frees capacity`);
    jobs[0].state = 'running'; jobs[1].state = 'waiting';
    assert.equal(blocked(), false, `${driver}: a job parked for human input frees capacity`);
  }
});
