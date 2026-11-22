import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig } from '../src/config.ts';
import { applySchedule, editConfig } from '../src/settings.ts';
import { weeklyResets } from '../src/scheduler.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

const NOW = Date.parse('2026-03-10T12:00:00Z'), PAST = '2026-03-10T11:00:00Z', EARLIER = '2026-03-10T10:00:00Z', FUTURE = '2026-03-12T12:00:00Z';
const none = { onAt: null, offAt: null, offAtReset: null };
type Schedule = { onAt: string | null; offAt: string | null; offAtReset: 'claude' | 'codex' | null };
// [name, schedule, each provider's weekly reset as last read, both switches and the schedule afterwards, the journal line]
const cases: [string, Partial<Schedule>, Record<string, string>, { on: boolean; schedule: Partial<Schedule> }, string?][] = [
  ['no timer leaves the switches alone', {}, {}, { on: true, schedule: {} }],
  ['a future timer waits', { onAt: FUTURE, offAt: FUTURE }, {}, { on: true, schedule: { onAt: FUTURE, offAt: FUTURE } }],
  ['a due off timer turns both off and keeps the later on timer', { onAt: FUTURE, offAt: PAST }, {}, { on: false, schedule: { onAt: FUTURE } }, 'Automation and queued runs turned off by the schedule'],
  ['timers missed while stopped apply in time order', { onAt: PAST, offAt: EARLIER }, {}, { on: true, schedule: {} }, 'Automation and queued runs turned on by the schedule'],
  ['off wins two timers at the same time', { onAt: PAST, offAt: PAST }, {}, { on: false, schedule: {} }, 'Automation and queued runs turned off by the schedule'],
  ['the reset time itself turns both off', { offAt: PAST, offAtReset: 'codex' }, { codex: PAST }, { on: false, schedule: {} }, 'Automation and queued runs turned off at the Codex weekly reset'],
  ['a reset that came early turns both off before its recorded time', { offAt: FUTURE, offAtReset: 'claude' }, { claude: '2026-03-19T12:00:00Z', codex: FUTURE }, { on: false, schedule: {} }, 'Automation and queued runs turned off at the Claude weekly reset'],
  ['a reset reading that drifts by seconds, or another provider resetting, changes nothing', { offAt: FUTURE, offAtReset: 'claude' }, { claude: '2026-03-12T12:00:05Z', codex: '2026-03-19T12:00:00Z' }, { on: true, schedule: { offAt: FUTURE, offAtReset: 'claude' } }],
];
for (const [name, schedule, resets, expected, line] of cases) test(`schedule: ${name}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-schedule-')), file = join(dir, 'config.jsonc');
  try {
    // A timer that fires starts from the opposite of what it sets, so the write is what the result shows.
    const start = line ? !expected.on : expected.on;
    // The example file has comments and neither section, like a file written before the schedule existed.
    copyFileSync(fileURLToPath(new URL('../config.example.jsonc', import.meta.url)), file);
    editConfig(file, [[['enabled'], start], [['schedule'], schedule], ...start ? [] : [[['queue', 'enabled'], false] as [string[], boolean]]]);
    const text = readFileSync(file, 'utf8'), before = loadConfig(file);
    assert.equal(applySchedule(file, before, () => resets, NOW)?.text, line);
    const after = loadConfig(file);
    assert.deepEqual({ enabled: after.enabled, queue: after.queue, schedule: after.schedule }, { enabled: expected.on, queue: { enabled: expected.on }, schedule: { ...none, ...expected.schedule } });
    assert.deepEqual({ ...after, enabled: start, queue: before.queue, schedule: before.schedule }, before, 'no other setting changes');
    assert.equal(readFileSync(file, 'utf8').includes('// Replace all placeholders'), true, 'the file keeps its comments');
    if (!line) assert.equal(readFileSync(file, 'utf8'), text, 'nothing due leaves the file untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a weekly reset schedule needs the reset time it was taken from', () => {
  const base = loadConfig(fileURLToPath(new URL('../config.example.jsonc', import.meta.url)));
  assert.throws(() => configSchema.parse({ ...base, schedule: { offAtReset: 'claude' } }), /A weekly reset needs its time/);
});

// Admission reads its quota from T3's current provider reading; the published streams follow only after the launches.
test('a reset is read from the provider reading admission uses, ahead of the published one', t => {
  const f = dispatchFixture(t), published = '2020-01-01T00:00:00.000Z';
  f.store.set('streams', JSON.stringify([{ driver: 'codex', quota: { windows: [{ name: 'weekly', resetsAt: published }] } }, { driver: 'claudeAgent', quota: { windows: [{ name: 'weekly', resetsAt: published }] } }]));
  assert.deepEqual(weeklyResets(f.c, f.store, f.t3), { codex: published, claude: published }, 'without a current reading the published ones stand');
  const provider = f.provider('codex');
  t.mock.method(f.t3, 'peekProvider', (id: string) => id === 'codex' ? provider : undefined);
  assert.deepEqual(weeklyResets(f.c, f.store, f.t3), { codex: provider.usageLimits.windows[0].resetsAt, claude: published });
  provider.usageLimits.checkedAt = '2020-01-01T00:00:00.000Z';
  assert.equal(weeklyResets(f.c, f.store, f.t3).codex, published, 'a reading too old for admission leaves the published one');
});
