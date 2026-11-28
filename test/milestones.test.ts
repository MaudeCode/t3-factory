import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Store, type Job } from '../src/store.ts';
import { milestoneHooks, hookPath } from '../src/milestones.ts';
import { milestoneGrant } from '../src/milestone-grant.ts';
import { createFactoryWeb, webConfigSchema } from '../src/web.ts';
import { reconcile } from '../src/scheduler.ts';
import type { T3, Kanvil } from '../src/clients.ts';
import { v2Thread } from './v2-fixture.ts';
import { cowtailItem } from '../src/cowtail.ts';

const key = Buffer.alloc(32, 8), secret = 'whsec_' + key.toString('base64');
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'milestones-')), config = loadConfig('config.example.jsonc');
  config.stateDir = stateDir;
  const store = new Store(stateDir), p = config.projects[0];
  const job: Job = { id: 'job', kind: 'ticket', projectId: p.kanvilId, taskId: 'task', ticketKey: 'APP-12', threadId: 'thread', messageId: 'message', createdAt: new Date().toISOString(),
    lastPersonalActivity: null, reason: 'working', state: 'running', prUrls: [], reportPath: '/none', completedAt: null };
  store.save(job);
  const hooks = () => {
    writeFileSync(join(stateDir, 'milestone-grant.json'), JSON.stringify({ origin: new URL(config.t3.url).origin, token: 'test-access', secret }));
    return milestoneHooks(store, () => config, 'http://127.0.0.1:3848')!;
  };
  return { store, config, job, hooks, [Symbol.dispose]() { store.close(); rmSync(stateDir, { recursive: true, force: true }); } };
}
function signed(raw: string, stamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', key).update('msg.' + stamp + '.' + raw).digest('base64');
  return { 'content-type': 'application/json', 'webhook-id': 'msg', 'webhook-timestamp': String(stamp), 'webhook-signature': 'v1,' + signature };
}

test('public callback authenticates the exact bytes and answers the signed challenge', async () => {
  using f = fixture();
  const web = createFactoryWeb({ config: webConfigSchema.parse({}), secret: 'private', dataDir: f.config.stateDir,
    milestone: f.hooks().receive, readState: () => ({}), run: async () => ({ code: 0, data: {} }) });
  const url = await listen(web) + hookPath;
  try {
    const raw = '{"type":"verification", "challenge":"abc"}';
    const post = (body: string, headers: Record<string,string>) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, host: '127.0.0.1:3848' } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', reject); req.end(body);
    });
    assert.equal((await post(raw + ' ', signed(raw))).status, 401);
    assert.equal((await post(raw, signed(raw, 1))).status, 401);
    const response = await post(raw, signed(raw)); assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { challenge: 'abc' });
  } finally { web.closeAllConnections(); web.close(); }
});

test('shell and webhook deliveries share a request, while a second approval gets its own phone item', () => {
  using f = fixture();
  const hook = f.hooks(), at = '2026-11-02T01:10:00.000Z', phone: ReturnType<typeof cowtailItem>[] = [];
  f.store.onEvent = event => {
    const item = cowtailItem(event, () => [], { failed: 'now', needsYou: 'now', quotaHold: 'off', noPr: 'off', finished: 'off' }, 'https://example.org');
    if (item) phone.push(item);
  };
  const deliver = (type: string, requestId: string, threadId = f.job.threadId) => {
    const raw = JSON.stringify({ name: type, cursor: 'c', data: { type, id: type + ':' + requestId, requestId, resolution: 'resolved', kind: 'approval',
      threadId, occurredAt: at, projectId: f.config.projects[0].t3Id } });
    assert.equal(hook.receive(signed(raw), Buffer.from(raw)).status, 204);
  };
  f.store.save({ ...f.job, state: 'waiting', reason: 'T3 is awaiting human input',
    thread: { title: 'A', status: 'waiting', branch: null, worktreePath: null, updatedAt: at, pending: 'command', pendingId: 'a', pendingAt: at, background: [] } });
  deliver('thread.needs_input', 'a');
  deliver('thread.needs_input', 'b');
  deliver('thread.input_resolved', 'a');
  deliver('thread.needs_input', 'b');
  deliver('thread.input_resolved', 'old');
  deliver('thread.needs_input', 'old');
  deliver('thread.needs_input', 'unowned', 'personal-thread');
  assert.deepEqual(phone.map(x => x && [x.kind, x.dedupeKey, x.links?.[0].url]), ['a','b'].map(id =>
    ['approval', 't3-factory:input:job:' + id, 'https://example.org/api/threads/thread/open']));
  assert.equal(f.store.inputResolved('job', 'a'), true);
  assert.equal(f.store.inputResolved('job', 'b'), false);
  assert.equal(f.store.events(100, 'job', 'thread.needs_input').filter(e => e.kind === 'thread.needs_input').length, 3);
});

