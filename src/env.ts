import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const envPath =
  process.env.T3_FACTORY_ENV ?? resolve(import.meta.dirname, "../.env");
export function loadEnvironment() {
  if (process.env.T3_FACTORY_ENV || existsSync(envPath))
    process.loadEnvFile(envPath);
}
