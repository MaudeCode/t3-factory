import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig } from '../src/config.ts';
import { saveSettings } from '../src/settings.ts';
import type { T3, Kanvil } from '../src/clients.ts';
import { Store, type Job } from '../src/store.ts';
import { cycle, pendingRepairs, reconcile, repairRows, writeStatus } from '../src/scheduler.ts';
import { v2Thread } from './v2-fixture.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

type Run = { databaseId: number; status: string; conclusion: string; headSha: string; url: string; createdAt: string; updatedAt: string };
// A controlled clock an hour in the past, so a report verified by reconcile is always newer than any read below.
const t0 = Date.now() - 3_600_000;
const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
const run = (id: number, conclusion: string, minutes: number, status = conclusion ? 'completed' : 'in_progress'): Run =>
  ({ databaseId: id, status, conclusion, headSha: `sha-${id}`, url: `https://github.com/fixture/app/actions/runs/${id}`, createdAt: at(minutes), updatedAt: at(minutes + 5) });

// A fake gh on PATH that answers only the reads repairs make, keyed by workflow, run and pull request; anything else fails.
function fakeGitHub(dir: string) {
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
echo "$*" >> "${join(dir, 'gh-calls')}"
wf=""; prev=""; for a in "$@"; do [ "$prev" = "--workflow" ] && wf="$a"; prev="$a"; done
case "$1 $2" in
  "run list") cat "${dir}/runs-$wf.json" ;;
  "run view") cat "${dir}/jobs-$3.json" ;;
  "pr view") cat "${dir}/pr-$3.json" ;;
  "pr list") printf "[]\\n" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  return {
    runs: (workflow: string, runs: Run[]) => writeFileSync(join(dir, `runs-${workflow}.json`), JSON.stringify(runs)),
    jobs: (id: number, failed: string[], passed: string[] = []) => writeFileSync(join(dir, `jobs-${id}.json`), JSON.stringify({ jobs: [...failed.map(name => ({ name, conclusion: 'failure' })), ...passed.map(name => ({ name, conclusion: 'success' }))] })),
    merged: (number: number) => writeFileSync(join(dir, `pr-${number}.json`), JSON.stringify({ state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: 'a'.repeat(40) } })),
    runReads: () => existsSync(join(dir, 'gh-calls')) ? readFileSync(join(dir, 'gh-calls'), 'utf8').split('\n').filter(line => line.startsWith('run list')).length : 0,
  };
}

function fixture(t: TestContext, repair: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-repair-')), repo = join(dir, 'repo'); mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  for (const file of ['discovery.md', 'skill']) writeFileSync(join(dir, file), 'Fixture.');
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  const budget = { reservePercent: 0, minRemainingPercent: 0 };
  const c = configSchema.parse({ enabled: true, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'opus', name: 'Opus', model: { instanceId: 'claudeAgent', model: 'claude-opus-5' }, automatic: true }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url: 'http://127.0.0.1:3773', credentialFile: join(dir, 'unused') },
    kanvil: { url: 'https://kanvil.example.test', workspaceId: 'workspace' },
    discovery: { promptFile: join(dir, 'discovery.md'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    repair: { enabled: true, promptFile: new URL('../prompts/repair.md', import.meta.url).pathname, ...repair },
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: repo, githubRepo: 'fixture/app', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'], repairWorkflows: ['ci.yml'] }],
  });
  const store = new Store(c.stateDir);
  t.after(() => { store.close(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  return { dir, c, store, gh: fakeGitHub(dir) };
}
// The tracker as a repair report's verification reads it: every ticket it names is in the fixture project.
const tracker = { task: async () => ({ projectId: 'FIX' }) } as unknown as Kanvil;
const repairJob = (overrides: Partial<Job> & { runId?: number; unrepaired?: string[] } = {}): Job => {
  const { runId = 4, unrepaired, ...job } = overrides;
  return { id: `repair-${runId}`, kind: 'repair', projectId: 'FIX', taskId: null, ticketKey: null, threadId: `thread-${runId}`, messageId: 'm', createdAt: at(-200), state: 'complete', reason: '', lastPersonalActivity: null, reportPath: '/nonexistent', command: null, prUrls: [], completedAt: null,
    repair: { workflow: 'ci.yml', runId, runUrl: `https://github.com/fixture/app/actions/runs/${runId}`, sha: `sha-${runId}`, failedJobs: ['deploy'], ...unrepaired ? { unrepaired } : {} }, ...job };
};

test('repair follow: an unfinished run is read on every pass and its failure is due on the first pass after it ends', async t => {
  const { c, store, gh } = fixture(t);
  gh.runs('ci.yml', [run(2, '', -1), run(1, 'success', -30)]);
  assert.deepEqual(await pendingRepairs(c, store, [], t0), []);
  gh.runs('ci.yml', [run(2, 'failure', -1), run(1, 'success', -30)]); gh.jobs(2, ['test'], ['lint']);
  assert.deepEqual((await pendingRepairs(c, store, [], t0 + 15_000)).map(p => p.repair),
    [{ workflow: 'ci.yml', runId: 2, runUrl: 'https://github.com/fixture/app/actions/runs/2', sha: 'sha-2', failedJobs: ['test'] }],
    'the next pass reads the followed run again, well inside repair.checkMinutes');
  await pendingRepairs(c, store, [], t0 + 60_000);
  assert.equal(gh.runReads(), 2, 'a finished run is not followed; the slow interval applies again');
});

test('repair follow: a verified merge of a factory pull request makes the next pass read the watched workflow', async t => {
  const { dir, c, store, gh } = fixture(t);
  gh.runs('ci.yml', [run(1, 'success', -30)]); gh.merged(7);
  await pendingRepairs(c, store, [], t0);
  await pendingRepairs(c, store, [], t0 + 60_000);
  assert.equal(gh.runReads(), 1, 'nothing to follow and no merge: the slow interval holds');
  const job = repairJob({ state: 'running', reportPath: join(dir, 'report.json') });
  store.save(job);
  writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'complete', reason: 'Repaired', prUrls: ['https://github.com/fixture/app/pull/7'], repairedJobs: ['test'], unrepairedJobs: ['deploy'], createdTaskIds: ['T-1'] }));
  await reconcile(c, store, {} as T3, tracker, [v2Thread({ id: job.threadId, projectId: 'FIX' })], false);
  assert.deepEqual([store.job(job.id)!.state, store.job(job.id)!.repair!.repaired, store.job(job.id)!.repair!.unrepaired], ['complete', ['test'], ['deploy']], 'the verified report records what it repaired and what it left');
  await pendingRepairs(c, store, [], t0 + 2 * 60_000);
  assert.equal(gh.runReads(), 2, 'the merge makes the next pass read');
});

