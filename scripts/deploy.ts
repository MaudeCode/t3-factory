// Installs the newest vX.Y.Z release on this Mac. The .deploy LaunchAgent runs it every few minutes.
// The release workflow creates a tag only after its checks pass, so a new tag is ready to install.
// Each tag is tried once: after a failure, fix the cause and release the next version.
// Uses only Node's standard library: the installers it runs replace the runtime's node_modules under it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [repository, checkout, tagFile] = process.argv.slice(2);
if (!repository || !checkout || !tagFile) throw new Error("Usage: deploy.ts <repository URL> <checkout> <tag file>");
const run = (command: string, ...args: string[]) => execFileSync(command, args, { cwd: checkout, stdio: "inherit" });
const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();

mkdirSync(dirname(tagFile), { recursive: true });
if (!existsSync(join(checkout, ".git"))) execFileSync("git", ["clone", "--quiet", "--no-checkout", repository, checkout], { stdio: "inherit" });
git("fetch", "--quiet", "--force", "--prune", "--prune-tags", "--tags", "origin");
const tag = git("tag", "--list", "--sort=-v:refname", "v*").split("\n").find(name => /^v\d+\.\d+\.\d+$/.test(name));
if (!tag || tag === (existsSync(tagFile) ? readFileSync(tagFile, "utf8").trim() : "")) process.exit(0);

writeFileSync(tagFile, `${tag}\n`);
console.log(`${new Date().toISOString()} deploying ${tag}`);
run("git", "checkout", "--quiet", "--force", "--detach", tag);
run("npm", "ci", "--no-audit", "--no-fund");
run(process.execPath, "scripts/install.ts");
run(process.execPath, "scripts/install-web.ts");
console.log(`${new Date().toISOString()} deployed ${tag}`);
