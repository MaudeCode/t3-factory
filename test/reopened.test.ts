import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.ts';
import { Store, type Job } from '../src/store.ts';
import { Kaneo, T3 } from '../src/clients.ts';
import { inventory, reconcile, writeStatus } from '../src/scheduler.ts';
import type { Thread } from '../src/policy.ts';

for (const settled of [false, true]) test(`historical ownership releases safely: ${settled ? 'explicitly settled' : 'completed'}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-reopened-')), repo = join(dir, 'repo'), tree = join(dir, 'old-tree'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'old work\n'); git('add', 'file');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'old work');
  const branch = 'chore/FIX-1-old', head = git('rev-parse', 'HEAD'); git('worktree', 'add', '-qb', branch, tree);
  const metadata = join(dir, 'metadata.json');
  const setPR = (open = false) => writeFileSync(metadata, JSON.stringify({ state: 'MERGED', headRefName: branch, headRefOid: head, open })); setPR();
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs');const p=JSON.parse(fs.readFileSync(${JSON.stringify(metadata)},'utf8'));console.log(JSON.stringify(process.argv.includes('view')?p:p.open?[{title:'FIX-1 follow-up',headRefName:'fix/FIX-1-new',body:''}]:[]));\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    model: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, runtimeMode: 'full-access', stateDir: join(dir, 'state'),
    t3: { url: 'http://127.0.0.1', credentialFile: join(dir, 'token') }, kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    quota: { maxAgeSeconds: 300, fiveHourReservePercent: 40, weeklyReservePercent: 70 }, discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', key: 'FIX', enabled: true, kaneoId: 'p', t3Id: 'tp', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'] }],
  });
  const task = { id: 'task', projectId: 'p', number: 1, title: 'Reopened work', status: 'to-do', priority: 'high', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'med' }] };
  t.mock.method(Kaneo.prototype, 'call', async (name: string) => {
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: [task] }] }, pagination: { total: 1, totalPages: 1 } };
    if (name === 'get_task_relations') return [];
    throw new Error(name);
  });
  const job: Job = { id: 'old-job', kind: 'ticket', projectId: 'p', taskId: 'task', ticketKey: 'FIX-1', threadId: 'old-thread', messageId: 'message', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Merged', lastPersonalActivity: null, reportPath: join(dir, 'report'), prUrls: ['https://github.com/fixture/repo/pull/1'], command: { bootstrap: { prepareWorktree: { branch } } } };
  const thread: Thread = { id: job.threadId, title: 'Factory: FIX-1', projectId: 'tp', branch, worktreePath: tree, modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, archivedAt: null, hasPendingApprovals: false, hasPendingUserInput: false, session: { status: 'stopped', providerName: 'claudeAgent', updatedAt: job.createdAt }, latestTurn: { state: 'completed', completedAt: job.createdAt } };
  if (settled) { job.state = 'waiting'; job.completedAt = null; job.prUrls = []; thread.settledOverride = 'settled'; thread.latestTurn!.state = 'error'; }
  let store = new Store(c.stateDir); store.save(job);
  store.db.prepare('UPDATE jobs SET task_id=? WHERE id=?').run(job.taskId, job.id); store.close(); // Old schema claimed completed tickets forever.
  store = new Store(c.stateDir); const kaneo = new Kaneo(c.kaneo);
  let visible = true;
  const inspect = () => inventory(c, kaneo, visible ? [thread] : [], store.jobs(), store, 'FIX-1');
  try {
    if (settled) {
      const t3 = { dispatch: async () => { throw new Error('Settling must not send a turn'); } } as unknown as T3;
      thread.latestTurn!.state = 'running'; thread.session!.status = 'running';
      await reconcile(c, store, t3, kaneo, [thread]);
      assert.notEqual(store.jobs()[0].state, 'dismissed', 'still-executing work must remain protected');
      thread.latestTurn!.state = 'error'; thread.session!.status = 'stopped';
      await reconcile(c, store, t3, kaneo, [thread]);
      assert.equal(store.jobs()[0].state, 'dismissed');
      assert.equal(writeStatus(c, store).jobs.length, 0, 'settled runs disappear from factory status');
      assert.equal(store.db.prepare('SELECT task_id FROM jobs WHERE id=?').get(job.id)!.task_id, null);
      thread.settledOverride = null;
      assert.match((await inspect()).skipped[0].reason, /T3 thread/);
      thread.settledOverride = 'settled';
    }
    assert.equal((await inspect()).selected?.key, 'FIX-1');
    if (settled) { visible = false; assert.equal((await inspect()).selected?.key, 'FIX-1', 'an archived settled task does not reclaim its ticket'); visible = true; }
    thread.session!.status = 'running'; thread.latestTurn!.state = 'running';
    assert.match((await inspect()).skipped[0].reason, /T3 thread/);
    thread.session!.status = 'stopped'; thread.latestTurn!.state = 'completed';
    writeFileSync(join(tree, 'file'), 'uncommitted new work\n');
    assert.match((await inspect()).skipped[0].reason, /T3 thread/);
    execFileSync('/usr/bin/git', ['-C', tree, 'checkout', '--', 'file']);
    setPR(true); assert.match((await inspect()).skipped[0].reason, /open PR/); setPR();
    writeFileSync(join(tree, 'file'), 'new commit\n');
    execFileSync('/usr/bin/git', ['-C', tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'new work']);
    thread.worktreePath = null;
    assert.match((await inspect()).skipped[0].reason, /Git branch|T3 thread/, 'a reused historical branch with new commits remains protected');
    execFileSync('/usr/bin/git', ['-C', tree, 'reset', '--hard', head]);
    const reopened = { ...job, id: 'new-job', threadId: 'new-thread', state: 'dispatching' as const, completedAt: null };
    store.save(reopened);
    assert.equal(store.jobs().length, 2); assert.equal(store.jobs()[0].taskId, 'task', 'history keeps its original ticket identity');
    assert.match((await inspect()).skipped[0].reason, /dispatching factory run/);
    assert.throws(() => store.save({ ...reopened, id: 'duplicate' }));
    store.save({ ...reopened, state: 'complete' });
    store.save({ ...reopened, id: 'third-run', threadId: 'third-thread' });
    assert.equal(store.jobs().length, 3);
  } finally { store.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});
