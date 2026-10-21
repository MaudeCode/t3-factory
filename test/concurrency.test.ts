import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig } from '../src/config.ts';
import { saveSettings } from '../src/settings.ts';
import { busyProviders } from '../src/scheduler.ts';
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
