import { accessSync, cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootout, bootstrap, plistString as string, writeAgent } from "./launchd.ts";
import { readDnsApiKey, readDnsConfig } from "./update-dns.ts";
import { loadEnvironment } from "../src/env.ts";

loadEnvironment();
const userDir = homedir(), app = join(userDir, ".local/share/t3-factory/app");
const configPath = process.argv[2] ?? join(userDir, ".config/t3-factory/dns.json");
if (!isAbsolute(configPath)) throw new Error("Use an absolute DNS configuration path");
const config = readDnsConfig(configPath);
readDnsApiKey(config.apiKeyFile);
// Like install-web, use the existing installed runtime and its dependencies.
accessSync(join(app, "node_modules/zod/package.json"));
const label = `${process.env.T3_FACTORY_SERVICE_LABEL ?? "local.t3-factory"}.dns`;
if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error("Invalid service label");
const domain = `gui/${process.getuid!()}`;
const plist = join(userDir, "Library/LaunchAgents", `${label}.plist`);
await bootout(domain, label);
mkdirSync(join(app, "scripts"), { recursive: true });
cpSync(join(import.meta.dirname, "update-dns.ts"), join(app, "scripts/update-dns.ts"));
mkdirSync(dirname(plist), { recursive: true });
mkdirSync(join(userDir, "Library/Logs"), { recursive: true });
writeAgent(plist, `<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[process.execPath, join(app, "scripts/update-dns.ts"), configPath].map(string).join("")}</array>
<key>WorkingDirectory</key>${string(app)}
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>NODE_NO_WARNINGS</key><string>1</string>${process.env.NODE_EXTRA_CA_CERTS ? `<key>NODE_EXTRA_CA_CERTS</key>${string(process.env.NODE_EXTRA_CA_CERTS)}` : ""}</dict>
<key>StandardOutPath</key>${string(join(userDir, "Library/Logs/t3-factory-dns.log"))}
<key>StandardErrorPath</key>${string(join(userDir, "Library/Logs/t3-factory-dns-error.log"))}`);
execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "inherit" });
await bootstrap(domain, plist);
console.log("Factory DNS updater installed.");
