import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../src/config.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle, pendingReviews, reconcile } from '../src/scheduler.ts';
import { v2Thread } from './v2-fixture.ts';

const releases = [
  { tagName: 'v3-draft', isDraft: true, isPrerelease: false, publishedAt: '2026-03-04T00:00:00Z' },
  { tagName: 'exp-3', isDraft: false, isPrerelease: true, publishedAt: '2026-03-03T00:00:00Z' },
  { tagName: 'v2', isDraft: false, isPrerelease: false, publishedAt: '2026-03-02T00:00:00Z' },
  { tagName: 'v1', isDraft: false, isPrerelease: false, publishedAt: '2026-03-01T00:00:00Z' },
];

// Synthetic config, fake gh on PATH that counts its calls, and a disposable store.
function fixture(t: { after: (fn: () => void) => void }, upstreams: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-upstream-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  writeFileSync(join(dir, 'releases.json'), JSON.stringify(releases));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$@" >> "${join(dir, 'gh-calls')}"\ncase "$1" in release) cat "${join(dir, 'releases.json')}" ;; *) printf "[]\\n" ;; esac\n`, { mode: 0o755 });
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
    upstream: { promptFile: join(dir, 'upstream.md'), checkMinutes: 60 },
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kaneoId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/app', baseBranch: 'main', readyStatuses: ['to-do'], doneStatuses: ['done'], upstreams }],
  });
  writeFileSync(process.env.T3_FACTORY_CONFIG, JSON.stringify(c));
  const store = new Store(c.stateDir);
  const ghCalls = () => existsSync(join(dir, 'gh-calls')) ? readFileSync(join(dir, 'gh-calls'), 'utf8').split('\n').filter(l => l.startsWith('release')).length : 0;
  t.after(() => { store.close(); process.env.PATH = oldPath; process.env.T3_FACTORY_CONFIG = oldConfig; rmSync(dir, { recursive: true, force: true }); });
  return { dir, c, store, ghCalls };
}
const job = (overrides: Partial<Job>): Job => ({ id: 'old', kind: 'upstream', projectId: 'FIX', taskId: null, ticketKey: null, threadId: 'old-thread', messageId: 'm', createdAt: '2026-03-01T00:00:00Z', state: 'running', reason: '', lastPersonalActivity: null, reportPath: '/nonexistent', command: null, prUrls: [], completedAt: null, ...overrides });

