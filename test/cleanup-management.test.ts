import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { manageCleanup, inspectCleanup, cleanupInventory } from '../src/cleanup.ts';
import { Store, type Job } from '../src/store.ts';
import { inspectWorkspace } from '../src/workspace.ts';
import type { Config } from '../src/config.ts';
import type { T3, Kaneo } from '../src/clients.ts';
import { v2Thread, v2Projection } from './v2-fixture.ts';

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-manager-'))), repo = join(dir, 'repo'), path = join(dir, 'tree'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, '.gitignore'), 'ignored\n'); writeFileSync(join(repo, 'file'), 'released\n'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'released');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD')); git('worktree', 'add', '-qb', 'feat/FIX-1', path);
  let store = new Store(join(dir, 'state'));
  const c = { enabled: false, monitoringTimeoutMinutes: 30, projects: [{ kaneoId: 'p', t3Id: 't3', repoPath: repo, baseBranch: 'main', doneStatuses: ['done'] }] } as Config;
  let threads: ReturnType<typeof v2Thread>[] = [], removeCalls = 0, detachCalls = 0, unknown = false, queued = false, removeError = false, lostAfter = false;
  let onShell: (() => void) | undefined;
  const t3 = { shell: async () => { onShell?.(); if (unknown) throw { _tag: 'EnvironmentAuthorizationError', detail: 'Missing terminal:read scope' }; return { threads, projects: [{ id: 't3', workspaceRoot: repo }] }; },
    request: async (url: string) => ({ projection: v2Projection(threads.find(t => url.includes(`/threads/${t.id}/`))!, { runs: queued ? [{ status: 'queued' }] : [], runtimeRequests: [], messages: [], providerThreads: [], subagents: [] }) }),
    terminals: async () => [], dispatch: async (command: any) => { detachCalls++; const thread = threads.find(t => t.id === command.threadId)!; assert.equal(command.expectedWorktreePath, thread.worktreePath); thread.worktreePath = thread.branch = null; },
    removeWorktree: async (_repo: string, target: string, force: boolean) => { removeCalls++; if (removeError) throw new Error('RPC response lost'); git('worktree', 'remove', ...force ? ['--force'] : [], target); if (lostAfter) throw new Error('RPC response lost after removal'); },
  } as unknown as T3;
  const kaneo = { call: async () => ({ id: 'task', projectId: 'p', number: 1, title: 'Fixture', createdAt: '2026-01-01T00:00:00Z', priority: 'low', status: 'done' }) } as unknown as Kaneo;
  const boundary = { processes: async () => ['/unrelated'] };
  const target = { projectId: 'p', path };
  const inspect = () => inspectCleanup(c, store, t3, kaneo, { ...target, size: true }, boundary);
  const review = () => manageCleanup(c, store, t3, kaneo, { type: 'review', ...target }, 'fixture operator', boundary);
  const force = (r: any, id = randomUUID()) => manageCleanup(c, store, t3, kaneo, { type: 'force', id, reviewId: r.reviewId, confirmation: path, reason: 'Discard reviewed fixture work' }, 'fixture operator', boundary);
  const job = (): Job => ({ id: 'job', kind: 'discovery', projectId: 'p', taskId: null, ticketKey: null, threadId: 'owner', messageId: 'initial', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Finished', reportPath: join(dir, 'report.json'), lastPersonalActivity: null, prUrls: [], command: { workspaceStrategy: { branch: 'feat/FIX-1' } }, thread: { title: '', status: 'completed', branch: 'feat/FIX-1', worktreePath: path, updatedAt: '2026-01-01T00:00:00Z', pending: null, background: [] } });
  return { dir, repo, path, c, target, git, t3, kaneo, boundary, inspect, review, force, job,
    get store() { return store; }, get calls() { return [removeCalls, detachCalls]; },
    owners: (n = 1) => { threads = Array.from({ length: n }, (_, i) => v2Thread({ id: i ? `owner${i}` : 'owner', projectId: 't3', worktreePath: path, branch: 'feat/FIX-1' })); return threads; },
    inventoryRecords: (count: number) => {
      threads = Array.from({ length: count }, (_, i) => v2Thread({ id: `inventory-${i}`, projectId: 't3', worktreePath: join(dir, `inventory-${i}`), branch: `feat/FIX-${i + 10}` }));
      for (const thread of threads) store.save({ ...job(), id: thread.id, threadId: thread.id, thread: { ...job().thread!, worktreePath: thread.worktreePath } });
    },
    unknown: () => { unknown = true; }, queued: () => { queued = true; }, lost: () => { removeError = true; }, lostAfter: () => { lostAfter = true; }, race: (fn: () => void) => { onShell = fn; },
    restart: () => { store.close(); store = new Store(join(dir, 'state')); },
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('read-only inventory includes orphan, shared, missing and cleaned records; repository failures stay separate', async () => {
  const f = fixture(); try {
    f.owners(2); const j = f.job(); f.store.save(j);
    const missing = { ...j, id: 'old', threadId: 'old', thread: undefined, workspaceCleanup: { path: join(f.dir, 'absent'), branch: 'old', head: f.git('rev-parse', 'HEAD') }, workspaceCleanedAt: '2026-01-03T00:00:00Z' }; f.store.save(missing);
    f.c.projects.push({ ...f.c.projects[0], kaneoId: 'broken', t3Id: 'broken', repoPath: join(f.dir, 'not-repository') });
    const result = await cleanupInventory(f.c, f.store, f.t3, 0, 100);
    assert.equal(result.items.find(i => i.path === f.path)!.ownership, 'shared');
    assert.equal(result.items.find(i => i.path.endsWith('/absent'))!.state, 'complete');
    assert.equal(result.errors.length, 1); assert.equal(result.items.length, 3); assert.deepEqual(f.calls, [0, 0]);
    assert.equal((await f.inspect()).ownership, 'shared'); assert.deepEqual(f.calls, [0, 0]);
    assert.ok(existsSync(f.path));
  } finally { f.close(); }
});

for (const scenario of ['dirty', 'ignored', 'unmerged', 'orphan', 'shared', 'missing'] as const) test(`force review and confirmed removal: ${scenario}`, async () => {
  const f = fixture(); try {
    if (scenario === 'dirty') writeFileSync(join(f.path, 'file'), 'discard\n');
    if (scenario === 'ignored') writeFileSync(join(f.path, 'ignored'), 'secret content never returned');
    if (scenario === 'unmerged') { writeFileSync(join(f.path, 'file'), 'new\n'); execFileSync('git', ['-C', f.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'unmerged']); }
    if (scenario === 'shared') f.owners(2);
    if (scenario === 'missing') rmSync(f.path, { recursive: true });
    const r = await f.review(); assert.equal(r.forceAllowed, true, JSON.stringify(r.checks)); assert.ok(r.overridden.length);
    assert.ok(!JSON.stringify(r).includes('secret content never returned'));
    const branchHead = f.git('rev-parse', 'refs/heads/feat/FIX-1'), id = randomUUID();
    const result = await f.force(r, id); assert.equal(result.state, 'confirmed', JSON.stringify(result));
    assert.equal(result.outcomes[0].physicalRemoval, scenario !== 'missing');
    assert.equal(result.outcomes[0].message, scenario === 'missing' ? 'already-absent' : 'removed');
    assert.equal(existsSync(f.path), false); assert.ok(!f.git('worktree', 'list', '--porcelain').includes(f.path));
    assert.equal(f.git('rev-parse', 'refs/heads/feat/FIX-1'), branchHead, 'branch ref preserved');
    f.restart(); assert.deepEqual(await f.force(r, id), result); assert.equal(f.calls[0], 1);
  } finally { f.close(); }
});

for (const scenario of ['active', 'queued', 'unknown', 'process', 'primary', 'symlink', 'changed-content', 'changed-head', 'changed-binding', 'new-subagent'] as const) test(`force refuses unsafe or stale review: ${scenario}`, async () => {
  const f = fixture(); try {
    const owners = f.owners(), r = await f.review(); assert.equal(r.forceAllowed, true);
    if (scenario === 'active') { owners[0].activeRunId = 'new-run'; owners[0].status = 'running'; }
    if (scenario === 'queued') f.queued();
    if (scenario === 'unknown') f.unknown();
    if (scenario === 'process') f.boundary.processes = async () => [f.path];
    if (scenario === 'primary') { const p = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'review', projectId: 'p', path: f.repo }, 'fixture', f.boundary); assert.equal(p.forceAllowed, false); return; }
    if (scenario === 'symlink') { f.git('worktree', 'remove', f.path); symlinkSync(f.repo, f.path); }
    if (scenario === 'changed-content') writeFileSync(join(f.path, 'ignored'), 'changed');
    if (scenario === 'changed-head') { writeFileSync(join(f.path, 'file'), 'new'); execFileSync('git', ['-C', f.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'new']); }
    if (scenario === 'changed-binding') owners[0].updatedAt = '2026-01-03T00:00:00Z';
    if (scenario === 'new-subagent') { let reads = 0; f.race(() => { if (++reads === 3) owners.push(v2Thread({ id: 'new-child', projectId: 't3', lineage: { parentThreadId: 'owner', relationshipToParent: 'subagent' }, status: 'running', activeRunId: 'child' })); }); }
    const result = await f.force(r); assert.notEqual(result.state, 'confirmed'); assert.equal(f.calls[0], 0);
  } finally { f.close(); }
});

test('uncertain removal is durable and cannot be repeated with another request ID', async () => {
  const f = fixture(); try {
    const r = await f.review(); f.lost(); const result = await f.force(r); assert.equal(result.state, 'uncertain');
    f.restart(); const retry = await f.force(await f.review()); assert.equal(retry.state, 'failed'); assert.equal(f.calls[0], 1);
    assert.match(retry.outcomes[0].message, /uncertain/); assert.ok(existsSync(f.path));
  } finally { f.close(); }
});

test('normal retry bypasses repaired authorization cooldown and uses the normal verifier without dispatching', async () => {
  const f = fixture(); try {
    f.owners(); const job = f.job(); job.workspaceCleanupBlockedAt = new Date().toISOString(); job.workspaceCleanupError = 'Missing terminal:read'; f.store.save(job);
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target], reason: 'Authorization repaired' }, 'fixture', f.boundary);
    assert.equal(result.state, 'confirmed', JSON.stringify(result)); assert.equal(result.outcomes[0].physicalRemoval, true); assert.ok(f.store.job('job')?.workspaceCleanedAt);
    assert.deepEqual(f.calls, [1, 1]); assert.equal(f.c.enabled, false);
  } finally { f.close(); }
});

