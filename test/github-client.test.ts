import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GitHub } from '../src/github-client.ts';

const page = (title = 'Fixture', more = false, cursor: string | null = null) => ({ data: { repository: { pullRequests: { nodes: [{ title, headRefName: 'fix/APP-1', body: 'Full PR body' }], pageInfo: { hasNextPage: more, endCursor: cursor } } } } });
async function fixture(t: TestContext, reply: (body: any, authorization?: string) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  let requests = 0, connections = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => void (async () => {
      requests++;
      const result = await reply(JSON.parse(Buffer.concat(chunks).toString()), req.headers.authorization);
      res.writeHead(result.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result.body));
    })());
  });
  server.on('connection', () => { connections++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { endpoint: `http://127.0.0.1:${address.port}/graphql`, requests: () => requests, connections: () => connections };
}

test('GitHub reuses authentication and HTTP connections while every query reads current PRs', async t => {
  let reads = 0, auth = 0;
  const f = await fixture(t, (body, authorization) => {
    assert.equal(authorization, 'Bearer fixture'); assert.equal(body.variables.owner, 'fixture'); assert.equal(body.variables.repo, 'repo');
    assert.ok(!body.query.includes('mutation')); return { body: page(`Current ${++reads}`) };
  });
  const client = new GitHub(async () => { auth++; return 'fixture'; }, undefined, f.endpoint); t.after(() => client.close());
  for (let i = 1; i <= 3; i++) { assert.equal((await client.pullRequests('fixture/repo'))[0].title, `Current ${i}`); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(auth, 1); assert.equal(f.requests(), 3); assert.ok(f.connections() < 3, 'serial reads must reuse an HTTP connection');
});

test('GitHub reads every page with full body and branch duplicate evidence', async t => {
  const cursors: unknown[] = [];
  const f = await fixture(t, body => { cursors.push(body.variables.cursor); return { body: body.variables.cursor ? page('Last page') : page('First page', true, 'next') }; });
  const client = new GitHub(async () => 'fixture', undefined, f.endpoint); t.after(() => client.close());
  const rows = await client.pullRequests('fixture/repo');
  assert.deepEqual(rows.map(row => row.title), ['First page', 'Last page']); assert.deepEqual(cursors, [null, 'next']);
  assert.equal(rows[1].body, 'Full PR body'); assert.equal(rows[1].headRefName, 'fix/APP-1');
});

test('an unauthorized read refreshes its credential once and never loops', async t => {
  let auth = 0; const headers: (string | undefined)[] = [];
  const f = await fixture(t, (_body, authorization) => { headers.push(authorization); return headers.length === 1 ? { status: 401, body: {} } : { body: page() }; });
  const client = new GitHub(async () => `fixture-${++auth}`, undefined, f.endpoint); t.after(() => client.close());
  await client.pullRequests('fixture/repo'); assert.deepEqual(headers, ['Bearer fixture-1', 'Bearer fixture-2']);
});

test('concurrent unauthorized readers share the replacement credential lookup', async t => {
  let auth = 0, oldRequests = 0;
  const refreshing = Promise.withResolvers<void>(), replacement = Promise.withResolvers<string>();
  const f = await fixture(t, async (_body, authorization) => {
    if (authorization === 'Bearer old') { if (++oldRequests === 2) await refreshing.promise; return { status: 401, body: {} }; }
    return { body: page() };
  });
  const client = new GitHub(async () => { if (++auth === 1) return 'old'; refreshing.resolve(); return replacement.promise; }, undefined, f.endpoint); t.after(() => client.close());
  const reads = [client.pullRequests('fixture/repo'), client.pullRequests('fixture/repo')];
  await refreshing.promise; replacement.resolve('new'); await Promise.all(reads);
  assert.equal(auth, 2, 'a late 401 must not clear a sibling replacement lookup');
});

for (const fault of ['forbidden', 'unauthorized', 'graphql', 'partial', 'cursor', 'overflow'] as const) test(`GitHub ${fault} fails closed`, async t => {
  const f = await fixture(t, () => {
    if (fault === 'forbidden' || fault === 'unauthorized') return { status: fault === 'forbidden' ? 403 : 401, body: {} };
    if (fault === 'graphql') return { body: { errors: [{ message: 'Fixture' }], data: { repository: null } } };
    if (fault === 'partial') return { body: { ...page(), errors: [{ message: 'Partial read' }] } };
    if (fault === 'cursor') return { body: page('Repeated cursor', true, 'same') };
    const result = page(); result.data.repository.pullRequests.nodes = Array.from({ length: 1001 }, () => ({ title: 'Fixture', headRefName: 'branch', body: '' })); return { body: result };
  });
  const client = new GitHub(async () => 'fixture', undefined, f.endpoint); t.after(() => client.close());
  await assert.rejects(client.pullRequests('fixture/repo')); assert.ok(f.requests() <= 2);
});

test('one cancelled reader leaves shared authentication and sibling reads intact', async t => {
  const token = Promise.withResolvers<string>(); let auth = 0;
  const f = await fixture(t, () => ({ body: page() }));
  const client = new GitHub(async () => { auth++; return token.promise; }, undefined, f.endpoint); t.after(() => client.close());
  const controller = new AbortController(), failure = new Error('Fixture cancellation');
  const first = client.pullRequests('fixture/repo', controller.signal); const rejected = assert.rejects(first, error => error === failure);
  const sibling = client.pullRequests('fixture/repo'); controller.abort(failure); await rejected; token.resolve('fixture');
  assert.equal((await sibling).length, 1); assert.equal(auth, 1); assert.equal(f.requests(), 1);
  client.close(); await assert.rejects(client.pullRequests('fixture/repo'), /closed/);
});
