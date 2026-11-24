import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.ts';
import { serveControl } from '../src/control.ts';
import { T3, Kanvil } from '../src/clients.ts';
import { FactoryService } from '../src/service.ts';
import { Store, type Job } from '../src/store.ts';
import { readStatus } from '../src/scheduler.ts';

// One fake T3 and Kanvil over real HTTP, so the scheduler's writer and the offline CLI process hit the same boundaries.
type Ticket = { status: string; version: number; claimRequired: boolean; claim: null | { id: string; workerId: string; createdAt: string; expiresAt: string } };
async function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-dismiss-')));
  const threads: Record<string, [number, unknown]> = {
    gone: [404, { _tag: 'EnvironmentResourceNotFoundError', code: 'not_found', reason: 'thread_not_found', traceId: 'trace' }],
    'gone-2': [404, { _tag: 'EnvironmentResourceNotFoundError', code: 'not_found', reason: 'thread_not_found', traceId: 'trace' }],
    live: [200, { projection: { thread: { id: 'live', status: 'idle' } } }],
    bare: [404, 'not found'], down: [500, { error: 'unavailable' }], odd: [200, { projection: { thread: { id: 'someone-else' } } }],
  };
  const ticket: Ticket = { status: 'in_progress', version: 5, claimRequired: true, claim: { id: '11111111-1111-4111-8111-111111111111', workerId: 'agent', createdAt: '2026-01-01T00:01:00Z', expiresAt: '2026-01-02T00:01:00Z' } };
  const writes: { method: string; path: string; body: any }[] = [];
  let refuseWrite = false;
  const body = (req: IncomingMessage) => new Promise<any>(resolve => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)); });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://x').pathname, input = await body(req);
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
    const thread = /^\/api\/orchestration\/threads\/([^/]+)\/bounded$/.exec(path);
    if (thread) return send(...threads[decodeURIComponent(thread[1])] ?? [404, 'not found']);
    if (path === '/api/v1/projects/FIX/workflow') return send(200, ['backlog', 'todo', 'in_progress', 'in_review', 'done'].map((category, position) => ({ category, name: category, position })));
    if (path === '/api/v1/projects/FIX/tickets/task-1' && req.method === 'GET') return send(200, {
      ticket: { id: 'task-1', projectId: 'FIX', key: 'FIX-1', number: 1, title: 'Fixture', priority: 'none', createdAt: '2026-01-01T00:00:00Z', labels: [], difficulty: 'low', automationReady: true, holdReason: null, archived: false, parentId: null, acceptanceCriteria: 'x', status: ticket.status, version: ticket.version, claimRequired: ticket.claimRequired },
      readiness: { ready: false, reasons: [] }, claim: ticket.claim, subscribed: false, canReleaseClaim: false,
    });
    if (path.startsWith('/api/v1/projects/FIX/tickets/task-1')) {
      writes.push({ method: req.method!, path, body: input });
      if (refuseWrite) return send(409, { error: { code: 'claim_conflict' } });
      ticket.status = 'todo'; ticket.version++; ticket.claim = null;
      return send(200, { ok: true });
    }
    send(404, 'not found');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const credentialFile = join(dir, 'credential.json'); writeFileSync(credentialFile, JSON.stringify({ token: 'fixture' }));
  const c = configSchema.parse({ enabled: false, pollSeconds: 60, idleMinutes: 30, maxWaitingPRs: null,
    models: [{ id: 'sol', name: 'Sol', model: { instanceId: 'codex', model: 'gpt-6.1-sol' } }],
    quota: { maxAgeSeconds: 300, claude: { fiveHour: { reservePercent: 0, minRemainingPercent: 0 }, weekly: { reservePercent: 0, minRemainingPercent: 0 }, fable: { reservePercent: 0, minRemainingPercent: 0 } }, codex: { weekly: { reservePercent: 0, minRemainingPercent: 0 } } },
    runtimeMode: 'full-access', stateDir: join(dir, 'state'), t3: { url, credentialFile }, kanvil: { url, workspaceId: 'workspace' },
    discovery: { promptFile: join(dir, 'prompt'), emptyCooldownHours: 24 }, factorySkill: join(dir, 'skill'),
    projects: [{ name: 'FIX', key: 'FIX', enabled: true, kanvilId: 'FIX', t3Id: 'FIX', repoPath: dir, githubRepo: 'fixture/FIX', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'] }],
  });
  const configPath = join(dir, 'config.jsonc'); writeFileSync(configPath, JSON.stringify(c));
  const previousKey = process.env.KANVIL_API_KEY; process.env.KANVIL_API_KEY = 'fixture';
  const store = new Store(c.stateDir);
  const job = (id: string, threadId: string, taskId: string | null = null): Job => ({ id, kind: 'ticket', projectId: 'FIX', taskId, ticketKey: taskId ? 'FIX-1' : null, threadId, messageId: 'm', createdAt: '2026-01-01T00:00:00Z', completedAt: null, state: 'running', reason: 'Claude is executing', lastPersonalActivity: null, reportPath: join(dir, `${id}.json`), prUrls: [], command: {} });
  const service = new FactoryService(configPath), internal = service as any;
  Object.assign(internal, { store, stateDir: c.stateDir, t3: new T3(c.t3), kanvil: Promise.resolve(new Kanvil(c.kanvil, c.projects)), t3Settings: JSON.stringify(c.t3), kanvilSettings: JSON.stringify(c.kanvil) });
  // serveControl turns a thrown command into this failure; the tests read the same result the CLI receives.
  const handle = (jobId: string, resetTicket = false) => internal.handle({ type: 'job-dismiss', jobId, resetTicket }).catch((error: Error) => ({ code: 1, data: { message: error.message } }));
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, 'job-dismiss', ...args], { env: { ...process.env, NODE_NO_WARNINGS: '1', T3_FACTORY_CONFIG: configPath }, encoding: 'utf8' })
    .then(r => ({ code: 0, out: r.stdout }), (e: any) => ({ code: e.code as number, out: `${e.stdout}${e.stderr}` }));
  t.after(async () => {
    clearTimeout(internal.statusTimer); store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previousKey === undefined) delete process.env.KANVIL_API_KEY; else process.env.KANVIL_API_KEY = previousKey;
    rmSync(dir, { recursive: true, force: true });
  });
  return { c, store, job, handle, cli, threads, ticket, writes, refuse: (value: boolean) => { refuseWrite = value; } };
}

