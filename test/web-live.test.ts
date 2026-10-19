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

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
async function pairSession(url: string, secret: string) {
  const headers = { Origin: url, "Content-Type": "application/json" };
  const pair = await (await fetch(`${url}/api/pair`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${secret}` } })).json();
  const code = new URLSearchParams(new URL(pair.url).hash.slice(1)).get("pair");
  const signed = await fetch(`${url}/api/session`, { method: "POST", headers, body: JSON.stringify({ code }) });
  return { ...headers, Cookie: signed.headers.get("set-cookie")!.split(";")[0] };
}

// A real CLI process covers main.ts composition, which injected createFactoryWeb callbacks bypass.
test("the web CLI exposes filterable snapshot metadata through state, history and reports", { timeout: 10000 }, async t => {
  const f = dispatchFixture(t), port = await freePort(), secret = "c".repeat(64), url = `http://127.0.0.1:${port}`;
  const job = { id: "metadata", kind: "ticket" as const, projectId: "FIX", taskId: "root", ticketKey: "FIX-1", threadId: "thread", messageId: "message", createdAt: new Date().toISOString(), state: "running" as const, reason: "Fixture", lastPersonalActivity: null, reportPath: join(f.dir, "report.json"), command: null, prUrls: [], completedAt: null, labels: ["bug", "web"], priority: "urgent", difficulty: "med" as const };
  f.store.save(job);
  writeFileSync(join(f.c.stateDir, "status.json"), JSON.stringify({ jobs: [job] }));
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
test("state is pushed over the event stream whenever the factory writes, and runs expose history, reports, and stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-web-live-"));
  const secret = "b".repeat(64);
  const port = await freePort();
  let version = 0;
  let notify: () => void = () => {};
  const stopped: string[] = [];
  const server = createFactoryWeb({
    config: webConfigSchema.parse({ publicOrigin: `http://127.0.0.1:${port}`, host: "127.0.0.1", port }),
    secret,
    dataDir: dir,
    readState: () => ({ config: { enabled: true }, status: { jobs: [], journal: [{ id: 1, text: "hello" }] }, now: new Date().toISOString(), version }),
    history: () => [{ id: "a1", state: "complete" }],
    report: (id) => (id === "a1" ? { job: { id }, events: [], report: { status: "complete", reason: "done" } } : undefined),
    watch: (fn) => { notify = fn; return () => {}; },
    run: async (args) => { stopped.push(args.join(" ")); return { code: 0, data: args[0] === "sources" ? { t3: [], kaneo: { projects: [], columns: {}, labels: [] } } : { ok: true } }; },
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  try {
    const auth = await pairSession(url, secret);

    assert.equal((await fetch(`${url}/api/events`)).status, 401, "the stream needs a session");
    const stream = await fetch(`${url}/api/events`, { headers: auth });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    const first = await read();
    assert.match(first, /^event: state\ndata: \{"config"/, "the first message carries the current state");
    assert.match(first, /"journal":\[\{"id":1/);
    version = 2;
    notify(); // the factory wrote status.json
    const second = await read();
    assert.match(second, /"version":2/, "a write pushes fresh state without a request");
    await reader.cancel();

    assert.deepEqual(await (await fetch(`${url}/api/history`, { headers: auth })).json(), [{ id: "a1", state: "complete" }]);
    assert.equal((await (await fetch(`${url}/api/jobs/a1/report`, { headers: auth })).json()).report.reason, "done");
    assert.equal((await fetch(`${url}/api/jobs/missing/report`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${url}/api/jobs/a1/stop`, { method: "POST", headers: auth })).status, 200);
    assert.deepEqual((await (await fetch(`${url}/api/sources`, { headers: auth })).json()).kaneo.labels, []);
    assert.deepEqual(stopped, ["job-stop a1", "sources"], "stop and the catalogs go through the CLI");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
