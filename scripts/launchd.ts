import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// launchd acknowledges bootout before it has finished removing the old service,
// so both helpers wait up to this long for it to settle.
const settleMs = 15_000;

function launchctl(...args: string[]) {
  try {
    execFileSync("launchctl", args, { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`launchctl ${args.join(" ")}: ${stderr || (error as Error).message}`);
  }
}

export async function bootout(domain: string, label: string) {
  const service = `${domain}/${label}`;
  try {
    launchctl("bootout", service);
  } catch {
    // Not loaded; the first install.
  }
  for (const deadline = Date.now() + settleMs; Date.now() < deadline; await setTimeout(250)) {
    try {
      launchctl("print", service);
    } catch {
      return;
    }
  }
  // Installing over a service that is still running would replace its files under it.
  throw new Error(`launchd did not unload ${service} within ${settleMs / 1000} seconds`);
}

export async function bootstrap(domain: string, plist: string) {
  for (let delay = 250, deadline = Date.now() + settleMs; ; delay = Math.min(delay * 2, 2_000)) {
    try {
      return launchctl("bootstrap", domain, plist);
    } catch (error) {
      const wait = Math.min(delay, deadline - Date.now());
      if (wait <= 0) throw error;
      await setTimeout(wait);
    }
  }
}

// These long-lived control-plane agents serve interactive state and deadline-bound RPCs.
export function writeControlAgent(plist: string, body: string) {
  if (/<key>\s*ProcessType\s*<\/key>/.test(body)) throw new Error('The control-agent writer owns ProcessType');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>ProcessType</key><string>Interactive</string>
${body}
</dict></plist>\n`, { mode: 0o600 });
}

// Everything an installer deploys to the shared runtime directory. Configuration, credentials and job state live elsewhere.
export const runtimeEntries = ["src", "web", "prompts", "scripts", "deploy", "node_modules", "package.json", "package-lock.json", "README.md", "docs", "LICENSE", "SECURITY.md", "config.example.jsonc", ".env.example"];

// Copies the runtime into a fresh staging directory while the service still runs, so a failed copy changes nothing,
// then unloads it and moves each entry into place. Links are copied as written: npm's relative node_modules/.bin links
// keep pointing inside the runtime instead of into a checkout that may later be removed.
export async function installRuntime(root: string, app: string, unload: () => Promise<void>) {
  const staging = join(app, ".install");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const entry of runtimeEntries) cpSync(join(root, entry), join(staging, entry), { recursive: true, verbatimSymlinks: true });
    await unload();
    for (const entry of runtimeEntries) {
      rmSync(join(app, entry), { recursive: true, force: true });
      renameSync(join(staging, entry), join(app, entry));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
