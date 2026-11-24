import { mockTracker } from './tracker-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, loadConfig } from '../src/config.ts';
import { T3, Kanvil } from '../src/clients.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle, pendingReviews, reconcile, upstreamRows, readStatus } from '../src/scheduler.ts';
import { v2Thread } from './v2-fixture.ts';
import { dispatchFixture, mockLaunchConnection } from './dispatch-fixture.ts';

// Releases gh lists after --exclude-drafts, on a synthetic commit graph: v1 <- v2 <- v2.1 <- exp-3 <- exp-4, with fork branching from v2.1.
// v2.1 is a stable release cut behind the experimental line, and fork diverges from it.
const stable = [{ tagName: 'v1', publishedAt: '2026-03-01T00:00:00Z' }, { tagName: 'v2', publishedAt: '2026-03-02T00:00:00Z' }];
const prerelease = (tagName: string, day: string) => ({ tagName, publishedAt: `2026-03-${day}T00:00:00Z`, pre: true });
const graph = { parents: { c1: [], c2: ['c1'], c3: ['c2'], c4: ['c3'], c5: ['c4'], d1: ['c3'] }, tags: { v1: 'c1', v2: 'c2', 'v2.1': 'c3', 'exp-3': 'c4', 'exp-4': 'c5', fork: 'd1' } };
type World = { releases?: Record<string, { tagName: string; publishedAt: string; pre?: boolean }[]>; broken?: string[] };

// Synthetic config, fake gh on PATH that records its calls, and a disposable store.
function fixture(t: { after: (fn: () => void) => void }, upstreams: Record<string, unknown>[], world: World = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-upstream-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'world.json'), JSON.stringify({ ...graph, broken: ['up/broken'], ...world, releases: { '*': [prerelease('exp-3', '03'), ...stable], ...world.releases } }));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${new URL('./fixtures/upstream-gh.cjs', import.meta.url).pathname}' '${dir}' "$@"\n`, { mode: 0o755 });
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
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' },
    discovery: { promptFile: join(dir, 'discovery.md'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    upstream: { enabled: true, promptFile: join(dir, 'upstream.md'), checkMinutes: 60 },
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/app', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'], upstreams }],
  });
  writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
  const store = new Store(c.stateDir);
  const calls = () => existsSync(join(dir, 'gh-calls')) ? readFileSync(join(dir, 'gh-calls'), 'utf8').split('\n').filter(Boolean) : [];
  const releaseCalls = () => calls().filter(l => l.startsWith('release'));
  const ghCalls = () => releaseCalls().length;
  // Every upstream read: release lists and their comparisons, but not the project's own pull requests.
  const upstreamReads = () => calls().filter(l => l.startsWith('release') || l.startsWith('api graphql')).length;
  t.after(() => { store.close(); process.env.PATH = oldPath; process.env.T3_FACTORY_CONFIG = oldConfig; rmSync(dir, { recursive: true, force: true }); });
  return { dir, c, store, ghCalls, releaseCalls, upstreamReads };
}
// The forward range a refresh verified and cached; manual starts read it without calling GitHub.
const verified = (store: Store, repo: string, base: string, candidate: string) => store.set(`upstreamCandidate:${repo}`, JSON.stringify({ base, candidate, baseCommit: `${base}-commit`, candidateCommit: `${candidate}-commit` }));
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
    { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2', baseCommit: 'c1', candidateCommit: 'c2' },
    { name: 'Exp', repo: 'up/exp', base: 'v1', candidate: 'exp-3', baseCommit: 'c1', candidateCommit: 'c4' },
  ], 'pre-releases count only when enabled, and an already-reviewed candidate yields nothing');
  assert.equal(ghCalls(), 3);
  assert.ok(releaseCalls().every(call => call.includes('--exclude-drafts')), 'drafts are excluded before the limit');
  for (const [repo, excluded] of [['up/stable', true], ['up/exp', false], ['up/current', true]] as const) assert.equal(releaseCalls().find(call => call.includes(`--repo ${repo} `))?.includes('--exclude-pre-releases'), excluded, 'each concurrent repository read applies its own prerelease policy before the limit');

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
  assert.deepEqual((await pendingReviews(c, store, [], now + 61 * 60_000)).map(p => p.upstream?.repo), ['up/exp'], 'a reviewed candidate is the new base');
  assert.deepEqual(upstreamRows(c, store).map(r => [r.repo, r.reviewed, r.latest, r.checkedAt, r.pending]), [
    ['up/stable', 'v2', 'v2', new Date(now + 61 * 60_000).toISOString(), false],
    ['up/exp', 'v1', 'exp-3', new Date(now + 61 * 60_000).toISOString(), true],
    ['up/current', 'v2', 'v2', new Date(now + 61 * 60_000).toISOString(), false],
  ], 'status rows report the watermark, the newest release seen, and whether a review is due');
  assert.equal(readStatus(c, store).upstreams.length, 3, 'status carries the rows');
  c.projects[0].enabled = false;
  assert.ok(upstreamRows(c, store).every(r => !r.pending), 'a disabled project has no review due');
});