test('T3 settlement and PR wakes describe the run while Factory retains delivery ownership', async () => {
  using f = fixture();
  const hook = f.hooks(), at = '2026-11-02T01:10:00.000Z';
  for (const extra of [{ type: 'thread.run_settled', outcome: 'failed', runId: 'turn' },
    { type: 'pr.watch_wake', outcome: 'updated', summary: 'CI finished', watchEnded: false, pullRequests: [{ host: 'github.com', repository: 'org/repo', number: 14 }] }]) {
    const raw = JSON.stringify({ name: extra.type, cursor: 'next', data: { ...extra, id: extra.type, threadId: 'thread', projectId: f.config.projects[0].t3Id, occurredAt: at } });
    assert.equal(hook.receive(signed(raw), Buffer.from(raw)).status, 204);
  }
  assert.equal(f.store.turnOutcome('job', 'turn'), 'failed');
  assert.equal(f.store.turnOutcome('job', 'older-turn'), undefined);
  assert.match(f.store.events(1, 'job')[0].text, /org\/repo#14.*CI finished/);
  assert.equal(f.store.job('job')?.state, 'running');
  await reconcile(f.config, f.store, {} as T3, {} as Kanvil, [v2Thread({ id: 'thread', status: 'failed', latestRunId: 'turn', latestRunCompletedAt: at, activeRunId: null })]);
  assert.equal(f.store.job('job')?.state, 'waiting');
  assert.match(f.store.job('job')!.reason, /turn failed without a completion report/);
});

test('outside-client subscriptions resume each event type from its own stored cursor', { timeout: 10_000 }, async t => {
  using f = fixture();
  const calls = new Map<string, any>(), all = Promise.withResolvers<void>();
  const mcp = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    calls.set(rpc.params.name, { headers: req.headers, path: req.url, ...rpc });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { id: 'sub', cursor: 'fresh', refreshBefore: new Date(Date.now() + 900_000).toISOString() } }));
    if (calls.size === 4) all.resolve();
  });
  f.config.t3.url = await listen(mcp);
  const stop = new AbortController(); f.store.set('milestoneCursor:pr.watch_wake', 'saved');
  const following = f.hooks().follow(stop.signal);
  try {
    await Promise.race([all.promise, once(t.signal, 'abort').then(() => { throw new Error('Subscription registration did not finish'); })]);
    assert.deepEqual([...calls.keys()].sort(), ['pr.watch_wake','thread.input_resolved','thread.needs_input','thread.run_settled']);
    for (const [name, rpc] of calls) {
      assert.equal(rpc.path, '/mcp'); assert.equal(rpc.headers.authorization, 'Bearer test-access');
      assert.equal(rpc.headers['mcp-method'], 'events/subscribe'); assert.equal(rpc.headers['mcp-name'], name);
      assert.deepEqual(rpc.params.arguments.projectIds, [...new Set(f.config.projects.map(p => p.t3Id))].sort());
      assert.equal(rpc.params.cursor, name === 'pr.watch_wake' ? 'saved' : null);
      assert.deepEqual(rpc.params.delivery, { mode: 'webhook', url: 'http://127.0.0.1:3848' + hookPath, secret });
    }
  } finally { stop.abort(); await following; mcp.closeAllConnections(); mcp.close(); }
});

