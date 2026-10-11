import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcile } from '../src/scheduler.ts';
import { Store, type Job } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import type { T3, Kaneo } from '../src/clients.ts';
import { v2Thread } from './v2-fixture.ts';

const accepted = { 'done': 'done', 'unlabeled': 'to-do', 'complete-empty': 'done', 'missing-worktree': 'done' } as const;
const rejected = {
  'still-ready': 'Ticket is still ready; record why no change is needed and remove it from the ready queue',
  'dirty': 'Unmerged work remains; deliver it through a PR or report awaiting-human',
  'extra-commit': 'Unmerged work remains; deliver it through a PR or report awaiting-human',
  'missing-worktree-extra-commit': 'Unmerged work remains; deliver it through a PR or report awaiting-human',
  'switched-branch-extra-commit': 'Unmerged work remains; deliver it through a PR or report awaiting-human',
  'no-work-with-pr': 'Ticket cannot finish as no-work',
  'missing-worktree-and-branch': 'Workspace head cannot be verified; inspect the work in T3 or report awaiting-human',
} as const;

for (const scenario of [...Object.keys(accepted), ...Object.keys(rejected)] as (keyof typeof accepted | keyof typeof rejected)[]) {
  test(`ticket closed without delivery: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-no-change-')), repo = join(dir, 'repo'), tree = join(dir, 'tree'); mkdirSync(repo);
    const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { encoding: 'utf8' }).trim();
    git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'released\n'); git(repo, 'add', 'file'); git(repo, 'commit', '-qm', 'released');
    const branch = 'chore/FIX-1-factory';
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD')); git(repo, 'worktree', 'add', '-qb', branch, tree);
    const store = new Store(join(dir, 'state'));
    const project = { kaneoId: 'project', t3Id: 't3-project', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] };
    const c = { monitoringTimeoutMinutes: 30, kaneo: { workspaceId: 'workspace', readyLabel: 'sf' }, projects: [project] } as unknown as Config;
    const job: Job = { id: 'job', kind: 'ticket', projectId: 'project', taskId: 'task', ticketKey: 'FIX-1', threadId: 'thread', messageId: 'initial', createdAt: '2026-01-01T00:00:00Z', completedAt: null, state: 'waiting', reason: 'Ticket cannot finish as no-work', lastPersonalActivity: null, reportPath: join(dir, 'report.json'), prUrls: [], command: { workspaceStrategy: { type: 'worktree', branch } } };
    const thread = v2Thread({ id: job.threadId, projectId: project.t3Id, branch, worktreePath: tree, status: 'completed' });
    const report = { jobId: job.id, status: scenario === 'complete-empty' ? 'complete' : 'no-work', reason: 'Already delivered on main; evidence recorded on the ticket', prUrls: scenario === 'no-work-with-pr' ? ['https://github.com/fixture/repo/pull/1'] : [], createdTaskIds: [] };
    writeFileSync(job.reportPath, JSON.stringify(report));
    const status = scenario in accepted ? accepted[scenario as keyof typeof accepted] : scenario === 'still-ready' ? 'to-do' : 'done';
    const kaneo = { config: c.kaneo, call: async (name: string) => {
      if (name === 'get_task') return { id: 'task', projectId: 'project', number: 1, title: 'Fixture', createdAt: job.createdAt, priority: 'low', status };
      if (name === 'list_workspace_labels') return [{ name: 'med', taskId: 'task', workspaceId: 'workspace' }, ...(scenario === 'unlabeled' ? [] : [{ name: 'sf', taskId: 'task', workspaceId: 'workspace' }])];
      throw new Error(name);
    } } as unknown as Kaneo;
    const threads = [thread];
    const t3 = { shell: async () => ({ threads }), terminals: async () => [],
      dispatch: async (command: any) => { thread.worktreePath = null; thread.branch = null; assert.equal(command.type, 'thread.metadata.update'); },
      removeWorktree: async (_cwd: string, path: string) => { git(repo, 'worktree', 'remove', path); } } as unknown as T3;
    try {
      if (scenario === 'dirty') writeFileSync(join(tree, 'untracked'), 'keep me');
      if (scenario.endsWith('extra-commit')) { writeFileSync(join(tree, 'file'), 'new work\n'); git(tree, 'commit', '-qam', 'unmerged'); }
      if (scenario === 'switched-branch-extra-commit') git(tree, 'switch', '-qc', 'other', 'main');
      if (scenario.startsWith('missing-worktree')) { git(repo, 'worktree', 'remove', tree); thread.worktreePath = null; }
      if (scenario === 'missing-worktree-and-branch') git(repo, 'branch', '-D', branch);
      store.save(job);
      await reconcile(c, store, t3, kaneo, threads);
      const saved = store.jobs()[0];
      if (scenario in accepted) {
        assert.deepEqual([saved.state, saved.reason, saved.prUrls], ['complete', report.reason, []], 'a verified no-change outcome finishes the job');
        assert.ok(saved.completedAt);
        // The existing cleanup cycle then removes the clean, released workspace.
        for (let i = 0; i < 3; i++) await reconcile(c, store, t3, kaneo, threads);
        assert.equal(store.jobs()[0].workspaceCleanupError, undefined);
        assert.ok(store.jobs()[0].workspaceCleanedAt);
        assert.equal(existsSync(tree), false);
      } else {
        assert.deepEqual([saved.state, saved.reason], ['waiting', rejected[scenario as keyof typeof rejected]], 'unverified closure stays parked with a specific reason');
        assert.equal(saved.completedAt, null);
        if (!scenario.startsWith('missing-worktree')) assert.equal(existsSync(tree), true);
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