test('upstream detection: a repository checkMinutes overrides the shared interval', async t => {
  const { store, c, releaseCalls } = fixture(t, [{ name: 'Daily', repo: 'up/daily', firstBase: 'v1', checkMinutes: 1440 }, { name: 'Stable', repo: 'up/stable', firstBase: 'v2' }]);
  const now = Date.parse('2026-03-05T00:00:00Z'), reads = () => releaseCalls().map(call => call.match(/--repo (\S+)/)![1]);
  await pendingReviews(c, store, [], now);
  await pendingReviews(c, store, [], now + 61 * 60_000);
  assert.deepEqual(reads().toSorted(), ['up/daily', 'up/stable', 'up/stable'], 'the daily repository is not read again within its own interval');
  await pendingReviews(c, store, [], now + 1441 * 60_000);
  assert.deepEqual(reads().slice(3).toSorted(), ['up/daily', 'up/stable']);
});

test('upstream detection: a failed release read is recorded on its row', async t => {
  const { c, store } = fixture(t, [{ name: 'Broken', repo: 'up/broken', firstBase: 'v1' }]);
  assert.deepEqual(await pendingReviews(c, store, [], Date.parse('2026-03-05T00:00:00Z')), []);
  const [row] = upstreamRows(c, store);
  assert.deepEqual([row.latest, row.pending, row.checkedAt], [null, false, '2026-03-05T00:00:00.000Z']);
  assert.match(row.checkError ?? '', /404/);
});

// Releases published after the watermark, newest first, that are not all strict descendants of it. Only a verified forward range is ever due;
// the cached reading that dry runs and manual starts use agrees with the refresh.
for (const [scenario, firstBase, published, candidate, error] of [
  ['an ancestor of the watermark is skipped', 'exp-3', ['v2.1'], null, null],
  ['the newest strict descendant is chosen over a later ancestor', 'exp-3', ['v2.1', 'exp-4'], { candidate: 'exp-4', baseCommit: 'c4', candidateCommit: 'c5' }, null],
  ['a diverged release is reported, not reviewed', 'exp-3', ['fork'], null, /fork diverged from exp-3/],
  ['a release GitHub cannot compare blocks the range', 'exp-3', ['gone', 'exp-4'], null, /GitHub could not compare gone with exp-3/],
  ['an unresolvable watermark blocks the range', 'lost', ['exp-4'], null, /Could not resolve head ref 'lost'/],
] as const) test(`upstream detection: ${scenario}`, async t => {
  const releases = [...published.map((tag, i) => prerelease(tag, String(10 - i))), prerelease('exp-3', '03'), ...stable];
  const { c, store } = fixture(t, [{ name: 'Exp', repo: 'up/exp', prereleases: true, firstBase }], { releases: { 'up/exp': releases } });
  const expected = candidate ? [{ name: 'Exp', repo: 'up/exp', base: firstBase, ...candidate }] : [];
  assert.deepEqual((await pendingReviews(c, store, [], Date.parse('2026-03-11T00:00:00Z'))).map(p => p.upstream), expected);
  assert.deepEqual((await pendingReviews(c, store, [], Date.parse('2026-03-11T00:01:00Z'), false)).map(p => p.upstream), expected, 'the cached reading offers the same range');
  const [row] = upstreamRows(c, store);
  assert.deepEqual([row.reviewed, row.pending], [firstBase, !!candidate], 'the watermark stays put');
  if (error) assert.match(row.checkError ?? '', error); else assert.equal(row.checkError, null);
});

