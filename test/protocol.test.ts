import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadContext } from '../src/read-context.ts';
import { T3, Kanvil } from '../src/clients.ts';
import { executing, providerExecuting } from '../src/policy.ts';
import { publicStopCommand, v2Shell, v2Thread } from './v2-fixture.ts';

function fixtureT3(t: test.TestContext, routes: Record<string, (init?: RequestInit) => Response>) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-protocol-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const credentialFile = join(dir, 'credential.json');
  writeFileSync(credentialFile, JSON.stringify({ token: 'fixture-token' }));
  const requests: { path: string; headers: Headers }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push({ path: url.pathname, headers: new Headers(init?.headers) });
    const route = routes[url.pathname];
    return route ? route(init) : new Response('not found', { status: 404 });
  });
  return { t3: new T3({ url: 'http://t3.invalid', credentialFile }), requests };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('desktop thread links resolve the configured environment and preserve opaque thread IDs', async t => {
  const f = fixtureT3(t, { '/.well-known/t3/environment': () => json({ environmentId: 'environment-1', orchestrationProtocolVersion: 2 }) });
  assert.equal(await f.t3.threadLink('mcp:thread/with %'), 't3code://threads/environment-1/mcp%3Athread%2Fwith%20%25');
  assert.equal(f.requests[0].headers.has('authorization'), false, 'the public descriptor needs no scheduler credential');
});

test('desktop thread links fail explicitly when environment resolution is unavailable', async t => {
  for (const [name, response] of [['missing ID', json({})], ['empty ID', json({ environmentId: '' })], ['unavailable', json({}, 503)]] as const) await t.test(name, async t => {
    const f = fixtureT3(t, { '/.well-known/t3/environment': () => response });
    await assert.rejects(f.t3.threadLink('thread'), /environment|Too small/);
  });
});

test('every T3 request negotiates orchestration protocol v2 and reads the v2 shell', async t => {
  const { t3, requests } = fixtureT3(t, {
    '/api/orchestration/shell': init => new Headers(init?.headers).get('x-t3-orchestration-protocol') === '2' ? json(v2Shell()) : json({ _tag: 'HttpApiSchemaError' }, 400),
    '/api/auth/websocket-ticket': () => json({ ticket: 'fixture-ticket' }),
  });
  const shell = await t3.shell();
  assert.equal(shell.threads[0].status, 'completed');
  assert.equal(shell.projects[0].workspaceRoot, '/tmp/fixture-repo');
  const socket = new URL(await t3.socketUrl());
  assert.equal(socket.searchParams.get('orchestrationProtocol'), '2');
  assert.equal(socket.protocol, 'ws:');
  assert.ok(requests.length >= 2 && requests.every(r => r.headers.get('x-t3-orchestration-protocol') === '2'));
});

test('a rejected protocol header reports the mismatch instead of a bare HTTP 400', async t => {
  for (const [descriptor, required] of [[{ serverVersion: '0.0.1' }, 'v1'], [{ serverVersion: '9.0.0', orchestrationProtocolVersion: 3 }, 'v3']] as const) {
    const { t3 } = fixtureT3(t, {
      '/api/orchestration/shell': () => json({ _tag: 'HttpApiSchemaError' }, 400),
      '/.well-known/t3/environment': () => json({ environmentId: 'env', label: 'Fixture', ...descriptor }),
    });
    await assert.rejects(t3.shell(), new RegExp(`T3 orchestration protocol mismatch \\(scheduler speaks v2, server requires ${required}\\)`));
  }
  for (const descriptor of [() => json({ environmentId: 'env', label: 'Fixture', orchestrationProtocolVersion: 2 }), () => json({ error: 'unavailable' }, 503)]) {
    const { t3 } = fixtureT3(t, { '/api/orchestration/shell': () => json({ _tag: 'HttpApiSchemaError' }, 400), '/.well-known/t3/environment': descriptor });
    await assert.rejects(t3.shell(), /^Error: T3 \/api\/orchestration\/shell returned HTTP 400$/, 'a matching or unknown protocol keeps the plain status');
  }
});

