import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (root: string, ...args: string[]) => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
};

// The checkout's version: the tag on HEAD, else its short commit SHA. Undefined outside a Git checkout.
export const gitVersion = (root: string) => git(root, 'describe', '--tags', '--exact-match', 'HEAD') ?? git(root, 'rev-parse', '--short', 'HEAD');

// A runtime's version. Installed runtimes have no .git, so the installer records it in VERSION.
export function runtimeVersion(root: string) {
  try { return readFileSync(join(root, 'VERSION'), 'utf8').trim() || undefined; } catch { return gitVersion(root); }
}