test('repair report: a run that leaves a failed job without a ticket does not complete', async t => {
  const { dir, c, store } = fixture(t);
  const job = repairJob({ state: 'running', reportPath: join(dir, 'report.json') });
  store.save(job);
  writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: 'complete', reason: 'Did not reproduce', prUrls: [], repairedJobs: [], unrepairedJobs: ['deploy'] }));
  await reconcile(c, store, {} as T3, tracker, [v2Thread({ id: job.threadId, projectId: 'FIX' })], false);
  assert.deepEqual([store.job(job.id)!.state, store.job(job.id)!.reason], ['waiting', 'Repair left failed jobs unrepaired without a ticket; file one and list it in createdTaskIds']);
});

// T3's own automatic settlement command; the fake refuses anything else.
const autoSettle = z.object({ type: z.literal('thread.auto-settle'), commandId: z.uuid(), threadId: z.string().min(1), snapshotAt: z.iso.datetime({ offset: true }) }).strict();
for (const scenario of ['cleaned', 'pinned', 'cleanup-pending'] as const) test(`finished run: a verified repair without a pull request ${scenario === 'cleaned' ? 'leaves the T3 list on its own' : `stays in the T3 list while ${scenario === 'pinned' ? 'pinned' : 'its workspace is not cleaned up'}`}`, async t => {
  const { c, store } = fixture(t);
  const job = repairJob({ completedAt: at(-10), ...scenario === 'cleanup-pending' ? {} : { workspaceCleanedAt: at(-5) } });
  store.save(job);
  const thread = v2Thread({ id: job.threadId, projectId: 'FIX', updatedAt: at(-5), ...scenario === 'pinned' ? { pinnedAt: at(-60) } : {} });
  const sent: z.infer<typeof autoSettle>[] = [];
  const t3 = { dispatch: async (command: unknown) => { sent.push(autoSettle.parse(command)); } } as unknown as T3;
  await reconcile(c, store, t3, {} as Kanvil, [thread], true, false);
  assert.deepEqual(sent.map(command => [command.threadId, command.snapshotAt]), scenario === 'cleaned' ? [[job.threadId, thread.updatedAt]] : []);
});