test('thread detail reads user messages and answered runtime requests from the bounded v2 projection', async t => {
  const { t3, requests } = fixtureT3(t, {
    '/api/orchestration/threads/thread-1/bounded': () => json({ snapshotSequence: 1, historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: 1, projection: {
      thread: v2Thread(), updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [{ id: 'm1', threadId: 'thread-1', runId: null, nodeId: null, role: 'user', text: 'hi', attachments: [], streaming: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      runtimeRequests: [
        { id: 'r1', kind: 'user_input', status: 'resolved', createdAt: '2026-01-01T00:01:00.000Z', resolvedAt: '2026-01-01T00:02:00.000Z' },
        { id: 'r2', kind: 'permission', status: 'resolved', createdAt: '2026-01-01T00:03:00.000Z', resolvedAt: '2026-01-01T00:04:00.000Z' },
        { id: 'r3', kind: 'dynamic_tool_call', status: 'resolved', createdAt: '2026-01-01T00:05:00.000Z', resolvedAt: '2026-01-01T00:06:00.000Z' },
        { id: 'r4', kind: 'command', status: 'pending', createdAt: '2026-01-01T00:07:00.000Z', resolvedAt: null },
      ],
    } }),
  });
  const detail = await t3.detail('thread-1');
  assert.equal(requests[0].path, '/api/orchestration/threads/thread-1/bounded');
  assert.deepEqual(detail.messages.map(m => m.id), ['m1']);
  assert.deepEqual(detail.responses.map(r => r.createdAt), ['2026-01-01T00:02:00.000Z', '2026-01-01T00:04:00.000Z'], 'only human answers count, not tool calls or pending requests');
});

test('the shell marks a run orphaned once every provider session stopped, and fails closed', async t => {
  const old = new Date(Date.now() - 3_600_000).toISOString(), fresh = new Date().toISOString();
  const active = (id: string, updatedAt = old) => v2Thread({ id, status: 'queued', activeRunId: 'run-1', updatedAt });
  const projection = (sessions: string[], runs = [{ id: 'run-1', status: 'running' }, { id: 'run-2', status: 'queued' }]) =>
    () => json({ projection: { runs: runs.map(r => ({ ...r, completedAt: null })), providerSessions: sessions.map(status => ({ status, updatedAt: old })) } });
  const { t3, requests } = fixtureT3(t, {
    '/api/orchestration/shell': () => json(v2Shell([
      active('stopped'), active('error'), active('mixed'), active('none'), active('missing-run'), active('failure'), active('invalid'), active('fresh', fresh),
      v2Thread({ id: 'waiting', status: 'waiting', activeRunId: 'run-1', updatedAt: old, pendingRuntimeRequest: { kind: 'user_input', createdAt: old } }),
      v2Thread({ id: 'requested', status: 'running', activeRunId: 'run-1', updatedAt: old, pendingRuntimeRequest: { kind: 'user_input', createdAt: old } }),
    ])),
    '/api/orchestration/threads/stopped/bounded': projection(['stopped']),
    '/api/orchestration/threads/error/bounded': projection(['error', 'stopped']),
    '/api/orchestration/threads/mixed/bounded': projection(['stopped', 'ready']),
    '/api/orchestration/threads/none/bounded': projection([]),
    '/api/orchestration/threads/missing-run/bounded': projection(['stopped'], [{ id: 'run-0', status: 'running' }]),
    '/api/orchestration/threads/failure/bounded': () => json({ error: 'unavailable' }, 500),
    '/api/orchestration/threads/invalid/bounded': () => new Response('not json', { status: 200 }),
  });
  const orphaned = (shell: Awaited<ReturnType<T3['shell']>>) => shell.threads.filter(x => x.orphanedRun).map(x => x.id);
  assert.deepEqual(orphaned(await t3.shell()), ['stopped', 'error']);
  const bounded = () => requests.filter(r => r.path.endsWith('/bounded')).map(r => r.path.split('/')[4]);
  assert.deepEqual(bounded(), ['stopped', 'error', 'mixed', 'none', 'missing-run', 'failure', 'invalid'], 'fresh, waiting and requested threads make no bounded request');
  assert.deepEqual(orphaned(await t3.shell()), ['stopped', 'error']);
  assert.deepEqual(bounded().slice(7), ['failure', 'invalid'], 'verdicts are cached per thread update; failed reads retry');
});

test('old internal requests undergo orphan probing without exposing human requests or releasing live work', async t => {
  const old = new Date(Date.now() - 3_600_000).toISOString(), fresh = new Date().toISOString();
  for (const kind of ['dynamic_tool_call', 'auth_refresh']) {
    const thread = (id: string, status = 'running', updatedAt = old, requestKind = kind) => v2Thread({ id, status, activeRunId: 'run-1', updatedAt, pendingRuntimeRequest: { kind: requestKind, createdAt: updatedAt } });
    const projection = (status: string, sessions: string[]) => () => json({ projection: { runs: [{ id: 'run-1', status }], providerSessions: sessions.map(status => ({ status })) } });
    const { t3, requests } = fixtureT3(t, {
      '/api/orchestration/shell': () => json(v2Shell([thread('stopped'), thread('waiting', 'waiting'), { ...thread('handoff', 'waiting'), pendingRuntimeRequest: null }, thread('live'), thread('failed-read'), thread('fresh', 'running', fresh), thread('human', 'waiting', old, 'user_input'), thread('unknown', 'running', old, 'future_request')])),
      '/api/orchestration/threads/stopped/bounded': projection('running', ['stopped', 'error']),
      '/api/orchestration/threads/waiting/bounded': projection('waiting', ['stopped']),
      '/api/orchestration/threads/handoff/bounded': projection('waiting', ['stopped']),
      '/api/orchestration/threads/live/bounded': projection('running', ['stopped', 'ready']),
      '/api/orchestration/threads/failed-read/bounded': () => json({ error: 'unavailable' }, 500),
    });
    const shell = await t3.shell();
    assert.deepEqual(shell.threads.filter(t => t.orphanedRun).map(t => t.id), ['stopped', 'waiting', 'handoff'], kind);
    for (const id of ['stopped', 'waiting', 'handoff']) {
      const orphan = shell.threads.find(t => t.id === id)!;
      assert.equal(executing(orphan), false, 'a stopped internal handoff releases execution');
      assert.equal(providerExecuting(orphan, new Map()), false);
    }
    for (const id of ['live', 'failed-read', 'fresh']) assert.equal(executing(shell.threads.find(t => t.id === id)!), true, id);
    assert.deepEqual(requests.filter(r => r.path.endsWith('/bounded')).map(r => r.path.split('/')[4]), ['stopped', 'waiting', 'handoff', 'live', 'failed-read'], 'human and fresh requests are not probed');
  }
});

function fixtureRpc(t: test.TestContext, reply: (request: { id: string; tag: string; payload: unknown }) => unknown[], persistent = false) {
  const requests: { tag: string; payload: unknown }[] = [];
  const sockets: FixtureSocket[] = [];
  let connections = 0;
  class FixtureSocket extends EventTarget {
    readyState = 1;
    constructor() { super(); connections++; sockets.push(this); }
    send(data: string) {
      const message = JSON.parse(data);
      if (message._tag !== 'Request') return;
      requests.push(message);
      queueMicrotask(() => { for (const response of reply(message)) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(response) })); });
    }
    close() { this.readyState = 3; }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const t3 = new (T3 as any)({ url: 'http://localhost', credentialFile: '/unused' }, { persistent }) as T3;
  t.after(async () => { await (t3 as any).close?.(); });
  t.mock.method(t3, 'socketUrl', async () => 'ws://fixture');
  return { t3, connections: () => connections, requests: () => requests.map(r => ({ tag: r.tag, payload: r.payload })), respond: (requestId: string, value: unknown) => {
    for (const socket of sockets) if (socket.readyState === 1) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ _tag: 'Exit', requestId, exit: { _tag: 'Success', value } }) }));
  } };
}
const success = (request: { id: string }) => ({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: null } });

