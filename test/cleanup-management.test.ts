import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { manageCleanup, inspectCleanup, cleanupInventory, readCleanupCatalog, refreshCleanupCatalog } from '../src/cleanup.ts';
import { Store, type Job } from '../src/store.ts';
import { cleanupNextWorkspace } from '../src/scheduler.ts';
import { inspectWorkspace, removeWorkspace } from '../src/workspace.ts';
import type { Config } from '../src/config.ts';
import type { T3, Kaneo } from '../src/clients.ts';
import { v2Thread, v2Projection } from './v2-fixture.ts';

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-manager-'))), repo = join(dir, 'repo'), path = join(dir, 'tree'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, '.gitignore'), 'ignored\n'); writeFileSync(join(repo, 'file'), 'released\n'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'released');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD')); git('remote', 'add', 'origin', repo); git('worktree', 'add', '-qb', 'feat/FIX-1', path);
  let store = new Store(join(dir, 'state'));
  const c = { enabled: false, monitoringTimeoutMinutes: 30, projects: [{ kaneoId: 'p', t3Id: 't3', repoPath: repo, baseBranch: 'main', doneStatuses: ['done'] }] } as Config;
  let threads: ReturnType<typeof v2Thread>[] = [], removeCalls = 0, detachCalls = 0, unknown = false, queued = false, removeError = false, lostAfter = false;
  let onShell: (() => void) | undefined, terminalList: any[] = []; const closes: { threadId: string; terminalId: string }[] = [];
  const t3 = { shell: async () => { onShell?.(); if (unknown) throw { _tag: 'EnvironmentAuthorizationError', detail: 'Missing terminal:read scope' }; return { threads, projects: [{ id: 't3', workspaceRoot: repo }] }; },
    request: async (url: string) => ({ projection: v2Projection(threads.find(t => url.includes(`/threads/${t.id}/`))!, { runs: queued ? [{ status: 'queued' }] : [], runtimeRequests: [], messages: [], providerThreads: [], subagents: [] }) }),
    terminals: async () => terminalList, closeTerminal: async (threadId: string, terminalId: string) => { closes.push({ threadId, terminalId }); terminalList = terminalList.filter(t => t.terminalId !== terminalId); }, dispatch: async (command: any) => { detachCalls++; const thread = threads.find(t => t.id === command.threadId)!; assert.equal(command.expectedWorktreePath, thread.worktreePath); thread.worktreePath = thread.branch = null; },
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
    terminal: (busy: boolean) => { terminalList = [{ threadId: 'owner', terminalId: 'setup-shell', cwd: path, worktreePath: path, status: 'running', pid: 1, hasRunningSubprocess: busy, label: 'fish', updatedAt: '2026-01-01T00:00:00Z' }]; }, closes,
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


test('workflow views separate retained directories from protected and historical records before pagination', async () => {
  const f = fixture(); try {
    f.inventoryRecords(3);
    const old = f.store.jobs()[0]; old.workspaceCleanedAt = '2026-01-03T00:00:00Z'; f.store.save(old);
    const result = await cleanupInventory(f.c, f.store, f.t3, 0, 1, undefined, { view: 'retained' });
    assert.equal(result.total, 1, 'retained view excludes primary, missing and already-removed records');
    assert.equal(result.items[0].path, f.path);
    assert.deepEqual(result.views, { retained: 1, protected: 1, missing: 2, removed: 1 });
    for (const [view, total] of [['protected', 1], ['missing', 2], ['removed', 1]] as const) {
      const page = await cleanupInventory(f.c, f.store, f.t3, 0, 1, undefined, { view });
      assert.equal(page.total, total); assert.equal(page.items.length, 1);
    }
    assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); }
});