test('upstream detection: newest counted release, throttled reads, and one review per candidate', async t => {
  const { c, store, ghCalls } = fixture(t, [
    { name: 'Stable', repo: 'up/stable', firstBase: 'v1' },
    { name: 'Exp', repo: 'up/exp', prereleases: true, firstBase: 'v1' },
    { name: 'Current', repo: 'up/current', firstBase: 'v2' },
  ]);
  const now = Date.parse('2026-03-05T00:00:00Z');
  const pending = await pendingReviews(c, store, [], now);
  assert.deepEqual(pending.map(p => p.upstream), [
    { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' },
    { name: 'Exp', repo: 'up/exp', base: 'v1', candidate: 'exp-3' },
  ], 'drafts never count, pre-releases only when enabled, and an already-reviewed candidate yields nothing');
  assert.equal(ghCalls(), 3);

  await pendingReviews(c, store, [], now + 59 * 60_000);
  assert.equal(ghCalls(), 3, 'GitHub is not read again within checkMinutes');

  const open = job({ upstream: { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' } });
  const dismissed = job({ id: 'gone', state: 'dismissed', upstream: { name: 'Exp', repo: 'up/exp', base: 'v1', candidate: 'exp-3' } });
  assert.deepEqual(await pendingReviews(c, store, [open, dismissed], now + 61 * 60_000), [], 'an unfinished or dismissed review blocks its candidate');
  assert.equal(ghCalls(), 5, 'a repository with an unfinished review is not read');

  store.set('upstreamReviewed:up/stable', 'v2');
  assert.deepEqual((await pendingReviews(c, store, [], now + 61 * 60_000)).map(p => p.upstream.repo), ['up/exp'], 'a reviewed candidate is the new base');
});

test('upstream dispatch: a pending review goes ahead of a ready ticket with a filled prompt', async t => {
  const { c, store } = fixture(t, [{ name: 'Stable', repo: 'up/stable', firstBase: 'v1' }]);
  const tasks = [{ id: 'task-1', projectId: 'FIX', title: 'Ready work', number: 1, status: 'to-do', priority: 'urgent', createdAt: '2026-01-01T00:00:00Z', labels: [{ name: 'sf' }, { name: 'high' }] }];
  const providers = [{ instanceId: 'claudeAgent', driver: 'claudeAgent', status: 'ready', installed: true, enabled: true, models: [{ slug: 'claude-opus-5' }] }];
  t.mock.method(T3.prototype, 'providers', async () => providers);
  t.mock.method(T3.prototype, 'shell', async () => ({ threads: [], projects: c.projects.map(p => ({ id: p.t3Id, title: p.name, workspaceRoot: p.repoPath })) }));
  t.mock.method(T3.prototype, 'detail', async () => ({ messages: [], responses: [] }));
  t.mock.method(T3.prototype, 'provider', async () => ({ ...providers[0], usageLimits: { checkedAt: new Date(Date.now() + 1000).toISOString(), windows: [
    { id: 'five_hour', usedPercent: 0, windowDurationMins: 300, resetsAt: new Date(Date.now() + 300 * 60_000).toISOString() },
    { id: 'seven_day', usedPercent: 0, windowDurationMins: 10080, resetsAt: new Date(Date.now() + 10080 * 60_000).toISOString() },
  ] } }));
  t.mock.method(Kaneo.prototype, 'connect', async () => {}); t.mock.method(Kaneo.prototype, 'close', async () => {});
  t.mock.method(Kaneo.prototype, 'call', async (name: string, args: Record<string, unknown>) => {
    if (name === 'list_workspace_labels') return tasks.flatMap(task => task.labels.map(label => ({ ...label, taskId: task.id, workspaceId: 'workspace' })));
    if (name === 'list_tasks') return { data: { workspaceId: 'workspace', columns: [{ tasks: tasks.filter(task => task.projectId === args.projectId) }] }, pagination: { total: tasks.length, totalPages: 1 } };
    if (name === 'get_task') return tasks.find(task => task.id === args.taskId);
    if (name === 'get_task_relations') return [];
    throw new Error(name);
  });
  const launched: Record<string, any>[] = [];
  t.mock.method(T3.prototype, 'launch', async (command: Record<string, any>) => { launched.push(command); return { sequence: launched.length }; });

  const result = await cycle(c, store);
  assert.equal(result.reason, 'dispatched');
  assert.equal(launched.length, 1, 'the only slot goes to the review');
  assert.equal(launched[0].title, 'Upstream review: Stable v1..v2');
  assert.match(launched[0].initialMessage.text, /Review Stable \(up\/stable\) from v1 to v2\./);
  assert.match(launched[0].initialMessage.text, /external content/);
  const [saved] = store.jobs();
  assert.deepEqual([saved.kind, saved.ticketKey, saved.upstream], ['upstream', null, { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' }]);
});

for (const status of ['complete', 'no-work', 'awaiting-human'] as const) {
  test(`upstream completion: a ${status} report ${status === 'awaiting-human' ? 'keeps' : 'advances'} the watermark`, async t => {
    const { dir, c, store } = fixture(t, [{ name: 'Stable', repo: 'up/stable', firstBase: 'v1' }]);
    const review = job({ id: 'review', threadId: 'review-thread', reportPath: join(dir, 'report.json'), upstream: { name: 'Stable', repo: 'up/stable', base: 'v1', candidate: 'v2' } });
    store.save(review);
    writeFileSync(review.reportPath, JSON.stringify({ jobId: review.id, status, reason: 'Reviewed', prUrls: [], createdTaskIds: status === 'complete' ? ['filed'] : [] }));
    const kaneo = { call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_task') return { id: args.taskId, projectId: 'FIX', number: 2, title: 'Filed', createdAt: review.createdAt, priority: 'low', status: 'to-do' };
      throw new Error(name);
    } } as unknown as Kaneo;
    const threads = [v2Thread({ id: review.threadId, projectId: 'FIX', status: 'completed' })];
    await reconcile(c, store, { shell: async () => ({ threads }) } as unknown as T3, kaneo, threads, false);
    const [saved] = store.jobs();
    assert.equal(saved.state, status === 'awaiting-human' ? 'waiting' : 'complete');
    assert.equal(store.get('upstreamReviewed:up/stable'), status === 'awaiting-human' ? null : 'v2');
    assert.equal(store.get('discoveryAfter:FIX'), null, 'a review never starts the discovery cooldown');
  });
}

test('upstream config: watched repositories need a prompt and a single owner', () => {
  const base = JSON.parse(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const project = { ...base.projects[0], upstreams: [{ name: 'Up', repo: 'up/stable', firstBase: 'v1' }] };
  assert.throws(() => configSchema.parse({ ...base, upstream: undefined, projects: [project] }), /upstream\.promptFile/);
  assert.throws(() => configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project, { ...project, key: 'TWO', kaneoId: 'two', t3Id: 'two' }] }), /only one project/);
  assert.equal(configSchema.parse({ ...base, upstream: { promptFile: '/p.md' }, projects: [project] }).upstream?.checkMinutes, 360);
});
