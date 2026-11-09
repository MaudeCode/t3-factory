import { writeFileSync } from "node:fs";
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