// Each section with its own switch: the CLI flips only that section. Upstream reviews refuse a config without their
// section, which holds their prompt; repairs default theirs, so the switch works on a config that never mentions them.
for (const [section, missing] of [['upstream', 'No upstream reviews are configured'], ['repair', null]] as const) test(`${section} switch: the CLI flips only ${section}.enabled and ${missing ? 'refuses' : 'works on'} configs without ${section}`, t => {
  const { dir, c } = fixture(t, []);
  const main = new URL('../src/main.ts', import.meta.url).pathname, run = (file: string) => {
    try { return { code: 0, out: execFileSync(process.execPath, [main, `${section}-resume`], { env: { ...process.env, NODE_NO_WARNINGS: '1', T3_FACTORY_CONFIG: file }, encoding: 'utf8', stdio: 'pipe' }) }; }
    catch (error: any) { return { code: error.status, out: String(error.stderr) }; }
  };
  const file = join(dir, 'config.jsonc'), off = { enabled: false, promptFile: join(dir, 'upstream.md') };
  writeFileSync(file, JSON.stringify({ ...c, upstream: { ...c.upstream, enabled: false }, repair: off }));
  assert.equal(run(file).code, 0);
  const saved = JSON.parse(readFileSync(file, 'utf8')), other = section === 'upstream' ? 'repair' : 'upstream';
  assert.deepEqual([saved[section].enabled, saved[other].enabled, saved.enabled], [true, false, true]);
  const bare = join(dir, 'bare.jsonc'), { [section]: _, ...without } = { ...c, repair: off };
  writeFileSync(bare, JSON.stringify(without));
  if (missing) {
    assert.deepEqual(run(bare), { code: 1, out: `${missing}\n` });
    assert.equal(readFileSync(bare, 'utf8'), JSON.stringify(without), 'the file is untouched');
  } else {
    assert.equal(run(bare).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(bare, 'utf8')), { ...without, repair: { enabled: true } }, 'only the switch is written');
    assert.equal(loadConfig(bare).repair.enabled, true, 'and the config still loads');
  }
});