// Each rule that holds a failed run back, with a control the rule alone separates it from.
const rules: { name: string; due: boolean; jobs?: Job[]; runs?: Run[]; failed?: string[]; repair?: Record<string, unknown> }[] = [
  { name: 'a repair is already running for the workflow', due: false, jobs: [repairJob({ state: 'running', completedAt: null })] },
  { name: 'inside the cooldown', due: false, jobs: [repairJob({ completedAt: at(-10) })] },
  { name: 'after the default 60-minute cooldown', due: true, jobs: [repairJob({ completedAt: at(-61) })] },
  { name: 'after a shorter cooldownMinutes', due: true, jobs: [repairJob({ completedAt: at(-10) })], repair: { cooldownMinutes: 5 } },
  { name: 'a run that already had a repair', due: false, jobs: [repairJob({ runId: 5, state: 'dismissed', dismissedAt: at(-120) })] },
  { name: 'a cancelled run', due: false, runs: [run(6, 'cancelled', -1), run(3, 'success', -60)] },
  { name: 'the failure the last repair gave up on', due: false, jobs: [repairJob({ completedAt: at(-120), unrepaired: ['deploy'] })] },
  { name: 'a gave-up failure after a run passed', due: true, jobs: [repairJob({ completedAt: at(-120), unrepaired: ['deploy'] })], runs: [run(5, 'failure', -1), run(3, 'success', -60)] },
  { name: 'a gave-up failure with a new failed job', due: true, jobs: [repairJob({ completedAt: at(-120), unrepaired: ['deploy'] })], failed: ['deploy', 'test'] },
];
for (const rule of rules) test(`repair rules: ${rule.name} ${rule.due ? 'starts' : 'starts nothing'}`, async t => {
  const { c, store, gh } = fixture(t, rule.repair);
  // Every listed run has readable jobs, so only the rule under test can hold a run back.
  for (const r of rule.runs ?? [run(5, 'failure', -1)]) gh.jobs(r.databaseId, rule.failed ?? ['deploy']);
  gh.runs('ci.yml', rule.runs ?? [run(5, 'failure', -1)]);
  assert.deepEqual((await pendingRepairs(c, store, rule.jobs ?? [], t0)).map(p => p.repair?.runId), rule.due ? [5] : []);
});

for (const passed of [false, true]) test(`repair cooldown: a failure seen during the cooldown ${passed ? 'is superseded by a later pass' : 'decides once the cooldown ends'}`, async t => {
  const { c, store, gh } = fixture(t);
  const jobs = [repairJob({ completedAt: at(-50) })];
  gh.runs('ci.yml', [run(5, 'failure', -1)]); gh.jobs(5, ['deploy']);
  assert.deepEqual(await pendingRepairs(c, store, jobs, t0), [], 'inside the cooldown nothing starts and nothing is queued');
  if (passed) gh.runs('ci.yml', [run(6, 'success', 5), run(5, 'failure', -1)]);
  assert.deepEqual(await pendingRepairs(c, store, jobs, t0 + 11 * 60_000, false), [], 'an admission pass that runs before the cooldown-end read starts nothing');
  assert.deepEqual((await pendingRepairs(c, store, jobs, t0 + 11 * 60_000)).map(p => p.repair?.runId), passed ? [] : [5], 'the newest finished run, read when the cooldown ends, decides');
  assert.equal(gh.runReads(), 2, 'the end of the cooldown is a reason to read');
});

test('repair cooldown: a failed read when the cooldown ends holds a stale failure until a read succeeds', async t => {
  const { dir, c, store, gh } = fixture(t);
  const jobs = [repairJob({ completedAt: at(-50) })];
  gh.runs('ci.yml', [run(5, 'failure', -1)]); gh.jobs(5, ['deploy']);
  assert.deepEqual(await pendingRepairs(c, store, jobs, t0), []);
  rmSync(join(dir, 'runs-ci.yml.json'));
  assert.deepEqual(await pendingRepairs(c, store, jobs, t0 + 11 * 60_000), [], 'the cached failure may be superseded; nothing starts while its result is unknown');
  gh.runs('ci.yml', [run(6, 'success', 5), run(5, 'failure', -1)]);
  assert.deepEqual(await pendingRepairs(c, store, jobs, t0 + 11 * 60_000 + 15_000), [], 'the next pass reads again and finds the newer pass');
  assert.equal(gh.runReads(), 3);
});

test('repair status: each watched workflow shows its newest result, the run being followed, the last repair and the cooldown', async t => {
  const { c, store, gh } = fixture(t);
  store.save(repairJob({ completedAt: at(-10), unrepaired: ['deploy'] }));
  gh.runs('ci.yml', [run(6, '', 0), run(5, 'failure', -1)]); gh.jobs(5, ['deploy']);
  await pendingRepairs(c, store, store.jobs(), t0);
  const [row] = repairRows(c, store, t0);
  assert.deepEqual([row.workflow, row.finished?.id, row.finished?.failedJobs, row.following?.id, row.lastRepair?.runId, row.lastRepair?.unrepaired, row.cooldownEndsAt, row.pending, row.hold],
    ['ci.yml', 5, ['deploy'], 6, 4, ['deploy'], at(50), false, 'Cooling down']);
  assert.equal(writeStatus(c, store).repairs.length, 1, 'status.json carries the rows');
});

