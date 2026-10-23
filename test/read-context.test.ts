import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadContext, ManualDeadline, readPhase } from '../src/read-context.ts';
import { T3, Kaneo } from '../src/clients.ts';
import { callT3Rpc } from '../src/rpc.ts';
import { readAll } from '../src/scheduler.ts';

const deferred = <T = void>() => Promise.withResolvers<T>();
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const heldRead = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
  signal?.throwIfAborted(); signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('HTTP and MCP reads cancel together, and a failed phase drains its started siblings', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-read-context-'));
  const credentialFile = join(dir, 'credential'); writeFileSync(credentialFile, '{"token":"fixture"}');
  const t3 = new T3({ url: 'http://fixture.invalid', credentialFile });
  const kaneo = new Kaneo({ url: 'https://tracker.invalid', workspaceId: 'fixture', readyLabel: 'sf' });
  const entered = deferred(), drain = deferred(); let settled = false, reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => { reads++; return heldRead(options.signal ?? undefined); });
  t.mock.method(kaneo.client, 'callTool', async (_input: unknown, _schema: unknown, options: { signal?: AbortSignal }) => { reads++; entered.resolve(); return heldRead(options.signal); });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const context = new ReadContext(Date.now() + 60_000); context.start(() => {});
  try {
    const outcome = context.run(() => readAll([
      t3.request('/api/orchestration/shell'), kaneo.call('get_task', { taskId: 'fixture' }),
      readPhase('fixture.drain', async signal => { try { await heldRead(signal); } finally { await drain.promise; } }),
    ])).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await entered.promise; assert.equal(reads, 2);
    assert.match(context.stage, /t3.shell/); assert.match(context.stage, /kaneo.get_task/);
    t.mock.timers.tick(60_001); await turn();
    assert.equal(settled, false, 'deadline cannot orphan an owned sibling continuation');
    drain.resolve(); assert.ok(await outcome instanceof ManualDeadline);
    let next = false;
    await new ReadContext(Date.now() + 1000).run(() => readPhase('next', async () => { next = true; }));
    assert.equal(next, true, 'the next accepted request has a fresh cancellation scope');
  } finally { drain.resolve(); context.finish(); rmSync(dir, { recursive: true, force: true }); }
});

test('Kaneo connection cancellation drains close before releasing request ownership', async t => {
  const kaneo = new Kaneo({ url: 'https://tracker.invalid', workspaceId: 'fixture', readyLabel: 'sf' });
  const entered = deferred(), closing = deferred(), drain = deferred(); let settled = false, closes = 0;
  (kaneo.client as any)._transport = { close: async () => { closes++; closing.resolve(); await drain.promise; } };
  t.mock.method(kaneo.client, 'connect', async (_transport: unknown, options: { signal?: AbortSignal }) => {
    entered.resolve();
    try { await heldRead(options.signal); }
    catch (error) { void kaneo.client.close(); throw error; } // The SDK's actual handshake failure behavior.
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const context = new ReadContext(Date.now() + 60_000); context.start(() => {});
  try {
    const outcome = context.run(() => kaneo.connect()).then(() => undefined, error => error).finally(() => { settled = true; });
    await entered.promise; assert.equal(context.stage, 'kaneo.connect');
    t.mock.timers.tick(60_001); await closing.promise; await turn();
    assert.match(context.stage, /kaneo.close/); assert.equal(settled, false);
    drain.resolve(); assert.ok(await outcome instanceof ManualDeadline); assert.equal(closes, 1, 'both close callers join the same owned teardown');
  } finally { drain.resolve(); context.finish(); }
});

test('a held T3 socket open is cancelled and its transport closes before returning', { timeout: 10000 }, async t => {
  const entered = deferred(), closed = deferred();
  const server = createServer(); const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('end', () => socket.end()); socket.on('close', () => { sockets.delete(socket); if (!sockets.size) closed.resolve(); }); });
  server.on('upgrade', () => { entered.resolve(); }); // Deliberately never complete the read-only handshake.
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const context = new ReadContext(Date.now() + 60_000); context.start(() => {});
  try {
    const outcome = context.run(() => callT3Rpc(`ws://127.0.0.1:${address.port}`, { type: 'provider' })).then(() => undefined, error => error);
    await entered.promise; assert.equal(context.stage, 't3.rpc.provider');
    t.mock.timers.tick(60_001);
    assert.ok(await outcome, 'socket cancellation must reject');
    await closed.promise; assert.equal(sockets.size, 0);
  } finally { context.finish(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
