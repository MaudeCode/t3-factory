import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as launchd from '../scripts/launchd.ts';

const ioError = 'Bootstrap failed: 5: Input/output error\n';

// Replaces execFileSync for the scripts' named import, throwing the same shape of error launchctl does.
function stubLaunchctl(t: TestContext, respond: (args: string[]) => string | undefined) {
  const calls: string[][] = [];
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options?: { encoding?: string }) => {
    assert.equal(file, 'launchctl');
    calls.push(args);
    const stderr = respond(args);
    if (stderr === undefined) return '';
    throw Object.assign(new Error(`Command failed: launchctl ${args.join(' ')}\n${stderr}`), {
      status: 5,
      stderr: options?.encoding ? stderr : Buffer.from(stderr),
    });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); t.mock.timers.reset(); syncBuiltinESMExports(); });
  return calls;
}

// Runs the helper under mock timers, advancing the clock whenever it waits.
async function withClock<T>(t: TestContext, run: () => Promise<T>) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  syncBuiltinESMExports();
  let settled = false;
  const result = run().finally(() => { settled = true; });
  result.catch(() => {});
  while (!settled) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(100);
  }
  return { result, elapsed: Date.now() };
}

test('bootstrap retries past a transient Input/output error while launchd unloads the old service', async t => {
  let failures = 8;
  const calls = stubLaunchctl(t, () => (failures-- > 0 ? ioError : undefined));
  const { result } = await withClock(t, () => launchd.bootstrap('gui/501', '/tmp/x.plist'));
  await assert.doesNotReject(result);
  assert.equal(calls.length, 9);
  assert.deepEqual(calls.at(-1), ['bootstrap', 'gui/501', '/tmp/x.plist']);
});

test('bootstrap gives up after about 15 seconds and reports the launchctl message as text', async t => {
  stubLaunchctl(t, () => ioError);
  const { result, elapsed } = await withClock(t, () => launchd.bootstrap('gui/501', '/tmp/x.plist'));
  await assert.rejects(result, { message: 'launchctl bootstrap gui/501 /tmp/x.plist: Bootstrap failed: 5: Input/output error' });
  assert.ok(elapsed >= 14_000 && elapsed <= 17_000, `gave up after ${elapsed} ms`);
});

test('bootout waits until launchctl print no longer finds the service', async t => {
  let loaded = 3;
  const calls = stubLaunchctl(t, args => (args[0] === 'print' && loaded-- <= 0 ? 'Could not find service' : undefined));
  const { result } = await withClock(t, () => launchd.bootout('gui/501', 'local.t3-factory'));
  await result;
  assert.deepEqual(calls[0], ['bootout', 'gui/501/local.t3-factory']);
  assert.equal(calls.filter(args => args[0] === 'print').length, 4);
  assert.deepEqual(calls.at(-1), ['print', 'gui/501/local.t3-factory']);
});

test('bootout returns at once for a service that was never installed', async t => {
  const calls = stubLaunchctl(t, () => 'Could not find service');
  const { result, elapsed } = await withClock(t, () => launchd.bootout('gui/501', 'local.t3-factory'));
  await result;
  assert.equal(calls.length, 2);
  assert.ok(elapsed < 1_000);
});

test('bootout fails rather than returning while the old service is still loaded', async t => {
  stubLaunchctl(t, () => undefined);
  const { result, elapsed } = await withClock(t, () => launchd.bootout('gui/501', 'local.t3-factory'));
  await assert.rejects(result, { message: 'launchd did not unload gui/501/local.t3-factory within 15 seconds' });
  assert.ok(elapsed >= 15_000 && elapsed <= 16_000, `gave up after ${elapsed} ms`);
});
