import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveControl, type ControlCommand } from '../src/control.ts';
import { handleMcp } from '../src/mcp.ts';

const call = (stateDir: string, name: string, args: unknown) => handleMcp(stateDir, { id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{ result: { isError?: true; content: { text: string }[] } }>;

test('agent dispatch reaches the scheduler as a manual request and cannot override limits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-')), seen: ControlCommand[] = [];
  const server = serveControl(dir, async command => { seen.push(command); return { code: 0, data: { reason: 'dispatched' } }; });
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.once('listening', resolve));

  const ok = await call(dir, 'dispatch', { ticket: 'fix-7', chain: 'all' });
  assert.equal(ok.result.isError, undefined);
  assert.deepEqual(seen, [{ type: 'dispatch', options: { manual: true, ticket: 'FIX-7', chain: 'all' } }]);

  const refused = await call(dir, 'dispatch', { ticket: 'FIX-7', overrideLimits: true });
  assert.equal(refused.result.isError, true);
  assert.equal(seen.length, 1);
});

test('agent writes fail without a running scheduler instead of running locally', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await call(dir, 'stop_run', { jobId: 'job-1' });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /not running/);
});
