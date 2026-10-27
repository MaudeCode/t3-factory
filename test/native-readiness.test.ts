import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFixture } from './dispatch-fixture.ts';
import { configSchema } from '../src/config.ts';
import { inventory } from '../src/scheduler.ts';

test('automatic inventory accepts native-ready tickets without sf', async t => {
  const f = dispatchFixture(t);
  f.tasks[0].labels = [{ name: 'med' }];
  const queue = await inventory(f.c, f.kanvil, [], [], f.store);
  assert.deepEqual(queue.ready.map(t => t.key), ['FIX-1']);
});

test('manual dispatch accepts native-ready tickets without sf or confirmation', async t => {
  const f = dispatchFixture(t);
  f.tasks[0].labels = [{ name: 'med' }];
  const result = await f.run();
  assert.equal(result.reason, 'dispatched');
  assert.equal(f.launches.length, 1);
});

test('removing sf during final validation does not revoke native readiness', async t => {
  const f = dispatchFixture(t);
  f.hooks.shell = async final => { if (final) f.tasks[0].labels = [{ name: 'med' }]; };
  assert.equal((await f.run()).reason, 'dispatched');
  assert.equal(f.launches.length, 1);
});

for (const fields of [{ automationReady: false }, { holdReason: 'Decision pending' }, { archived: true }]) {
  test(`sf cannot bypass native readiness: ${JSON.stringify(fields)}`, async t => {
    const f = dispatchFixture(t);
    Object.assign(f.tasks[0], fields);
    const queue = await inventory(f.c, f.kanvil, [], [], f.store, 'FIX-1');
    assert.equal(queue.ready.length, 0);
    assert.equal(queue.skipped.length, 1);
    assert.equal(f.launches.length, 0);
  });
}

for (const readyLabel of [undefined, 'sf', 'another-label']) {
  test(`readiness-label configuration is optional and ignored: ${readyLabel}`, async t => {
    const f = dispatchFixture(t);
    const parsed = configSchema.parse({ ...f.c, kanvil: { ...f.c.kanvil, ...(readyLabel === undefined ? {} : { readyLabel }) } });
    assert.deepEqual(parsed.kanvil, f.c.kanvil);
    assert.equal('readyLabel' in parsed.kanvil, false);
    assert.throws(() => configSchema.parse({ ...f.c, kanvil: { ...f.c.kanvil, unknownSetting: true } }), 'unknown config still fails closed');
  });
}

test('automatic dispatch launches native-ready tickets without sf', async t => {
  const f = dispatchFixture(t);
  f.tasks[0].labels = [{ name: 'med' }];
  assert.equal((await f.run('auto', false)).reason, 'dispatched');
  assert.deepEqual(f.store.jobs().map(job => [job.kind, job.ticketKey]), [['ticket', 'FIX-1']]);
  assert.equal(f.launches.length, 1);
});