test('job-dismiss in the running scheduler dismisses a deleted-thread run and releases its ticket claim', async t => {
  const f = await fixture(t);
  f.store.save(f.job('deleted', 'gone', 'task-1')); f.store.save(f.job('other', 'live'));
  const result = await f.handle('deleted');
  assert.equal(result.code, 0, JSON.stringify(result.data));
  const dismissed = f.store.job('deleted')!;
  assert.equal(dismissed.state, 'dismissed');
  assert.match(dismissed.reason, /thread was deleted/);
  assert.ok(Date.parse(dismissed.dismissedAt!));
  assert.ok(f.store.events(20, 'deleted').some(e => e.kind === 'job.state' && /dismissed/.test(e.text)), 'the journal records the dismissal');
  f.store.save({ ...f.job('next', 'next'), taskId: 'task-1' }); // the unique live claim on the ticket was released
  assert.equal(f.store.job('other')!.state, 'running', 'unrelated runs are untouched');
  assert.equal(f.writes.length, 0, 'without --reset-ticket the tracker is untouched');
});

test('repeating a finished job-dismiss succeeds without changing the run', async t => {
  const f = await fixture(t);
  f.store.save(f.job('deleted', 'gone'));
  assert.equal((await f.handle('deleted')).code, 0);
  const first = f.store.job('deleted')!;
  f.threads.gone = [200, { projection: { thread: { id: 'gone' } } }]; // the repeat must not depend on T3 again
  const repeat = await f.handle('deleted', true);
  assert.equal(repeat.code, 0, JSON.stringify(repeat.data));
  assert.deepEqual(f.store.job('deleted'), first);
  assert.equal(f.writes.length, 0);
});

test('job-dismiss without a scheduler claims the state directory and dismisses from the CLI', async t => {
  const f = await fixture(t);
  f.store.save(f.job('offline', 'gone'));
  const offline = await f.cli('offline');
  assert.equal(offline.code, 0, offline.out);
  assert.equal(f.store.job('offline')!.state, 'dismissed');
  assert.equal(readStatus(f.c, f.store).jobs.some(j => j.id === 'offline'), false, 'status no longer shows it');
});

test('job-dismiss refuses readable, ambiguous and unknown evidence without mutation', async t => {
  const f = await fixture(t);
  for (const thread of ['live', 'bare', 'down', 'odd']) {
    f.store.save(f.job(thread, thread, 'task-1'));
    const result = await f.handle(thread, true);
    assert.equal(result.code, 1, `${thread}: ${JSON.stringify(result.data)}`);
    assert.match(result.data.message, thread === 'live' ? /T3 still has/ : /T3 did not confirm/);
    assert.equal(f.store.job(thread)!.state, 'running', `${thread} keeps its run`);
    f.store.save({ ...f.store.job(thread)!, state: 'complete', completedAt: '2026-01-02T00:00:00Z' }); // frees task-1 for the next case
  }
  assert.match((await f.handle('missing-job')).data.message, /No run missing-job/);
  assert.equal(f.writes.length, 0, 'refusals never write the tracker');
});

