import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createFactoryWeb, webConfigSchema } from '../src/web.ts';

test('cleanup inventory is authenticated, read-only and routed through the scheduler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-api-'));
  const calls: unknown[] = [];
  const server = createFactoryWeb({ config: webConfigSchema.parse({}), secret: 'a'.repeat(64), dataDir: dir,
    oidc: { authenticated: async () => true } as any, readState: () => ({}),
    run: async (args, input) => { calls.push({ args, input }); return { code: 0, data: { items: [], total: 0 } }; },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const response = await new Promise<Response>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${address.port}/api/cleanup?view=retained`, { headers: { Host: '127.0.0.1:3848' } }, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }))); });
      req.on('error', reject); req.end();
    });
    assert.equal(response.status, 200, 'cleanup inventory must be available to an authenticated operator');
    assert.deepEqual(await response.json(), { items: [], total: 0 });
    assert.deepEqual(calls, [{ args: ['cleanup'], input: { type: 'inventory', offset: 0, limit: 50, view: 'retained' } }]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});

test('cleanup mutations enforce authentication, origin, strict validation and shared operation idempotency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-api-actions-'));
  let authenticated = false, calls = 0, finish!: (result: any) => void;
  const server = createFactoryWeb({ config: webConfigSchema.parse({}), secret: 'a'.repeat(64), dataDir: dir,
    oidc: { authenticated: async () => authenticated } as any, readState: () => ({}),
    run: async (args, input: any) => { calls++; assert.equal(args[0], 'cleanup'); assert.match(args[1], /^web-session:/); assert.equal(input.type, 'retry'); return new Promise(resolve => { finish = resolve; }); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, id = '00000000-0000-4000-8000-000000000043';
  const send = (path: string, method = 'GET', input?: unknown, origin = 'http://127.0.0.1:3848') => new Promise<Response>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { Host: '127.0.0.1:3848', Origin: origin, 'Idempotency-Key': id, 'Content-Type': 'application/json', Cookie: 'fixture-session' } }, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }))); });
    req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
  const input = { type: 'retry', targets: [{ projectId: 'p', path: '/workspace/tree' }], reason: 'Repair authorization' };
  try {
    assert.equal((await send('/api/cleanup')).status, 401);
    authenticated = true;
    assert.equal((await send('/api/cleanup/actions', 'POST', input, 'https://untrusted.example.test')).status, 403);
    assert.equal((await send('/api/cleanup/actions', 'POST', { ...input, force: true })).status, 400);
    const accepted = await send('/api/cleanup/actions', 'POST', input); assert.equal(accepted.status, 202);
    assert.equal((await send('/api/cleanup/actions', 'POST', input)).status, 200); assert.equal(calls, 1);
    assert.equal((await send('/api/cleanup/actions', 'POST', { ...input, reason: 'Different request' })).status, 409);
    finish({ code: 0, data: { state: 'confirmed', outcomes: [] } });
    await new Promise(resolve => setImmediate(resolve));
    const stored = await (await send('/api/operations/' + id)).json(); assert.equal(stored.state, 'done'); assert.equal(stored.result.data.state, 'confirmed');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});


for (const outcome of ['failed', 'pending', 'uncertain'] as const) test(`cleanup HTTP operation reports ${outcome} outcomes even when the command returned zero`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-api-outcome-'));
  const server = createFactoryWeb({ config: webConfigSchema.parse({}), secret: 'a'.repeat(64), dataDir: dir, oidc: { authenticated: async () => true } as any, readState: () => ({}),
    run: async () => ({ code: 0, data: { state: outcome === 'pending' ? 'confirmed' : outcome, outcomes: [{ path: '/workspace/tree', state: outcome, physicalRemoval: false, message: 'Not removed' }] } }),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, id = '00000000-0000-4000-8000-000000000044';
  const send = (path: string, input?: unknown) => new Promise<any>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method: input ? 'POST' : 'GET', headers: { Host: '127.0.0.1:3848', Origin: 'http://127.0.0.1:3848', 'Idempotency-Key': id, 'Content-Type': 'application/json' } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body))); });
    req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
  try {
    await send('/api/cleanup/actions', { type: 'remove', targets: [{ projectId: 'p', path: '/workspace/tree' }], reason: 'Check physical outcome' });
    await new Promise(resolve => setImmediate(resolve));
    const operation = await send('/api/operations/' + id);
    assert.equal(operation.state, outcome, 'request completion must preserve the cleanup outcome');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});


test('cleanup HTTP reads use the maintained snapshot even when the command runner is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-api-catalog-')); const inputs: any[] = [];
  const server = createFactoryWeb({ config: webConfigSchema.parse({}), secret: 'a'.repeat(64), dataDir: dir,
    oidc: { authenticated: async () => true } as any, readState: () => ({}),
    cleanupInventory: input => { inputs.push(input); return { items: [], total: 0, checkedAt: '2026-01-01T00:00:00Z' }; },
    run: async () => { assert.fail('inventory must bypass command execution'); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await new Promise<{ code: number; data: any }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}/api/cleanup?limit=6&view=retained&refresh=true`, { headers: { Host: '127.0.0.1:3848' } }, res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ code: res.statusCode!, data: JSON.parse(text) })); }); req.on('error', reject); req.end();
    });
    assert.equal(result.code, 200); assert.equal(result.data.checkedAt, '2026-01-01T00:00:00Z');
    assert.equal(inputs[0].refresh, true); assert.equal(inputs[0].limit, 6);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});
