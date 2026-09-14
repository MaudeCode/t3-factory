import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadEnvironment } from "../src/env.ts";

loadEnvironment();
for (const name of [
  "FACTORY_HOSTNAME",
  "FACTORY_WEB_UPSTREAM",
  "CLOUDFLARE_API_TOKEN",
]) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}
const child = spawn(
  process.env.CADDY_BINARY ?? "caddy",
  ["run", "--config", resolve(import.meta.dirname, "../deploy/Caddyfile")],
  { stdio: "inherit" },
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => child.kill(signal));
child.once("error", () => {
  console.error("Could not start Caddy");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
