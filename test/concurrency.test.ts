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
import type { Thread } from '../src/policy.ts';

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
  const resumed = { id: 'wait', modelSelection: { instanceId: 'codex', model: 'fixture' }, session: { status: 'running' }, latestTurn: { state: 'running' } } as Thread;
  assert.equal(busyProviders(jobs, [resumed], instances, 30, limits).has('codex'), true);
  assert.equal(busyProviders(jobs, [], instances, 30, limits, new Map([['codex', 1]])).has('codex'), true);
  assert.deepEqual([...busyProviders([...jobs, job('unknown', 'dispatching', 'unknown')], [], instances, 30, limits)].sort(), ['claudeAgent', 'codex']);
});
