import { z } from 'zod';
import { readPhase } from './read-context.ts';
import type { Thread } from './policy.ts';
// Filesystem evidence shared by automatic maintenance and operator reviews. Never follows worktree symlinks.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { lstat, realpath, readdir, readlink, statfs, stat } from 'node:fs/promises';
import { createReadStream, existsSync, realpathSync, promises as fsp } from 'node:fs';
import { dirname, basename, join, resolve, sep } from 'node:path';
import type { T3 } from './clients.ts';

const exec = promisify(execFile);
const workspaceGit = async (repo: string, args: string[], signal?: AbortSignal) => readPhase('git.workspace', async scoped =>
  (await exec('git', ['-C', repo, ...args], { timeout: 20_000, maxBuffer: 4_000_000, signal: signal && scoped ? AbortSignal.any([signal, scoped]) : signal ?? scoped, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout);
export function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : join(canonicalPath(dirname(path)), basename(path));
}
export async function worktrees(repo: string, signal?: AbortSignal) {
  const text = await workspaceGit(repo, ['worktree', 'list', '--porcelain', '-z'], signal);
  return text.split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    const field = (name: string) => fields.find(f => f.startsWith(name + ' '))?.slice(name.length + 1);
    return { path: field('worktree')!, head: field('HEAD') ?? '', branch: field('branch')?.replace(/^refs\/heads\//, '') ?? 'HEAD', locked: fields.some(f => f === 'locked' || f.startsWith('locked ')) };
  }).filter(t => t.path);
}
// Dispatch admission needs the failure; displays and removal evidence read an unreadable volume as unknown.
export async function availableBytes(path: string): Promise<number> {
  const fs = await statfs(path); return fs.bavail * fs.bsize;
}
export const freeBytes = (path: string): Promise<number | null> => availableBytes(path).catch(() => null);
// Repository aliases can share one filesystem and must not multiply the free-space display.
export async function filesystemSpace(path: string): Promise<{ id: string | null; freeBytes: number | null }> {
  try { return { id: String((await stat(path)).dev), freeBytes: await freeBytes(path) }; }
  catch { return { id: null, freeBytes: null }; }
}
export async function processWorkspaces(signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await exec('lsof', ['-b', '-n', '-d', 'cwd', '-Fn'], { timeout: 20_000, maxBuffer: 4_000_000, signal });
  const paths = stdout.split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1).replace(/ \(deleted\)$/, ''));
  if (!paths.length) throw new Error('Cannot verify running process workspaces');
  return paths;
}
export const usesWorkspace = (cwd: string, path: string) => { const p = canonicalPath(cwd); return p === path || p.startsWith(path + sep); };
// Daemons an agent started and left behind (dev servers, sidecars) outlive their terminal and are reparented to launchd.
// Once every other check has passed, those are the only processes that can still hold a finished worktree.
export async function reapOrphans(path: string, signal?: AbortSignal): Promise<number[]> {
  const killed: number[] = [];
  for (let round = 0; round < 3; round++) {
    const { stdout } = await exec('lsof', ['-b', '-n', '-d', 'cwd', '-Fpn'], { timeout: 20_000, maxBuffer: 4_000_000, signal });
    const orphans: number[] = []; let pid = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid && usesWorkspace(line.slice(1).replace(/ \(deleted\)$/, ''), path)) {
        const ppid = await exec('ps', ['-o', 'ppid=', '-p', String(pid)]).then(r => r.stdout.trim(), () => '');
        if (ppid === '1') orphans.push(pid);
      }
    }
    if (!orphans.length) break;
    for (const pid of orphans) { try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch {} }
    await sleep(1000, undefined, { signal });
  }
  return killed;
}
// Deleted tracked files are recoverable from the commit, so a removal that was interrupted mid-delete leaves nothing to preserve.
const classify = (entry: string) => entry.startsWith('??') ? 'untracked' : entry.startsWith('!!') ? 'ignored' : /^[ D][ D] /.test(entry) ? 'deleted' : 'tracked';
export async function dirtyEntries(path: string, signal?: AbortSignal) {
  const status = await workspaceGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
  return status.split('\0').filter(entry => entry && classify(entry) !== 'deleted');
}