test('disk inventory identifies shared filesystems instead of presenting free space as separate per-repository capacity', async () => {
  const f = fixture(), other = fixture(); try {
    f.c.projects.push({ ...other.c.projects[0], kaneoId: 'other', t3Id: 'other' });
    const result = await cleanupInventory(f.c, f.store, f.t3);
    const filesystems = result.filesystems;
    assert.equal(filesystems.length, 1, 'two repositories on the same filesystem have one disk-space observation');
    assert.deepEqual(filesystems[0].repositories.sort(), [f.repo, other.repo].sort());
    assert.ok(filesystems[0].freeBytes != null && filesystems[0].freeBytes > 0);
    assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); other.close(); }
});


test('read-only checks summarize ignored directories without expanding every dependency file', async () => {
  const f = fixture(); try {
    const ignored = join(f.path, 'ignored'); mkdirSync(ignored);
    for (let i = 0; i < 18000; i++) writeFileSync(join(ignored, `${i}-${'x'.repeat(230)}`), '');
    await assert.doesNotReject(async () => {
      const workspace = await inspectWorkspace(f.repo, f.path);
      assert.equal(workspace.ignored, 1, 'the ignored dependency directory is one summarized entry');
      assert.deepEqual(workspace.changes, [{ kind: '!!', path: 'ignored/' }]);
      assert.ok(workspace.status, 'normal removal still preserves ignored contents');
    }, 'a cheap check must not fail because an ignored dependency tree exceeds Git output limits');
  } finally { f.close(); }
});


for (const scenario of ['ignored-only', 'tracked-change', 'untracked-change', 'queued', 'resumed'] as const) test(`normal cleanup with ignored files: ${scenario}`, async () => {
  const f = fixture(); try {
    const [owner] = f.owners(); f.store.save(f.job());
    writeFileSync(join(f.path, 'ignored'), 'ignored local data is explicitly disposable');
    if (scenario === 'tracked-change') writeFileSync(join(f.path, 'file'), 'keep tracked work');
    if (scenario === 'untracked-change') writeFileSync(join(f.path, 'new-file'), 'keep untracked work');
    if (scenario === 'queued') f.queued();
    if (scenario === 'resumed') owner.latestUserMessageAt = '2026-01-03T00:00:00Z';
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target], reason: 'Normal cleanup includes ignored files' }, 'fixture', f.boundary);
    assert.equal(result.state, scenario === 'ignored-only' ? 'confirmed' : 'failed', JSON.stringify(result));
    assert.equal(existsSync(f.path), scenario !== 'ignored-only');
    assert.equal(f.calls[0], scenario === 'ignored-only' ? 1 : 0);
  } finally { f.close(); }
});

for (const tracked of [true, false]) test(`ignored-only removal rechecks ${tracked ? 'tracked' : 'untracked'} changes after the final activity callback`, async () => {
  const f = fixture(); try {
    writeFileSync(join(f.path, 'ignored'), 'discard ignored files only');
    await assert.rejects(removeWorkspace(f.repo, f.path, f.t3, false, async () => {
      writeFileSync(join(f.path, tracked ? 'file' : 'new-work'), 'new work must survive');
    }), /dirty|changed|untracked/i);
    assert.ok(existsSync(f.path)); assert.equal(f.calls[0], 0);
  } finally { f.close(); }
});


test('inventory gives each retained row a human reason and one next action before inspection', async () => {
  const f = fixture(); try {
    f.owners(); const job = f.job(); f.store.save(job);
    let row = (await cleanupInventory(f.c, f.store, f.t3)).items.find(i => i.path === f.path)!;
    assert.equal((row as any).next?.group, 'ready', 'finished work with no recorded blocker offers normal removal');
    assert.equal((row as any).next.action, 'remove');
    job.workspaceCleanupError = 'Ticket is no longer Done'; f.store.save(job);
    row = (await cleanupInventory(f.c, f.store, f.t3)).items.find(i => i.path === f.path)!;
    assert.equal((row as any).next.group, 'ready'); assert.equal((row as any).next.action, 'remove');
    assert.match((row as any).next.reason, /merge.*local changes.*checked/i, 'manual deletion verifies current Git evidence instead of trusting historical ticket state');
    assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); }
});


