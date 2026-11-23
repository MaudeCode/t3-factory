import { bootout, bootstrap, installRuntime, plistString as string, writeControlAgent } from "./launchd.ts";
import { mkdirSync } from "node:fs";
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
mkdirSync(join(userDir, "Library/LaunchAgents"), { recursive: true });
mkdirSync(join(userDir, "Library/Logs"), { recursive: true });
// Dependencies are copied rather than rebuilt with npm: the scheduler runs from the same
// directory, and an npm install there removes modules it is loading.
await installRuntime(root, app, () => bootout(domain, label), envPath);
writeControlAgent(
  plist,
  `<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[process.execPath, join(app, "src/main.ts"), "web"].map(string).join("")}</array>
<key>WorkingDirectory</key>${string(app)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(process.env.PATH ?? "/usr/bin:/bin")}<key>NODE_NO_WARNINGS</key><string>1</string></dict>
<key>StandardOutPath</key>${string(join(userDir, "Library/Logs/t3-factory-web.log"))}
<key>StandardErrorPath</key>${string(join(userDir, "Library/Logs/t3-factory-web-error.log"))}
`,
);
execFileSync("plutil", ["-lint", plist], { stdio: "inherit" });
await bootstrap(domain, plist);
console.log("Factory web service installed.");
