import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootout, bootstrap, plistString as string, writeAgent } from "./launchd.ts";
import { envPath, loadEnvironment } from "../src/env.ts";

// Installs the LaunchAgent that deploys each new release tag; see scripts/deploy.ts.
loadEnvironment();
if (!existsSync(envPath)) throw new Error(`The deployer installs with ${envPath}; create it first`);
const userDir = homedir(), state = join(userDir, ".local/share/t3-factory"), app = join(state, "app");
const label = `${process.env.T3_FACTORY_SERVICE_LABEL ?? "local.t3-factory"}.deploy`;
if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error("Invalid service label");
// The HTTPS URL, so fetching needs no SSH agent inside launchd.
const repository = execFileSync("gh", ["repo", "view", "--json", "url", "--jq", ".url"], { encoding: "utf8" }).trim() + ".git";
const domain = `gui/${process.getuid!()}`, plist = join(userDir, "Library/LaunchAgents", `${label}.plist`);
await bootout(domain, label);
mkdirSync(join(app, "scripts"), { recursive: true });
cpSync(join(import.meta.dirname, "deploy.ts"), join(app, "scripts/deploy.ts"));
mkdirSync(join(userDir, "Library/LaunchAgents"), { recursive: true });
mkdirSync(join(userDir, "Library/Logs"), { recursive: true });
writeAgent(plist, `<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[process.execPath, join(app, "scripts/deploy.ts"), repository, join(state, "deploy/source"), join(state, "deploy/tag")].map(string).join("")}</array>
<key>WorkingDirectory</key>${string(app)}
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(process.env.PATH ?? "/usr/bin:/bin")}<key>T3_FACTORY_ENV</key>${string(envPath)}<key>NODE_NO_WARNINGS</key><string>1</string></dict>
<key>StandardOutPath</key>${string(join(userDir, "Library/Logs/t3-factory-deploy.log"))}
<key>StandardErrorPath</key>${string(join(userDir, "Library/Logs/t3-factory-deploy-error.log"))}`);
execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "inherit" });
await bootstrap(domain, plist);
console.log(`Release deployer installed: ${label} installs each new release tag of ${repository}.`);
