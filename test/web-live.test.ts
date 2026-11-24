import { createServer as createHttpServer } from "node:http";
import { serveControl } from "../src/control.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createFactoryWeb, webConfigSchema } from "../src/web.ts";
import { dispatchFixture } from "./dispatch-fixture.ts";
import { matchesRunFilters } from "../web/lib/format.js";
import { randomUUID } from 'node:crypto';
import { saveOperation, type Operation } from '../src/operations.ts';
import { Store } from "../src/store.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
async function pairSession(url: string, secret: string) {
  const headers = { Origin: url, "Content-Type": "application/json" };
  const pair = await (await fetch(`${url}/api/pair`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${secret}` } })).json();
  const code = new URLSearchParams(new URL(pair.url).hash.slice(1)).get("pair");
  const signed = await fetch(`${url}/api/session`, { method: "POST", headers, body: JSON.stringify({ code }) });
  return { ...headers, Cookie: signed.headers.get("set-cookie")!.split(";")[0] };
}

test('web restart preserves scheduler-owned queued, checking, expired and uncertain operations without replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-operation-reload-')), secret = 'f'.repeat(64), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const input = { ticket: 'APP-1', model: 'auto', overrideLimits: true };
  const operations: Operation[] = ['queued', 'checking', 'expired', 'uncertain'].map(phase => ({ id: randomUUID(), input, command: { manual: true, ticket: 'APP-1' }, createdAt: new Date().toISOString(),
    state: phase === 'expired' ? 'done' : phase === 'uncertain' ? 'uncertain' : 'running',
    progress: { phase: phase === 'queued' ? 'queued' : phase === 'checking' ? 'checking' : 'launching', stage: 'kanvil.ticket', acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    ...phase === 'expired' ? { result: { code: 1, data: { reason: 'manual-deadline-exceeded', notLaunched: true } } } : phase === 'uncertain' ? { result: { code: 1, data: { uncertain: true, jobId: 'existing-job', threadId: 'existing-thread' } } } : {},
  }));
  operations.forEach(operation => saveOperation(dir, operation));
  let sends = 0;
  const server = createFactoryWeb({ config: webConfigSchema.parse({ publicOrigin: url }), secret, dataDir: dir, readState: () => ({}), run: async args => {
    sends++;
    const id = args[args.indexOf('--request-id') + 1];
    saveOperation(dir, { ...operations[1], id });
    return { code: 1, data: { uncertain: true, message: 'The scheduler stopped answering after taking the request.' } };
  } });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    const headers = await pairSession(url, secret);
    for (const operation of operations) {
      assert.deepEqual(await (await fetch(`${url}/api/operations/${operation.id}`, { headers })).json(), operation);
      assert.deepEqual(await (await fetch(`${url}/api/dispatch`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': operation.id }, body: JSON.stringify(input) })).json(), operation);
    }
    assert.equal(sends, 0, 'reload and duplicate submissions only read existing outcomes');
    const confirmed = { ...operations[3], state: 'done' as const, result: { code: 0, data: { reason: 'dispatched', jobId: 'existing-job', threadId: 'existing-thread' } } };
    saveOperation(dir, confirmed);
    assert.deepEqual(await (await fetch(`${url}/api/operations/${confirmed.id}`, { headers })).json(), confirmed, 'reconciliation becomes visible without another dispatch');
    const lostId = randomUUID();
    await fetch(`${url}/api/dispatch`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': lostId }, body: JSON.stringify(input) });
    const lost = await (await fetch(`${url}/api/operations/${lostId}`, { headers })).json();
    assert.equal(lost.state, 'uncertain', 'a lost accepted control response must not leave an indefinite spinner');
    assert.equal(lost.result.data.uncertain, true); assert.equal(lost.progress.stage, 'kanvil.ticket');
    assert.equal(sends, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

// A real CLI process covers main.ts composition, which injected createFactoryWeb callbacks bypass.
test("the web CLI exposes filterable snapshot metadata through state, history and reports", { timeout: 10000 }, async t => {
  const f = dispatchFixture(t), port = await freePort(), secret = "c".repeat(64), url = `http://127.0.0.1:${port}`;
  const job = { id: "metadata", kind: "ticket" as const, projectId: "FIX", taskId: "root", ticketKey: "FIX-1", threadId: "thread", messageId: "message", createdAt: new Date().toISOString(), state: "running" as const, reason: "Fixture", lastPersonalActivity: null, reportPath: join(f.dir, "report.json"), command: null, prUrls: [], completedAt: null, labels: ["bug", "web"], priority: "urgent", difficulty: "med" as const };
  f.store.save(job);
  const archived = { ...job, id: 'archived-run', historyOnly: true, state: 'waiting', createdAt: '2025-01-01T00:00:00Z', ticketKey: 'FIX-OLD' };
  f.store.db.exec('CREATE TABLE IF NOT EXISTS job_history(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  f.store.db.prepare('INSERT INTO job_history VALUES(?,?)').run(archived.id, JSON.stringify(archived));
  // Change times either side of the cursor: a live run settled after it completed, and an archived run that completed later than it started.
  f.store.save({ ...job, id: 'settled', taskId: 'settled-task', state: 'dismissed', createdAt: '2025-02-01T00:00:00.000Z', completedAt: '2025-02-02T00:00:00.000Z', dismissedAt: '2025-03-01T00:00:00.000Z' });
  f.store.save({ ...job, id: 'finished', taskId: 'finished-task', state: 'complete', createdAt: '2025-01-20T00:00:00.000Z', completedAt: '2025-02-03T00:00:00.000Z' });
  const archivedLate = { ...archived, id: 'archived-late', state: 'complete', createdAt: '2025-01-02T00:00:00Z', completedAt: '2025-02-10T00:00:00Z' };
  f.store.db.prepare('INSERT INTO job_history VALUES(?,?)').run(archivedLate.id, JSON.stringify(archivedLate));
  const envFile = join(f.dir, ".env"); writeFileSync(envFile, "");
  const child = spawn(process.execPath, [new URL("../src/main.ts", import.meta.url).pathname, "web"], { env: { ...process.env, T3_FACTORY_ENV: envFile, FACTORY_AUTH_MODE: "pairing", FACTORY_WEB_HOST: "127.0.0.1", FACTORY_WEB_PORT: String(port), FACTORY_PUBLIC_ORIGIN: url, FACTORY_WEB_SESSION_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", chunk => { if (String(chunk).includes("Factory web controls listening")) resolve(); });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Web CLI exited ${code}: ${errors}`)));
    });
    const headers = await pairSession(url, secret);
    const state = await (await fetch(`${url}/api/state`, { headers })).json();
    const history = await (await fetch(`${url}/api/history`, { headers })).json();
    const report = await (await fetch(`${url}/api/jobs/metadata/report`, { headers })).json();
    assert.equal(history.length, 5, 'the actual Runs API must retain the archived backend history');
    const since = async (after: string) => fetch(`${url}/api/history?after=${encodeURIComponent(after)}`, { headers });
    const delta = await (await since('2025-02-05T00:00:00Z')).json();
    assert.deepEqual(delta.jobs?.map((row: any) => row.id).sort(), ['archived-late', 'metadata', 'settled'], 'only jobs whose latest change is after the cursor, from both tables');
    assert.equal(delta.cursor, job.createdAt, 'the newest change the delta covers');
    assert.deepEqual(delta.jobs.find((row: any) => row.id === 'settled'), history.find((row: any) => row.id === 'settled'), 'delta rows have the full read\'s fields');
    assert.deepEqual(await (await since(job.createdAt)).json(), { jobs: [], cursor: job.createdAt }, 'nothing changed after the newest change');
    assert.equal((await since('yesterday')).status, 400);
    assert.equal(history.find((row: any) => row.id === archived.id)?.historyOnly, true);
    const archivedReport = await (await fetch(`${url}/api/jobs/${archived.id}/report`, { headers })).json();
    assert.equal(archivedReport.job.historyOnly, true, 'historical report routes remain readable and read-only');
    for (const row of [state.status.jobs[0], history[0], report.job]) {
      assert.equal(matchesRunFilters(row, { tags: ["bug", "web"], tagMode: "and", priorities: ["urgent"] }), true, "actual API runs must match tag and priority filters");
      assert.deepEqual(row.labels, job.labels);
      assert.equal(row.priority, job.priority);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
});

// The web app's live data paths: the event stream, run history, run reports, and stop requests.
test("state is pushed over the event stream whenever the factory writes, and runs expose history, reports, and stop", async t => {
  const dir = mkdtempSync(join(tmpdir(), "factory-web-live-"));
  const secret = "b".repeat(64);
  const port = await freePort();
  let version = 0;
  let jobs: { id: string }[] = [];
  const stopped: string[] = [];
  // The web process's own Store connection, and the scheduler's.
  const store = new Store(dir), scheduler = new Store(dir), checks = t.mock.method(store, "dataVersion");
  t.after(() => { store.close(); scheduler.close(); });
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const unwatched = Promise.withResolvers<void>(), reclosed = Promise.withResolvers<void>();
  let closes = 0;
  const server = createFactoryWeb({
    config: webConfigSchema.parse({ publicOrigin: `http://127.0.0.1:${port}`, host: "127.0.0.1", port }),
    secret,
    dataDir: dir,
    readState: () => ({ config: { enabled: true }, status: { jobs, journal: [{ id: 1, text: "hello" }] }, now: new Date().toISOString(), version }),
    history: () => [{ id: "a1", state: "complete" }],
    report: (id) => (id === "a1" ? { job: { id }, events: [], report: { status: "complete", reason: "done" } } : undefined),
    watch: (fn) => { const stop = store.watch(fn); return () => { stop(); (++closes === 1 ? unwatched : reclosed).resolve(); }; },
    run: async (args) => { stopped.push(args.join(" ")); return { code: 0, data: args[0] === "sources" ? { t3: [], kanvil: { projects: [], columns: {}, labels: [] } } : { ok: true } }; },
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  try {
    const auth = await pairSession(url, secret);

    assert.equal((await fetch(`${url}/api/events`)).status, 401, "the stream needs a session");
    scheduler.set("idle-write", "1");
    t.mock.timers.tick(5000);
    assert.equal(checks.mock.callCount(), 0, "nothing polls the Store while no page is subscribed");
    const stream = await fetch(`${url}/api/events`, { headers: auth });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const read = async () => {
      while (!buffered.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'the stream should stay open for a complete frame');
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffered.indexOf("\n\n"), frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      return frame;
    };
    const first = await read();
    assert.match(first, /^event: state\ndata: \{"config"/, "the first message carries the current state");
    assert.match(first, /"journal":\[\{"id":1/);
    scheduler.set("irrelevant", "written");
    t.mock.timers.tick(1000);
    t.mock.timers.tick(150);
    jobs = [{ id: "running" }];
    scheduler.set("fixture", "written"); // the scheduler writes through its own connection
    t.mock.timers.tick(1000);
    t.mock.timers.tick(150);
    const second = await read();
    await reader.cancel();
    await unwatched.promise;
    const { now, ...delta } = JSON.parse(second.split("data: ")[1]);
    assert.ok(Number.isFinite(Date.parse(now)));
    assert.deepEqual(delta, { delta: true, status: { jobs } });
    const reconnected = await fetch(`${url}/api/events`, { headers: auth });
    const nextReader = reconnected.body!.getReader();
    const snapshot = new TextDecoder().decode((await nextReader.read()).value);
    await nextReader.cancel();
    assert.deepEqual(JSON.parse(snapshot.split("data: ")[1]).status, { jobs, journal: [{ id: 1, text: "hello" }] });
    await reclosed.promise; // the last page closing stops the watch
    const after = checks.mock.callCount();
    t.mock.timers.tick(5000);
    assert.equal(checks.mock.callCount(), after, "nothing polls after the last page closes");

    assert.deepEqual(await (await fetch(`${url}/api/history`, { headers: auth })).json(), [{ id: "a1", state: "complete" }]);
    assert.equal((await (await fetch(`${url}/api/jobs/a1/report`, { headers: auth })).json()).report.reason, "done");
    assert.equal((await fetch(`${url}/api/jobs/missing/report`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${url}/api/jobs/a1/stop`, { method: "POST", headers: auth })).status, 200);
    assert.equal((await fetch(`${url}/api/session-tickets/task-1/dismiss`, { method: "POST", headers: auth })).status, 200);
    assert.equal((await fetch(`${url}/api/session-tickets/task-1/dismiss`, { headers: auth })).status, 404, "dismissal is a POST");
    assert.deepEqual((await (await fetch(`${url}/api/sources`, { headers: auth })).json()).kanvil.labels, []);
    assert.deepEqual(stopped, ["job-stop a1", "session-dismiss task-1", "sources"], "stop, dismissal and the catalogs go through the CLI");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Epic CLI reads directly even while an older scheduler socket is running", { timeout: 10000 }, async t => {
  const f = dispatchFixture(t), controls: unknown[] = [], reads: string[] = [];
  const control = serveControl(f.c.stateDir, async command => { controls.push(command); return { code: 1, data: { message: "Unsupported old scheduler command" } }; });
  await new Promise<void>(resolve => control.once("listening", resolve));
  const tracker = createHttpServer((req, res) => {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    reads.push(path);
    const epicPath = `/api/v1/workspaces/${f.c.kanvil.workspaceId}/epics/e1`;
    res.writeHead(path === epicPath || path === `${epicPath}/comments` ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(path === epicPath ? { id: "e1", workspaceId: f.c.kanvil.workspaceId, title: "CLI Epic", description: "Upgrade-safe read", archived: false } : path === `${epicPath}/comments` ? { items: [], total: 0 } : { error: { code: "not_found" } }));
  });
  await new Promise<void>(resolve => tracker.listen(0, "127.0.0.1", resolve));
  const address = tracker.address(); assert(address && typeof address === "object");
  f.c.kanvil.url = `http://127.0.0.1:${address.port}`;
  const configFile = join(f.dir, "epic-config.jsonc"), envFile = join(f.dir, "epic.env");
  writeFileSync(configFile, JSON.stringify(f.c)); writeFileSync(envFile, "");
  const child = spawn(process.execPath, [new URL("../src/main.ts", import.meta.url).pathname, "epic", "e1"], { env: { ...process.env, T3_FACTORY_CONFIG: configFile, T3_FACTORY_ENV: envFile, KANVIL_API_KEY: "fixture-secret" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, errors || output);
    const detail = JSON.parse(output);
    assert.equal(detail.title, "CLI Epic"); assert.equal(detail.status, "todo"); assert.deepEqual(detail.comments, []);
    assert.deepEqual(controls, [], "a read never sends an unknown command to an older scheduler");
    assert.equal(reads.length, 2, "the CLI uses the direct record and discussion reads");
  } finally { child.kill(); await new Promise<void>(resolve => tracker.close(() => resolve())); await new Promise<void>(resolve => control.close(() => resolve())); }
});

// Epics, Up next and session-ticket rows go only to a page that asked for them; the rest of the status always goes.
test("each stream carries only the heavy sections it asked for, from one shared publish", async t => {
  const dir = mkdtempSync(join(tmpdir(), "factory-web-sections-")), secret = "d".repeat(64), port = await freePort(), url = `http://127.0.0.1:${port}`;
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let status: Record<string, unknown> = { jobs: [], epics: [{ id: "e1" }], upNext: { tickets: [{ id: "t1" }], held: [] }, sessionTickets: { at: "a1", error: null, rows: [{ taskId: "s1" }] } };
  let wake = () => {};
  const server = createFactoryWeb({ config: webConfigSchema.parse({ publicOrigin: url, host: "127.0.0.1", port }), secret, dataDir: dir,
    readState: () => ({ config: { enabled: true }, status, now: new Date().toISOString(), version: "v1" }), watch: fn => { wake = fn; return () => {}; } });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  try {
    const auth = await pairSession(url, secret);
    const open = async (query: string) => {
      const reader = (await fetch(`${url}/api/events${query}`, { headers: auth })).body!.getReader(), decoder = new TextDecoder();
      let buffered = "";
      return async () => {
        while (!buffered.includes("\n\n")) buffered += decoder.decode((await reader.read()).value, { stream: true });
        const end = buffered.indexOf("\n\n"), { now, ...data } = JSON.parse(buffered.slice(0, end).split("data: ")[1]);
        buffered = buffered.slice(end + 2);
        return data;
      };
    };
    const publish = (next: Record<string, unknown>) => { status = { ...status, ...next }; wake(); t.mock.timers.tick(150); };
    const base = await open(""), all = await open("?with=epics,upNext,sessionTickets"), queue = await open("?with=upNext");
    const light = (total: number) => ({ at: "a1", error: null, total });
    assert.deepEqual(await base(), { config: { enabled: true }, status: { jobs: [], sessionTickets: light(1) }, version: "v1" });
    assert.deepEqual(await all(), { config: { enabled: true }, status, version: "v1" }, "a page that asks for every section gets today's first event");
    assert.deepEqual((await queue()).status, { jobs: [], upNext: status.upNext, sessionTickets: light(1) });

    publish({ epics: [{ id: "e2" }], upNext: { tickets: [], held: [] }, sessionTickets: { at: "a1", error: null, rows: [{ taskId: "s1" }, { taskId: "s2" }] } });
    assert.deepEqual(await base(), { delta: true, status: { sessionTickets: light(2) } });
    assert.deepEqual(await all(), { delta: true, status: { epics: status.epics, upNext: status.upNext, sessionTickets: status.sessionTickets } });
    assert.deepEqual(await queue(), { delta: true, status: { upNext: status.upNext, sessionTickets: light(2) } });

    // Rows that change without changing the count, and an Epic change, reach only the page that holds them.
    publish({ epics: [{ id: "e3" }], sessionTickets: { at: "a1", error: null, rows: [{ taskId: "s1" }, { taskId: "s3" }] } });
    assert.deepEqual(await all(), { delta: true, status: { epics: status.epics, sessionTickets: status.sessionTickets } });
    publish({ jobs: [{ id: "j1" }] });
    assert.deepEqual(await base(), { delta: true, status: { jobs: [{ id: "j1" }] } }, "the base page received nothing from the Epic-only publish");
    assert.deepEqual(await queue(), { delta: true, status: { jobs: [{ id: "j1" }] } });

    const read = (query: string) => fetch(`${url}/api/state${query}`, { headers: auth });
    assert.deepEqual((await (await read("?fields=upNext")).json()).status, { upNext: status.upNext });
    assert.equal((await read("?fields=jobs")).status, 400, "only on-demand sections can be named");
    assert.equal((await fetch(`${url}/api/events?with=bogus`, { headers: auth })).status, 400);
    assert.deepEqual((await (await read("?with=epics")).json()).status, { jobs: [{ id: "j1" }], epics: status.epics, sessionTickets: light(2) });
    assert.deepEqual((await (await read("")).json()).status, status, "no fields returns everything as before");
  } finally { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); }
});