test('persistent RPC multiplexes independent calls over one connection', async t => {
  const f = fixtureRpc(t, request => [success(request)], true);
  await Promise.all([1, 2, 3].map(id => f.t3.dispatch({ id })));
  assert.equal(f.connections(), 1, 'a connected client must reuse its transport across concurrent RPCs');
});

test('cancelling one persistent RPC leaves sibling calls and the connection usable', async t => {
  const entered = Promise.withResolvers<void>();
  const f = fixtureRpc(t, request => { if ((request.payload as any)?.itemId === 'held') { entered.resolve(); return []; } return [{ ...success(request), exit: { _tag: 'Success', value: { item: null } } }]; }, true);
  const context = new ReadContext();
  const held = context.run(() => f.t3.turnItem('thread', 'held')).catch(error => error);
  await entered.promise;
  await f.t3.turnItem('thread', 'sibling');
  context.controller.abort(new Error('Fixture request cancelled'));
  assert.ok(await held);
  await f.t3.turnItem('thread', 'later');
  assert.equal(f.connections(), 1, 'caller cancellation must not close or recreate the shared socket');
});

test('an accepted RPC mutation drains after caller cancellation without replay', async t => {
  const entered = Promise.withResolvers<void>(); let requestId = '', settled = false;
  const f = fixtureRpc(t, request => { if ((request.payload as any)?.held) { requestId = request.id; entered.resolve(); return []; } return [success(request)]; }, true);
  const context = new ReadContext();
  const held = context.run(() => f.t3.dispatch({ held: true })).then(value => { settled = true; return value; });
  await entered.promise;
  context.controller.abort(new Error('Fixture caller cancelled'));
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'an accepted writer must settle before its client can close'); }
  finally { f.respond(requestId, null); await held; }
  assert.equal(f.requests().filter(request => request.tag === 'orchestration.dispatchCommand').length, 1);
});

