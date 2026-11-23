import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandFor, refuseRunCaller, serveControl, type ControlCommand } from '../src/control.ts';
import { handleMcp } from '../src/mcp.ts';
import type { Job } from '../src/store.ts';

const call = (stateDir: string, name: string, args: unknown) => handleMcp(stateDir, { id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{ result: { isError?: true; content: { text: string }[] } }>;

async function scheduler(t: import('node:test').TestContext, jobs: Job[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-')), seen: ControlCommand[] = [];
  // The service's own refusal runs before anything is queued; only accepted commands reach `seen`.
  const server = serveControl(dir, async command => refuseRunCaller(command, jobs) ?? (seen.push(command), { code: 0, data: { reason: 'dispatched' } }));
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
  const root = mkdtempSync(join(tmpdir(), 'factory-mcp-run-')), worktree = join(root, 'worktree'), link = join(root, 'link');
  mkdirSync(join(worktree, 'src'), { recursive: true }); symlinkSync(worktree, link);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const job = (id: string, state: Job['state'], worktreePath: string) => ({ id, state, thread: { worktreePath } }) as Job;
  const { dir, seen } = await scheduler(t, [job('run-1', 'running', link), job('old', 'complete', root)]);
  const dispatch = (callerCwd: string) => ({ type: 'dispatch' as const, callerCwd, options: { manual: true, ticket: 'FIX-7', overrideLimits: true } });

  for (const cwd of [worktree, join(link, 'src')]) {
    t.mock.method(process, 'cwd', () => cwd);
    const refused = await call(dir, 'dispatch', { ticket: 'FIX-7', overrideLimits: true });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /run-1/);
  }
  assert.equal(seen.length, 0, 'a refused override queues nothing');
  assert.equal(refuseRunCaller(dispatch(`${worktree}-other`), [job('run-1', 'running', worktree)]), undefined, 'a sibling path is outside the worktree');
  assert.equal(refuseRunCaller(dispatch(root), [job('old', 'dismissed', root)]), undefined, 'finished runs do not hold their worktree');
});

test('agent writes fail without a running scheduler instead of running locally', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await call(dir, 'stop_run', { jobId: 'job-1' });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /not running/);
});