test('disposable ignored contents do not invalidate an explicit deletion review or require a full dependency hash', async () => {
  const f = fixture(); try {
    f.owners(); mkdirSync(join(f.path, 'ignored')); writeFileSync(join(f.path, 'ignored', 'cache'), 'old ignored data');
    const review = await f.review(); assert.equal(review.forceAllowed, true);
    writeFileSync(join(f.path, 'ignored', 'cache'), 'new ignored data'); writeFileSync(join(f.path, 'ignored', 'another'), 'disposable');
    const result = await f.force(review);
    assert.equal(result.state, 'confirmed', 'ignored data is disposable under the approved policy');
    assert.equal(existsSync(f.path), false);
    assert.equal(review.size.bytes, null, 'a skipped ignored tree must not produce a falsely complete size estimate');
  } finally { f.close(); }
});

test('automatic maintenance retry reports a deleted completion thread as a blocker instead of claiming maintenance advanced', async () => {
  const f = fixture(); try {
    f.store.save(f.job());
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'retry', id: randomUUID(), targets: [f.target], reason: 'A missing completion thread prevents automatic maintenance' }, 'fixture', f.boundary);
    assert.equal(result.state, 'failed', 'missing ownership evidence cannot report successful progress');
    assert.match(result.outcomes[0].message, /completion thread.*unavailable/i); assert.ok(existsSync(f.path)); assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); }
});


test('inventory distinguishes a repaired terminal permission from an undated historical cleanup error', async () => {
  const f = fixture(); try {
    f.owners(); const job = f.job(); job.workspaceCleanupError = 'EnvironmentAuthorizationError: The authenticated token is missing required scope: terminal:read.'; f.store.save(job);
    const inventory = await cleanupInventory(f.c, f.store, f.t3), row = inventory.items.find(i => i.path === f.path)!;
    assert.equal(row.next?.group, 'ready', 'a fresh successful terminal snapshot resolves the recorded permission blocker');
    assert.match(row.next!.reason, /terminal.*(?:restored|available|resolved)/i);
    assert.equal(f.store.job(job.id)!.workspaceCleanupError, job.workspaceCleanupError, 'the previous result remains history, not rewritten success');
    assert.equal(row.lastAttempt, null, 'an unknown historical timestamp must not be invented');
    f.t3.terminals = async () => { throw { _tag: 'EnvironmentAuthorizationError', detail: 'Missing terminal:read scope' }; };
    const blocked = await cleanupInventory(f.c, f.store, f.t3);
    assert.equal(blocked.terminalAccess?.state, 'unavailable');
    assert.equal(blocked.items.find(i => i.path === f.path)!.next?.group, 'attention', 'an unresolved live permission failure is still a hold');
    assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); }
});


test('failed normal removals name their blocker and the action that clears it', async () => {
  const f = fixture(); try {
    f.owners(); const job = f.job(); f.store.save(job);
    const record = (message: string) => f.store.saveCleanupAction({ id: randomUUID(), input: { type: 'remove' }, operator: 'fixture', requestedAt: '2026-01-03T00:00:00Z', updatedAt: new Date().toISOString(), state: 'failed', targets: [f.target], reason: 'Remove finished work', outcomes: [{ path: f.path, state: 'failed', message }] });
    const row = async () => (await cleanupInventory(f.c, f.store, f.t3)).items.find(i => i.path === f.path)!.next!;
    record('Workspace HEAD is not verified merged into the remote release branch');
    assert.deepEqual(await row(), { group: 'attention', reason: 'Not merged into the release branch', action: 'force' }, 'a real refusal is not advertised as Unused');
    record('1 tracked changes, 2 untracked files will be lost');
    assert.deepEqual(await row(), { group: 'attention', reason: 'Local changes would be lost', action: 'force' });
    record('Open T3 terminals retain this workspace; A running process is using the worktree');
    assert.equal((await row()).group, 'protected', 'a folder something is using is In use, not a deletion candidate');
    record('Preserve dirty or ignored workspace contents');
    assert.equal((await row()).action, 'remove', 'a refusal under a rule that no longer applies is retried by the next delete');
    assert.ok(existsSync(f.path)); assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); }
});