// `assigned` is the caller's durable evidence (a Factory job or T3 binding recorded this path as its worktree); without it an
// unregistered directory is never removable, however empty it looks.
export async function inspectWorkspace(repo: string, input: string, contents = false, signal?: AbortSignal, assigned = false) {
  signal = AbortSignal.any([AbortSignal.timeout(30_000), ...signal ? [signal] : []]);
  signal.throwIfAborted();
  const path = canonicalPath(input), root = canonicalPath(repo), registrations = await worktrees(repo, signal);
  const registration = registrations.find(t => canonicalPath(t.path) === path);
  const primary = registrations[0] && canonicalPath(registrations[0].path);
  const present = existsSync(path);
  // A registered worktree may live outside the main checkout, but its Git common directory must be this repository's.
  if (path !== resolve(input)) throw new Error('Worktree path contains a symlink or alias; inspect its canonical registered path');
  const inputStat = await lstat(input).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (inputStat?.isSymbolicLink()) throw new Error('Worktree path is a symlink');
  const ancestor = canonicalPath(dirname(input));
  if (join(ancestor, basename(input)) !== path) throw new Error('Worktree path escapes its registered parent');
  let head = registration?.head ?? '', branch = registration?.branch ?? '', status = '';
  let common = '', inode = '', content = '', files = 0, bytes = 0;
  let tracked = 0, untracked = 0, ignored = 0, deleted = 0;
  const changes: { kind: string; path: string }[] = [];
  const ignoredPaths = new Set<string>();
  // An interrupted removal can leave an assigned directory without its .git link: Git only started deleting a clean tree, so
  // what remains is not work. An unassigned directory without Git metadata is simply not a worktree.
  const leftover = present && !registration && !existsSync(join(path, '.git'));
  if (present && !leftover) {
    const s = await lstat(path); inode = `${s.dev}:${s.ino}`;
    const ownCommon = (await workspaceGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim();
    common = await realpath(ownCommon);
    if (common !== await realpath((await workspaceGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim())) throw new Error('Worktree belongs to another repository');
    if (canonicalPath((await workspaceGit(path, ['rev-parse', '--show-toplevel'], signal)).trim()) !== path) throw new Error('Path is not a worktree root');
    head = (await workspaceGit(path, ['rev-parse', 'HEAD'], signal)).trim(); branch = (await workspaceGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)).trim();
    status = await workspaceGit(path, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all'], signal);
    const entries = status.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]; if (!entry) continue;
      if (changes.length < 100) changes.push({ kind: entry.slice(0, 2), path: entry.slice(3) });
      const kind = classify(entry);
      if (kind === 'untracked') untracked++; else if (kind === 'ignored') { ignored++; ignoredPaths.add(entry.slice(3).replace(/\/$/, '')); } else if (kind === 'deleted') deleted++; else { tracked++; if (/^[RC]|^.[RC]/.test(entry)) i++; }
    }
    if (contents) {
      const hash = createHash('sha256');
      const visit = async (dir: string) => {
        for (const name of (await readdir(dir)).sort()) {
          signal?.throwIfAborted(); if (dir === path && name === '.git') continue;
          // Ignored data is explicitly disposable; fingerprint only the work that still needs review.
          if (ignoredPaths.has(join(dir, name).slice(path.length + 1))) continue;
          if (++files > 100_000) throw new Error('Content inspection exceeded 100000 entries; narrow or clean the workspace before reviewing');
          const file = join(dir, name), s = await lstat(file);
          hash.update(JSON.stringify([file.slice(path.length), s.mode, s.size, s.mtimeMs, s.ino]));
          if (s.isSymbolicLink()) hash.update(await readlink(file));
          else if (s.isDirectory()) await visit(file);
          else if (s.isFile()) { bytes += s.size; for await (const chunk of createReadStream(file, { signal })) hash.update(chunk); }
          else throw new Error('Workspace contains a special file; inspection cannot verify its contents');
        }
      };
      await visit(path); content = hash.digest('hex');
    }
  }
  const identity = { path, root, primary, present, registered: !!registration, registration, common, inode, head, branch, status, content };
  return { ...identity, leftover, tracked, untracked, ignored, deleted, changes, files: contents ? files : null, bytes: contents && !ignored ? bytes : null,
    fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    removable: path !== root && path !== primary && (registration ? !registration.locked && (!present || !!common) : leftover && assigned),
  };
}

