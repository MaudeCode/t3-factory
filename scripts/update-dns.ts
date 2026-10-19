import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  recordUrl: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Use an HTTPS record URL without embedded credentials"),
  hostname: z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i),
  apiKeyFile: z.string().refine(isAbsolute, "Use an absolute API key path"),
});

export function readDnsConfig(path: string) {
  return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function readDnsApiKey(path: string) {
  const file = openSync(path, "r");
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
      throw new Error("UniFi API key file must be owned by the current user and accessible only to that user");
    const key = readFileSync(file, "utf8").trim();
    if (!key || /[\r\n]/.test(key)) throw new Error("Invalid UniFi API key");
    return key;
  } finally {
    closeSync(file);
  }
}

export function selectLanAddress(
  primaryState: string,
  interfaces: Record<string, readonly { address: string; family: string; internal: boolean }[] | undefined>,
) {
  const primary = primaryState.match(/\bPrimaryInterface\s*:\s*((?:en|bridge|bond)\d+)\b/)?.[1];
  if (!primary) return;
  const addresses = (interfaces[primary] ?? []).filter(entry => {
    if (entry.family !== "IPv4" || entry.internal || !isIPv4(entry.address)) return false;
    const [a, b] = entry.address.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  });
  // Multiple IPv4 aliases are ambiguous; leave DNS alone until the active address is clear.
  if (addresses.length === 1) return addresses[0].address;
}

function currentLanAddress() {
  const primary = execFileSync("/usr/sbin/scutil", [], {
    input: "show State:/Network/Global/IPv4\n", encoding: "utf8", timeout: 5_000,
  });
  return selectLanAddress(primary, networkInterfaces());
}

export async function updateDns(
  input: z.input<typeof configSchema>,
  apiKey: string,
  address = currentLanAddress,
  request = fetch,
) {
  const config = configSchema.parse(input);
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error("Invalid UniFi API key");
  const ip = address();
  if (!ip) return "no LAN address";
  const call = async (method: string, body?: unknown) => {
    const response = await request(config.recordUrl, {
      method, redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`UniFi DNS ${method} failed (HTTP ${response.status})`);
    return response;
  };
  const read = async () => {
    const parsed = z.object({
      type: z.literal("A_RECORD"), enabled: z.literal(true),
      domain: z.string().refine(value => value.toLowerCase() === config.hostname.toLowerCase()),
      ipv4Address: z.string().refine(isIPv4), ttlSeconds: z.number().int().min(0).max(86400),
    }).safeParse(await (await call("GET")).json());
    if (!parsed.success) throw new Error("UniFi policy is not the configured enabled A record");
    return parsed.data;
  };
  const record = await read();
  if (record.ipv4Address === ip) return "unchanged";
  if (address() !== ip) return "LAN changed; retry next pass";
  await call("PUT", { ...record, ipv4Address: ip });
  if ((await read()).ipv4Address !== ip) throw new Error("UniFi did not confirm the DNS update");
  return `updated ${ip}`;
}

if (import.meta.main) {
  try {
    const config = readDnsConfig(process.argv[2] ?? join(homedir(), ".config/t3-factory/dns.json"));
    const result = await updateDns(config, readDnsApiKey(config.apiKeyFile));
    if (result !== "unchanged") console.log(`Factory DNS: ${result}`);
  } catch (error) {
    // Do not log response bodies, configuration, or transport errors that may contain credentials.
    console.error(error instanceof Error && /^(UniFi |Invalid UniFi)/.test(error.message)
      ? error.message : "Factory DNS update failed; check the private configuration and connectivity");
    process.exitCode = 1;
  }
}
