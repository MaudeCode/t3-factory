import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { T3 } from '../src/clients.ts';
import { v2Shell, v2Thread } from './v2-fixture.ts';

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

function fixtureRpc(t: test.TestContext, reply: (request: { id: string; tag: string }) => unknown[]) {
  const requests: { tag: string; payload: unknown }[] = [];
  class FixtureSocket extends EventTarget {
    readyState = 1;
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
  const t3 = new T3({ url: 'http://localhost', credentialFile: '/unused' });
  t.mock.method(t3, 'socketUrl', async () => 'ws://fixture');
  return { t3, requests: () => requests.map(r => ({ tag: r.tag, payload: r.payload })) };
}
const success = (request: { id: string }) => ({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: null } });

test('workspace removal uses the native T3 RPC without force', async t => {
  const { t3, requests } = fixtureRpc(t, request => [success(request)]);
  await t3.removeWorktree('/repo', '/worktree');
  assert.deepEqual(requests(), [{ tag: 'vcs.removeWorktree', payload: { cwd: '/repo', path: '/worktree', force: false } }]);
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
