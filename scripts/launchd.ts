import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

export async function bootstrap(domain: string, plist: string) {
  // launchd can acknowledge bootout before finishing removal of the old service.
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync("launchctl", ["bootstrap", domain, plist], {
        stdio: "pipe",
      });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await setTimeout(500);
    }
  }
}