// Renaming the directory is atomic and instant, so an aborted or restarted removal never leaves a half-deleted tree behind.
// A detached process deletes the moved tree while cleanup verifies the result.
// ponytail: a reboot during that delete leaves a .<name>.removing-* folder beside the worktrees to delete by hand.
async function removeWorktree(repo: string, path: string, present: boolean) {
  if (present) {
    const trash = join(dirname(path), `.${basename(path)}.removing-${randomUUID().slice(0, 8)}`);
    await fsp.rename(path, trash);
    spawn('rm', ['-rf', trash], { detached: true, stdio: 'ignore' }).unref();
  }
  await workspaceGit(repo, ['worktree', 'prune']);
}

export async function removeWorkspace(repo: string, path: string, force = false, beforeRemove?: () => Promise<void>, onRemove?: () => void, assigned = false) {
  const before = await inspectWorkspace(repo, path, false, undefined, assigned);
  if (before.present || before.registered) {
    if (!before.removable) throw new Error('Only a registered, unlocked, non-primary worktree of the configured repository can be removed');
    if (!force && (before.tracked || before.untracked)) throw new Error('Preserve tracked or untracked workspace changes');
    await beforeRemove?.();
    // Git needs force for ignored files, so recheck real changes after the final activity guard.
    const final = force ? before : await inspectWorkspace(repo, path, false, undefined, assigned);
    if (!force && (!final.removable || final.head !== before.head || final.branch !== before.branch || final.inode !== before.inode || final.tracked || final.untracked)) throw new Error('Workspace identity or tracked/untracked contents changed before removal');
    onRemove?.();
    await removeWorktree(repo, before.path, before.present);
  }
  const after = await inspectWorkspace(repo, path, false, undefined, assigned);
  if (after.present || after.registered) throw new Error('Workspace removal is not confirmed; directory or Git registration remains');
  return { outcome: before.present ? 'removed' as const : 'already-absent' as const, physicalRemoval: before.present, registrationRemoved: before.registered };
}

// The bounded projection is authoritative for queued work that a settled shell can hide. Contents are never returned.
export async function verifyIdleProjection(t3: T3, thread: Thread, confirmedCommandStop = false) {
  const { projection: p } = z.object({ projection: z.object({
    thread: z.object({ id: z.string(), projectId: z.string(), worktreePath: z.string().nullable(), branch: z.string().nullable() }).passthrough(),
    runs: z.array(z.object({ status: z.string() })),
    runtimeRequests: z.array(z.object({ status: z.string(), resolvedAt: z.string().nullable() })),
    messages: z.array(z.object({ role: z.string(), createdAt: z.string() })),
    turnItems: z.array(z.object({ type: z.string(), status: z.string() })),
    providerThreads: z.array(z.object({ pendingBackgroundTasks: z.array(z.object({ kind: z.string() })).nullish() })),
    subagents: z.array(z.object({ status: z.string() })),
  }).passthrough() }).parse(await t3.request(`/api/orchestration/threads/${encodeURIComponent(thread.id)}/bounded`));
  if (p.thread.id !== thread.id || p.thread.projectId !== thread.projectId || p.thread.worktreePath !== thread.worktreePath || p.thread.branch !== thread.branch) throw new Error('Bounded ownership differs from shell');
  // Confirmed normal-maintenance stops can leave historical command items. Force reviews never get this waiver.
  const final = ['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'];
  if (p.runs.some(r => !final.includes(r.status)) || p.runtimeRequests.some(r => r.status === 'pending') ||
      p.turnItems.some(i => !final.includes(i.status) && i.type !== 'todo_list' && !(confirmedCommandStop && i.type === 'command_execution')) ||
      p.providerThreads.some(p => p.pendingBackgroundTasks?.length) || p.subagents.some(s => !final.includes(s.status))) throw new Error('Bounded thread has active, queued or pending work');
  if (p.messages.some(m => m.role === 'user' && Date.parse(m.createdAt) > Date.parse(thread.latestUserMessageAt ?? '1970-01-01'))) throw new Error('Thread resumed during inspection');
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}