test('workspace removal uses the native T3 RPC without force', async t => {
  const { t3, requests } = fixtureRpc(t, request => [success(request)]);
  await t3.removeWorktree('/repo', '/worktree');
  assert.deepEqual(requests(), [{ tag: 'vcs.removeWorktree', payload: { cwd: '/repo', path: '/worktree', force: false } }]);
});

test('explicit operator force removal uses the native T3 force contract', async t => {
  const { t3, requests } = fixtureRpc(t, request => [success(request)]);
  await t3.removeWorktree('/repo', '/worktree', true);
  assert.deepEqual(requests(), [{ tag: 'vcs.removeWorktree', payload: { cwd: '/repo', path: '/worktree', force: true } }]);
});

const summary = { threadId: 'thread-1', terminalId: 'setup-install-dependencies', cwd: '/worktree', worktreePath: '/worktree', status: 'running', pid: 42, exitCode: null, exitSignal: null, hasRunningSubprocess: false, label: 'fish', updatedAt: '2026-01-01T00:00:00.000Z' };
const snapshot = (terminals: unknown[]) => (request: { id: string }) => [{ _tag: 'Chunk', requestId: request.id, values: [{ type: 'snapshot', terminals }] }];

test('terminal cleanup reads the metadata snapshot and closes one terminal without deleting history', async t => {
  const { t3, requests } = fixtureRpc(t, request => request.tag === 'terminal.close' ? [success(request)] : snapshot([summary])(request));
  assert.deepEqual(await t3.terminals(), [summary]);
  await t3.closeTerminal('thread-1', 'setup-install-dependencies');
  assert.deepEqual(requests(), [
    { tag: 'subscribeTerminalMetadata', payload: {} },
    { tag: 'terminal.close', payload: { threadId: 'thread-1', terminalId: 'setup-install-dependencies', deleteHistory: false } },
  ]);
});