test('a job-dismiss the scheduler took but never answered is reported, not repeated offline', async t => {
  const f = await fixture(t);
  f.store.save(f.job('uncertain', 'gone'));
  const dropping = serveControl(f.c.stateDir, async () => new Promise(() => {}));
  dropping.on('request', req => req.once('end', () => req.socket.destroy()));
  await new Promise(resolve => dropping.once('listening', resolve));
  t.after(() => new Promise(resolve => { dropping.closeAllConnections(); dropping.close(resolve); }));
  const lost = await f.cli('uncertain');
  assert.equal(lost.code, 1);
  assert.match(lost.out, /"uncertain":true/);
  assert.equal(f.store.job('uncertain')!.state, 'running');
});

test('job-dismiss --reset-ticket returns the ticket before dismissing and retries safely', async t => {
  const f = await fixture(t);
  f.store.save(f.job('deleted', 'gone', 'task-1'));
  f.refuse(true);
  const refused = await f.handle('deleted', true);
  assert.equal(refused.code, 1);
  assert.match(refused.data.message, /claim_conflict/);
  assert.equal(f.store.job('deleted')!.state, 'running', 'a failed reset keeps the run and its claim for retry');
  assert.throws(() => f.store.save({ ...f.job('next', 'next'), taskId: 'task-1' }), /UNIQUE/);

  // The tracker accepts the reset but the local save fails; the retry finds the ticket ready and only dismisses.
  f.refuse(false);
  const save = Store.prototype.save; let failed = false;
  t.mock.method(f.store, 'save', function (this: Store, job: Job) { if (job.state === 'dismissed' && !failed) { failed = true; throw new Error('disk full'); } return save.call(this, job); });
  assert.equal((await f.handle('deleted', true)).code, 1);
  assert.equal(f.ticket.status, 'todo');
  const retried = await f.handle('deleted', true);
  assert.equal(retried.code, 0, JSON.stringify(retried.data));
  assert.equal(f.store.job('deleted')!.state, 'dismissed');
  const recovers = f.writes.filter(w => w.path.endsWith('/claim/recover'));
  assert.equal(recovers.length, 2, 'one refused and one applied recovery; the retry writes nothing');
  assert.deepEqual({ ...recovers[1].body, reason: undefined, requestId: undefined }, { claimId: '11111111-1111-4111-8111-111111111111', confirmedStopped: true, reschedule: true, expectedVersion: 5, reason: undefined, requestId: undefined });
});

test('job-dismiss --reset-ticket refuses another status, an older claim or a live claim, and moves an unclaimed ticket directly', async t => {
  const f = await fixture(t);
  f.store.save(f.job('deleted', 'gone', 'task-1'));
  f.ticket.status = 'in_review';
  assert.match((await f.handle('deleted', true)).data.message, /in_review/);
  f.ticket.status = 'in_progress'; f.ticket.claim!.createdAt = '2025-12-31T00:00:00Z';
  assert.match((await f.handle('deleted', true)).data.message, /predates this run/);
  f.ticket.claim!.createdAt = '2026-01-01T00:01:00Z'; f.ticket.claim!.expiresAt = '2999-01-01T00:00:00Z';
  assert.match((await f.handle('deleted', true)).data.message, /may not be this run/, 'a live claim may be a newer worker\'s');
  assert.equal(f.writes.length, 0);
  assert.equal(f.store.job('deleted')!.state, 'running');

  f.ticket.claim = null; f.ticket.claimRequired = false;
  assert.equal((await f.handle('deleted', true)).code, 0);
  assert.deepEqual(f.writes.map(w => [w.method, w.body.changes]), [['PATCH', { status: 'todo' }]]);
  assert.equal(f.store.job('deleted')!.state, 'dismissed');
});

// History deltas select by change time, so a dismissal's time is taken when it is saved, after the workspace's head is read.
test('a dismissal is stamped after the workspace read it waits on, so a history cursor cannot pass it', async t => {
  const f = await fixture(t), bin = mkdtempSync(join(tmpdir(), 'factory-git-')), started = join(bin, 'started'), release = join(bin, 'release');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch "${started}"\nwhile [ ! -e "${release}" ]; do sleep 0.01; done\necho 0123456789abcdef\n`, { mode: 0o755 });
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); });
  f.store.save({ ...f.job('deleted', 'gone'), thread: { worktreePath: bin, branch: 'feat/FIX-1' } } as Job);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-02-01T00:00:00Z') });
  const result = f.handle('deleted');
  const until = async (ok: () => boolean) => { for (let i = 0; !ok(); i++) { if (i > 500) throw new Error('git was not called'); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 10)); } };
  await until(() => existsSync(started));
  t.mock.timers.setTime(Date.parse('2026-02-01T00:05:00Z'));
  writeFileSync(release, '');
  assert.equal((await result).code, 0);
  const dismissed = f.store.job('deleted')!;
  assert.equal(dismissed.dismissedHead, '0123456789abcdef');
  assert.equal(dismissed.dismissedAt, '2026-02-01T00:05:00.000Z', 'the dismissal time is taken when it is saved');
});
