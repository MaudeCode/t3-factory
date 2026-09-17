import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "openid-client";
import { createOidc, oidcSchema } from "../src/oidc.ts";
import { createFactoryWeb, webSettings, webConfigSchema } from "../src/web.ts";

test("SSO validates the OIDC flow and enforces group membership on every control endpoint", async () => {
  const issuer = "https://id.example.test",
    origin = "https://factory.example.test";
  const config = new client.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
    },
    "factory",
    "secret",
  );
  client.enableNonRepudiationChecks(config);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  let groups: unknown = ["factory-admins"],
    flow: URL,
    time = Date.now(),
    refreshed = 0;
  let invalidClaim: "nonce" | "aud" | "iss" | "signature" | "sub" | undefined;
  let userInfoAvailable = true,
    refreshAvailable = true,
    refreshRevoked = false;
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  config[client.customFetch] = async (url, options) => {
    if (String(url).endsWith("/jwks")) return response({ keys: [jwk] });
    if (String(url).endsWith("/userinfo")) {
      if (!userInfoAvailable) return new Response(null, { status: 503 });
      return response({
        sub: invalidClaim === "sub" ? "other-user" : "user",
        groups,
      });
    }
    assert.equal(String(url), `${issuer}/token`);
    const body = new URLSearchParams(options?.body as string);
    if (body.get("grant_type") === "refresh_token") {
      if (!refreshAvailable) return new Response(null, { status: 503 });
      if (refreshRevoked)
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      refreshed++;
      return response({
        access_token: "refreshed",
        refresh_token: "next-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    assert.equal(body.get("redirect_uri"), `${origin}/auth/callback`);
    assert.equal(
      await client.calculatePKCECodeChallenge(body.get("code_verifier")!),
      flow.searchParams.get("code_challenge"),
    );
    const claims = {
      iss: issuer,
      sub: "user",
      aud: "factory",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: flow.searchParams.get("nonce"),
    };
    if (invalidClaim && ["nonce", "aud", "iss"].includes(invalidClaim))
      (claims as any)[invalidClaim] = "incorrect";
    const encode = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const payload = `${encode({ alg: "RS256", kid: "test" })}.${encode(claims)}`;
    const signature = sign("RSA-SHA256", Buffer.from(payload), keys.privateKey);
    if (invalidClaim === "signature") signature[0] ^= 1;
    return response({
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: `${payload}.${signature.toString("base64url")}`,
    });
  };
  const dir = mkdtempSync(join(tmpdir(), "factory-oidc-"));
  const sessionFile = join(dir, "web-sessions.json");
  const settings = oidcSchema.parse({
    issuer,
    clientId: "factory",
    clientSecret: "secret",
    requiredGroup: "factory-admins",
  });
  const auth = await createOidc(
    settings,
    `${origin}/`,
    config,
    () => time,
    sessionFile,
  );
  const restart = async (next = settings) =>
    Object.assign(
      auth,
      await createOidc(next, origin, config, () => time, sessionFile),
    );
  let commands = 0;
  const server = createFactoryWeb({
    config: webConfigSchema.parse({ publicOrigin: origin }),
    secret: "old-pair-key",
    oidc: auth,
    dataDir: dir,
    readState: () => ({ ok: true }),
    run: async () => {
      commands++;
      return { code: 0, data: {} };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const req = (
    path: string,
    method = "GET",
    cookie = "",
    extra: Record<string, string> = {},
  ) =>
    new Promise<{
      status: number;
      headers: IncomingMessage["headers"];
      data: string;
    }>((resolve, reject) => {
      const r = request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method,
          headers: {
            Host: new URL(origin).host,
            Origin: origin,
            Cookie: cookie,
            "Content-Type": "application/json",
            ...extra,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers, data }),
          );
        },
      );
      r.on("error", reject);
      r.end(method === "POST" ? "{}" : undefined);
    });
  const login = async () => {
    const start = await req("/auth/login");
    assert.equal(start.status, 302);
    flow = new URL(start.headers.location!);
    assert.equal(flow.searchParams.get("code_challenge_method"), "S256");
    assert.ok(flow.searchParams.get("nonce"));
    assert.ok(flow.searchParams.get("state"));
    return {
      transaction: start.headers["set-cookie"]![0].split(";")[0],
      callback: `/auth/callback?code=code&state=${flow.searchParams.get("state")}`,
    };
  };
  const signIn = async () => {
    const f = await login();
    return req(f.callback, "GET", f.transaction);
  };
  try {
    assert.equal(JSON.parse((await req("/api/auth")).data).mode, "oidc");
    for (const [path, method] of [
      ["/api/state", "GET"],
      ["/api/models", "GET"],
      ["/api/config", "POST"],
      ["/api/enabled", "POST"],
      ["/api/dispatch", "POST"],
      ["/api/operations/abc", "GET"],
    ])
      assert.equal(
        (await req(path, method, "factory_session=old.pair.cookie")).status,
        401,
      );
    assert.equal(
      (
        await req("/api/pair", "POST", "", {
          Authorization: "Bearer old-pair-key",
        })
      ).status,
      403,
    );
    assert.equal((await req("/api/session", "POST")).status, 403);
    const wrongState = await login();
    assert.equal(
      (
        await req(
          wrongState.callback.replace(/state=.*/, "state=wrong"),
          "GET",
          wrongState.transaction,
        )
      ).headers.location,
      "/?auth_error=denied",
    );
    assert.equal(
      (await req(wrongState.callback, "GET", wrongState.transaction)).headers
        .location,
      "/?auth_error=denied",
    );
    const missingCookie = await login();
    assert.equal(
      (await req(missingCookie.callback)).headers.location,
      "/?auth_error=denied",
    );
    const expired = await login();
    time += 601_000;
    assert.equal(
      (await req(expired.callback, "GET", expired.transaction)).headers
        .location,
      "/?auth_error=denied",
    );
    for (invalidClaim of ["nonce", "aud", "iss", "signature", "sub"] as const)
      assert.equal(
        (await signIn()).headers.location,
        "/?auth_error=denied",
        invalidClaim,
      );
    invalidClaim = undefined;
    for (groups of [undefined, "factory-admins", [], ["factory-admins-extra"]])
      assert.equal((await signIn()).headers.location, "/?auth_error=denied");
    groups = ["factory-admins"];
    const success = await signIn();
    assert.equal(success.headers.location, "/");
    const sessionHeader = success.headers["set-cookie"]!.find((v) =>
      v.startsWith("__Host-factory_session="),
    )!;
    assert.match(sessionHeader, /HttpOnly; Secure; SameSite=Lax; Path=\//);
    assert.match(sessionHeader, /Max-Age=2592000/);
    assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
    const session = sessionHeader.split(";")[0];
    await restart();
    assert.equal((await req("/api/state", "GET", session)).status, 200);
    assert.equal(
      (
        await req("/api/enabled", "POST", session, {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    time += 3_600_000;
    assert.equal((await req("/api/state", "GET", session)).status, 200);
    assert.equal(refreshed, 1);
    assert.equal(
      JSON.parse(readFileSync(sessionFile, "utf8")).sessions[0][1].refresh,
      "next-refresh",
    );
    await restart();
    assert.equal((await req("/api/state", "GET", session)).status, 200);
    groups = [];
    time += 60_000;
    assert.equal((await req("/api/state", "GET", session)).status, 401);
    await restart();
    assert.equal((await req("/api/state", "GET", session)).status, 401);
    groups = ["factory-admins"];
    const s2 = (await signIn()).headers["set-cookie"]!.find((v) =>
      v.startsWith("__Host-factory_session="),
    )!.split(";")[0];
    userInfoAvailable = false;
    time += 60_000;
    assert.equal((await req("/api/state", "GET", s2)).status, 503);
    await restart();
    assert.equal((await req("/api/state", "GET", s2)).status, 503);
    userInfoAvailable = true;
    assert.equal((await req("/api/state", "GET", s2)).status, 200);
    refreshAvailable = false;
    time += 3_600_000;
    assert.equal((await req("/api/state", "GET", s2)).status, 503);
    refreshAvailable = true;
    assert.equal((await req("/api/state", "GET", s2)).status, 200);
    refreshRevoked = true;
    time += 3_600_000;
    assert.equal((await req("/api/state", "GET", s2)).status, 401);
    await restart();
    assert.equal((await req("/api/state", "GET", s2)).status, 401);
    refreshRevoked = false;
    const s3 = (await signIn()).headers["set-cookie"]!.find((v) =>
      v.startsWith("__Host-factory_session="),
    )!.split(";")[0];
    assert.equal((await req("/api/session", "DELETE", s3)).status, 200);
    await restart();
    assert.equal((await req("/api/state", "GET", s3)).status, 401);
    const s4 = (await signIn()).headers["set-cookie"]!.find((v) =>
      v.startsWith("__Host-factory_session="),
    )!.split(";")[0];
    time += 30 * 86_400_000;
    assert.equal((await req("/api/state", "GET", s4)).status, 401);
    const revokedOnRestart = (await signIn()).headers["set-cookie"]!.find(v => v.startsWith("__Host-factory_session="))!.split(";")[0];
    groups = [];
    await restart();
    assert.equal((await req("/api/state", "GET", revokedOnRestart)).status, 401, "restored sessions must recheck membership immediately");
    groups = ["factory-admins"];
    const s5 = (await signIn()).headers["set-cookie"]!.find((v) =>
      v.startsWith("__Host-factory_session="),
    )!.split(";")[0];
    await restart({ ...settings, requiredGroup: "other-group" });
    assert.equal((await req("/api/state", "GET", s5)).status, 401);
    await restart();
    assert.equal(
      (await req("/api/state", "GET", s5)).status,
      401,
      "restoring settings must not resurrect invalidated sessions",
    );
    writeFileSync(sessionFile, "invalid json");
    await assert.rejects(restart(), /Stored SSO sessions are invalid/);
    assert.equal(commands, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth configuration is explicit and fails closed without leaking deployment values", () => {
  assert.throws(() => webSettings({}));
  assert.throws(() => webSettings({ FACTORY_AUTH_MODE: "oidc" }));
  assert.throws(() => webSettings({ FACTORY_AUTH_MODE: "pairing" }));
  assert.equal(
    webSettings({
      FACTORY_AUTH_MODE: "pairing",
      FACTORY_WEB_SESSION_SECRET: "a".repeat(32),
    }).oidc,
    undefined,
  );
});
