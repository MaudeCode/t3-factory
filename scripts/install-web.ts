import { bootout, bootstrap } from "./launchd.ts";
import { cpSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { webSettings } from "../src/web.ts";
import { loadEnvironment, envPath } from "../src/env.ts";

loadEnvironment();
webSettings();

const root = resolve(import.meta.dirname, ".."),
  userDir = homedir();
const app = join(userDir, ".local/share/t3-factory/app"),
  label = `${process.env.T3_FACTORY_SERVICE_LABEL ?? "local.t3-factory"}.web`,
  domain = `gui/${process.getuid!()}`;
if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error("Invalid service label");
const plist = join(userDir, "Library/LaunchAgents", `${label}.plist`);
mkdirSync(app, { recursive: true, mode: 0o700 });
mkdirSync(join(userDir, "Library/LaunchAgents"), { recursive: true });
mkdirSync(join(userDir, "Library/Logs"), { recursive: true });
// Stage the complete runtime before restarting the web process.
for (const entry of [
  "src",
  "web",
  "scripts",
  "deploy",
  "package.json",
  "package-lock.json",
  "README.md",
  "docs",
  "LICENSE",
  "SECURITY.md",
  "config.example.jsonc",
  ".env.example",
])
  cpSync(join(root, entry), join(app, entry), { recursive: true });
cpSync(envPath, join(app, ".env"));
chmodSync(join(app, ".env"), 0o600);
// Dependencies are copied in place rather than rebuilt with npm: the scheduler runs from the same
// directory, and an npm install there removes modules it is loading.
cpSync(join(root, "node_modules"), join(app, "node_modules"), { recursive: true });
await bootout(domain, label);
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(join(app, "src/main.ts"))}</string><string>web</string></array>
<key>WorkingDirectory</key><string>${escape(app)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH ?? "/usr/bin:/bin")}</string><key>NODE_NO_WARNINGS</key><string>1</string></dict>
<key>StandardOutPath</key><string>${userDir}/Library/Logs/t3-factory-web.log</string>
<key>StandardErrorPath</key><string>${userDir}/Library/Logs/t3-factory-web-error.log</string>
</dict></plist>\n`,
  { mode: 0o600 },
);
execFileSync("plutil", ["-lint", plist], { stdio: "inherit" });
await bootstrap(domain, plist);
console.log("Factory web service installed.");