test('a malformed terminal snapshot is rejected', async t => {
  for (const reply of [snapshot([{ ...summary, hasRunningSubprocess: undefined }]), snapshot([{ ...summary, status: 'busy' }]), (request: { id: string }) => [{ _tag: 'Chunk', requestId: request.id, values: [{ type: 'upsert', terminal: summary }] }], (request: { id: string }) => [{ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: null } }]]) {
    const { t3 } = fixtureRpc(t, reply);
    await assert.rejects(t3.terminals(), { name: 'ZodError' });
  }
});

// Model the public RPC server: internal thread.stop and malformed public commands are rejected.
function stopRpc(t: test.TestContext, projection: unknown, reject = false) {
  const { t3, requests } = fixtureRpc(t, request => {
    const parsed = publicStopCommand.safeParse(request.payload);
    if (request.tag !== 'orchestration.dispatchCommand' || !parsed.success || reject) return [{
      _tag: 'Exit', requestId: request.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'StopRejected', message: 'Public stop rejected' } }] },
    }];
    return [success(request)];
  });
  const paths: string[] = [];
  t.mock.method(t3, 'request', async (path: string) => { paths.push(path); return { projection }; });
  return { t3, requests, paths };
}
const stopProjection = (runs: { id: string; status: string }[] = [], extra: Record<string, unknown> = {}) => ({
  thread: { id: 'thread-1', activeProviderThreadId: null, pullRequests: [] }, runs, providerThreads: [], turnItems: [], ...extra,
});
const watchedLink = { host: 'github.com', repository: 'fixture/repo', number: 1, source: 'explicit', watch: {} };

test('Stop resolves fresh work and emits only schema-valid public interruption commands', async t => {
  for (const status of ['preparing', 'starting', 'running', 'waiting']) {
    const { t3, requests, paths } = stopRpc(t, stopProjection([{ id: 'old-run', status: 'completed' }, { id: 'fresh-run', status }, { id: 'queued-run', status: 'queued' }]));
    await t3.stop('thread-1');
    assert.deepEqual(paths, ['/api/orchestration/threads/thread-1/bounded']);
    assert.equal(requests().length, 1);
    assert.deepEqual(publicStopCommand.parse(requests()[0].payload), { type: 'run.interrupt', commandId: (requests()[0].payload as any).commandId, threadId: 'thread-1', runId: 'fresh-run', holdQueue: true });
  }
});

test('Stop interrupts settled runs with pending provider work or active background items', async t => {
  for (const extra of [
    { providerThreads: [{ id: 'provider-1', pendingBackgroundTasks: [{ taskId: 'worker', kind: 'background_task' }] }] },
    ...['command_execution', 'dynamic_tool', 'subagent'].map(type => ({ turnItems: [{ id: 'item', type, status: 'running', runId: 'run-1' }] })),
    { turnItems: [{ id: 'item', type: 'command_execution', status: 'pending', runId: null }] },
    { turnItems: [{ id: 'item', type: 'subagent', status: 'waiting', runId: 'run-1' }] },
  ]) {
    const { t3, requests } = stopRpc(t, stopProjection([{ id: 'run-1', status: 'completed' }], extra));
    await t3.stop('thread-1');
    assert.equal((requests()[0].payload as any).runId, 'run-1');
    assert.equal(requests().length, 1);
  }
});

test('Stop treats queued-only, finished and excluded background work as no-ops without inventing runs', async t => {
  for (const projection of [
    stopProjection(), stopProjection([{ id: 'run-1', status: 'queued' }]), stopProjection([{ id: 'run-1', status: 'completed' }]),
    stopProjection([{ id: 'run-1', status: 'rolled_back' }], { providerThreads: [{ id: 'p', pendingBackgroundTasks: [{ taskId: 'abandoned' }] }] }),
    stopProjection([{ id: 'run-1', status: 'completed' }], { turnItems: [{ id: 'item', type: 'dynamic_tool', status: 'running', input: { persistent: true } }] }),
    stopProjection([{ id: 'old', status: 'rolled_back' }, { id: 'new', status: 'completed' }], { turnItems: [{ id: 'item', type: 'command_execution', status: 'running', runId: 'old' }] }),
    stopProjection([{ id: 'run-1', status: 'completed' }], { thread: { id: 'thread-1', activeProviderThreadId: 'current', pullRequests: [] }, providerThreads: [{ id: 'old', pendingBackgroundTasks: [{ taskId: 'stale' }] }] }),
    stopProjection([{ id: 'run-1', status: 'completed' }], { turnItems: [{ id: 'item', type: 'command_execution', status: 'completed' }] }),
  ]) {
    const { t3, requests } = stopRpc(t, projection);
    await t3.stop('thread-1');
    assert.deepEqual(requests(), []);
  }
});

