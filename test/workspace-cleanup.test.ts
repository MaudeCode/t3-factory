import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcile } from '../src/scheduler.ts';
import { Store, type Job } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import type { T3, Kaneo } from '../src/clients.ts';
import { v2Thread } from './v2-fixture.ts';

for (const scenario of ['clean', 'renamed', 'renamed-stale-metadata', 'new-completion', 'settled', 'monitor', 'dirty', 'extra-commit', 'active', 'waiting', 'shared', 'resumed', 'unmerged', 'not-done', 'primary', 'process', 'dry-run', 'retry', 'retry-unusual-error', 'retry-detach', 'resumed-after-detach', 'dirty-after-detach', 'branch-change-after-detach', 'path-change-after-detach', 'race-before-remove', 'discovery'] as const) {
  test(`completed workspace cleanup: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-cleanup-')), repo = join(dir, 'repo'), tree = join(dir, 'tree'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'merged\n'); git('add', 'file');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'merged');
    const head = git('rev-parse', 'HEAD'), branch = 'chore/FIX-1-factory';
    git('update-ref', 'refs/remotes/origin/main', head); git('worktree', 'add', '-qb', branch, tree);
    const realTree = realpathSync(tree);
    const mergedBranch = scenario.startsWith('renamed') ? 'fix/FIX-1-delivery' : branch;
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ state: scenario === 'unmerged' ? 'OPEN' : 'MERGED', headRefName: mergedBranch, headRefOid: head, baseRefName: 'main', mergeCommit: { oid: head } })}'\n`, { mode: 0o755 });
    const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
    const store = new Store(join(dir, 'state'));
    const project = { kaneoId: 'project', t3Id: 't3-project', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', doneStatuses: ['done'] };
    const c = { monitoringTimeoutMinutes: 30, projects: [project] } as Config;
    const job: Job = { id: 'job', kind: scenario === 'discovery' ? 'discovery' : 'ticket', projectId: 'project', taskId: 'task', ticketKey: 'FIX-1', threadId: 'thread', messageId: 'initial', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Verified complete', lastPersonalActivity: null, reportPath: join(dir, 'report.json'), prUrls: ['https://github.com/fixture/repo/pull/1'], command: { workspaceStrategy: { type: 'worktree', branch } } };
    const thread = v2Thread({ id: job.threadId, projectId: project.t3Id, branch, worktreePath: tree, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, latestRunCompletedAt: job.createdAt, status: 'completed', activeRunId: null });
    let threads = [thread], attempts = 0, detachAttempts = 0, shellReads = 0;
    const commands: any[] = [];
    const t3 = { shell: async () => { if (scenario === 'race-before-remove' && ++shellReads === 3) thread.updatedAt = thread.latestUserMessageAt = '2026-01-03T00:00:00Z'; return { threads }; }, dispatch: async (command: any) => { commands.push(command); if (command.type === 'thread.stop') { thread.pendingBackgroundTasks = []; return; } assert.equal(command.expectedWorktreePath, tree); detachAttempts++; if (scenario === 'retry-detach' && detachAttempts === 1) throw new Error('temporary detach failure'); thread.worktreePath = null; thread.branch = null; }, removeWorktree: async (cwd: string, path: string) => {
      attempts++; assert.equal(cwd, repo); assert.equal(path, realTree);
      if (scenario === 'retry' && attempts === 1) throw new Error('temporary removal failure');
      if (scenario === 'retry-unusual-error' && attempts === 1) { const error = new Error(); Object.defineProperty(error, 'message', { value: undefined }); throw error; }
      git('worktree', 'remove', path);
    } } as unknown as T3;
    const kaneo = { call: async () => ({ id: 'task', projectId: 'project', number: 1, title: 'Fixture', createdAt: job.createdAt, priority: 'low', status: scenario === 'not-done' ? 'to-do' : 'done' }) } as unknown as Kaneo;
    let childProcess: ReturnType<typeof spawn> | undefined;
    try {
      if (scenario.startsWith('renamed')) { execFileSync('git', ['-C', tree, 'branch', '-m', mergedBranch]); if (scenario === 'renamed') thread.branch = mergedBranch; }
      if (scenario === 'new-completion') { job.state = 'running'; job.completedAt = null; writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'complete', reason: 'Merged', prUrls: job.prUrls, createdTaskIds: [] })); }
      if (scenario === 'settled') thread.settledOverride = 'settled';
      if (scenario === 'monitor') thread.pendingBackgroundTasks = [{ taskId: 'pr-watch', kind: 'monitor' }];
      if (scenario === 'dirty') writeFileSync(join(tree, 'untracked'), 'keep me');
      if (scenario === 'extra-commit') { writeFileSync(join(tree, 'file'), 'new work'); execFileSync('git', ['-C', tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'unmerged']); }
      if (scenario === 'active') { thread.status = 'running'; thread.activeRunId = 'live-run'; }
      if (scenario === 'waiting') { thread.status = 'waiting'; thread.pendingRuntimeRequest = { kind: 'user_input', createdAt: job.createdAt }; }
      if (scenario === 'shared') threads.push(v2Thread({ ...thread, id: 'another-thread' }));
      if (scenario === 'resumed') thread.latestUserMessageAt = '2026-01-03T00:00:00Z';
      if (scenario === 'primary') thread.worktreePath = repo;
      if (scenario === 'process') { childProcess = spawn('sleep', ['60'], { cwd: tree }); await once(childProcess, 'spawn'); }
      store.save(job);
      await reconcile(c, store, t3, kaneo, threads, scenario !== 'dry-run');
      if (scenario === 'resumed-after-detach') thread.latestUserMessageAt = '2026-01-03T00:00:00Z';
      if (scenario === 'dirty-after-detach') writeFileSync(join(tree, 'untracked'), 'new work');
      if (scenario === 'branch-change-after-detach') execFileSync('git', ['-C', tree, 'switch', '-qc', 'unrelated-work']);
      if (scenario === 'path-change-after-detach') thread.worktreePath = repo;
      await reconcile(c, store, t3, kaneo, threads, scenario !== 'dry-run');
      if (scenario === 'retry' || scenario === 'retry-unusual-error') { assert.equal(existsSync(tree), true); await reconcile(c, store, t3, kaneo, threads); }
      if (scenario === 'new-completion' || scenario === 'retry-detach' || scenario === 'monitor') await reconcile(c, store, t3, kaneo, threads);
      const removed = ['clean', 'renamed', 'renamed-stale-metadata', 'new-completion', 'settled', 'monitor', 'retry', 'retry-unusual-error', 'retry-detach', 'discovery'].includes(scenario);
      assert.equal(existsSync(tree), !removed, 'remove only a verified complete, clean, unchanged and inactive worktree');
      assert.equal(store.jobs()[0].state, scenario === 'settled' ? 'dismissed' : 'complete', 'cleanup preserves completion history and explicit settling');
      if (removed) {
        assert.equal(thread.worktreePath, null); assert.equal(thread.branch, null);
        assert.ok(!git('worktree', 'list', '--porcelain').includes(tree));
        const count = attempts; await reconcile(c, store, t3, kaneo, threads); assert.equal(attempts, count, 'successful cleanup is idempotent');
      }
      assert.ok(existsSync(repo), 'preserve the primary checkout');
    } finally {
      if (childProcess) { childProcess.kill(); await once(childProcess, 'exit'); }
      store.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true });
    }
  });
}
