import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandFor, refuseRunCaller, serveControl, type ControlCommand } from '../src/control.ts';
import { handleMcp } from '../src/mcp.ts';
import type { Job } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

const call = (stateDir: string, name: string, args: unknown, config?: Config) => handleMcp(stateDir, { id: 1, method: 'tools/call', params: { name, arguments: args } }, () => config!) as Promise<{ result: { isError?: true; content: { text: string }[] } }>;

test('factory_status reads its fields from the Store, with each run labelled and without its prompt', async t => {
  const f = dispatchFixture(t);
  await f.run();
  const result = await call(f.c.stateDir, 'factory_status', {}, f.c);
  assert.equal(result.result.isError, undefined, result.result.content[0].text);
  const status = JSON.parse(result.result.content[0].text);
  assert.deepEqual(Object.keys(status), ['enabled', 'concurrency', 'work', 'decision', 'upNext', 'plans', 'jobs', 'recent']);
  assert.deepEqual(status.concurrency, f.c.concurrency);
  assert.deepEqual(status.jobs.map((job: Job & { label: string }) => [job.id, job.label]), f.store.jobs().map(job => [job.id, job.ticketKey]));
  assert.ok(status.jobs.length && status.jobs.every((job: Job) => !('command' in job)));
});

type Live = { id: string; worktreePath: string | null }[];
async function scheduler(t: import('node:test').TestContext, jobs: Job[] = [], threads: () => Promise<Live> = async () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-')), seen: ControlCommand[] = [];
  // The service's own refusal runs before anything is queued; only accepted commands reach `seen`.
  const server = serveControl(dir, async command => await refuseRunCaller(command, jobs, threads) ?? (seen.push(command), { code: 0, data: { reason: 'dispatched' } }));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.once('listening', resolve));
  return { dir, seen };
}

test('agent dispatch without overrides reaches the scheduler as an agent request', async t => {
  const { dir, seen } = await scheduler(t);
  const ok = await call(dir, 'dispatch', { ticket: 'fix-7', chain: 'all' });
  assert.equal(ok.result.isError, undefined);
  assert.deepEqual(seen, [{ type: 'dispatch', options: { manual: true, agent: true, ticket: 'FIX-7', chain: 'all' } }]);
});

test('an owner session overrides limits, model and provider with the same command as the CLI', async t => {
  const { dir, seen } = await scheduler(t);
  const cases: [Record<string, unknown>, string[]][] = [
    [{ ticket: 'FIX-7', overrideLimits: true, chain: 'all' }, ['--ticket', 'FIX-7', '--chain', 'all', '--override-limits']],
    [{ epic: 'epic-1', overrideLimits: ['idle', 'labels'], model: 'opus' }, ['--epic', 'epic-1', '--override', 'idle,labels', '--model', 'opus']],
    [{ ticket: 'FIX-7', provider: 'codex' }, ['--ticket', 'FIX-7', '--provider', 'codex']],
  ];
  for (const [args, cli] of cases) {
    const ok = await call(dir, 'dispatch', args);
    assert.equal(ok.result.isError, undefined, ok.result.content[0].text);
    assert.deepEqual(seen.at(-1), { ...commandFor(['dispatch', ...cli]), callerCwd: process.cwd() });
  }
  assert.equal((await call(dir, 'dispatch', { ticket: 'FIX-7', overrideLimits: ['quota'] })).result.isError, true);
});

test('a factory run cannot override from its worktree, symlinked paths included', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-mcp-run-')), worktree = join(root, 'worktree'), link = join(root, 'link'), owner = join(root, 'owner');
  mkdirSync(join(worktree, 'src'), { recursive: true }); mkdirSync(owner); symlinkSync(worktree, link);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const job = (id: string, state: Job['state'], worktreePath?: string) => ({ id, threadId: `thread-${id}`, state, ...worktreePath ? { thread: { worktreePath } } : {} }) as Job;
  const { dir, seen } = await scheduler(t, [job('run-1', 'running', link), job('old', 'complete', root)]);
  const dispatch = { type: 'dispatch' as const, callerCwd: owner, options: { manual: true, ticket: 'FIX-7', overrideLimits: true } };
  const refusal = async (jobs: Job[], live: Live | Error) => ((await refuseRunCaller(dispatch, jobs, async () => { if (live instanceof Error) throw live; return live; }))?.data as { message: string } | undefined)?.message;

  for (const cwd of [worktree, join(link, 'src')]) {
    t.mock.method(process, 'cwd', () => cwd);
    const refused = await call(dir, 'dispatch', { ticket: 'FIX-7', overrideLimits: true });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /run-1/);
  }
  assert.equal(seen.length, 0, 'a refused override queues nothing');
  // A run launched since the last reconcile has no snapshot; T3's live binding still names its worktree.
  assert.match(await refusal([job('new', 'running')], [{ id: 'thread-new', worktreePath: owner }]) ?? '', /inside run new's worktree/);
  assert.match(await refusal([job('new', 'dispatching')], []) ?? '', /run new's worktree is not known yet/, 'an unknown worktree fails closed');
  await assert.rejects(refusal([job('run-1', 'running', worktree)], new Error('T3 unreachable')), /T3 unreachable/);
  assert.equal(await refusal([job('run-1', 'running', `${owner}-other`)], []), undefined, 'a sibling path is outside the worktree');
  assert.equal(await refusal([job('old', 'dismissed', owner)], new Error('not read')), undefined, 'finished runs do not hold their worktree');
});

test('agent writes fail without a running scheduler instead of running locally', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await call(dir, 'stop_run', { jobId: 'job-1' });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /not running/);
});
