import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createFactoryWeb, webConfigSchema } from "../src/web.ts";

test("web controls require pairing, reject cross-origin requests and deduplicate dispatches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-web-"));
  const secret = "a".repeat(64),
    config = webConfigSchema.parse({
      publicOrigin: "https://factory.example.test",
      host: "192.168.10.25",
    });
  const calls: { args: string[]; input: unknown }[] = [];
  let finish: (value: any) => void = () => {};
  const server = createFactoryWeb({
    config,
    secret,
    dataDir: dir,
    readState: () => ({ config: { enabled: false }, status: { jobs: [] } }),
    run: async (args, input) => {
      calls.push({ args, input });
      if (args[0] === "dispatch")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return { code: 0, data: { ok: true } };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const headers = {
    Host: "factory.example.test",
    Origin: "https://factory.example.test",
    "Content-Type": "application/json",
  };
  const request = (path: string, options: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        url + path,
        {
          method: options.method ?? "GET",
          headers: {
            ...headers,
            ...(options.headers as Record<string, string>),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: Object.fromEntries(
                  Object.entries(res.headers)
                    .filter(([, value]) => value !== undefined)
                    .map(([key, value]) => [
                      key,
                      Array.isArray(value) ? value.join(",") : String(value),
                    ]),
                ),
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body as string | undefined);
    });
  try {
    assert.equal((await request("/api/state")).status, 401);
    assert.equal((await request("/api/pair", { method: "POST" })).status, 401);
    assert.equal(
      (await request("/api/state", { headers: { Host: "attacker.example" } }))
        .status,
      403,
    );
    const pair = await (
      await request("/api/pair", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      })
    ).json();
    const code = new URLSearchParams(new URL(pair.url).hash.slice(1)).get(
      "pair",
    );
    const signed = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    assert.equal(signed.status, 200);
    const setCookie = signed.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(";")[0];
    assert.equal(
      (
        await request("/api/state", {
          headers: {
            Cookie: cookie,
            Host: "192.168.10.25:3848",
            Origin: "http://192.168.10.25:3848",
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/session", {
          method: "POST",
          body: JSON.stringify({ code }),
        })
      ).status,
      401,
      "pairing is single use",
    );
    assert.equal(
      (await request("/api/state", { headers: { Cookie: cookie } })).status,
      200,
    );
    assert.equal(
      (
        await request("/api/state", {
          headers: { Cookie: cookie + "tampered" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request("/api/enabled", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://attacker.example" },
          body: '{"enabled":true}',
        })
      ).status,
      403,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await request("/api/enabled", {
          method: "POST",
          headers: { Cookie: cookie },
          body: '{"enabled":false}',
        })
      ).status,
      200,
    );
    assert.deepEqual(calls.at(-1)?.args, ["pause"]);
    assert.equal(
      (
        await request("/api/upstream/enabled", {
          method: "POST",
          headers: { Cookie: cookie },
          body: '{"enabled":true}',
        })
      ).status,
      200,
    );
    assert.deepEqual(calls.at(-1)?.args, ["upstream-resume"], "the reviews switch edits only upstream.enabled");
    const id = randomUUID(),
      input = { ticket: "app-8", model: "astra", overrideLimits: true };
    const dispatch = () =>
      request("/api/dispatch", {
        method: "POST",
        headers: { Cookie: cookie, "Idempotency-Key": id },
        body: JSON.stringify(input),
      });
    assert.equal((await dispatch()).status, 202);
    assert.equal((await dispatch()).status, 200);
    assert.equal(calls.filter((c) => c.args[0] === "dispatch").length, 1);
    assert.deepEqual(calls.at(-1)?.args, [
      "dispatch",
      "--model",
      "astra",
      "--ticket",
      "APP-8",
      "--override-limits",
    ]);
    assert.equal(
      (
        await request("/api/dispatch", {
          method: "POST",
          headers: { Cookie: cookie, "Idempotency-Key": id },
          body: JSON.stringify({ ...input, ticket: "APP-9" }),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/api/dispatch", {
          method: "POST",
          headers: { Cookie: cookie, "Idempotency-Key": randomUUID() },
          body: JSON.stringify({ model: "astra;touch /tmp/no", ticket: "" }),
        })
      ).status,
      400,
    );
    assert.equal((await request("/api/dispatch", {
      method: "POST", headers: { Cookie: cookie, "Idempotency-Key": id },
      body: JSON.stringify({ ...input, allowMissingReadyLabel: true }),
    })).status, 409, "confirmation is a new request, not an idempotency replay");
    assert.equal((await request("/api/dispatch", {
      method: "POST", headers: { Cookie: cookie, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ model: "astra", allowMissingReadyLabel: true }),
    })).status, 400, "confirmation requires a ticket");
    const finishFirst = finish, secondId = randomUUID();
    const secondInput = { ticket: "APP-9", model: "auto", overrideLimits: false };
    const second = () => request("/api/dispatch", {
      method: "POST", headers: { Cookie: cookie, "Idempotency-Key": secondId }, body: JSON.stringify(secondInput),
    });
    assert.equal((await second()).status, 202);
    assert.equal((await second()).status, 200, "each request ID deduplicates independently");
    assert.equal(calls.filter(c => c.args[0] === "dispatch").length, 2);
    finish({ code: 1, data: { reason: "quota-exhausted", ticket: "APP-9" } });
    const operation = async (requestId: string) => (await request(`/api/operations/${requestId}`, { headers: { Cookie: cookie } })).json();
    assert.equal((await operation(secondId)).result.data.ticket, "APP-9");
    assert.equal((await operation(id)).state, "running", "settling B must not overwrite A");
    finishFirst({ code: 0, data: { reason: "dispatched", ticket: "APP-8" } });
    const result = await (
      await request(`/api/operations/${id}`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(result.state, "done");
    assert.equal(result.result.data.ticket, "APP-8");
    const confirmedId = randomUUID();
    assert.equal((await request("/api/dispatch", {
      method: "POST", headers: { Cookie: cookie, "Idempotency-Key": confirmedId },
      body: JSON.stringify({ ...input, allowMissingReadyLabel: true }),
    })).status, 202);
    assert.ok(calls.at(-1)!.args.includes("--allow-missing-ready-label"));
    finish({ code: 0, data: { reason: "dispatched", ticket: "APP-8" } });
    assert.equal(
      (
        await request("/api/operations/not-a-uuid", {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web binding accepts the requested private LAN address but rejects public HTTP exposure", () => {
  assert.equal(
    webConfigSchema.parse({
      host: "192.168.10.25",
      publicOrigin: "http://192.168.10.25:3848",
    }).host,
    "192.168.10.25",
  );
  assert.throws(() => webConfigSchema.parse({ host: "0.0.0.0" }));
  assert.throws(() =>
    webConfigSchema.parse({ publicOrigin: "http://factory.example.test" }),
  );
  assert.throws(() =>
    webConfigSchema.parse({
      publicOrigin: "https://factory.example.test/path",
    }),
  );
});