test('a fresh deployment provisions one read-only grant and consumes milestones when T3 refuses a private callback', { timeout: 10_000 }, async t => {
  using f = fixture();
  let origin = '', redirect = '', approvals = 0, registrations = 0, proof = '';
  const completed = Promise.withResolvers<void>(), stamp = new Date().toISOString();
  const issuer = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); res.setHeader('content-type', 'application/json');
    switch (req.url) {
      case '/.well-known/oauth-authorization-server':
        return res.end(JSON.stringify({ issuer: origin, authorization_endpoint: origin + '/authorize', registration_endpoint: origin + '/register', token_endpoint: origin + '/token' }));
      case '/register':
        registrations++;
        redirect = JSON.parse(body).redirect_uris[0];
        return res.writeHead(201).end(JSON.stringify({ client_id: 'factory', token_endpoint_auth_method: 'none' }));
      case '/api/auth/pairing-token':
        approvals++;
        if (req.headers.authorization !== 'Bearer factory-session' || JSON.parse(body).access !== 'read-only') return res.writeHead(403).end('{}');
        return res.end(JSON.stringify({ credential: 'approval', access: 'read-only' }));
      case '/oauth/mcp/decision': {
        const { authorization, decision } = JSON.parse(body);
        if (decision.access !== 'read-only' || decision.code !== 'approval' || authorization.resource !== origin + '/mcp') return res.writeHead(403).end('{}');
        proof = authorization.code_challenge;
        const url = new URL(redirect); url.searchParams.set('code', 'approved'); url.searchParams.set('state', authorization.state);
        return res.end(JSON.stringify({ redirectTo: url.href }));
      }
      case '/token': {
        const form = new URLSearchParams(body);
        if (form.get('code') !== 'approved' || form.get('resource') !== origin + '/mcp' || form.get('redirect_uri') !== redirect ||
            createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== proof) return res.writeHead(400).end('{}');
        return res.end(JSON.stringify({ access_token: 'outside', token_type: 'Bearer', scope: 'orchestration:read', expires_in: 3600 }));
      }
      case '/mcp': {
        if (req.headers.authorization !== 'Bearer outside') return res.writeHead(401).end('{}');
        const { method, params } = JSON.parse(body);
        if (method === 'events/subscribe') return res.writeHead(400).end(JSON.stringify({ error: { code: -32602, message: 'delivery.url is not allowed' } }));
        if (method !== 'events/poll') return res.writeHead(400).end('{}');
        return res.end(JSON.stringify({ result: { cursor: 'tail', hasMore: false, events: params.name === 'thread.run_settled' ? [{ data: {
          type: params.name, id: 'settlement', threadId: f.job.threadId, projectId: f.config.projects[0].t3Id, runId: 'ended', occurredAt: stamp, outcome: 'completed',
        } }] : [] } }));
      }
      default: return res.writeHead(404).end('{}');
    }
  });
  origin = f.config.t3.url = await listen(issuer);
  f.config.t3.credentialFile = join(f.config.stateDir, 'session.json');
  writeFileSync(f.config.t3.credentialFile, JSON.stringify({ token: 'factory-session' }));
  const stop = new AbortController();
  f.store.onEvent = event => { if (event.kind === 'thread.run_settled') completed.resolve(); };
  const following = milestoneHooks(f.store, () => f.config, 'https://factory.example').follow(stop.signal);
  try {
    await Promise.race([completed.promise, once(t.signal, 'abort').then(() => { throw new Error('Missing milestone'); })]);
    assert.equal(f.store.turnOutcome('job', 'ended'), 'completed');
    assert.equal(f.store.get('milestoneCursor:thread.run_settled'), 'tail');
    assert.equal(registrations, 1); assert.equal(approvals, 1);
    assert.equal(milestoneGrant(f.config)?.token, 'outside');
    assert.equal(statSync(join(f.config.stateDir, 'milestone-grant.json')).mode & 0o777, 0o600);
  } finally { stop.abort(); await following; issuer.closeAllConnections(); issuer.close(); }
});