test('a maintenance step that leaves the worktree present is pending, never confirmed removal', async () => {
  const f = fixture(); try {
    f.owners(); f.store.save(f.job());
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'retry', id: randomUUID(), targets: [f.target], reason: 'Advance one step' }, 'fixture', f.boundary);
    assert.equal(result.state, 'pending', 'a successful step is not successful physical removal');
    assert.equal(result.outcomes[0].state, 'pending'); assert.equal(result.outcomes[0].physicalRemoval, false); assert.ok(existsSync(f.path));
  } finally { f.close(); }
});


for (const scenario of ['orphan', 't3-only', 'shared-idle', 'factory-without-report', 'factory-without-ticket', 'ignored', 'tracked', 'untracked', 'unmerged', 'remote-diverged', 'unknown', 'active', 'queued', 'process', 'resumed', 'resumed-after-detach', 'dirty-after-detach', 'uncertain-removal'] as const) test(`manual unused cleanup verifies Git and live state regardless of Factory ownership: ${scenario}`, async () => {
  const f = fixture(); try {
    const owners = scenario === 'orphan' || scenario === 'remote-diverged' ? [] : f.owners(scenario === 'shared-idle' ? 2 : 1);
    if (scenario.startsWith('factory-') || scenario === 'resumed') {
      const job = f.job(); if (scenario === 'factory-without-ticket') { job.kind = 'ticket'; job.taskId = 'deleted'; f.kaneo.call = async () => { throw new Error('task not found'); }; } f.store.save(job);
    }
    if (scenario === 'ignored') writeFileSync(join(f.path, 'ignored'), 'explicitly disposable');
    if (scenario === 'tracked') writeFileSync(join(f.path, 'file'), 'preserve tracked work');
    if (scenario === 'untracked') writeFileSync(join(f.path, 'untracked'), 'preserve new work');
    if (scenario === 'unmerged') { writeFileSync(join(f.path, 'file'), 'unmerged work'); execFileSync('git', ['-C', f.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'unmerged']); }
    if (scenario === 'remote-diverged') {
      f.git('checkout', '--orphan', 'replacement'); f.git('rm', '-rf', '.'); writeFileSync(join(f.repo, 'replacement'), 'replacement release'); f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'replacement'); f.git('branch', '-f', 'main', 'HEAD');
      assert.notEqual(f.git('rev-parse', 'main'), f.git('rev-parse', 'refs/remotes/origin/main'), 'the remote release differs from the stale local tracking ref');
    }
    if (scenario === 'unknown') f.unknown();
    if (scenario === 'active') { owners[0].activeRunId = 'active'; owners[0].status = 'running'; }
    if (scenario === 'queued') f.queued();
    if (scenario === 'process') f.boundary.processes = async () => [f.path];
    if (scenario === 'resumed') owners[0].latestUserMessageAt = '2026-01-03T00:00:00Z';
    if (scenario === 'resumed-after-detach' || scenario === 'dirty-after-detach') f.race(() => {
      if (owners[0].worktreePath !== null) return;
      if (scenario === 'resumed-after-detach') owners[0].latestUserMessageAt = '2026-01-03T00:00:00Z';
      else writeFileSync(join(f.path, 'file'), 'late work must survive');
    });
    if (scenario === 'uncertain-removal') f.lost();
    const allowed = ['orphan', 't3-only', 'shared-idle', 'factory-without-report', 'factory-without-ticket', 'ignored'].includes(scenario);
    const branchHead = f.git('rev-parse', 'refs/heads/feat/FIX-1'), id = randomUUID();
    const input = { type: 'remove', id, targets: [f.target], reason: 'Delete verified unused worktrees regardless of Factory ownership' };
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, input, 'fixture', f.boundary);
    assert.equal(result.state, allowed ? 'confirmed' : scenario === 'uncertain-removal' ? 'uncertain' : 'failed', JSON.stringify(result));
    assert.equal(existsSync(f.path), !allowed, 'only verified unused worktrees are removed');
    assert.equal(f.calls[0], allowed || scenario === 'uncertain-removal' ? 1 : 0);
    assert.equal(f.git('rev-parse', 'refs/heads/feat/FIX-1'), branchHead, 'the branch ref stays available');
    if (allowed) { assert.equal(result.outcomes[0].physicalRemoval, true); f.restart(); assert.deepEqual(await manageCleanup(f.c, f.store, f.t3, f.kaneo, input, 'fixture', f.boundary), result); assert.equal(f.calls[0], 1, 'restart never repeats deletion'); }
  } finally { f.close(); }
});