test('inspection cancellation cannot persist a force plan or mutate a worktree', async () => {
  const f = fixture(); try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'review', ...f.target }, 'fixture', { ...f.boundary, signal: abort.signal }), /abort/i);
    assert.deepEqual(f.calls, [0, 0]); assert.equal(f.store.cleanupActions().length, 0);
  } finally { f.close(); }
});

test('inventory filters and sorting run before pagination and keep unknown size distinct', async () => {
  const f = fixture(); try {
    const all = await cleanupInventory(f.c, f.store, f.t3, 0, 1, undefined, { ownership: 'orphan', query: 'tree', sort: 'path' });
    assert.equal(all.total, 1); assert.equal(all.items[0].path, f.path); assert.deepEqual(all.items[0].size, { state: 'unknown', bytes: null });
    await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'inspect', ...f.target, size: true }, 'fixture', f.boundary);
    const sized = await cleanupInventory(f.c, f.store, f.t3, 0, 50, undefined, { sort: 'size' });
    assert.equal(sized.items[0].path, f.path); assert.equal(sized.items[0].size.state, 'known'); assert.ok(sized.items[0].size.bytes !== null && sized.items[0].size.bytes > 0);
  } finally { f.close(); }
});

test('fresh inspection finalizes an uncertain already-absent result without repeating removal or claiming recovered bytes', async () => {
  const f = fixture(); try {
    const r = await f.review(); f.lostAfter(); const result = await f.force(r);
    assert.equal(result.state, 'uncertain'); assert.equal(existsSync(f.path), false);
    f.restart(); await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'inspect', ...f.target }, 'fixture', f.boundary);
    const confirmed = f.store.cleanupAction(result.id)!; assert.equal(confirmed.state, 'confirmed'); assert.equal(confirmed.outcomes[0].physicalRemoval, false); assert.equal(confirmed.outcomes[0].freeSpaceChange, null); assert.equal(f.calls[0], 1);
  } finally { f.close(); }
});

