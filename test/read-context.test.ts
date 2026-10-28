import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadContext, ManualDeadline, readPhase } from '../src/read-context.ts';
import { T3, Kanvil } from '../src/clients.ts';
import { callT3Rpc } from '../src/rpc.ts';
import { readAll, safeError } from '../src/scheduler.ts';
import { runManualRequest } from '../src/manual-request.ts';
import { readOperation } from '../src/operations.ts';
import { dispatchFixture } from './dispatch-fixture.ts';

const deferred = <T = void>() => Promise.withResolvers<T>();
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const heldRead = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
  signal?.throwIfAborted(); signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('a failed T3 body preserves its cause and phase after a parallel read drains into a saved manual outcome', async t => {
  const f = dispatchFixture(t), bodyEntered = deferred(), bodyFailed = deferred(), sibling = deferred();
  writeFileSync(f.c.t3.credentialFile, '{"token":"fixture"}');
  const transport = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET', headers: { authorization: 'private-header' }, socket: { remoteAddress: 'private-socket' } });
  const failure = new TypeError('terminated', { cause: transport });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => { bodyEntered.resolve(); await bodyFailed.promise; throw failure; } }));
  const id = '44444444-4444-4444-8444-444444444444', logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(line));
  const result = runManualRequest(f.c, f.store, { manual: true, requestId: id, ticket: 'FIX-1' },
    async (work, _foreground, { context }) => context.run(() => work(0)),
    async () => { await readAll([f.t3.request('/api/orchestration/shell'), readPhase('t3.rpc.provider', async () => { await sibling.promise; })]); return { reason: 'unused' }; });
  await bodyEntered.promise; bodyFailed.resolve(); await turn(); sibling.resolve();
  const outcome = await result, saved = readOperation(f.c.stateDir, id)!;
  assert.equal((outcome.data as any).stage, 't3.shell', 'the failed HTTP read must win over its later-draining provider sibling');
  assert.equal((outcome.data as any).notLaunched, true);
  assert.match((outcome.data as any).message, /t3\.shell.*\d+ms.*TypeError.*terminated.*UND_ERR_SOCKET.*other side closed/);
  assert.deepEqual(saved.result, outcome);
  const diagnosticLog = logs.find(line => line.includes('manual-request-failed'))!;
  assert.match(diagnosticLog, /UND_ERR_SOCKET/);
  assert.doesNotMatch(JSON.stringify(outcome) + diagnosticLog, /private-header|private-socket|authorization|remoteAddress/);
  assert.equal(f.store.jobs().length, 0);
});

test('safeError bounds nested causes and redacts credentials at every level', () => {
  const cause = Object.assign(new Error('socket https://user:password@fixture.invalid/path?wsTicket=private-ticket&api_key=private-key Bearer private-bearer sk-ant-private-anthropic'), { code: 'UND_ERR_SOCKET' });
  const error = new TypeError('terminated', { cause });
  const text = safeError(error);
  assert.match(text, /TypeError.*terminated.*UND_ERR_SOCKET/);
  assert.doesNotMatch(text, /password|private-ticket|private-key|private-bearer|private-anthropic/);
  assert.ok(text.length <= 800);
  const cyclic = Object.assign(new Error('cycle'), { cause: undefined as unknown }); cyclic.cause = cyclic;
  assert.ok(safeError(cyclic).length <= 800);
  let deep: Error = new Error('unbounded-leaf');
  for (let i = 0; i < 100; i++) deep = new Error('level', { cause: deep });
  assert.doesNotMatch(safeError(deep), /unbounded-leaf/);
  assert.ok(safeError(new Error('x'.repeat(100_000), { cause })).length <= 800);
  assert.match(safeError(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })), /UND_ERR_CONNECT_TIMEOUT/);
  assert.doesNotMatch(safeError(new Error('api_key="quoted-key" token=bare-token sk-proj-openai-key')), /quoted-key|bare-token|sk-proj-openai-key/);
  assert.equal(safeError({ _tag: 'RpcError', detail: 'fixture failure', body: 'private-body' }), 'RpcError: fixture failure');
});

test('an actual truncated HTTP body reports the transport code without a read context', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-truncated-body-'));
  const credentialFile = join(dir, 'credential'); writeFileSync(credentialFile, '{"token":"fixture"}');
  let response!: import('node:http').ServerResponse;
  const server = createServer((_req, res) => { response = res; res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' }); res.write('{"threads":['); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => { const headers = await fetch(...args); response.destroy(); return headers; });
  const t3 = new T3({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, credentialFile });
  const error = await t3.request('/api/orchestration/shell').catch(error => error);
  assert.match(safeError(error), /t3\.shell.*\d+ms.*TypeError.*terminated.*UND_ERR_SOCKET/);
});

test('read failure metadata never replaces manual cancellation identity', async () => {
  const context = new ReadContext(), deadline = new ManualDeadline('t3.shell');
  const outcome = await context.run(() => readPhase('t3.shell', async () => { throw deadline; })).catch(error => error);
  assert.equal(outcome, deadline);
});

test('T3 and Kanvil HTTP reads cancel together, and a failed phase drains its started siblings', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-read-context-'));
  const credentialFile = join(dir, 'credential'); writeFileSync(credentialFile, '{"token":"fixture"}');
  const t3 = new T3({ url: 'http://fixture.invalid', credentialFile });
  const kanvil = new Kanvil({ url: 'https://tracker.invalid', workspaceId: 'fixture' });
  const entered = deferred(), drain = deferred(); let settled = false, reads = 0;
  const oldKey = process.env.KANVIL_API_KEY; process.env.KANVIL_API_KEY = 'fixture';
  t.after(() => { if (oldKey === undefined) delete process.env.KANVIL_API_KEY; else process.env.KANVIL_API_KEY = oldKey; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => { if (++reads === 2) entered.resolve(); return heldRead(options.signal ?? undefined); });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const context = new ReadContext(Date.now() + 60_000); context.start(() => {});
  try {
    const outcome = context.run(() => readAll([
      t3.request('/api/orchestration/shell'), kanvil.task('fixture'),
      readPhase('fixture.drain', async signal => { try { await heldRead(signal); } finally { await drain.promise; } }),
    ])).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await entered.promise; assert.equal(reads, 2);
    assert.match(context.stage, /t3.shell/); assert.match(context.stage, /kanvil.read/);
    t.mock.timers.tick(60_001); await turn();
    assert.equal(settled, false, 'deadline cannot orphan an owned sibling continuation');
    drain.resolve(); assert.ok(await outcome instanceof ManualDeadline);
    let next = false;
    await new ReadContext(Date.now() + 1000).run(() => readPhase('next', async () => { next = true; }));
    assert.equal(next, true, 'the next accepted request has a fresh cancellation scope');
  } finally { drain.resolve(); context.finish(); rmSync(dir, { recursive: true, force: true }); }
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