test('public inspection offers normal deletion of a clean merged orphan without a Factory report', async () => {
  const f = fixture(); try {
    const detail = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'inspect', ...f.target }, 'fixture', f.boundary);
    assert.equal(detail.state, 'eligible', JSON.stringify(detail.checks));
    assert.equal(detail.jobs.length, 0);
    assert.ok(detail.checks.some((check: any) => check.name === 'Merged HEAD' && check.state === 'pass'));
    assert.deepEqual(f.calls, [0, 0]);
    assert.equal((await cleanupInventory(f.c, f.store, f.t3)).items.find(i => i.path === f.path)!.next!.action, 'remove');
  } finally { f.close(); }
});


test('maintained cleanup inventory survives restart and serves filters without filesystem or network discovery', async t => {
  const f = fixture(); try {
    f.owners(); const job = f.job(); job.state = 'running'; f.store.save(job);
    await refreshCleanupCatalog(f.c, f.store, f.t3);
    const observed = readCleanupCatalog(f.c, f.store).checkedAt;
    job.state = 'complete'; f.store.save(job); f.restart();
    t.mock.method(f.t3, 'shell', async () => { assert.fail('cached page reads cannot call T3'); });
    t.mock.method(f.store, 'jobs', () => { assert.fail('cached page reads cannot deserialize historical dispatch commands'); });
    t.mock.method(fs, 'realpathSync', () => { assert.fail('cached page reads cannot resolve filesystem paths'); }); syncBuiltinESMExports();
    try {
      const page = readCleanupCatalog(f.c, f.store, 0, 1, { view: 'retained', query: 'FIX-1', sort: 'path' });
      assert.equal(page.checkedAt, observed, 'a cache read does not invent a new discovery timestamp');
      assert.equal(page.total, 1); assert.equal(page.items.length, 1); assert.equal(page.items[0].path, f.path);
      assert.equal(page.items[0].jobs[0].state, 'complete', 'finished run state is projected immediately from the ledger');
      assert.notEqual(page.items[0].next!.group, 'protected');
      assert.deepEqual(f.calls, [0, 0]);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  } finally { f.close(); }
});

test('verified removal outcomes update maintained inventory before another discovery scan', async () => {
  const f = fixture(); try {
    await refreshCleanupCatalog(f.c, f.store, f.t3);
    const at = new Date().toISOString();
    f.store.saveCleanupAction({ id: randomUUID(), input: {}, operator: 'fixture', requestedAt: at, updatedAt: at, state: 'confirmed', targets: [f.target], reason: 'Verified fixture outcome', outcomes: [{ path: f.path, state: 'confirmed', physicalRemoval: true, message: 'removed' }] });
    const retained = readCleanupCatalog(f.c, f.store, 0, 50, { view: 'retained' });
    assert.equal(retained.total, 0, 'a known confirmed removal leaves the retained list immediately');
    const gone = readCleanupCatalog(f.c, f.store, 0, 50, { view: 'gone' });
    assert.equal(gone.items.find(item => item.path === f.path)!.present, false);
    assert.equal(gone.staleResults, false, 'known durable outcomes do not force the client to wait for a rescan');
  } finally { f.close(); }
});

test('a failed background discovery preserves the previous catalog and configuration changes invalidate it', async () => {
  const f = fixture(); try {
    await refreshCleanupCatalog(f.c, f.store, f.t3);
    const previous = readCleanupCatalog(f.c, f.store);
    f.unknown(); await refreshCleanupCatalog(f.c, f.store, f.t3);
    const degraded = readCleanupCatalog(f.c, f.store);
    assert.equal(degraded.checkedAt, previous.checkedAt);
    assert.ok(degraded.items.some(item => item.path === f.path)); assert.ok(degraded.errors.length);
    const changed = { ...f.c, projects: [{ ...f.c.projects[0], repoPath: join(f.dir, 'different') }] };
    const invalid = readCleanupCatalog(changed, f.store);
    assert.equal(invalid.checkedAt, ''); assert.equal(invalid.items.length, 0); assert.equal(invalid.refreshing, true);
  } finally { f.close(); }
});


test('offline inventory discovery materializes the same persistent catalog used by page reads', async () => {
  const f = fixture(); try {
    const discovered = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'inventory', view: 'retained' }, 'offline fixture', f.boundary);
    assert.ok(discovered.items.some((item: any) => item.path === f.path)); assert.ok(f.store.get('cleanupCatalog'));
    f.restart(); const cached = readCleanupCatalog(f.c, f.store, 0, 50, { view: 'retained' });
    assert.equal(cached.checkedAt, discovered.checkedAt); assert.equal(cached.total, discovered.total); assert.deepEqual(f.calls, [0, 0]);
  } finally { f.close(); }
});