test('normal removal refuses queued work hidden by a settled shell', async () => {
  const f = fixture(); try {
    f.owners(); f.store.save(f.job()); f.queued();
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target], reason: 'Normal verifier must inspect the bounded queue' }, 'fixture', f.boundary);
    assert.equal(result.state, 'failed'); assert.match(result.outcomes[0].message, /queued|pending/); assert.equal(f.calls[0], 0); assert.ok(existsSync(f.path));
  } finally { f.close(); }
});

test('inspection projects activity summaries without raw request, background or terminal payloads', async () => {
  const f = fixture(); try {
    const [owner] = f.owners();
    owner.pendingRuntimeRequest = { kind: 'approval', createdAt: owner.updatedAt, payload: 'private request payload' };
    owner.pendingBackgroundTasks = [{ taskId: 'task', kind: 'command', input: 'private command input' }];
    f.t3.terminals = async () => [{ threadId: owner.id, terminalId: 'terminal', status: 'running', cwd: f.path, worktreePath: f.path, pid: 12, hasRunningSubprocess: true, updatedAt: owner.updatedAt, label: 'private terminal label' }];
    const detail = await f.inspect(); assert.equal(detail.forceAllowed, false);
    const serialized = JSON.stringify(detail); assert.ok(!serialized.includes('private request payload')); assert.ok(!serialized.includes('private command input')); assert.ok(!serialized.includes('private terminal label'));
  } finally { f.close(); }
});