for (const scenario of ['priority', 'ambiguous-launch', 'dry-run', 'tickets-paused', 'tickets-paused-empty', 'reviews-paused', 'owner-busy', 'activity-unreadable', 'behind'] as const) test(`upstream dispatch: ${scenario}`, async t => {
  // behind: the reviewed v2.1 descends from every listed release, though v2 was published later.
  const { c, store, upstreamReads } = fixture(t, [{ name: 'Stable', repo: 'up/stable', firstBase: scenario === 'behind' ? 'v2.1' : 'v1' }]);
  if (['ambiguous-launch', 'tickets-paused', 'tickets-paused-empty', 'reviews-paused'].includes(scenario))
    c.models.push({ id: 'astra', name: 'Astra', model: { instanceId: 'codex', model: 'gpt-6-astra', options: [] }, automatic: true, maxDifficulty: 'high' });
  if (scenario.startsWith('tickets-paused')) c.enabled = false;
  if (scenario === 'reviews-paused') c.upstream!.enabled = false;
  if (['owner-busy', 'activity-unreadable'].includes(scenario)) c.concurrency.claude = 2; // a free slot, so only the idle gate can hold the ticket back
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  const tasks = scenario === 'tickets-paused-empty' ? [] : [{ id: 'task-1', projectId: 'FIX', title: 'Ready work', number: 1, status: 'todo', priority: 'urgent', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'high' }] }];
  const providers = [{ instanceId: 'claudeAgent', driver: 'claudeAgent', status: 'ready', installed: true, enabled: true, models: [{ slug: 'claude-opus-5' }] },
    { instanceId: 'codex', driver: 'codex', status: 'ready', installed: true, enabled: true, models: [{ slug: 'gpt-6-astra' }] }];
  t.mock.method(T3.prototype, 'providers', async () => providers);
  // The owner's own running Claude thread closes the idle gate.
  const personal = ['owner-busy', 'activity-unreadable'].includes(scenario) ? [v2Thread({ id: 'personal', projectId: 'FIX', status: 'running', activeRunId: 'run', updatedAt: new Date().toISOString(), latestUserMessageAt: new Date().toISOString(), providerInstanceId: 'claudeAgent', modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5' } })] : [];
  t.mock.method(T3.prototype, 'shell', async () => ({ threads: personal, projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })) }));
  t.mock.method(T3.prototype, 'detail', async () => { if (scenario === 'activity-unreadable') throw new Error('detail read failed'); return { messages: [], responses: [] }; });
  const window = (id: string, minutes: number) => ({ id, usedPercent: 0, windowDurationMins: minutes, resetsAt: new Date(Date.now() + minutes * 60_000).toISOString() });
  t.mock.method(T3.prototype, 'provider', async (instanceId: string) => ({ ...providers.find(p => p.instanceId === instanceId)!, usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(),
    windows: instanceId === 'codex' ? [window('primary', 10080)] : [window('five_hour', 300), window('seven_day', 10080)] } }));
  t.mock.method(Kanvil.prototype, 'connect', async () => {}); t.mock.method(Kanvil.prototype, 'close', async () => {});
  mockTracker(t, Kanvil.prototype, async (name: string, args: Record<string, unknown>) => {
    if (scenario.startsWith('tickets-paused')) throw new Error(`ticket read ${name} must not block a review`);
    if (name === 'labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'tickets') return { data: { workspaceId: 'workspace', columns: [{ tasks: tasks.filter(task => task.projectId === args.projectId) }] }, pagination: { total: tasks.length, totalPages: 1 } };
    if (name === 'ticket') return tasks.find(task => task.id === args.taskId);
    if (name === 'relations') return [];
    throw new Error(name);
  });
  const launched: Record<string, any>[] = [];
  mockLaunchConnection(t);
  t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => {
    launched.push(command);
    if (scenario === 'ambiguous-launch' && launched.length === 1) throw new Error('RPC outcome unknown');
    return { sequence: launched.length };
  });

  if (scenario === 'dry-run') {
    const result = await cycle(c, store, { dryRun: true });
    assert.deepEqual([result.reason, launched.length, upstreamReads(), store.get('upstreamCheckedAt:up/stable')], ['would-dispatch', 0, 0, null], 'a dry run reads no releases and writes no cache');
    return;
  }
  const result = await cycle(c, store);
  if (scenario.startsWith('tickets-paused')) {
    assert.deepEqual([result.reason, launched.map(l => l.title)], ['dispatched', ['Upstream review: Stable v1..v2']], 'reviews run while ticket automation is paused; the free slot takes no ticket or discovery');
    return;
  }
  if (scenario === 'owner-busy') {
    assert.deepEqual([result.reason, launched.map(l => l.title)], ['dispatched', ['Upstream review: Stable v1..v2']], 'a review does not wait for idle time; the second slot takes no ticket');
    const next = await cycle(c, store) as Record<string, any>;
    assert.equal(launched.length, 1, 'the ticket still waits for idle time');
    assert.equal(next.streams.find((s: any) => s.driver === 'claudeAgent').models[0].reason, 'waiting-for-idle', 'the idle gate, not the run limit, holds the ticket');
    return;
  }
  if (scenario === 'behind') {
    assert.deepEqual([result.reason, launched.map(l => l.title), store.get('upstreamReviewed:up/stable')], ['dispatched', ['Factory: FIX-1'], null], 'no backward review starts, and the slot goes to the ticket');
    return;
  }
  if (scenario === 'activity-unreadable') {
    assert.deepEqual([result.reason, launched.map(l => l.title)], ['dispatched', ['Upstream review: Stable v1..v2']], 'an unreadable activity state never blocks a review, nor lets the ticket through');
    return;
  }
  if (scenario === 'reviews-paused') {
    assert.deepEqual([launched.map(l => l.title), upstreamReads()], [['Factory: FIX-1'], 0], 'paused reviews neither read releases nor dispatch');
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
  assert.match(launched[0].initialMessage.text, /verified that v2 \(c2\) strictly descends from v1 \(c1\)\. If you review a different forward range from v1 instead, add "range":\{"base":"v1","candidate":"TAG"\}/);
  assert.deepEqual([saved.kind, saved.ticketKey, saved.upstream], ['upstream', null, { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2', baseCommit: 'c1', candidateCommit: 'c2' }]);
});

// Each review covers its scheduled range unless its report names the range it reviewed instead. The watermark moves only over a forward
// range GitHub confirms; backward and corrected cases model a review dispatched before ranges were verified.
const completions = {
  complete: { report: { status: 'complete', createdTaskIds: ['filed'] }, state: 'complete', reviewed: 'v2' },
  'no-work': { report: { status: 'no-work' }, state: 'complete', reviewed: 'v2' },
  'awaiting-human': { report: { status: 'awaiting-human' }, state: 'waiting', reviewed: null },
  'complete-empty': { report: { status: 'complete' }, state: 'waiting', reviewed: null, reason: /without created tickets/ },
  'complete-old': { report: { status: 'complete', createdTaskIds: ['filed'] }, state: 'waiting', reviewed: null, reason: /created before the review started/ },
  backward: { base: 'exp-3', candidate: 'v2.1', report: { status: 'no-work' }, state: 'complete', reviewed: null },
  corrected: { base: 'exp-3', candidate: 'v2.1', report: { status: 'no-work', range: { base: 'exp-3', candidate: 'exp-4' } }, state: 'complete', reviewed: 'exp-4' },
  'corrected-elsewhere': { base: 'exp-3', candidate: 'v2.1', report: { status: 'no-work', range: { base: 'v2', candidate: 'exp-4' } }, state: 'waiting', reviewed: null, reason: /does not start at the watermark exp-3/ },
} as const;
for (const [name, { base = 'v1', candidate = 'v2', report, state, reviewed, ...expected }] of Object.entries(completions) as [string, { base?: string; candidate?: string; report: Record<string, unknown>; state: string; reviewed: string | null; reason?: RegExp }][]) {
  test(`upstream completion: a ${name} report ${reviewed ? `advances the watermark to ${reviewed}` : 'keeps the watermark'}`, async t => {
    const { dir, c, store } = fixture(t, [{ name: 'Stable', repo: 'up/stable', firstBase: base }]);
    const review = job({ id: 'review', threadId: 'review-thread', reportPath: join(dir, 'report.json'), upstream: { name: 'Stable', repo: 'up/stable', base, candidate } });
    store.save(review);
    writeFileSync(review.reportPath, JSON.stringify({ jobId: review.id, reason: 'Reviewed', prUrls: [], createdTaskIds: [], ...report }));
    const kanvil = { task: async (id: string) => ({ id, projectId: 'FIX', number: 2, title: 'Filed', createdAt: name === 'complete-old' ? '2026-02-01T00:00:00Z' : review.createdAt, priority: 'low', status: 'todo' }) } as unknown as Kanvil;
    const threads = [v2Thread({ id: review.threadId, projectId: 'FIX', status: 'completed' })];
    await reconcile(c, store, { shell: async () => ({ threads }) } as unknown as T3, kanvil, threads, false);
    const [saved] = store.jobs();
    assert.equal(saved.state, state);
    if (expected.reason) assert.match(saved.reason, expected.reason);
    assert.equal(store.get('upstreamReviewed:up/stable'), reviewed);
    assert.equal(store.get('discoveryAfter:FIX'), null, 'a review never starts the discovery cooldown');
  });
}

test('upstream config: watched repositories need a prompt and a single owner', () => {
  const base = JSON.parse(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const project = { ...base.projects[0], upstreams: [{ name: 'Up', repo: 'up/stable', firstBase: 'v1' }] };
  assert.throws(() => configSchema.parse({ ...base, upstream: undefined, projects: [project] }), /upstream\.promptFile/);
  assert.throws(() => configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project, { ...project, key: 'TWO', kanvilId: 'two', t3Id: 'two' }] }), /only one project/);
  assert.equal(configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project] }).upstream?.checkMinutes, 360);
  const aliased = { ...project, key: 'TWO', kanvilId: 'two', t3Id: 'two', upstreams: [{ name: 'Up', repo: 'Up/Stable', firstBase: 'v1' }] };
  assert.throws(() => configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project, aliased] }), /only one project/, 'repository names compare case-insensitively');
});