test('catalog discovery is triggered by lifecycle and removal changes rather than heartbeat bookkeeping', () => {
  const f = fixture(); try {
    let changes = 0; f.store.onCleanupChange = () => { changes++; };
    const job = f.job(); f.store.save(job); assert.equal(changes, 1);
    job.workspaceCleanupAttemptedAt = new Date().toISOString(); job.workspaceCleanupError = 'Still held'; f.store.save(job);
    job.thread!.updatedAt = new Date().toISOString(); f.store.save(job);
    assert.equal(changes, 1, 'retry timestamps and thread heartbeats do not rescan every repository');
    job.state = 'waiting'; f.store.save(job); assert.equal(changes, 2);
    job.state = 'complete'; f.store.save(job); assert.equal(changes, 3);
    job.workspaceCleanedAt = new Date().toISOString(); f.store.save(job); assert.equal(changes, 4);
    const at = new Date().toISOString(), action = { id: randomUUID(), input: {}, operator: 'fixture', requestedAt: at, updatedAt: at, state: 'requested' as const, targets: [f.target], reason: 'Fixture', outcomes: [] as any[] };
    f.store.saveCleanupAction(action); assert.equal(changes, 5);
    action.outcomes.push({ path: f.path, state: 'failed', message: 'Preserved' }); f.store.saveCleanupAction(action);
    assert.equal(changes, 5, 'failed attempts update the ledger without another discovery');
    action.outcomes = [{ path: f.path, state: 'confirmed', physicalRemoval: true, message: 'removed' }]; f.store.saveCleanupAction(action);
    assert.equal(changes, 6, 'verified physical changes request discovery');
  } finally { f.close(); }
});