test('batch normal removal retains failed dirty work and independently confirms the next selected worktree', async () => {
  const f = fixture(); try {
    const owners = f.owners(), other = join(f.dir, 'other-tree');
    f.git('worktree', 'add', '-qb', 'feat/FIX-2', other);
    owners.push(v2Thread({ id: 'owner2', projectId: 't3', worktreePath: other, branch: 'feat/FIX-2' }));
    const first = f.job(), second = { ...f.job(), id: 'job2', threadId: 'owner2', command: { workspaceStrategy: { branch: 'feat/FIX-2' } }, thread: { ...first.thread!, worktreePath: other, branch: 'feat/FIX-2' } };
    f.store.save(first); f.store.save(second); writeFileSync(join(f.path, 'file'), 'keep this dirty work');
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target, { projectId: 'p', path: other }], reason: 'Review per-item outcomes' }, 'fixture', f.boundary);
    assert.equal(result.state, 'failed'); assert.deepEqual(result.outcomes.map((o: any) => o.state), ['failed', 'confirmed']);
    assert.ok(existsSync(f.path)); assert.equal(existsSync(other), false); assert.ok(f.store.job('job2')?.workspaceCleanedAt); assert.equal(f.calls[0], 1);
  } finally { f.close(); }
});

for (const uncertain of [false, true]) test(`action-only cleanup remains in inventory after restart: ${uncertain ? 'uncertain' : 'confirmed'}`, async () => {
  const f = fixture(); try {
    const review = await f.review(); if (uncertain) f.lostAfter();
    const action = await f.force(review); assert.equal(action.state, uncertain ? 'uncertain' : 'confirmed');
    f.restart();
    const inventory = await cleanupInventory(f.c, f.store, f.t3), row = inventory.items.find(i => i.path === f.path);
    assert.ok(row, 'an action-only workspace remains visible after its directory and Git registration are absent');
    assert.equal(row.present, false); assert.equal(row.registered, false);
    assert.equal(row.state, uncertain ? 'blocked' : 'complete');
    assert.equal(row.lastAttempt, action.updatedAt);
    const sorted = await cleanupInventory(f.c, f.store, f.t3, 0, 50, undefined, { sort: 'attempt' });
    assert.equal(sorted.items[0].path, f.path);
    assert.equal(inventory.counts.complete, uncertain ? 0 : 1);
    assert.equal(inventory.present, 1, 'only the primary checkout remains physically present');
  } finally { f.close(); }
});

