import test from 'node:test';
import assert from 'node:assert/strict';
import { Kanvil, KanvilTaskNotFound, listTasks } from '../src/clients.ts';
import { taskDifficulty, taskHold } from '../src/policy.ts';

export const ticket = (extra: Record<string, unknown> = {}) => ({
  id: 'ticket', projectId: 'project', key: 'APP-1', number: 1, title: 'Fixture', description: 'Problem', acceptanceCriteria: 'Works',
  status: 'todo', priority: 'none', createdAt: '2026-01-01T00:00:00Z', version: 1,
  labels: ['sec', 'high', 'app', 'web', 'contracts', 'sf'], difficulty: 'high', automationReady: true,
  holdReason: null, archived: false, parentId: null, ...extra,
});
const snapshot = (tickets = [ticket()], cursor = '5') => ({ project: { id: 'project', workspaceId: 'workspace', name: 'Fixture', key: 'APP' }, tickets, cursor });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) { for (let n = 0; n < 100; n++) { if (predicate()) return; await turn(); } assert.fail('fixture condition did not settle'); }
function fixture(t: test.TestContext, read: (url: URL, init?: RequestInit) => Response | Promise<Response>, scoped = false) {
  const old = process.env.KANVIL_API_KEY; process.env.KANVIL_API_KEY = 'fixture-secret';
  t.after(() => { if (old === undefined) delete process.env.KANVIL_API_KEY; else process.env.KANVIL_API_KEY = old; });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input); calls.push(url.pathname + url.search);
    assert.equal(url.origin, 'https://tracker.example.test');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret');
    assert.equal(init?.redirect, 'error');
    if (!scoped && url.pathname.endsWith('/events') && url.searchParams.has('projectId')) return new Response(new ReadableStream<Uint8Array>({ start(c) {
      const cursor = url.searchParams.get('cursor') ?? '0';
      c.enqueue(new TextEncoder().encode(`event: checkpoint\nid: ${cursor}\ndata: ${JSON.stringify({cursor})}\n\n`));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    return read(url, init);
  });
  const client = new Kanvil({ url: 'https://tracker.example.test', workspaceId: 'workspace' });
  t.after(() => client.close());
  return { client, calls };
}

test('native ticket payloads supply complete labels, priority and difficulty without a workspace scan', async t => {
  const f = fixture(t, url => {
    if (url.pathname === '/api/v1/snapshot') return json(snapshot());
    if (url.pathname === '/api/v1/projects/project/tickets/ticket') return json({ ticket: ticket(), readiness: { ready: true, reasons: [] } });
    throw new Error(url.pathname);
  });
  const listed = await listTasks(f.client, 'project', ['todo']);
  const task = await f.client.task('ticket', 'project');
  assert.deepEqual(task.labels, listed[0].labels);
  assert.deepEqual(task.labels?.map(l => l.name), ticket().labels);
  assert.equal(taskDifficulty(task), 'high');
  assert.equal(task.priority, 'none');
  assert.equal(f.calls.length, 2);
  assert.equal(taskHold(task), '');
  assert.match(taskHold({ ...task, automationReady: false }), /not enabled/);
  assert.match(taskHold({ ...task, holdReason: 'Product decision' }), /Product decision/);
  assert.throws(() => taskDifficulty({ ...task, difficulty: 'low' }), /disagree/);
});

test('malformed payloads and project or workspace mismatches fail closed', async t => {
  let payload: unknown = snapshot();
  const f = fixture(t, () => json(payload));
  for (const value of [snapshot([ticket({ labels: [{ name: 'sf' }] })]), snapshot([ticket({ automationReady: undefined })]), snapshot([ticket({ projectId: 'other' })]), { ...snapshot(), project: { ...snapshot().project, workspaceId: 'other' } }]) {
    payload = value; await assert.rejects(listTasks(f.client, 'project'));
  }
});

test('only HTTP 404 with the stable absence code retires a missing reference; errors redact server prose', async t => {
  let status = 404, payload: unknown = { error: { code: 'not_found', message: 'private fixture-secret' } };
  const f = fixture(t, () => json(payload, status));
  await assert.rejects(f.client.task('missing', 'project'), KanvilTaskNotFound);
  for (const value of [{ error: 'Task not found (NOT_FOUND)' }, { error: { code: 'unauthorized', message: 'Bearer fixture-secret' } }, { message: 'HTTP 404' }]) {
    payload = value;
    await assert.rejects(f.client.task('missing', 'project'), error => {
      assert.ok(error instanceof Error && !(error instanceof KanvilTaskNotFound));
      assert.doesNotMatch(error.message, /fixture-secret|private/); return true;
    });
  }
  status = 503; payload = { error: { code: 'unavailable', message: 'private fixture-secret' } };
  await assert.rejects(f.client.task('missing', 'project'), /HTTP 503, unavailable/);
});

test('native relations include blockers and parentId hierarchy, with every page of archived children', async t => {
  const f = fixture(t, url => {
    if (url.pathname === '/api/v1/tickets/resolve') return json({ ticket: ticket({ parentId: 'parent' }) });
    if (url.pathname.endsWith('/tickets/ticket')) return json({ ticket: ticket({ parentId: 'parent' }), readiness: { ready: false, reasons: [{ code: 'claimed', message: 'Owned' }] } });
    if (url.pathname.endsWith('/relations')) return json([{ sourceId: 'blocker', targetId: 'ticket', type: 'blocks' }, { sourceId: 'ticket', targetId: 'other', type: 'reviews' }]);
    assert.equal(url.searchParams.get('archived'), 'include');
    const offset = Number(url.searchParams.get('offset'));
    return json({ items: [ticket({ id: `child-${offset}`, parentId: 'ticket' })], total: 2 });
  });
  assert.deepEqual(await f.client.relations('ticket'), [
    { sourceTaskId: 'blocker', targetTaskId: 'ticket', relationType: 'blocks' },
    { sourceTaskId: 'parent', targetTaskId: 'ticket', relationType: 'subtask' },
    { sourceTaskId: 'ticket', targetTaskId: 'child-0', relationType: 'subtask' },
    { sourceTaskId: 'ticket', targetTaskId: 'child-1', relationType: 'subtask' },
  ]);
});

test('event checkpoints wake the consumer and cache inventory until a real change; duplicates do not rescan', async t => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, snapshots = 0, notifications = 0, updates = 0;
  const encoder = new TextEncoder();
  const send = (event: string, id: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`));
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/checkpoint')) return json({ cursor: '5' });
    if (url.pathname.endsWith('/snapshot')) { snapshots++; return json(snapshot([ticket({ title: `Snapshot ${snapshots}` })])); }
    if (url.pathname.endsWith('/tickets/ticket')) return json({ ticket: ticket({ title: `Update ${++updates}` }), readiness: { ready: true, reasons: [] } });
    return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const abort = new AbortController();
  const stream = f.client.subscribe(event => { if (!event?.type.startsWith('stream.')) notifications++; }, abort.signal);
  await until(() => !!controller);
  send('checkpoint', '5', { cursor: '5' }); await until(() => notifications === 1);
  for (let n = 0; n < 4; n++) await f.client.tasks('project');
  assert.equal(snapshots, 1, 'scheduler timers reuse a live inventory');
  send('change', '6', { id: '6', projectId: 'project', ticketId: 'ticket', type: 'ticket.updated' });
  await until(() => notifications === 2);
  assert.equal((await f.client.tasks('project'))[0].title, 'Update 1');
  send('change', '6', { id: '6', projectId: 'project', ticketId: 'ticket', type: 'ticket.updated' });
  await turn(); await f.client.tasks('project');
  assert.equal(snapshots, 1, 'a changed ticket does not rescan its project'); assert.equal(updates, 1); assert.equal(notifications, 2);
  send('change', '7', { id: '7', projectId: 'project', ticketId: 'ticket', type: 'ticket.deleted' });
  await until(() => notifications === 3);
  assert.deepEqual(await f.client.tasks('project'), [], 'a native deletion removes the ticket without another inventory read');
  send('change', '8', { id: '8', projectId: 'project', ticketId: 'ticket', type: 'comment.created' });
  await turn(); assert.equal(notifications, 3); assert.equal(snapshots, 1); assert.equal(updates, 1);
  abort.abort(); await stream;
});

test('disconnect replay uses the last processed cursor; an expired cursor clears the projection and snapshots again', async t => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [], cursors: string[] = [];
  let checkpoints = 0, notifications = 0, expired = false, snapshots = 0;
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/checkpoint')) return json({ cursor: String(++checkpoints === 1 ? 5 : 20) });
    if (url.pathname.endsWith('/snapshot')) { snapshots++; return json(snapshot()); }
    cursors.push(url.searchParams.get('cursor')!);
    if (expired) { expired = false; return json({ error: { code: 'snapshot_required' } }, 410); }
    return new Response(new ReadableStream<Uint8Array>({ start(c) { controllers.push(c); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = f.client.subscribe(event => { if (!event?.type.startsWith('stream.')) notifications++; }, new AbortController().signal);
  const send = (id: number) => controllers.at(-1)!.enqueue(new TextEncoder().encode(`event: checkpoint\nid: ${id}\ndata: {"cursor":"${id}"}\n\n`));
  await until(() => controllers.length === 1); send(7); await until(() => notifications === 1);
  await f.client.tasks('project'); controllers[0].close(); await turn(); t.mock.timers.tick(1000);
  await until(() => controllers.length === 2); assert.deepEqual(cursors, ['5', '7']);
  send(8); await until(() => notifications === 3); await f.client.tasks('project');
  expired = true; controllers[1].close(); await turn(); t.mock.timers.tick(1000);
  await until(() => controllers.length === 3); assert.deepEqual(cursors, ['5', '7', '8', '20']);
  send(20); await until(() => notifications === 5); await f.client.tasks('project');
  assert.equal(snapshots, 3, 'each loss of trust requires a fresh projection');
  await f.client.close(); await stream;
});

test('former ticket keys resolve to the verified current project and ID before reading readiness', async t => {
  const f = fixture(t, url => {
    if (url.pathname === '/api/v1/tickets/resolve') {
      assert.equal(url.searchParams.get('ticketId'), 'OLD-7');
      return json({ ticket: ticket() });
    }
    assert.equal(url.pathname, '/api/v1/projects/project/tickets/ticket');
    return json({ ticket: ticket(), readiness: { ready: true, reasons: [] } });
  });
  assert.equal((await f.client.task('OLD-7')).key, 'APP-1');
  assert.equal(f.calls.length, 2);
});

test('project access revocation invalidates cached tickets even while the unscoped feed stays connected', async t => {
  let global!: ReadableStreamDefaultController<Uint8Array>, scoped: ReadableStreamDefaultController<Uint8Array> | undefined, revoked = false, errors = 0;
  const encode = (event: string, id: string, data: unknown) => new TextEncoder().encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/checkpoint')) return json({ cursor: '5' });
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream<Uint8Array>({ start(c) {
      if (url.searchParams.has('projectId')) { scoped = c; c.enqueue(encode('checkpoint', '5', {cursor:'5'})); }
      else global = c;
    } }), {headers:{'content-type':'text/event-stream'}});
    if (revoked) return json({error:{code:'not_found'}}, 404);
    if (url.pathname.endsWith('/snapshot')) return json(snapshot());
    return json({ticket:ticket(),readiness:{ready:true,reasons:[]}});
  }, true);
  const stream = f.client.subscribe(() => {}, new AbortController().signal, () => errors++);
  await until(() => !!global); global.enqueue(encode('checkpoint', '5', {cursor:'5'})); await turn();
  const row = (await f.client.tasks('project'))[0]; await f.client.eligibleTask(row);
  revoked = true;
  scoped?.enqueue(encode('error', '6', {status:404,code:'not_found',message:'Project was not found'}));
  global.enqueue(encode('checkpoint', '6', {cursor:'6'})); await turn();
  if (scoped) await until(() => errors > 0);
  await assert.rejects(f.client.tasks('project'), /not_found|synchronized|unavailable/i, 'revoked project data cannot remain trusted behind global checkpoints');
  await assert.rejects(f.client.eligibleTask(row), /not_found|synchronized|unavailable/i);
  await f.client.close(); await stream;
});

test('session-only ticket reads enroll in scoped access monitoring', async t => {
  let global!: ReadableStreamDefaultController<Uint8Array>, scoped: ReadableStreamDefaultController<Uint8Array> | undefined, disconnected = 0;
  const encode = (event: string, id: string, data: unknown) => new TextEncoder().encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/checkpoint')) return json({ cursor: '5' });
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream<Uint8Array>({ start(c) {
      if (url.searchParams.has('projectId')) { scoped = c; c.enqueue(encode('checkpoint','5',{cursor:'5'})); }
      else global = c;
    } }), {headers:{'content-type':'text/event-stream'}});
    return json({ticket:ticket(),readiness:{ready:true,reasons:[]}});
  }, true);
  const stream = f.client.subscribe(event => { if (event?.type === 'stream.disconnected' && event.projectId === 'project') disconnected++; }, new AbortController().signal);
  await until(() => !!global); global.enqueue(encode('checkpoint','5',{cursor:'5'})); await turn();
  await f.client.task('ticket','project'); // No project snapshot or enabled-project inventory.
  scoped?.enqueue(encode('error','6',{status:404,code:'not_found',message:'Project was not found'}));
  global.enqueue(encode('checkpoint','6',{cursor:'6'}));
  for (let n=0; n<5; n++) await turn();
  assert.equal(disconnected, 1, 'a session-only row needs an access-loss invalidation even when global checkpoints continue');
  await f.client.close(); await stream;
});
