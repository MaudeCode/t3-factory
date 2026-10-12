import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle, pendingReviews, reconcile, upstreamRows, writeStatus } from '../src/scheduler.ts';
import { v2Thread } from './v2-fixture.ts';

// What gh returns after --exclude-drafts, with and without --exclude-pre-releases.
const stable = [{ tagName: 'v1', publishedAt: '2026-03-01T00:00:00Z' }, { tagName: 'v2', publishedAt: '2026-03-02T00:00:00Z' }];
const withPrereleases = [{ tagName: 'exp-3', publishedAt: '2026-03-03T00:00:00Z' }, ...stable];

// Synthetic config, fake gh on PATH that counts its calls, and a disposable store.
function fixture(t: { after: (fn: () => void) => void }, upstreams: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-upstream-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'stable.json'), JSON.stringify(stable)); writeFileSync(join(dir, 'all.json'), JSON.stringify(withPrereleases));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$@" >> "${join(dir, 'gh-calls')}"\ncase "$1 $*" in\n  release*--exclude-pre-releases*) cat "${join(dir, 'stable.json')}" ;;\n  release*) cat "${join(dir, 'all.json')}" ;;\n  *) printf "[]\\n" ;;\nesac\n`.replace('case "$1 $*" in\n', 'case "$1 $*" in\n  *up/broken*) echo "HTTP 404" >&2; exit 1 ;;\n'), { mode: 0o755 });
  writeFileSync(join(dir, 'upstream.md'), 'Review {{name}} ({{repo}}) from {{base}} to {{candidate}}.');
  writeFileSync(join(dir, 'discovery.md'), 'Discover.'); writeFileSync(join(dir, 'skill'), '# Software factory');
  const oldPath = process.env.PATH, oldConfig = process.env.T3_FACTORY_CONFIG;
  process.env.PATH = `${dir}:${oldPath}`; process.env.T3_FACTORY_CONFIG = join(dir, 'config.jsonc');
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: true, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'opus', name: 'Opus', model: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, automatic: true }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'),
    t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kaneo: { url: 'https://kaneo.example.test', workspaceId: 'workspace', readyLabel: 'sf' },
    discovery: { promptFile: join(dir, 'discovery.md'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    upstream: { enabled: true, promptFile: join(dir, 'upstream.md'), checkMinutes: 60 },
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kaneoId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/app', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'], upstreams }],
  });
  writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
  const store = new Store(c.stateDir);
  const releaseCalls = () => existsSync(join(dir, 'gh-calls')) ? readFileSync(join(dir, 'gh-calls'), 'utf8').split('\n').filter(l => l.startsWith('release')) : [];
  const ghCalls = () => releaseCalls().length;
  t.after(() => { store.close(); process.env.PATH = oldPath; process.env.T3_FACTORY_CONFIG = oldConfig; rmSync(dir, { recursive: true, force: true }); });
  return { dir, c, store, ghCalls, releaseCalls };
}
const job = (overrides: Partial<Job>): Job => ({ id: 'old', kind: 'upstream', projectId: 'FIX', taskId: null, ticketKey: null, threadId: 'old-thread', messageId: 'm', createdAt: '2026-03-01T00:00:00Z', state: 'running', reason: '', lastPersonalActivity: null, reportPath: '/nonexistent', command: null, prUrls: [], completedAt: null, ...overrides });