for (const model of ['auto', 'sol']) test(`manual upstream dispatch: ${model} starts only the named due review while paused`, async t => {
  const f = dispatchFixture(t), { c, store } = f;
  c.enabled = false;
  c.upstream = { enabled: false, promptFile: c.factorySkill, checkMinutes: 60 };
  c.projects[0].upstreams = [{ name: 'Stable', repo: 'up/stable', firstBase: 'v1', prereleases: false }, { name: 'Other', repo: 'up/other', firstBase: 'v1', prereleases: false }];
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  verified(store, 'up/stable', 'v1', 'v2'); verified(store, 'up/other', 'v1', 'v3');
  const options = { manual: true, model, upstream: 'UP/Stable', overrideLimits: true };
  const result = await cycle(configSchema.parse(c), store, options, { t3: f.t3, kanvil: f.kanvil });
  assert.equal(result.reason, 'dispatched', 'Review now dispatches while both automation switches are paused');
  assert.equal(f.launches.length, 1);
  assert.deepEqual(store.jobs().map(j => [j.kind, j.projectId, j.taskId, j.upstream]), [['upstream', 'FIX', null, { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2', baseCommit: 'v1-commit', candidateCommit: 'v2-commit' }]]);
  assert.ok(!f.calls.some(call => call.startsWith('tickets:')), 'review dispatch does not depend on ticket inventory');
  assert.match((f.launches[0] as any).initialMessage.text, /Do not implement any ticket/);
  const again = await cycle(configSchema.parse(c), store, options, { t3: f.t3, kanvil: f.kanvil });
  assert.equal(again.reason, 'upstream-not-due', 'a pending review cannot be started again');
  assert.equal(f.launches.length, 1);
});

for (const scenario of ['unknown', 'current', 'behind', 'disabled', 'candidate-owned', 'fresh-change', 'exhausted', 'waiting-cap'] as const) test(`manual upstream guards: ${scenario}`, async t => {
  const f = dispatchFixture(t), { c, store } = f;
  c.upstream = { enabled: false, promptFile: c.factorySkill, checkMinutes: 60 };
  c.projects[0].upstreams = [{ name: 'Stable', repo: 'up/stable', firstBase: 'v1', prereleases: false }];
  c.projects[0].enabled = scenario !== 'disabled';
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  // behind: an older scheduler cached the newest published release, v1, which the reviewed v2 already contains.
  if (scenario === 'behind') { store.set('upstreamReviewed:up/stable', 'v2'); store.set('upstreamLatest:up/stable', 'v1'); }
  else if (scenario !== 'current') verified(store, 'up/stable', 'v1', 'v2');
  if (scenario === 'candidate-owned') store.save(job({ projectId: 'FIX', state: 'complete', upstream: { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' } }));
  if (scenario === 'fresh-change') f.hooks.shell = async final => { if (final) store.set('upstreamReviewed:up/stable', 'v2'); };
  if (scenario === 'exhausted') t.mock.method(f.t3, 'provider', async () => { const p = f.provider(); p.usageLimits.windows[0].usedPercent = 100; return p; });
  if (scenario === 'waiting-cap') {
    c.maxWaitingPRs = 1;
    store.save(job({ threadId: 'waiting-thread', state: 'waiting', upstream: { name: 'Other', repo: 'up/other', base: 'v1', candidate: 'v2' } }));
    f.threads.push(v2Thread({ id: 'waiting-thread', projectId: 'FIX', status: 'waiting', pendingRuntimeRequest: { kind: 'approval' } }));
  }
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  const result = await cycle(configSchema.parse(c), store, { manual: true, model: 'sol', upstream: scenario === 'unknown' ? 'up/unknown' : 'up/stable', overrideLimits: true }, { t3: f.t3, kanvil: f.kanvil });
  assert.equal(result.reason, scenario === 'fresh-change' ? 'upstream-changed-before-dispatch' : scenario === 'exhausted' ? 'codex-quota-exhausted' : scenario === 'waiting-cap' ? 'waiting-cap' : 'upstream-not-due');
  assert.equal(f.launches.length, 0, 'a refused review never falls back to ticket or discovery');
});

test('concurrent provider lanes reserve one upstream review at the final boundary', async t => {
  const f = dispatchFixture(t);
  f.c.enabled = false;
  f.c.upstream = { enabled: true, promptFile: f.c.factorySkill, checkMinutes: 60 };
  f.c.projects[0].upstreams = [{ name: 'Shared', repo: 'up/shared', firstBase: 'v1', prereleases: false }];
  f.c.models.push({ ...f.c.models[0], id: 'opus', name: 'Opus', model: { instanceId: 'claudeAgent', model: 'fixture-opus', options: [] } });
  const c = configSchema.parse(f.c);
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  verified(f.store, 'up/shared', 'v1', 'v2');
  const provider = (instanceId: string) => ({ ...f.provider(), instanceId, driver: instanceId, models: [{ slug: instanceId === 'codex' ? 'fixture-sol' : 'fixture-opus' }],
    usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: [
      { id: instanceId === 'codex' ? 'primary' : 'five_hour', usedPercent: 0, windowDurationMins: instanceId === 'codex' ? 10080 : 300 },
      ...instanceId === 'codex' ? [] : [{ id: 'seven_day', usedPercent: 0, windowDurationMins: 10080 }],
    ] } });
  t.mock.method(f.t3, 'providers', async () => [provider('codex'), provider('claudeAgent')]);
  const both = Promise.withResolvers<void>(); let finals = 0;
  t.mock.method(f.t3, 'provider', async (id: string, fresh: boolean) => {
    if (fresh) { if (++finals === 2) both.resolve(); await both.promise; }
    return provider(id);
  });
  const results = await Promise.all(['codex', 'claudeAgent'].map(providerDriver => cycle(c, f.store, {}, { t3: f.t3, kanvil: f.kanvil, deferReconcile: true, workKind: 'upstream', providerDriver })));
  assert.equal(finals, 2, 'both independent providers reached final validation');
  assert.equal(f.launches.length, 1, 'one due repository candidate must launch exactly once across providers');
  assert.equal(f.store.jobs().length, 1, 'the loser must not retain an extra upstream reservation');
  assert.equal(results.filter(result => result.reason === 'dispatched').length, 1);
});
