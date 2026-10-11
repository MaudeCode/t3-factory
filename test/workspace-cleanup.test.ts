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

for (const scenario of ['clean', 'renamed', 'renamed-stale-metadata', 'new-completion', 'settled', 'monitor', 'dirty', 'extra-commit', 'active', 'waiting', 'shared', 'resumed', 'unmerged', 'not-done', 'primary', 'process', 'dry-run', 'retry', 'retry-unusual-error', 'retry-detach', 'resumed-after-detach', 'dirty-after-detach', 'branch-change-after-detach', 'path-change-after-detach', 'race-before-remove', 'discovery', 'pushed-under-other-name', 'pushed-under-other-name-extra-commit', 'pushed-under-other-name-dirty', 'pushed-under-other-name-unmerged', 'missing-unregistered-worktree', 'missing-registered-worktree', 'idle-terminal', 'busy-terminal', 'starting-terminal', 'other-thread-terminal', 'terminal-snapshot-failure', 'idle-subagent', 'active-subagent', 'waiting-subagent', 'resumed-subagent', 'foreign-subagent', 'grandchild-subagent', 'monitor-subagent'] as const) {
  test(`completed workspace cleanup: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-cleanup-')), repo = join(dir, 'repo'), tree = join(dir, 'tree'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'merged\n'); git('add', 'file');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'merged');
    const head = git('rev-parse', 'HEAD'), branch = 'chore/FIX-1-factory';
    git('update-ref', 'refs/remotes/origin/main', head); git('worktree', 'add', '-qb', branch, tree);
    const realTree = realpathSync(tree);
    const mergedBranch = scenario.startsWith('renamed') || scenario.startsWith('pushed') || scenario.startsWith('missing') ? 'fix/FIX-1-delivery' : branch;
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ state: scenario.endsWith('unmerged') ? 'OPEN' : 'MERGED', headRefName: mergedBranch, headRefOid: head, baseRefName: 'main', mergeCommit: { oid: head } })}'\n`, { mode: 0o755 });
    const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
    const store = new Store(join(dir, 'state'));
    const project = { kaneoId: 'project', t3Id: 't3-project', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', doneStatuses: ['done'] };
    const c = { monitoringTimeoutMinutes: 30, projects: [project] } as Config;
    const job: Job = { id: 'job', kind: scenario === 'discovery' ? 'discovery' : 'ticket', projectId: 'project', taskId: 'task', ticketKey: 'FIX-1', threadId: 'thread', messageId: 'initial', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Verified complete', lastPersonalActivity: null, reportPath: join(dir, 'report.json'), prUrls: ['https://github.com/fixture/repo/pull/1'], command: { workspaceStrategy: { type: 'worktree', branch } } };
    const thread = v2Thread({ id: job.threadId, projectId: project.t3Id, branch, worktreePath: tree, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, latestRunCompletedAt: job.createdAt, status: 'completed', activeRunId: null });
    let threads = [thread], attempts = 0, detachAttempts = 0, shellReads = 0;
    const commands: any[] = [], closes: any[] = [];
    let terminalReads = 0, terminalProcess: ReturnType<typeof spawn> | undefined;
    const terminal = (threadId: string, status: string, hasRunningSubprocess: boolean) => ({ threadId, terminalId: 'setup-install-dependencies', cwd: tree, worktreePath: tree, status, pid: terminalProcess?.pid ?? 1, exitCode: null, exitSignal: null, hasRunningSubprocess, label: 'fish', updatedAt: job.createdAt });
    const terminals = () => closes.length ? [] : ({
      'idle-terminal': [terminal('thread', 'running', false), terminal('thread', 'exited', false)],
      'busy-terminal': [terminal('thread', 'running', true)], 'starting-terminal': [terminal('thread', 'starting', false)],
      'other-thread-terminal': [terminal('another-thread', 'running', false)], 'dry-run': [terminal('thread', 'running', false)],
    } as Record<string, unknown[]>)[scenario] ?? [];
    const t3 = { shell: async () => { if (scenario === 'race-before-remove' && ++shellReads === 3) thread.updatedAt = thread.latestUserMessageAt = '2026-01-03T00:00:00Z'; return { threads }; }, dispatch: async (command: any) => { commands.push(command); if (command.type === 'thread.stop') { threads.find(t => t.id === command.threadId)!.pendingBackgroundTasks = []; return; } assert.equal(command.expectedWorktreePath, tree); detachAttempts++; if (scenario === 'retry-detach' && detachAttempts === 1) throw new Error('temporary detach failure'); const target = threads.find(t => t.id === command.threadId)!; target.worktreePath = null; target.branch = null; }, removeWorktree: async (cwd: string, path: string) => {
      attempts++; assert.equal(cwd, repo); assert.equal(path, realTree);
      if (scenario === 'retry' && attempts === 1) throw new Error('temporary removal failure');
      if (scenario === 'retry-unusual-error' && attempts === 1) { const error = new Error(); Object.defineProperty(error, 'message', { value: undefined }); throw error; }
      git('worktree', 'remove', path);
    }, terminals: async () => { terminalReads++; if (scenario === 'terminal-snapshot-failure') throw new Error('T3 terminal snapshot unavailable'); return terminals(); },
    closeTerminal: async (threadId: string, terminalId: string) => { closes.push({ threadId, terminalId }); if (terminalProcess) { const exited = once(terminalProcess, 'exit'); terminalProcess.kill(); await exited; } } } as unknown as T3;
    const kaneo = { call: async () => ({ id: 'task', projectId: 'project', number: 1, title: 'Fixture', createdAt: job.createdAt, priority: 'low', status: scenario === 'not-done' ? 'to-do' : 'done' }) } as unknown as Kaneo;
    let childProcess: ReturnType<typeof spawn> | undefined;
    try {
      if (scenario.startsWith('renamed')) { execFileSync('git', ['-C', tree, 'branch', '-m', mergedBranch]); if (scenario === 'renamed') thread.branch = mergedBranch; }
      if (scenario === 'new-completion') { job.state = 'running'; job.completedAt = null; writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'complete', reason: 'Merged', prUrls: job.prUrls, createdTaskIds: [] })); }
      if (scenario === 'settled') thread.settledOverride = 'settled';
      if (scenario === 'monitor') thread.pendingBackgroundTasks = [{ taskId: 'pr-watch', kind: 'monitor' }];
      if (scenario.endsWith('dirty')) writeFileSync(join(tree, 'untracked'), 'keep me');
      if (scenario.endsWith('extra-commit')) { writeFileSync(join(tree, 'file'), 'new work'); execFileSync('git', ['-C', tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'unmerged']); }
      if (scenario === 'active') { thread.status = 'running'; thread.activeRunId = 'live-run'; }
      if (scenario === 'waiting') { thread.status = 'waiting'; thread.pendingRuntimeRequest = { kind: 'user_input', createdAt: job.createdAt }; }
      if (scenario === 'shared') threads.push(v2Thread({ ...thread, id: 'another-thread' }));
      if (scenario === 'resumed') thread.latestUserMessageAt = '2026-01-03T00:00:00Z';
      if (scenario === 'primary') thread.worktreePath = repo;
      if (scenario === 'missing-unregistered-worktree') git('worktree', 'remove', tree);
      if (scenario === 'missing-registered-worktree') rmSync(tree, { recursive: true });
      const subagent = (id: string, parentThreadId: string, overrides: Record<string, unknown> = {}) => v2Thread({ ...thread, id, status: 'idle', lineage: { rootThreadId: 'thread', parentThreadId, relationshipToParent: 'subagent' }, ...overrides });
      if (scenario === 'idle-subagent') threads.push(subagent('subagent', thread.id));
      if (scenario === 'active-subagent') threads.push(subagent('subagent', thread.id, { status: 'running', activeRunId: 'subagent-run' }));
      if (scenario === 'waiting-subagent') threads.push(subagent('subagent', thread.id, { status: 'waiting', pendingRuntimeRequest: { kind: 'user_input', createdAt: job.createdAt } }));
      if (scenario === 'resumed-subagent') threads.push(subagent('subagent', thread.id, { latestRunCompletedAt: '2026-01-03T00:00:00Z' }));
      if (scenario === 'foreign-subagent') threads.push(v2Thread({ ...thread, id: 'other-parent', worktreePath: null }), subagent('subagent', 'other-parent'));
      if (scenario === 'grandchild-subagent') threads.push(subagent('subagent', thread.id), subagent('grandchild', 'subagent'));
      if (scenario === 'monitor-subagent') threads.push(subagent('subagent', thread.id, { pendingBackgroundTasks: [{ taskId: 'pr-watch', kind: 'monitor' }] }));
      if (scenario === 'process') { childProcess = spawn('sleep', ['60'], { cwd: tree }); await once(childProcess, 'spawn'); }
      if (scenario.endsWith('-terminal')) { terminalProcess = spawn('sleep', ['60'], { cwd: tree }); await once(terminalProcess, 'spawn'); }
      store.save(job);
      await reconcile(c, store, t3, kaneo, threads, scenario !== 'dry-run');
      if (scenario === 'resumed-after-detach') thread.latestUserMessageAt = '2026-01-03T00:00:00Z';
      if (scenario === 'dirty-after-detach') writeFileSync(join(tree, 'untracked'), 'new work');
      if (scenario === 'branch-change-after-detach') execFileSync('git', ['-C', tree, 'switch', '-qc', 'unrelated-work']);
      if (scenario === 'path-change-after-detach') thread.worktreePath = repo;
      await reconcile(c, store, t3, kaneo, threads, scenario !== 'dry-run');
      if (scenario === 'retry' || scenario === 'retry-unusual-error') { assert.equal(existsSync(tree), true); await reconcile(c, store, t3, kaneo, threads); }
      if (scenario === 'new-completion' || scenario === 'retry-detach' || scenario === 'monitor' || scenario.includes('terminal') || scenario.endsWith('subagent')) await reconcile(c, store, t3, kaneo, threads);
      if (scenario === 'monitor-subagent') await reconcile(c, store, t3, kaneo, threads);
      const removed = ['clean', 'renamed', 'renamed-stale-metadata', 'new-completion', 'settled', 'monitor', 'retry', 'retry-unusual-error', 'retry-detach', 'discovery', 'pushed-under-other-name', 'missing-unregistered-worktree', 'missing-registered-worktree', 'idle-terminal', 'idle-subagent', 'grandchild-subagent', 'monitor-subagent'].includes(scenario);
      if (removed) assert.equal(store.jobs()[0].workspaceCleanupError, undefined, 'cleanup completes without a recorded error');
      if (scenario === 'idle-terminal') assert.deepEqual(closes, [{ threadId: 'thread', terminalId: 'setup-install-dependencies' }], 'close only the thread\'s idle live terminal, once');
      else assert.deepEqual(closes, [], 'never close a busy, starting, or foreign terminal');
      if (scenario === 'busy-terminal' || scenario === 'starting-terminal') assert.equal(store.jobs()[0].workspaceCleanupError, 'A T3 terminal for this thread is still running a command');
      if (scenario === 'other-thread-terminal') assert.equal(store.jobs()[0].workspaceCleanupError, 'A running process is still using the workspace');
      if (scenario === 'terminal-snapshot-failure') assert.equal(store.jobs()[0].workspaceCleanupError, 'T3 terminal snapshot unavailable');
      if (scenario === 'dry-run') assert.equal(terminalReads, 0, 'dry runs send no terminal RPCs');
      assert.equal(existsSync(tree), !removed, 'remove only a verified complete, clean, unchanged and inactive worktree');
      assert.equal(store.jobs()[0].state, scenario === 'settled' ? 'dismissed' : 'complete', 'cleanup preserves completion history and explicit settling');
      if (removed) {
        assert.equal(thread.worktreePath, null); assert.equal(thread.branch, null);
        assert.ok(!git('worktree', 'list', '--porcelain').includes(realTree)); assert.ok(store.jobs()[0].workspaceCleanedAt);
        if (scenario.startsWith('missing')) assert.equal(attempts, scenario === 'missing-registered-worktree' ? 1 : 0, 'remove only a workspace Git still registers');
        const count = attempts; await reconcile(c, store, t3, kaneo, threads); assert.equal(attempts, count, 'successful cleanup is idempotent');
      }
      if (scenario.endsWith('subagent')) {
        const detached = commands.filter(command => command.type === 'thread.metadata.update').map(command => command.threadId);
        const owned = scenario === 'grandchild-subagent' ? ['subagent', 'grandchild'] : ['subagent'];
        assert.deepEqual(commands.filter(command => command.type === 'thread.stop').map(command => command.threadId), scenario === 'monitor-subagent' ? ['subagent'] : [], 'stop owned subagent monitors before detaching');
        if (removed) {
          assert.deepEqual(detached, [...owned, 'thread'], 'detach owned subagents before the job thread');
          for (const id of owned) assert.equal(threads.find(t => t.id === id)!.worktreePath, null);
        } else {
          assert.deepEqual(detached, [], 'detach nothing while the workspace is not owned and idle');
          assert.equal(store.jobs()[0].workspaceCleanupError, scenario === 'foreign-subagent' ? 'Workspace is shared with another thread' : 'Workspace is shared with an active subagent');
        }
      }
      assert.ok(existsSync(repo), 'preserve the primary checkout');
    } finally {
      for (const child of [childProcess, terminalProcess]) if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
      store.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true });
    }
  });
}