test('Stop ends visible linked PR watches when no interruptible run owns background work', async t => {
  for (const runs of [[], [{ id: 'run-1', status: 'completed' }], [{ id: 'run-1', status: 'queued' }]]) {
    const { t3, requests } = stopRpc(t, stopProjection(runs, { thread: { id: 'thread-1', activeProviderThreadId: null, pullRequests: [watchedLink, { ...watchedLink, number: 2 }, { ...watchedLink, number: 3, watch: undefined }, { ...watchedLink, number: 4, source: 'stack-dismissed' }] } }));
    await t3.stop('thread-1');
    assert.deepEqual(requests().map(r => { const command = publicStopCommand.parse(r.payload); return [command.type, 'number' in command && command.number, 'watching' in command && command.watching]; }), [['thread.pull-request.watch', 1, false], ['thread.pull-request.watch', 2, false]]);
    assert.notEqual((requests()[0].payload as any).commandId, (requests()[1].payload as any).commandId);
  }
});

test('Stop propagates missing or incompatible projections and rejected or uncertain mutations without retry', async t => {
  for (const projection of [null, stopProjection([], { thread: { id: 'another-thread', activeProviderThreadId: null, pullRequests: [] } }), stopProjection([], { runs: undefined })]) {
    const { t3, requests } = stopRpc(t, projection);
    await assert.rejects(t3.stop('thread-1'));
    assert.deepEqual(requests(), []);
  }
  const publicServer = stopRpc(t, stopProjection());
  await assert.rejects(publicServer.t3.dispatch({ type: 'thread.stop', commandId: 'invalid-internal-command', threadId: 'thread-1' }));
  assert.equal(publicServer.requests().length, 1, 'the server rejects internal thread.stop');
  const { t3, requests } = stopRpc(t, stopProjection([{ id: 'run-1', status: 'running' }]), true);
  await assert.rejects(t3.stop('thread-1'));
  assert.equal(requests().length, 1, 'a rejected public RPC is not retried');
  let attempts = 0;
  t.mock.method(t3, 'dispatch', async () => { attempts++; throw new Error('Connection lost; outcome unknown'); });
  await assert.rejects(t3.stop('thread-1'), /outcome unknown/);
  assert.equal(attempts, 1);
});

test('Stop accepts work finishing before its fresh read and surfaces a dispatch race without retargeting', async t => {
  const { t3, requests } = stopRpc(t, stopProjection([{ id: 'run-1', status: 'completed' }]));
  await t3.stop('thread-1'); assert.deepEqual(requests(), []);
  t.mock.method(t3, 'request', async () => ({ projection: stopProjection([{ id: 'run-2', status: 'running' }]) }));
  let attempts = 0;
  t.mock.method(t3, 'dispatch', async (command: unknown) => { attempts++; assert.equal((command as any).runId, 'run-2'); throw new Error('Run finished during Stop'); });
  await assert.rejects(t3.stop('thread-1'), /Run finished/);
  assert.equal(attempts, 1, 'do not retry against a newer run');
});


test('Stop surfaces a missing thread without dispatching any mutation', async t => {
  const { t3, requests } = fixtureT3(t, {});
  let dispatched = false;
  t.mock.method(t3, 'dispatch', async () => { dispatched = true; });
  await assert.rejects(t3.stop('missing/thread'), /HTTP 404/);
  assert.equal(dispatched, false);
  assert.deepEqual(requests.map(r => r.path), ['/api/orchestration/threads/missing%2Fthread/bounded']);
});
