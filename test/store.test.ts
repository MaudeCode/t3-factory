import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as stores from '../src/store.ts';
import type { Job } from '../src/store.ts';

const { Store } = stores;
type Store = stores.Store;
const assignedBranch = (job: Partial<Job>) => stores.assignedBranch(job);

const job = (id: string, command?: unknown): Job => ({ id, kind: 'ticket', projectId: 'project', taskId: null, ticketKey: 'FIX-1', threadId: `thread-${id}`, messageId: 'message', createdAt: '2026-01-01T00:00:00Z',
  state: 'complete', reason: 'Fixture', lastPersonalActivity: null, reportPath: '/missing.json', prUrls: [], completedAt: '2026-01-02T00:00:00Z', ...command === undefined ? {} : { command } });
const launch = { commandId: 'c', workspaceStrategy: { type: 'worktree', branch: 'feat/FIX-1-factory-new' }, initialMessage: { text: 'prompt' } };
const legacy = { bootstrap: { prepareWorktree: { branch: 'fix/FIX-2-factory-old' } } };
const listReads = (store: Store) => [store.jobs(), store.jobSummaries(), store.activeJobs(), store.finishedJobs(), store.recentJobs(), store.history()].flat();
const fixture = (t: test.TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// A database as the previous schema wrote it: each command inside its job row and no job_commands table.
function oldDatabase(dir: string) {
  const store = new Store(dir);
  const insert = store.db.prepare('INSERT INTO jobs VALUES(?,?,?)'), archive = store.db.prepare('INSERT INTO job_history VALUES(?,?)');
  insert.run('new', null, JSON.stringify(job('new', launch)));
  insert.run('legacy', null, JSON.stringify(job('legacy', legacy)));
  insert.run('discovery', null, JSON.stringify(job('discovery', { initialMessage: { text: 'no branch' } })));
  insert.run('bare', null, JSON.stringify(job('bare')));
  archive.run('archived', JSON.stringify({ ...job('archived', legacy), historyOnly: true }));
  store.db.exec("DROP TABLE IF EXISTS job_commands; DELETE FROM metadata WHERE key = 'jobCommandsVersion'");
  assert.equal(store.db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode, 'delete');
  store.close();
}
const snapshot = (store: Store) => ({
  jobs: store.db.prepare('SELECT id, data FROM jobs ORDER BY id').all(),
  history: store.db.prepare('SELECT id, data FROM job_history ORDER BY id').all(),
  commands: store.db.prepare('SELECT id, data FROM job_commands ORDER BY id').all(),
});

test('list reads omit the command that a read by ID returns, for live and history rows', t => {
  const store = new Store(fixture(t));
  t.after(() => store.close());
  store.save(job('live', launch));
  store.archiveJob(job('archived', legacy));
  assert.ok(listReads(store).length >= 6);
  assert.ok(listReads(store).every(row => !('command' in row)), 'no list read returns a command');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(data, '$.command') IS NOT NULL").get()!.n, 0, 'the job row stores no command');
  assert.deepEqual(store.job('live')?.command, launch);
  assert.deepEqual(store.job('archived')?.command, legacy);
  assert.equal(assignedBranch(store.jobs()[0]), 'feat/FIX-1-factory-new', 'a list-read job names its assigned branch');
  assert.equal(assignedBranch(store.history().find(row => row.id === 'archived')!), 'fix/FIX-2-factory-old');
});

test('saving a progress change leaves the stored command alone', t => {
  const store = new Store(fixture(t));
  t.after(() => store.close());
  store.save(job('live', launch));
  store.db.exec(`CREATE TABLE command_writes(n INTEGER); CREATE TEMP TRIGGER count_insert AFTER INSERT ON job_commands BEGIN INSERT INTO command_writes VALUES(1); END;
    CREATE TEMP TRIGGER count_update AFTER UPDATE ON job_commands BEGIN INSERT INTO command_writes VALUES(1); END;`);
  store.save({ ...store.jobs()[0], lastExecutionAt: '2026-01-03T00:00:00Z' });
  store.save({ ...store.job('live')!, lastExecutionAt: '2026-01-04T00:00:00Z' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM command_writes').get()!.n, 0);
  assert.deepEqual(store.job('live')?.command, launch, 'a list-read save keeps the command');
  assert.equal(store.job('live')?.lastExecutionAt, '2026-01-04T00:00:00Z');
});

test('opening an old database moves each command beside its job once and records its branch', t => {
  const dir = fixture(t);
  oldDatabase(dir);
  const store = new Store(dir);
  t.after(() => store.close());
  assert.ok(listReads(store).every(row => !('command' in row)));
  assert.deepEqual(store.job('new')?.command, launch);
  assert.deepEqual(store.job('legacy')?.command, legacy);
  assert.deepEqual(store.job('archived')?.command, legacy);
  assert.equal(store.job('bare')?.command, undefined);
  const branches = Object.fromEntries(store.history().map(row => [row.id, row.branch]));
  assert.deepEqual(branches, { new: 'feat/FIX-1-factory-new', legacy: 'fix/FIX-2-factory-old', archived: 'fix/FIX-2-factory-old', discovery: undefined, bare: undefined });
  const migrated = snapshot(store);
  new Store(dir).close();
  assert.deepEqual(snapshot(store), migrated, 'opening it again changes nothing');
});

test('two stores opening an old database at once leave one migrated result', async t => {
  const dir = fixture(t);
  oldDatabase(dir);
  // Both workers wait on one shared flag, then construct their Store together.
  const gate = new Int32Array(new SharedArrayBuffer(4)), store = new URL('../src/store.ts', import.meta.url).href;
  const source = `const { workerData } = require('node:worker_threads'); Atomics.wait(workerData.gate, 0, 0);
    import(workerData.store).then(({ Store }) => new Store(workerData.dir).close());`;
  const workers = [0, 1].map(() => new Worker(source, { eval: true, workerData: { gate, store, dir } }));
  const exits = workers.map(worker => new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); }));
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
  assert.deepEqual(await Promise.all(exits), [0, 0]);
  const reader = new Store(dir);
  t.after(() => reader.close());
  assert.deepEqual(snapshot(reader).commands.map(row => row.id), ['archived', 'discovery', 'legacy', 'new']);
  assert.equal(reader.db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(data, '$.command') IS NOT NULL").get()!.n, 0);
  assert.deepEqual(reader.job('new')?.command, launch);
  assert.equal(reader.get('jobCommandsVersion'), '1');
});

test('reopening a legacy job source trigger lets save update the indexed source', t => {
  const dir = fixture(t);
  const old = new Store(dir);
  try {
    old.save(job('live'));
    old.db.exec(`
      UPDATE metadata SET value = '1' WHERE key = 'jobSourcesVersion';
      DROP TRIGGER jobs_source_update;
      CREATE TRIGGER jobs_source_update AFTER UPDATE ON jobs
      WHEN json_extract(new.data, '$.kind') IS NOT json_extract(old.data, '$.kind')
        OR json_extract(new.data, '$.threadId') IS NOT json_extract(old.data, '$.threadId')
      BEGIN
        INSERT OR REPLACE INTO job_sources VALUES(new.id, json_extract(new.data, '$.kind'), json_extract(new.data, '$.threadId'));
      END;
    `);
  } finally {
    old.close();
  }

  const reopened = new Store(dir);
  t.after(() => reopened.close());
  assert.doesNotThrow(() => reopened.save({ ...job('live'), threadId: 'replacement' }));
  assert.deepEqual(reopened.jobSources().map(source => ({ ...source })), [{ kind: 'ticket', threadId: 'replacement' }]);
  reopened.save({ ...job('live'), threadId: 'replacement', kind: 'discovery' });
  assert.deepEqual(reopened.jobSources().map(source => ({ ...source })), [{ kind: 'discovery', threadId: 'replacement' }]);
});
