import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createFactoryWeb, webConfigSchema } from "../src/web.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });

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
  const headers = { Origin: url, "Content-Type": "application/json" };
  try {
    const pair = await (await fetch(`${url}/api/pair`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${secret}` } })).json();
    const code = new URLSearchParams(new URL(pair.url).hash.slice(1)).get("pair");
    const signed = await fetch(`${url}/api/session`, { method: "POST", headers, body: JSON.stringify({ code }) });
    const cookie = signed.headers.get("set-cookie")!.split(";")[0];
    const auth = { ...headers, Cookie: cookie };

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