test('manual deletion recognises a squash-merged branch', async () => {
  const f = fixture(); try {
    f.owners();
    const commit = (cwd: string, message: string) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', message]);
    writeFileSync(join(f.path, 'file'), 'first\n'); commit(f.path, 'first');
    writeFileSync(join(f.path, 'file'), 'second\n'); commit(f.path, 'second');
    const blocked = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target], reason: 'Unmerged yet' }, 'fixture', f.boundary);
    assert.equal(blocked.state, 'failed'); assert.match(blocked.outcomes[0].message, /not verified merged/);
    f.git('merge', '--squash', 'feat/FIX-1'); commit(f.repo, 'squash');
    f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'HEAD'));
    const result = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target], reason: 'Squash merged' }, 'fixture', f.boundary);
    assert.equal(result.state, 'confirmed', JSON.stringify(result.outcomes)); assert.equal(result.outcomes[0].physicalRemoval, true); assert.ok(!existsSync(f.path));
  } finally { f.close(); }
});

test('manual deletion closes idle T3 shells but never a terminal running a command', async () => {
  const f = fixture(); try {
    f.owners(); f.terminal(true);
    const busy = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target], reason: 'Busy shell' }, 'fixture', f.boundary);
    assert.equal(busy.state, 'failed'); assert.match(busy.outcomes[0].message, /terminals/i); assert.equal(f.closes.length, 0); assert.ok(existsSync(f.path));
    f.restart(); f.closes.length = 0; f.terminal(false);
    const idle = await manageCleanup(f.c, f.store, f.t3, f.kaneo, { type: 'remove', id: randomUUID(), targets: [f.target], reason: 'Idle shell' }, 'fixture', f.boundary);
    assert.equal(idle.state, 'confirmed', JSON.stringify(idle.outcomes)); assert.deepEqual(f.closes, [{ threadId: 'owner', terminalId: 'setup-shell' }]); assert.ok(!existsSync(f.path));
  } finally { f.close(); }
});

test('automatic maintenance finalizes a finished job whose worktree is gone instead of retrying it forever', async () => {
  const f = fixture(); try {
    const absent = join(f.dir, 'absent'), noShell = { shell: async () => { throw new Error('Nothing to verify for a vanished worktree'); } } as unknown as T3;
    const ghost = { ...f.job(), id: 'ghost', state: 'dismissed' as const, dismissedAt: '2026-01-02T00:00:00Z', thread: { ...f.job().thread!, worktreePath: absent } };
    const orphaned = { ...ghost, id: 'orphaned', projectId: 'removed-project' };
    f.store.save(ghost); f.store.save(orphaned);
    for (const job of [ghost, orphaned]) assert.equal(await cleanupNextWorkspace(f.c, f.store, noShell, f.kaneo, new Set()), true);
    assert.ok(f.store.job('ghost')!.workspaceCleanedAt); assert.ok(f.store.job('orphaned')!.workspaceCleanedAt);
    assert.equal(await cleanupNextWorkspace(f.c, f.store, noShell, f.kaneo, new Set()), false, 'nothing is left to retry');
    rmSync(f.path, { recursive: true });
    const registered = { ...ghost, id: 'registered', thread: { ...ghost.thread, worktreePath: f.path } }; f.store.save(registered);
    await cleanupNextWorkspace(f.c, f.store, noShell, f.kaneo, new Set());
    assert.ok(!f.store.job('registered')!.workspaceCleanedAt, 'a stale Git registration still needs real cleanup'); assert.ok(f.store.job('registered')!.workspaceCleanupError);
    const kept = { ...orphaned, id: 'kept', thread: { ...ghost.thread, worktreePath: f.repo } }; f.store.save(kept);
    await cleanupNextWorkspace(f.c, f.store, noShell, f.kaneo, new Set());
    assert.match(f.store.job('kept')!.workspaceCleanupError!, /no longer configured/); assert.notEqual(JSON.parse(f.store.get('cleanupMaintenance')!).state, 'blocked', 'an unconfigured project does not alarm maintenance');
  } finally { f.close(); }
});