test('repair config: a file with no repair section has repairs off with the shipped prompt, and watching a workflow from settings adds nothing else to it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-repair-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { repair: _, ...bare } = JSON.parse(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const file = join(dir, 'config.jsonc'); writeFileSync(file, JSON.stringify({ ...bare, projects: [{ ...bare.projects[0], repairWorkflows: [] }] }));
  const before = loadConfig(file);
  assert.deepEqual(before.repair, { enabled: false, promptFile: fileURLToPath(new URL('../prompts/repair.md', import.meta.url)), cooldownMinutes: 60, checkMinutes: 30 });
  assert.ok(existsSync(before.repair.promptFile), 'the default prompt ships with the code');
  saveSettings({ base: before, config: { ...before, projects: [{ ...before.projects[0], repairWorkflows: ['ci.yml'] }] } }, file);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([stored.repair, stored.projects[0].repairWorkflows, loadConfig(file).projects[0].repairWorkflows], [undefined, ['ci.yml'], ['ci.yml']]);
  assert.deepEqual(configSchema.parse({ ...bare, repair: { promptFile: '/p.md' } }).repair, { enabled: false, promptFile: '/p.md', cooldownMinutes: 60, checkMinutes: 30 }, 'a prompt of its own replaces the shipped one');
});

test('repair dispatch: a failed run takes the free slot ahead of a ready ticket, without waiting for idle time, once', async t => {
  const f = dispatchFixture(t), { c, store } = f, gh = fakeGitHub(f.dir);
  c.repair = { enabled: true, promptFile: new URL('../prompts/repair.md', import.meta.url).pathname, cooldownMinutes: 60, checkMinutes: 30 };
  c.projects[0].repairWorkflows = ['ci.yml'];
  writeFileSync(process.env.T3_FACTORY_CONFIG!, JSON.stringify(c));
  gh.runs('ci.yml', [run(5, 'failure', -1)]); gh.jobs(5, ['test', 'deploy'], ['lint']);
  // The owner's own running Codex session closes the idle gate for tickets.
  f.threads.push(v2Thread({ id: 'personal', projectId: 'FIX', status: 'running', activeRunId: 'run', updatedAt: new Date().toISOString(), latestUserMessageAt: new Date().toISOString(), providerInstanceId: 'codex', modelSelection: { instanceId: 'codex', model: 'fixture-sol' } }));
  const result = await cycle(configSchema.parse(c), store, {}, { t3: f.t3, kanvil: f.kanvil });
  assert.equal(result.reason, 'dispatched');
  const [launch] = f.launches as { title: string; workspaceStrategy: Record<string, unknown>; initialMessage: { text: string } }[];
  assert.deepEqual([f.launches.length, launch.title], [1, 'CI repair: FIX ci.yml run 5'], 'the only slot goes to the repair, not FIX-1');
  assert.deepEqual({ ...launch.workspaceStrategy, branch: String(launch.workspaceStrategy.branch).replace(/[0-9a-f]{8}$/, 'ID') }, { type: 'worktree', baseRef: 'main', branch: 'fix/factory-repair-ID', startFromOrigin: true });
  assert.match(launch.initialMessage.text, /The `ci\.yml` workflow of `fixture\/FIX` failed on its release branch: run 5 \(https:\/\/github\.com\/fixture\/app\/actions\/runs\/5\) at commit `sha-5`\. These jobs failed:\n\n- test\n- deploy\n/);
  assert.match(launch.initialMessage.text, /"createdTaskIds":\["TICKET_ID"\],"repairedJobs":\["test"\],"unrepairedJobs":\["deploy"\]/, 'the report names the jobs it repaired, those it left, and the ticket that records them');
  assert.match(launch.initialMessage.text, /<software-factory-skill>\nSource: [^\n]+\n[^\n]+\n\n# Software factory\n<\/software-factory-skill>/, 'a repair publishes and merges under the configured delivery workflow');
  assert.deepEqual(store.jobs().map(j => [j.kind, j.repair?.runId]), [['repair', 5]]);
  await cycle(configSchema.parse(c), store, {}, { t3: f.t3, kanvil: f.kanvil });
  assert.equal(f.launches.length, 1, 'the same run never gets a second repair');
});