test('upstream detection: newest counted release, throttled reads, and one review per candidate', async t => {
  const { c, store, ghCalls, releaseCalls } = fixture(t, [
    { name: 'Stable', repo: 'up/stable', firstBase: 'v1' },
    { name: 'Exp', repo: 'up/exp', prereleases: true, firstBase: 'v1' },
    { name: 'Current', repo: 'up/current', firstBase: 'v2' },
  ]);
  const now = Date.parse('2026-03-05T00:00:00Z');
  const pending = await pendingReviews(c, store, [], now);
  assert.deepEqual(pending.map(p => p.upstream), [
    { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' },
    { name: 'Exp', repo: 'up/exp', base: 'v1', candidate: 'exp-3' },
  ], 'pre-releases count only when enabled, and an already-reviewed candidate yields nothing');
  assert.equal(ghCalls(), 3);
  assert.ok(releaseCalls().every(call => call.includes('--exclude-drafts')), 'drafts are excluded before the limit');
  assert.deepEqual(releaseCalls().map(call => call.includes('--exclude-pre-releases')), [true, false, true], 'skipped pre-releases are excluded before the limit');

  await pendingReviews(c, store, [], now + 59 * 60_000);
  assert.equal(ghCalls(), 3, 'GitHub is not read again within checkMinutes');

  const open = job({ upstream: { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' } });
  const dismissed = job({ id: 'gone', state: 'dismissed', upstream: { name: 'Exp', repo: 'up/exp', base: 'v1', candidate: 'exp-3' } });
  assert.deepEqual(await pendingReviews(c, store, [open, dismissed], now + 61 * 60_000), [], 'an unfinished or dismissed review blocks its candidate');
  assert.equal(ghCalls(), 5, 'a repository with an unfinished review is not read');
  store.save(open); store.save(dismissed);
  assert.deepEqual(upstreamRows(c, store).map(r => [r.repo, r.reviewing, r.pending]), [['up/stable', true, false], ['up/exp', false, false], ['up/current', false, false]],
    'a running review shows as reviewing, and a dismissed candidate is not due again');
  store.save({ ...open, state: 'complete' }); store.save({ ...dismissed, upstream: { ...dismissed.upstream!, candidate: 'exp-2' } });

  store.set('upstreamReviewed:up/stable', 'v2');
  assert.deepEqual((await pendingReviews(c, store, [], now + 61 * 60_000)).map(p => p.upstream.repo), ['up/exp'], 'a reviewed candidate is the new base');
  assert.deepEqual(upstreamRows(c, store).map(r => [r.repo, r.reviewed, r.latest, r.checkedAt, r.pending]), [
    ['up/stable', 'v2', 'v2', new Date(now + 61 * 60_000).toISOString(), false],
    ['up/exp', 'v1', 'exp-3', new Date(now + 61 * 60_000).toISOString(), true],
    ['up/current', 'v2', 'v2', new Date(now + 61 * 60_000).toISOString(), false],
  ], 'status rows report the watermark, the newest release seen, and whether a review is due');
  assert.equal(writeStatus(c, store).upstreams.length, 3, 'status.json carries the rows');
  c.projects[0].enabled = false;
  assert.ok(upstreamRows(c, store).every(r => !r.pending), 'a disabled project has no review due');
});

test('upstream detection: a failed release read is recorded on its row', async t => {
  const { c, store } = fixture(t, [{ name: 'Broken', repo: 'up/broken', firstBase: 'v1' }]);
  assert.deepEqual(await pendingReviews(c, store, [], Date.parse('2026-03-05T00:00:00Z')), []);
  const [row] = upstreamRows(c, store);
  assert.deepEqual([row.latest, row.pending, row.checkedAt], [null, false, '2026-03-05T00:00:00.000Z']);
  assert.match(row.checkError ?? '', /404/);
});

test('upstream switch: the CLI flips only upstream.enabled and refuses configs without upstream', t => {
  const { dir, c } = fixture(t, []);
  const main = new URL('../src/main.ts', import.meta.url).pathname, run = (file: string) => {
    try { return { code: 0, out: execFileSync(process.execPath, [main, 'upstream-resume'], { env: { ...process.env, NODE_NO_WARNINGS: '1', T3_FACTORY_CONFIG: file }, encoding: 'utf8', stdio: 'pipe' }) }; }
    catch (error: any) { return { code: error.status, out: String(error.stderr) }; }
  };
  const file = join(dir, 'config.jsonc');
  writeFileSync(file, JSON.stringify({ ...c, upstream: { ...c.upstream, enabled: false } }));
  assert.equal(run(file).code, 0);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([saved.upstream.enabled, saved.enabled], [true, true]);
  const bare = join(dir, 'bare.jsonc'), { upstream: _, ...withoutUpstream } = c;
  writeFileSync(bare, JSON.stringify(withoutUpstream));
  assert.deepEqual(run(bare), { code: 1, out: 'No upstream reviews are configured\n' });
  assert.equal(readFileSync(bare, 'utf8'), JSON.stringify(withoutUpstream), 'the file is untouched');
});

for (const scenario of ['priority', 'ambiguous-launch', 'dry-run', 'tickets-paused', 'tickets-paused-empty', 'reviews-paused'] as const) test(`upstream dispatch: ${scenario}`, async t => {
  const { c, store, ghCalls } = fixture(t, [{ name: 'Stable', repo: 'up/stable', firstBase: 'v1' }]);
  if (['ambiguous-launch', 'tickets-paused', 'tickets-paused-empty', 'reviews-paused'].includes(scenario))
    c.models.push({ id: 'astra', name: 'Astra', model: { instanceId: 'codex', model: 'gpt-6-astra', options: [] }, automatic: true, maxDifficulty: 'high' });
  if (scenario.startsWith('tickets-paused')) c.enabled = false;
  if (scenario === 'reviews-paused') c.upstream!.enabled = false;
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  const tasks = scenario === 'tickets-paused-empty' ? [] : [{ id: 'task-1', projectId: 'FIX', title: 'Ready work', number: 1, status: 'to-do', priority: 'urgent', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'high' }] }];
  const providers = [{ instanceId: 'claudeAgent', driver: 'claudeAgent', status: 'ready', installed: true, enabled: true, models: [{ slug: 'claude-opus-5' }] },
    { instanceId: 'codex', driver: 'codex', status: 'ready', installed: true, enabled: true, models: [{ slug: 'gpt-6-astra' }] }];
  t.mock.method(T3.prototype, 'providers', async () => providers);
  t.mock.method(T3.prototype, 'shell', async () => ({ threads: [], projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })) }));
  t.mock.method(T3.prototype, 'detail', async () => ({ messages: [], responses: [] }));
  const window = (id: string, minutes: number) => ({ id, usedPercent: 0, windowDurationMins: minutes, resetsAt: new Date(Date.now() + minutes * 60_000).toISOString() });
  t.mock.method(T3.prototype, 'provider', async (instanceId: string) => ({ ...providers.find(p => p.instanceId === instanceId)!, usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(),
    windows: instanceId === 'codex' ? [window('primary', 10080)] : [window('five_hour', 300), window('seven_day', 10080)] } }));
  t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
  t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: tasks.filter(task => task.projectId === args.projectId) }] }, pagination: { total: tasks.length, totalPages: 1 } };
    if (name === 'get_task') return tasks.find(task => task.id === args.taskId);
    if (name === 'get_task_relations') return [];
    throw new Error(name);
  });
  const launched: Record<string, any>[] = [];
  t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => {
    launched.push(command);
    if (scenario === 'ambiguous-launch' && launched.length === 1) throw new Error('RPC outcome unknown');
    return { sequence: launched.length };
  });

  if (scenario === 'dry-run') {
    const result = await cycle(c, store, { dryRun: true });
    assert.deepEqual([result.reason, launched.length, ghCalls(), store.get('upstreamCheckedAt:up/stable')], ['would-dispatch', 0, 0, null], 'a dry run reads no releases and writes no cache');
    return;
  }
  const result = await cycle(c, store);
  if (scenario.startsWith('tickets-paused')) {
    assert.deepEqual([result.reason, launched.map(l => l.title)], ['dispatched', ['Upstream review: Stable v1..v2']], 'reviews run while ticket automation is paused; the free slot takes no ticket or discovery');
    return;
  }
  if (scenario === 'reviews-paused') {
    assert.deepEqual([launched.map(l => l.title), ghCalls()], [['Factory: FIX-1'], 0], 'paused reviews neither read releases nor dispatch');
    return;
  }
  if (scenario === 'ambiguous-launch') {
    assert.deepEqual(launched.map(l => l.title), ['Upstream review: Stable v1..v2', 'Factory: FIX-1'], 'the other provider takes the ticket, not the same review');
    return;
  }
  assert.equal(result.reason, 'dispatched');
  assert.equal(launched.length, 1, 'the only slot goes to the review');
  assert.equal(launched[0].title, 'Upstream review: Stable v1..v2');
  assert.match(launched[0].initialMessage.text, /Review Stable \(up\/stable\) from v1 to v2\./);
  assert.match(launched[0].initialMessage.text, /external content/);
  const [saved] = store.jobs();
  assert.deepEqual([saved.kind, saved.ticketKey, saved.upstream], ['upstream', null, { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' }]);
});

for (const status of ['complete', 'no-work', 'awaiting-human', 'complete-empty', 'complete-old'] as const) {
  const holds = !['complete', 'no-work'].includes(status);
  test(`upstream completion: a ${status} report ${holds ? 'keeps' : 'advances'} the watermark`, async t => {
    const { dir, c, store } = fixture(t, [{ name: 'Stable', repo: 'up/stable', firstBase: 'v1' }]);
    const review = job({ id: 'review', threadId: 'review-thread', reportPath: join(dir, 'report.json'), upstream: { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' } });
    store.save(review);
    writeFileSync(review.reportPath, JSON.stringify({ jobId: review.id, status: status.startsWith('complete') ? 'complete' : status, reason: 'Reviewed', prUrls: [], createdTaskIds: ['complete', 'complete-old'].includes(status) ? ['filed'] : [] }));
    const kaneo = { call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_task') return { id: args.taskId, projectId: 'FIX', number: 2, title: 'Filed', createdAt: status === 'complete-old' ? '2026-02-01T00:00:00Z' : review.createdAt, priority: 'low', status: 'to-do' };
      throw new Error(name);
    } } as unknown as Kaneo;
    const threads = [v2Thread({ id: review.threadId, projectId: 'FIX', status: 'completed' })];
    await reconcile(c, store, { shell: async () => ({ threads }) } as unknown as T3, kaneo, threads, false);
    const [saved] = store.jobs();
    assert.equal(saved.state, holds ? 'waiting' : 'complete');
    if (status === 'complete-empty') assert.match(saved.reason, /without created tickets/);
    if (status === 'complete-old') assert.match(saved.reason, /created before the review started/);
    assert.equal(store.get('upstreamReviewed:up/stable'), holds ? null : 'v2');
    assert.equal(store.get('discoveryAfter:FIX'), null, 'a review never starts the discovery cooldown');
  });
}

test('upstream config: watched repositories need a prompt and a single owner', () => {
  const base = JSON.parse(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const project = { ...base.projects[0], upstreams: [{ name: 'Up', repo: 'up/stable', firstBase: 'v1' }] };
  assert.throws(() => configSchema.parse({ ...base, upstream: undefined, projects: [project] }), /upstream\.promptFile/);
  assert.throws(() => configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project, { ...project, key: 'TWO', kaneoId: 'two', t3Id: 'two' }] }), /only one project/);
  assert.equal(configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project] }).upstream?.checkMinutes, 360);
  const aliased = { ...project, key: 'TWO', kaneoId: 'two', t3Id: 'two', upstreams: [{ name: 'Up', repo: 'Up/Stable', firstBase: 'v1' }] };
  assert.throws(() => configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project, aliased] }), /only one project/, 'repository names compare case-insensitively');
});
