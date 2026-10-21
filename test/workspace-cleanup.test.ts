import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcile, cleanupNextWorkspace, busyProviders } from '../src/scheduler.ts';
import { Store, type Job } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import { T3, type Kaneo } from '../src/clients.ts';
import { publicStopCommand, v2Projection, v2Thread } from './v2-fixture.ts';

const commandScenarios = ['command', 'command-lifecycle', 'command-todos', 'command-dismissed', 'command-settled-running', 'command-settled-resumed', 'command-pending', 'command-error', 'command-rejected', 'command-process', 'command-missing-report', 'command-invalid-report', 'command-awaiting-report', 'command-not-done', 'command-unmerged', 'command-race-run', 'command-race-request', 'command-race-queued', 'command-race-message', 'command-race-worker', 'command-race-child', 'command-race-shared', 'command-race-owner', 'command-race-binding', 'command-race-dirty', 'command-race-report', 'command-bounded-unavailable', 'command-bounded-request', 'command-bounded-message', 'command-bounded-worker', 'command-bounded-child', 'command-mixed-monitor'] as const;

for (const mode of ['direct', 'deferred'] as const) for (const scenario of ['clean', 'settled-report', 'renamed', 'renamed-stale-metadata', 'new-completion', 'settled', 'monitor', 'dirty', 'extra-commit', 'active', 'waiting', 'shared', 'resumed', 'unmerged', 'not-done', 'primary', 'process', 'dry-run', 'retry', 'retry-unusual-error', 'retry-detach', 'resumed-after-detach', 'dirty-after-detach', 'branch-change-after-detach', 'path-change-after-detach', 'race-before-remove', 'discovery', 'pushed-under-other-name', 'pushed-under-other-name-extra-commit', 'pushed-under-other-name-dirty', 'pushed-under-other-name-unmerged', 'missing-unregistered-worktree', 'missing-registered-worktree', 'idle-terminal', 'busy-terminal', 'starting-terminal', 'other-thread-terminal', 'terminal-snapshot-failure', 'idle-subagent', 'active-subagent', 'waiting-subagent', 'resumed-subagent', 'foreign-subagent', 'grandchild-subagent', 'monitor-subagent', 'no-pr', 'no-pr-not-done', 'no-pr-extra-commit', 'no-pr-dirty', 'orphaned-run', 'orphaned-run-subagent', ...commandScenarios] as const) {
  test(`completed workspace cleanup: ${mode}: ${scenario}`, async () => {
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
    let store = new Store(join(dir, 'state'));
    const project = { kaneoId: 'project', t3Id: 't3-project', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', doneStatuses: ['done'] };
    const c = { monitoringTimeoutMinutes: 30, projects: [project] } as Config;
    const job: Job = { id: 'job', kind: scenario === 'discovery' ? 'discovery' : 'ticket', projectId: 'project', taskId: 'task', ticketKey: 'FIX-1', threadId: 'thread', messageId: 'initial', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Verified complete', lastPersonalActivity: null, reportPath: join(dir, 'report.json'), prUrls: scenario.startsWith('no-pr') ? [] : ['https://github.com/fixture/repo/pull/1'], command: { workspaceStrategy: { type: 'worktree', branch } } };
    const thread = v2Thread({ id: job.threadId, projectId: project.t3Id, branch, worktreePath: tree, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, latestRunCompletedAt: job.createdAt, status: 'completed', activeRunId: null });
    const isCommand = scenario.startsWith('command');
    let threads = [thread], attempts = 0, detachAttempts = 0, shellReads = 0;
    const commands: any[] = [], closes: any[] = [];
    let terminalReads = 0, terminalProcess: ReturnType<typeof spawn> | undefined;
    const terminal = (threadId: string, status: string, hasRunningSubprocess: boolean) => ({ threadId, terminalId: 'setup-install-dependencies', cwd: tree, worktreePath: tree, status, pid: terminalProcess?.pid ?? 1, exitCode: null, exitSignal: null, hasRunningSubprocess, label: 'fish', updatedAt: job.createdAt });
    const terminals = () => closes.length ? [] : ({
      'idle-terminal': [terminal('thread', 'running', false), terminal('thread', 'exited', false)],
      'busy-terminal': [terminal('thread', 'running', true)], 'starting-terminal': [terminal('thread', 'starting', false)],
      'other-thread-terminal': [terminal('another-thread', 'running', false)], 'dry-run': [terminal('thread', 'running', false)],
    } as Record<string, unknown[]>)[scenario] ?? [];
    const t3 = { stop: T3.prototype.stop, request: async (path: string) => {
      if (scenario === 'command-bounded-unavailable') throw new Error('Bounded state unavailable');
      if (scenario === 'command-race-run') thread.activeRunId = 'resumed';
      if (scenario === 'command-race-request') thread.pendingRuntimeRequest = { kind: 'dynamic_tool_call', createdAt: thread.updatedAt };
      if (scenario === 'command-race-message') thread.latestUserMessageAt = '2026-01-03T00:00:00Z';
      if (scenario === 'command-race-worker') thread.pendingBackgroundTasks.push({ taskId: 'worker', kind: 'future_kind' });
      if (scenario === 'command-race-child') threads.push(v2Thread({ id: 'child', lineage: { parentThreadId: thread.id, relationshipToParent: 'subagent' }, activeRunId: 'child-run' }));
      if (scenario === 'command-race-shared') threads.push(v2Thread({ ...thread, id: 'foreign' }));
      if (scenario === 'command-race-owner') { const changed = store.job(job.id)!; changed.threadId = 'foreign'; store.save(changed); }
      if (scenario === 'command-race-binding') thread.worktreePath = repo;
      if (scenario === 'command-race-dirty') writeFileSync(join(tree, 'new-work'), 'keep');
      if (scenario === 'command-race-report') writeFileSync(job.reportPath, '{}');
      return { projection: v2Projection(threads.find(t => path.includes(`/threads/${t.id}/`))!, {
        runs: isCommand ? [{ id: 'completed-run', status: 'completed' }, ...(scenario === 'command-race-queued' ? [{ id: 'follow-up', status: 'queued' }] : [])] : [],
        providerThreads: isCommand ? [{ id: 'provider', pendingBackgroundTasks: scenario === 'command-todos' ? [] : thread.pendingBackgroundTasks }] : [],
        messages: scenario === 'command-bounded-message' ? [{ role: 'user', createdAt: '2026-01-03T00:00:00Z' }] : [], runtimeRequests: scenario === 'command-bounded-request' ? [{ status: 'pending', resolvedAt: null }] : [], turnItems: scenario === 'command-bounded-worker' ? [{ type: 'future_kind', status: 'running' }] : scenario === 'command-todos' ? [{ type: 'todo_list', status: 'running' }, { type: 'command_execution', status: 'running' }, { type: 'command_execution', status: 'running' }, { type: 'todo_list', status: 'running' }] : [], subagents: scenario === 'command-bounded-child' ? [{ status: 'running' }] : [],
      }) };
    }, shell: async () => { if (++shellReads === 3 && scenario === 'race-before-remove') thread.updatedAt = thread.latestUserMessageAt = '2026-01-03T00:00:00Z'; return { threads }; }, dispatch: async (command: any) => { commands.push(command); if (command.type === 'run.interrupt') { publicStopCommand.parse(command); if (scenario === 'command-error') throw new Error('Transport outcome unknown'); if (scenario === 'command-rejected') throw { _tag: 'CommandRejected', detail: 'Request was rejected' }; return; } if (command.type === 'thread.pull-request.watch') { publicStopCommand.parse(command); threads.find(t => t.id === command.threadId)!.pendingBackgroundTasks = []; return; } assert.equal(command.expectedWorktreePath, tree); detachAttempts++; if (scenario === 'retry-detach' && detachAttempts === 1) throw new Error('temporary detach failure'); const target = threads.find(t => t.id === command.threadId)!; target.worktreePath = null; target.branch = null; }, removeWorktree: async (cwd: string, path: string) => {
      attempts++; assert.equal(cwd, repo); assert.equal(path, realTree);
      if (scenario === 'retry' && attempts === 1) throw { _tag: 'GitCommandError', operation: 'removeWorktree', command: 'git worktree remove', cwd, detail: 'temporary removal failure' }; // T3's RPC error, decoded as a plain object
      if (scenario === 'retry-unusual-error' && attempts === 1) { const error = new Error(); Object.defineProperty(error, 'message', { value: undefined }); throw error; }
      git('worktree', 'remove', path);
    }, terminals: async () => { terminalReads++; if (scenario === 'terminal-snapshot-failure') throw new Error('T3 terminal snapshot unavailable'); return terminals(); },
    closeTerminal: async (threadId: string, terminalId: string) => { closes.push({ threadId, terminalId }); if (terminalProcess) { const exited = once(terminalProcess, 'exit'); terminalProcess.kill(); await exited; } } } as unknown as T3;
    const kaneo = { call: async () => ({ id: 'task', projectId: 'project', number: 1, title: 'Fixture', createdAt: job.createdAt, priority: 'low', status: scenario.endsWith('not-done') ? 'to-do' : 'done' }) } as unknown as Kaneo;
    const runReconcile = async (allow = true) => {
      await reconcile(c, store, t3, kaneo, threads, allow, mode === 'direct');
      if (allow && mode === 'deferred') await cleanupNextWorkspace(c, store, t3, kaneo, new Set());
    };
    let childProcess: ReturnType<typeof spawn> | undefined;
    try {
      if (scenario.startsWith('renamed')) { execFileSync('git', ['-C', tree, 'branch', '-m', mergedBranch]); if (scenario === 'renamed') thread.branch = mergedBranch; }
      if (scenario === 'new-completion' || scenario === 'settled-report') { job.state = 'running'; job.completedAt = null; writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'complete', reason: 'Merged', prUrls: job.prUrls, createdTaskIds: [] })); }
      if (scenario === 'settled' || scenario === 'settled-report') thread.settledOverride = 'settled';
      if (scenario === 'monitor') thread.pendingBackgroundTasks = [{ taskId: 'pr-watch', kind: 'monitor' }];
      if (scenario.endsWith('dirty')) writeFileSync(join(tree, 'untracked'), 'keep me');
      if (scenario.endsWith('extra-commit')) { writeFileSync(join(tree, 'file'), 'new work'); execFileSync('git', ['-C', tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'unmerged']); }
      if (scenario === 'active') { thread.status = 'running'; thread.activeRunId = 'live-run'; }
      if (scenario === 'orphaned-run') Object.assign(thread, { status: 'queued', activeRunId: 'orphaned-run', orphanedRun: true });
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
      if (scenario === 'orphaned-run-subagent') threads.push(subagent('subagent', thread.id, { status: 'running', activeRunId: 'subagent-run', orphanedRun: true }));
      if (scenario === 'monitor-subagent') threads.push(subagent('subagent', thread.id, { pendingBackgroundTasks: [{ taskId: 'pr-watch', kind: 'monitor' }] }));
      if (scenario === 'process' || scenario === 'command-process') { childProcess = spawn('sleep', ['60'], { cwd: tree }); await once(childProcess, 'spawn'); }
      if (scenario.endsWith('-terminal')) { terminalProcess = spawn('sleep', ['60'], { cwd: tree }); await once(terminalProcess, 'spawn'); }
      // A blocked cleanup makes no T3, Kaneo, Git or process call until its retry window passes.
      const skipsUntilRetry = async () => {
        const reads = () => [shellReads, terminalReads, attempts, detachAttempts, commands.length];
        const before = reads(); await runReconcile();
        assert.deepEqual(reads(), before, 'skip a blocked cleanup within its retry window');
        assert.ok(store.jobs()[0].workspaceCleanupBlockedAt, 'record when cleanup was blocked');
        const saved = store.jobs()[0]; saved.workspaceCleanupBlockedAt = new Date(Date.now() - 16 * 60_000).toISOString(); store.save(saved);
      };
      if (isCommand) {
        thread.pendingBackgroundTasks = [{ taskId: 'server', kind: 'command' }];
        if (scenario === 'command-mixed-monitor') thread.pendingBackgroundTasks.push({ taskId: 'watch', kind: 'monitor' });
        if (scenario === 'command-dismissed') { job.state = 'dismissed'; thread.settledOverride = 'settled'; }
        if (scenario === 'command-settled-running') { job.state = 'running'; job.completedAt = null; thread.settledOverride = 'settled'; }
        if (scenario === 'command-lifecycle') { job.state = 'running'; job.completedAt = null; Object.assign(thread, { status: 'running', activeRunId: 'first-run', pendingBackgroundTasks: [] }); }
        const report = { jobId: job.id, status: scenario === 'command-awaiting-report' ? 'awaiting-human' : 'complete', reason: 'Finished', prUrls: job.prUrls };
        if (!['command-missing-report', 'command-lifecycle'].includes(scenario)) writeFileSync(job.reportPath, JSON.stringify(scenario === 'command-invalid-report' ? {} : report));
        if (scenario === 'command-settled-resumed') {
          job.state = 'dismissed'; job.completedAt = null; thread.settledOverride = 'settled';
          thread.latestUserMessageAt = '2026-01-03T00:00:00Z';
          utimesSync(job.reportPath, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
        }
      }
      store.save(job);
      if (scenario === 'command-lifecycle') {
        // Incident shape: a turn yields to a background validation command, its notification resumes the turn, delivery finishes.
        const state = () => [store.job(job.id)!.state, store.job(job.id)!.reason];
        await runReconcile();
        assert.deepEqual(state(), ['running', 'Claude is executing']);
        Object.assign(thread, { status: 'completed', activeRunId: null, latestRunCompletedAt: '2026-01-01T06:00:00Z', pendingBackgroundTasks: [{ taskId: 'validation', kind: 'command' }] });
        for (let pass = 0; pass < 2; pass++) { await runReconcile(); store.close(); store = new Store(join(dir, 'state')); }
        assert.deepEqual(state(), ['running', 'Waiting for background commands']);
        assert.equal(busyProviders(store.jobs(), threads, new Map(), 30).size, 1, 'an unfinished command wait retains its admission reservation');
        assert.deepEqual(commands, [], 'a missing report authorizes no Stop, cleanup or launch');
        assert.equal(existsSync(tree), true);
        Object.assign(thread, { status: 'running', activeRunId: 'resumed-run', pendingBackgroundTasks: [] });
        await runReconcile();
        assert.deepEqual(state(), ['running', 'Claude is executing']);
        Object.assign(thread, { status: 'completed', activeRunId: null, latestRunCompletedAt: '2026-01-01T12:00:00Z', pendingBackgroundTasks: [{ taskId: 'server', kind: 'command' }] });
        writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'complete', reason: 'Merged', prUrls: job.prUrls, createdTaskIds: [] }));
        assert.equal(store.events().some(e => e.text === 'FIX-1 needs you'), false, 'no intermediate wait asks the user');
      }
      if (isCommand) {
        const eligible = ['command', 'command-lifecycle', 'command-todos', 'command-dismissed', 'command-settled-running', 'command-pending', 'command-error', 'command-rejected', 'command-process'].includes(scenario);
        // Settled jobs first retain dismissal semantics, then maintenance verifies their report.
        await runReconcile(); await runReconcile();
        const stops = () => commands.filter(c => c.type === 'run.interrupt');
        assert.equal(stops().length, eligible ? 1 : 0, 'stop only verified, freshly owned command-only work');
        assert.equal(existsSync(tree), true, 'accepted Stop is not process exit confirmation');
        store.close(); store = new Store(join(dir, 'state'));
        const saved = store.job(job.id)!; saved.workspaceCleanupBlockedAt = undefined; store.save(saved);
        await runReconcile();
        assert.equal(stops().length, eligible ? 1 : 0, 'restart never repeats an unconfirmed mutation');
        if (eligible) {
          assert.ok(store.job(job.id)!.commandStop?.requestedAt, 'persist the request before mutation');
          if (scenario === 'command-error' || scenario === 'command-rejected') assert.equal(store.job(job.id)!.commandStop?.status, 'uncertain');
          if (scenario !== 'command-pending') {
            thread.pendingBackgroundTasks = [];
            const retry = store.job(job.id)!; retry.workspaceCleanupBlockedAt = undefined; store.save(retry);
            await runReconcile(); await runReconcile(); await runReconcile();
            assert.equal(store.job(job.id)!.commandStop?.status, 'confirmed');
            assert.equal(existsSync(tree), scenario === 'command-process', 'process CWD still holds cleanup after T3 settlement');
          }
        } else assert.ok(store.job(job.id)!.workspaceCleanupError, 'retain a cleanup hold diagnostic');
        return;
      }
      await runReconcile(scenario !== 'dry-run');
      if (mode === 'deferred') { store.close(); store = new Store(join(dir, 'state')); }
      if (scenario === 'retry-detach') await skipsUntilRetry();
      if (scenario === 'resumed-after-detach') thread.latestUserMessageAt = '2026-01-03T00:00:00Z';
      if (scenario === 'dirty-after-detach') writeFileSync(join(tree, 'untracked'), 'new work');
      if (scenario === 'branch-change-after-detach') execFileSync('git', ['-C', tree, 'switch', '-qc', 'unrelated-work']);
      if (scenario === 'path-change-after-detach') thread.worktreePath = repo;
      await runReconcile(scenario !== 'dry-run');
      if (scenario === 'retry' || scenario === 'retry-unusual-error') { assert.equal(existsSync(tree), true); if (scenario === 'retry') assert.equal(store.jobs()[0].workspaceCleanupError, 'GitCommandError: temporary removal failure'); await skipsUntilRetry(); await runReconcile(); }
      if (scenario === 'new-completion' || scenario === 'settled-report' || scenario === 'retry-detach' || scenario === 'monitor' || scenario.includes('terminal') || scenario.endsWith('subagent')) await runReconcile();
      if (scenario === 'monitor-subagent') await runReconcile();
      const removed = ['clean', 'settled-report', 'renamed', 'renamed-stale-metadata', 'new-completion', 'settled', 'monitor', 'retry', 'retry-unusual-error', 'retry-detach', 'discovery', 'pushed-under-other-name', 'missing-unregistered-worktree', 'missing-registered-worktree', 'idle-terminal', 'idle-subagent', 'grandchild-subagent', 'monitor-subagent', 'no-pr', 'no-pr-not-done'].includes(scenario);
      if (removed) assert.deepEqual([store.jobs()[0].workspaceCleanupError, store.jobs()[0].workspaceCleanupBlockedAt], [undefined, undefined], 'cleanup completes without a recorded error');
      else if (store.jobs()[0].workspaceCleanupError) await skipsUntilRetry();
      if (scenario === 'idle-terminal') assert.deepEqual(closes, [{ threadId: 'thread', terminalId: 'setup-install-dependencies' }], 'close only the thread\'s idle live terminal, once');
      else assert.deepEqual(closes, [], 'never close a busy, starting, or foreign terminal');
      if (scenario === 'busy-terminal' || scenario === 'starting-terminal') assert.equal(store.jobs()[0].workspaceCleanupError, 'A T3 terminal for this thread is still running a command');
      if (scenario === 'other-thread-terminal') assert.equal(store.jobs()[0].workspaceCleanupError, 'A running process is still using the workspace');
      if (scenario === 'terminal-snapshot-failure') assert.equal(store.jobs()[0].workspaceCleanupError, 'T3 terminal snapshot unavailable');
      if (scenario === 'orphaned-run') assert.deepEqual([store.jobs()[0].workspaceCleanupError, commands], ['Thread has an orphaned T3 run; settle it in T3 before workspace cleanup', []], 'hold the workspace without mutating the run');
      if (scenario === 'dry-run') assert.equal(terminalReads, 0, 'dry runs send no terminal RPCs');
      assert.equal(existsSync(tree), !removed, 'remove only a verified complete, clean, unchanged and inactive worktree');
      assert.equal(store.jobs()[0].state, ['settled', 'settled-report'].includes(scenario) ? 'dismissed' : 'complete', 'cleanup preserves completion history and explicit settling');
      if (removed) {
        assert.equal(thread.worktreePath, null); assert.equal(thread.branch, null);
        assert.ok(!git('worktree', 'list', '--porcelain').includes(realTree)); assert.ok(store.jobs()[0].workspaceCleanedAt);
        if (scenario.startsWith('missing')) assert.equal(attempts, scenario === 'missing-registered-worktree' ? 1 : 0, 'remove only a workspace Git still registers');
        const count = attempts; await runReconcile(); assert.equal(attempts, count, 'successful cleanup is idempotent');
      }
      if (scenario.endsWith('subagent')) {
        const detached = commands.filter(command => command.type === 'thread.metadata.update').map(command => command.threadId);
        const owned = scenario === 'grandchild-subagent' ? ['subagent', 'grandchild'] : ['subagent'];
        assert.deepEqual(commands.filter(command => command.type === 'thread.pull-request.watch').map(command => command.threadId), scenario === 'monitor-subagent' ? ['subagent'] : [], 'stop owned subagent monitors before detaching');
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