test('an uncertain batch holds only targets with an unresolved outcome', async () => {
  const f = fixture(); try {
    const at = new Date().toISOString(), other = join(f.dir, 'uncertain-tree');
    f.store.saveCleanupAction({ id: randomUUID(), input: {}, operator: 'fixture', reason: 'Mixed batch', state: 'uncertain', requestedAt: at, updatedAt: at,
      targets: [f.target, { projectId: 'p', path: other }], outcomes: [{ path: f.path, state: 'failed', message: 'Preflight refused without a mutation' }, { path: other, state: 'uncertain', message: 'Transport response lost' }] });
    const action = await f.force(await f.review());
    assert.equal(action.state, 'confirmed', 'a known failed target can be reviewed again without replaying the uncertain target');
    assert.equal(f.calls[0], 1); assert.equal(f.store.cleanupActions().find(a => a.reason === 'Mixed batch')?.state, 'uncertain');
  } finally { f.close(); }
});

test('physical inspection respects its own deadline when no caller signal is provided', async t => {
  const f = fixture(); try {
    const deadline = new AbortController(); deadline.abort();
    t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
    await assert.rejects(inspectWorkspace(f.repo, f.path, true), /abort/i, 'an expired inspection deadline must refuse the read even outside the review planner');
    assert.ok(existsSync(f.path)); assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); }
});

for (const scenario of ['filesystem-work', 'history-scale', 'cancellation'] as const) test(`large cleanup inventory: ${scenario}`, async t => {
  const f = fixture(), count = scenario === 'history-scale' ? 806 : 128; let immediate: NodeJS.Immediate | undefined;
  try {
    f.inventoryRecords(count);
    const original = fs.realpathSync, cancel = new AbortController(); let reads = 0, scheduled = false;
    t.mock.method(fs, 'realpathSync', (...args: any[]) => {
      reads++;
      if (scenario === 'cancellation' && args[0] === f.dir && !scheduled) { scheduled = true; immediate = setImmediate(() => cancel.abort()); }
      return (original as any)(...args);
    });
    syncBuiltinESMExports();
    if (scenario === 'cancellation') {
      await assert.rejects(cleanupInventory(f.c, f.store, f.t3, 0, 100, cancel.signal), /abort/i, 'an inventory read must yield so cancellation is handled before the scan completes');
      assert.ok(scheduled);
    } else {
      const inventory = await cleanupInventory(f.c, f.store, f.t3, 0, 100);
      assert.equal(inventory.total, count + 2, 'every historical path and both Git worktrees remain in the inventory');
      assert.equal(inventory.counts.missing, count);
      for (const item of inventory.items.filter(i => i.path.includes('/inventory-'))) { assert.equal(item.jobs.length, 1); assert.equal(item.bindings.length, 1); }
      t.diagnostic(`${count} jobs/bindings: ${reads} filesystem path resolutions`);
      assert.ok(reads <= 20 * (count * 2 + 2), `path normalization must stay linear in jobs and bindings; observed ${reads} filesystem reads for ${count} of each`);
    }
    assert.deepEqual(f.calls, [0, 0]);
  } finally { if (immediate) clearImmediate(immediate); t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});
