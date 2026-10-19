import test from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDnsApiKey, selectLanAddress, updateDns } from "../scripts/update-dns.ts";

const config = {
  recordUrl: "https://gateway.example.com/proxy/network/integration/v1/sites/site/dns/policies/record",
  hostname: "factory.example.com",
  apiKeyFile: "/private/api-key",
};
const original = {
  id: "record", type: "A_RECORD", enabled: true, domain: config.hostname,
  ipv4Address: "10.20.0.8", ttlSeconds: 30, metadata: { origin: "USER_DEFINED" },
};

test("requires a private, current-user-owned API key file in both entry points", t => {
  const directory = mkdtempSync(join(tmpdir(), "factory-dns-key-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, "key");
  writeFileSync(key, "test-key\n", { mode: 0o600 });
  assert.equal(readDnsApiKey(key), "test-key");
  chmodSync(key, 0o400);
  assert.equal(readDnsApiKey(key), "test-key");
  for (const mode of [0o644, 0o640, 0o620]) {
    chmodSync(key, mode);
    assert.throws(() => readDnsApiKey(key), /owned by the current user and accessible only to that user/);
  }
  chmodSync(key, 0o600);
  const fstat = fs.fstatSync;
  const mock = t.mock.method(fs, "fstatSync", (fd: number) =>
    Object.assign(fstat(fd), { uid: process.getuid!() + 1 }));
  syncBuiltinESMExports();
  try {
    assert.throws(() => readDnsApiKey(key), /owned by the current user and accessible only to that user/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  writeFileSync(key, "\n");
  assert.throws(() => readDnsApiKey(key), /Invalid UniFi API key/);
});

test("compares policy hostnames without case sensitivity while preserving the policy's spelling", async () => {
  for (const [hostname, domain] of [
    ["Factory.example.com", "factory.example.com"],
    ["factory.example.com", "FACTORY.EXAMPLE.COM"],
  ]) {
    let record = { ...original, domain };
    const request: typeof fetch = async (_url, options) => {
      if (options?.method === "PUT") {
        const body = JSON.parse(String(options.body));
        assert.equal(body.domain, domain);
        record = { ...record, ...body };
      }
      return Response.json(record);
    };
    assert.equal(await updateDns({ ...config, hostname }, "key", () => "10.0.10.21", request), "updated 10.0.10.21");
  }
});

test("uses the active physical LAN interface, excluding VPNs and disconnected adapters", () => {
  const interfaces = {
    en0: [{ address: "10.0.10.21", family: "IPv4", internal: false }],
    en1: [{ address: "192.168.8.10", family: "IPv4", internal: false }],
    utun8: [{ address: "100.90.0.1", family: "IPv4", internal: false }],
  };
  assert.equal(selectLanAddress("  PrimaryInterface : en1\n", interfaces), "192.168.8.10");
  assert.equal(selectLanAddress("  PrimaryInterface : en0\n", interfaces), "10.0.10.21");
  assert.equal(selectLanAddress("  PrimaryInterface : utun8\n", interfaces), undefined);
  assert.equal(selectLanAddress("No such key", interfaces), undefined);
  assert.equal(selectLanAddress("PrimaryInterface : en2", interfaces), undefined);
  assert.equal(selectLanAddress("PrimaryInterface : en0", {
    en0: [...interfaces.en0, { address: "10.0.10.22", family: "IPv4", internal: false }],
  }), undefined);
  for (const address of ["169.254.1.2", "127.0.0.1", "100.91.127.34", "8.8.8.8"])
    assert.equal(selectLanAddress("PrimaryInterface : en0", {
      en0: [{ address, family: "IPv4", internal: false }],
    }), undefined);
});

test("updates the same DNS record after each LAN change and leaves matching records alone", async () => {
  let record = { ...original }, address = "10.0.10.21";
  const writes: unknown[] = [];
  const request: typeof fetch = async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("X-API-Key"), "test-key");
    if (options?.method === "PUT") {
      const body = JSON.parse(String(options.body));
      writes.push(body);
      record = { ...record, ...body };
    }
    return Response.json(record);
  };
  const run = () => updateDns(config, "test-key", () => address, request);
  assert.equal(await run(), "updated 10.0.10.21");
  assert.equal(await run(), "unchanged");
  address = "192.168.8.10";
  assert.equal(await run(), "updated 192.168.8.10");
  assert.deepEqual(writes, ["10.0.10.21", "192.168.8.10"].map(ipv4Address => ({
    type: "A_RECORD", enabled: true, domain: config.hostname, ipv4Address, ttlSeconds: 30,
  })));
});

test("offline and mid-request network changes leave DNS untouched", async () => {
  let reads = 0;
  const request: typeof fetch = async (_url, options) => {
    reads++;
    assert.notEqual(options?.method, "PUT");
    return Response.json(original);
  };
  assert.equal(await updateDns(config, "key", () => undefined, request), "no LAN address");
  assert.equal(reads, 0);
  const addresses = ["10.0.10.21", "192.168.8.10"];
  assert.equal(await updateDns(config, "key", () => addresses.shift(), request), "LAN changed; retry next pass");
  assert.equal(reads, 1);
});

test("rejects a different, disabled, or malformed record before writing", async () => {
  for (const changed of [
    { domain: "other.example.com" }, { enabled: false }, { type: "CNAME_RECORD" },
    { ttlSeconds: undefined }, { ipv4Address: "not-an-ip" },
  ]) {
    await assert.rejects(updateDns(config, "key", () => "10.0.10.21", async (_url, options) => {
      assert.notEqual(options?.method, "PUT");
      return Response.json({ ...original, ...changed });
    }), /configured enabled A record/);
  }
});

test("HTTP failures and unconfirmed writes report failure without exposing responses or credentials", async () => {
  await assert.rejects(updateDns(config, "secret-key", () => "10.0.10.21", async () =>
    new Response("private diagnostic with secret-key", { status: 403 })),
  { message: "UniFi DNS GET failed (HTTP 403)" });
  await assert.rejects(updateDns(config, "key", () => "10.0.10.21", async () => Response.json(original)),
    /did not confirm/);
});

test("refuses credentials over HTTP and record URLs with embedded credentials", async () => {
  for (const recordUrl of ["http://gateway.example.com/record", "https://user:pass@gateway.example.com/record"]) {
    await assert.rejects(updateDns({ ...config, recordUrl }, "key", () => "10.0.10.21", async () => {
      assert.fail("should not make a request");
    }), /HTTPS/);
  }
});
