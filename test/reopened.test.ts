import { mockTracker } from './tracker-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.ts';
import { Store, type Job } from '../src/store.ts';
import { Kanvil, T3 } from '../src/clients.ts';
import { inventory, reconcile, writeStatus } from '../src/scheduler.ts';
import { v2Thread } from './v2-fixture.ts';
import { parse } from 'jsonc-parser';

for (const scenario of ['other-project', 'settled-discussion'] as const) test(`ticket references: ${scenario}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-references-')), repo = join(dir, 'repo'), tree = join(dir, 'tree'); mkdirSync(repo);
  const git = (path: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'released\n'); git(repo, 'add', 'file'); git(repo, 'commit', '-qm', 'released');
  git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
  const input = parse(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8'));
  input.stateDir = join(dir, 'state'); input.projects[0].repoPath = repo; input.projects[0].readyStatuses = ['todo'];
  const c = configSchema.parse(input), p = c.projects[0], key = `${p.key}-1`;
  const task = { id: 'task', projectId: p.kanvilId, number: 1, title: 'Ready work', status: 'todo', priority: 'high', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'med' }] };
  const kanvil = new Kanvil(c.kanvil), store = new Store(c.stateDir);
  mockTracker(t, kanvil, async (name: string) => {
    if (name === 'labels') return task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: c.kanvil.workspaceId }));
    if (name === 'tickets') return { data: { workspaceId: c.kanvil.workspaceId, columns: [{ tasks: [task] }] }, pagination: { total: 1, totalPages: 1 } };
    if (name === 'relations') return [];
    throw new Error(name);
  });
  let openPR = false;
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'prs'))}\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const branch = `t3/${key.toLowerCase()}-scope`;
  const thread = v2Thread({ title: `Clarify ${key} scope`, projectId: scenario === 'other-project' ? 'maintenance' : p.t3Id, settledOverride: 'settled' });
  if (scenario === 'settled-discussion') {
    git(repo, 'worktree', 'add', '-qb', branch, tree); thread.branch = branch; thread.worktreePath = tree;
  }
  const threads = [thread];
  const inspect = () => {
    writeFileSync(join(dir, 'prs'), JSON.stringify(openPR ? [{ title: key, headRefName: branch, body: '' }] : []));
    return inventory(c, kanvil, threads, store.jobs(), store, key);
  };
  const blocked = async (message: string) => assert.equal((await inspect()).selected, undefined, message);
  try {
    assert.equal((await inspect()).selected?.key, key, 'a discussion does not own implementation');
    if (scenario === 'other-project') {
      thread.status = 'running'; thread.activeRunId = 'run'; thread.branch = `fix/${key}-maintenance`;
      assert.equal((await inspect()).selected?.key, key, 'even active references in another project are unrelated');
      thread.projectId = p.t3Id; await blocked('a reference in the ticket project remains protected');
      return;
    }
    thread.settledOverride = null; await blocked('unsettled threads remain protected'); thread.settledOverride = 'settled';
    thread.status = 'running'; thread.activeRunId = 'run'; await blocked('settled active runs remain protected'); thread.status = 'completed'; thread.activeRunId = null;
    thread.pendingRuntimeRequest = { kind: 'user_input', createdAt: thread.updatedAt }; await blocked('pending requests remain protected'); thread.pendingRuntimeRequest = null;
    thread.pendingBackgroundTasks = [{ kind: 'monitor', taskId: 'watch' }]; await blocked('even passive background work remains protected'); thread.pendingBackgroundTasks = [];
    thread.worktreePath = join(dir, 'missing'); await blocked('missing workspaces cannot be verified'); thread.worktreePath = tree;
    git(tree, 'checkout', '-qb', 'another-branch'); await blocked('a changed workspace binding remains protected'); git(tree, 'checkout', '-q', branch);
    writeFileSync(join(tree, 'untracked'), 'work'); await blocked('untracked work remains protected'); rmSync(join(tree, 'untracked'));
    writeFileSync(join(tree, 'file'), 'dirty\n'); await blocked('modified work remains protected'); git(tree, 'checkout', '--', 'file');
    openPR = true; await blocked('open PRs still block an untouched discussion branch'); openPR = false;
    threads.push(v2Thread({ id: 'shared', projectId: p.t3Id, worktreePath: tree, status: 'running', activeRunId: 'run' }));
    await blocked('another thread using the workspace remains protected'); threads.pop();
    writeFileSync(join(tree, 'file'), 'new work\n'); git(tree, 'commit', '-qam', 'new work'); await blocked('new commits remain protected');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(tree, 'rev-parse', 'HEAD')); await blocked('directly released commits do not make an implementation an untouched discussion');
  } finally { store.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

for (const [settled, launched, pushedElsewhere] of [[false, false, false], [true, false, false], [false, true, false], [false, true, true]]) test(`historical ownership releases safely: ${settled ? 'explicitly settled' : 'completed'}${launched ? ' v2 launch' : ''}${pushedElsewhere ? ' pushed under another name' : ''}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-reopened-')), repo = join(dir, 'repo'), tree = join(dir, 'old-tree'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'old work\n'); git('add', 'file');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'old work');
  const branch = 'chore/FIX-1-old', head = git('rev-parse', 'HEAD'); git('worktree', 'add', '-qb', branch, tree);
  const metadata = join(dir, 'metadata.json'), prBranch = pushedElsewhere ? 'fix/FIX-1-delivery' : branch;
  if (pushedElsewhere) git('update-ref', `refs/remotes/origin/${prBranch}`, head);
  const setPR = (open = false) => writeFileSync(metadata, JSON.stringify({ state: 'MERGED', headRefName: prBranch, headRefOid: head, open })); setPR();
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs');const p=JSON.parse(fs.readFileSync(${JSON.stringify(metadata)},'utf8'));console.log(JSON.stringify(process.argv.includes('view')?p:p.open?[{title:'FIX-1 follow-up',headRefName:'fix/FIX-1-new',body:''}]:[]));\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    model: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, runtimeMode: 'full-access', stateDir: join(dir, 'state'),
    t3: { url: 'http://127.0.0.1', credentialFile: join(dir, 'token') }, kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' },
    quota: { maxAgeSeconds: 300, fiveHourReservePercent: 40, weeklyReservePercent: 70 }, discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', key: 'FIX', enabled: true, kanvilId: 'p', t3Id: 'tp', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
  });
  writeFileSync(c.factorySkill, '# Software factory\nMerge without asking after review and CI.');
  const task = { id: 'task', projectId: 'p', number: 1, title: 'Reopened work', status: 'todo', priority: 'high', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'med' }] };
  mockTracker(t, Kanvil.prototype, async (name: string) => {
    if (name === 'labels') return [task].flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'tickets') return { data: { workspaceId: 'workspace', columns: [{ tasks: [task] }] }, pagination: { total: 1, totalPages: 1 } };
    if (name === 'relations') return [];
    throw new Error(name);
  });
  const job: Job = { id: 'old-job', kind: 'ticket', projectId: 'p', taskId: 'task', ticketKey: 'FIX-1', threadId: 'old-thread', messageId: 'message', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Merged', lastPersonalActivity: null, reportPath: join(dir, 'report'), prUrls: ['https://github.com/fixture/repo/pull/1'], command: launched ? { workspaceStrategy: { type: 'worktree', baseRef: 'main', branch, startFromOrigin: true } } : { bootstrap: { prepareWorktree: { branch } } } };
  const thread = v2Thread({ id: job.threadId, title: 'Factory: FIX-1', projectId: 'tp', branch, worktreePath: tree, modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, status: 'completed', latestRunCompletedAt: job.createdAt });
  if (settled) { job.state = 'waiting'; job.completedAt = null; job.prUrls = []; thread.settledOverride = 'settled'; thread.status = 'failed'; }
  let store = new Store(c.stateDir); store.save(job);
  store.db.prepare('UPDATE jobs SET task_id=? WHERE id=?').run(job.taskId, job.id); store.close(); // Old schema claimed completed tickets forever.
  store = new Store(c.stateDir); const kanvil = new Kanvil(c.kanvil);
  let visible = true;
  const inspect = () => inventory(c, kanvil, visible ? [thread] : [], store.jobs(), store, 'FIX-1');
  try {
    if (settled) {
      const t3 = { dispatch: async () => { throw new Error('Settling must not send a turn'); } } as unknown as T3;
      thread.status = 'running'; thread.activeRunId = 'run-2';
      await reconcile(c, store, t3, kanvil, [thread]);
      assert.notEqual(store.jobs()[0].state, 'dismissed', 'still-executing work must remain protected');
      thread.status = 'failed'; thread.activeRunId = null;
      await reconcile(c, store, t3, kanvil, [thread]);
      assert.equal(store.jobs()[0].state, 'dismissed');
      assert.equal(writeStatus(c, store).jobs.length, 0, 'settled runs disappear from factory status');
      assert.equal(store.db.prepare('SELECT task_id FROM jobs WHERE id=?').get(job.id)!.task_id, null);
      thread.settledOverride = null;
      assert.match((await inspect()).skipped[0].reason, /T3 thread/);
      thread.settledOverride = 'settled';
    }
    assert.equal((await inspect()).selected?.key, 'FIX-1');
    visible = false; assert.equal((await inspect()).selected?.key, 'FIX-1', 'an archived task does not reclaim its ticket; its stored command names the branch'); visible = true;
    thread.status = 'running'; thread.activeRunId = 'run-2';
    assert.match((await inspect()).skipped[0].reason, /T3 thread/);
    thread.status = 'completed'; thread.activeRunId = null;
    writeFileSync(join(tree, 'file'), 'uncommitted new work\n');
    assert.match((await inspect()).skipped[0].reason, /T3 thread/);
    execFileSync('/usr/bin/git', ['-C', tree, 'checkout', '--', 'file']);
    setPR(true); assert.match((await inspect()).skipped[0].reason, /open PR/); setPR();
    writeFileSync(join(tree, 'file'), 'new commit\n');
    execFileSync('/usr/bin/git', ['-C', tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'new work']);
    thread.worktreePath = null;
    assert.match((await inspect()).skipped[0].reason, /Git branch|T3 thread/, 'a reused historical branch with new commits remains protected');
    execFileSync('/usr/bin/git', ['-C', tree, 'reset', '--hard', head]);
    git('worktree', 'remove', tree);
    thread.branch = null; thread.worktreePath = null;
    store.save({ ...store.jobs()[0], completedAt: '2026-01-02T00:00:00Z', workspaceCleanedAt: '2026-01-02T00:01:00Z' });
    assert.equal((await inspect()).selected?.key, 'FIX-1', 'workspace cleanup does not let the old thread reclaim a reopened ticket');
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

test('a ticket closed without delivery can be dispatched again once ready', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-reopened-')), repo = join(dir, 'repo'), tree = join(dir, 'old-tree'); mkdirSync(repo);
  const git = (path: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'released\n'); git(repo, 'add', 'file'); git(repo, 'commit', '-qm', 'released');
  const branch = 'chore/FIX-1-old';
  git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD')); git(repo, 'worktree', 'add', '-qb', branch, tree);
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho '[]'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    model: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, runtimeMode: 'full-access', stateDir: join(dir, 'state'),
    t3: { url: 'http://127.0.0.1', credentialFile: join(dir, 'token') }, kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' },
    quota: { maxAgeSeconds: 300, fiveHourReservePercent: 40, weeklyReservePercent: 70 }, discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'Fixture', key: 'FIX', enabled: true, kanvilId: 'p', t3Id: 'tp', repoPath: repo, githubRepo: 'fixture/repo', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
  });
  const task = { id: 'task', projectId: 'p', number: 1, title: 'Reopened work', status: 'todo', priority: 'high', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'med' }] };
  mockTracker(t, Kanvil.prototype, async (name: string) => {
    if (name === 'labels') return task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' }));
    if (name === 'tickets') return { data: { workspaceId: 'workspace', columns: [{ tasks: [task] }] }, pagination: { total: 1, totalPages: 1 } };
    if (name === 'relations') return [];
    throw new Error(name);
  });
  const job: Job = { id: 'old-job', kind: 'ticket', projectId: 'p', taskId: 'task', ticketKey: 'FIX-1', threadId: 'old-thread', messageId: 'message', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', state: 'complete', reason: 'Superseded', lastPersonalActivity: null, reportPath: join(dir, 'report'), prUrls: [], command: { workspaceStrategy: { type: 'worktree', baseRef: 'main', branch, startFromOrigin: true } } };
  const thread = v2Thread({ id: job.threadId, title: 'Factory: FIX-1', projectId: 'tp', branch, worktreePath: tree, updatedAt: job.createdAt, latestUserMessageAt: job.createdAt, status: 'completed', latestRunCompletedAt: job.createdAt });
  const store = new Store(c.stateDir); store.save(job);
  const inspect = () => inventory(c, new Kanvil(c.kanvil), [thread], store.jobs(), store, 'FIX-1');
  try {
    assert.equal((await inspect()).selected?.key, 'FIX-1', 'a released, idle, clean history does not block the ready ticket');
    // Cleanup verified the head and unbound the thread, then the owner settled it before the directory was removed.
    store.save({ ...job, workspaceCleanup: { path: tree, branch, head: git(tree, 'rev-parse', 'HEAD') } });
    thread.branch = null; thread.worktreePath = null; thread.settledOverride = 'settled';
    await reconcile(c, store, {} as T3, new Kanvil(c.kanvil), [thread], false);
    assert.equal(store.jobs()[0].state, 'dismissed');
    assert.equal(store.jobs()[0].dismissedHead, undefined, 'the unbound thread has no worktree to read');
    assert.equal((await inspect()).selected?.key, 'FIX-1', 'the head cleanup verified releases a ticket settled mid-cleanup');
    writeFileSync(join(tree, 'file'), 'uncommitted\n');
    assert.match((await inspect()).skipped[0].reason, /T3 thread|Git branch/, 'a dirty leftover workspace still blocks');
    git(tree, 'checkout', '--', 'file');
    writeFileSync(join(tree, 'file'), 'new work\n'); git(tree, 'commit', '-qam', 'new work');
    assert.match((await inspect()).skipped[0].reason, /T3 thread|Git branch/, 'a new commit on the old branch still blocks');
  } finally { store.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});
