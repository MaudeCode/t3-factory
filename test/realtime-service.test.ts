import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { T3 } from '../src/clients.ts';
import { FactoryService } from '../src/service.ts';

test('idle scheduler does not schedule tracker inventory polling', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-event-regression-'));
  const config = loadConfig(new URL('../config.example.jsonc', import.meta.url).pathname);
  config.stateDir = join(dir, 'state');
  const path = join(dir, 'config.jsonc'); writeFileSync(path, JSON.stringify(config));
  const intervals: number[] = [], interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', ((callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    intervals.push(ms); return interval(callback, ms, ...args);
  }) as typeof setInterval);
  t.mock.method(T3.prototype, 'subscribe', async (_onItem: unknown, signal: AbortSignal) => {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const service = new FactoryService(path), internal = service as any;
  // Keep the real service lifecycle and scheduling; isolate unrelated T3/ticket dispatch work.
  t.mock.method(internal, 'pass', async () => ({ reason: 'disabled' }));
  const runLane = internal.runLane.bind(internal);
  t.mock.method(internal, 'runLane', (name: string, work: () => Promise<void>) => { if (name === 'tickets:codex') runLane(name, work); });
  try {
    await service.start(); await internal.idle;
    assert.deepEqual(intervals, [], 'ticket changes must use the event feed instead of a periodic inventory poll');
  } finally { await service.stop(); rmSync(dir, { recursive: true, force: true }); }
});


test('duplicate config notifications do not enqueue unchanged scheduler work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-config-notification-'));
  const config = loadConfig(new URL('../config.example.jsonc', import.meta.url).pathname);
  config.stateDir = join(dir, 'state');
  const path = join(dir, 'config.jsonc'); writeFileSync(path, JSON.stringify(config));
  let notify!: (event: string, name: string) => void;
  const original = fs.watch;
  t.mock.method(fs, 'watch', ((_directory: unknown, listener: typeof notify) => {
    notify = listener; return { close() {} };
  }) as unknown as typeof fs.watch);
  syncBuiltinESMExports();
  t.after(() => { fs.watch = original; syncBuiltinESMExports(); });
  t.mock.method(T3.prototype, 'subscribe', async (_onItem: unknown, signal: AbortSignal) => {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const service = new FactoryService(path), internal = service as any, passes: string[] = [];
  const wake = internal.wake.bind(internal);
  t.mock.method(internal, 'wake', (reason: string) => { passes.push(reason); wake(reason); });
  t.mock.method(internal, 'pass', async () => ({ reason: 'disabled' }));
  const runLane = internal.runLane.bind(internal);
  t.mock.method(internal, 'runLane', (name: string, work: () => Promise<void>) => { if (name === 'tickets:codex') runLane(name, work); });
  try {
    await service.start(); await internal.idle;
    notify('change', 'config.jsonc'); await internal.idle;
    assert.deepEqual(passes, ['start'], 'an unchanged filesystem notification must not become another scheduler pass');
    writeFileSync(path, JSON.stringify({ ...config, enabled: !config.enabled }));
    notify('change', 'config.jsonc'); notify('change', 'config.jsonc'); await internal.idle;
    assert.deepEqual(passes, ['start', 'config'], 'a real configuration edit still wakes exactly one pass');
    writeFileSync(path, '{'); notify('change', 'config.jsonc'); await internal.idle;
    assert.deepEqual(passes, ['start', 'config', 'config'], 'invalid configuration must still reach the diagnostic pass');
    writeFileSync(path, JSON.stringify({ ...config, enabled: !config.enabled }));
    notify('change', 'config.jsonc'); await internal.idle;
    assert.deepEqual(passes, ['start', 'config', 'config', 'config'], 'restoring the previous valid configuration must wake again after an error');
  } finally { await service.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a T3 thread event wakes every lane but inbox triage; tracker, timer, config and triage commands still start it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-wake-routing-'));
  const config = loadConfig(new URL('../config.example.jsonc', import.meta.url).pathname);
  config.stateDir = join(dir, 'state');
  const path = join(dir, 'config.jsonc'); writeFileSync(path, JSON.stringify(config));
  let emit!: (item: unknown) => void;
  t.mock.method(T3.prototype, 'subscribe', async (onItem: typeof emit, signal: AbortSignal) => {
    emit = onItem;
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const service = new FactoryService(path), internal = service as any, lanes: string[] = [];
  t.mock.method(internal, 'pass', async () => ({ reason: 'disabled' }));
  t.mock.method(internal, 'ensureKanvil', async () => ({}));
  t.mock.method(internal, 'runLane', (name: string) => { lanes.push(name); });
  const wake = internal.wake.bind(internal);
  let woke: (reason: string) => void = () => {};
  t.mock.method(internal, 'wake', (reason: string) => { wake(reason); woke(reason); });
  const started = async (act: () => unknown) => { lanes.length = 0; await act(); return [...lanes]; };
  try {
    await service.start(); await internal.idle;
    const threadWake = new Promise<string>(resolve => { woke = resolve; });
    const t3 = await started(async () => { emit({ kind: 'thread.updated', thread: { id: 'thread-1', title: 'Work' } }); assert.equal(await threadWake, 't3'); });
    assert.ok(t3.includes('reconcile') && t3.includes('tickets:codex'), 'a thread event still reconciles and admits');
    assert.ok(!t3.includes('inbox-triage'), 'a thread event changes nothing the triage lane reads');
    assert.ok((await started(() => internal.handle({ type: 'triage-run' }))).includes('inbox-triage'), 'Triage now runs a pass right after a thread wake');
    assert.ok((await started(() => internal.handle({ type: 'triage-report', ticketId: 'report-1', action: 'retry' }))).includes('inbox-triage'), 'a report decision runs a pass right after a thread wake');
    for (const reason of ['kanvil', 'timer', 'config']) assert.ok((await started(() => internal.wake(reason))).includes('inbox-triage'), `a ${reason} wake starts the triage lane`);
  } finally { await service.stop(); rmSync(dir, { recursive: true, force: true }); }
});
