import { ReadContext, independentOperation, waitFor, readAll, readContext, readPhase, readFailure, backgroundCheckpoint, backgroundRead } from './read-context.ts';
export { readAll } from './read-context.ts';
import { inboxes, triageCanary, type TriageRow } from './triage.ts';
import { inspectWorkspace, removeWorkspace, processWorkspaces, reapOrphans, dirtyEntries, canonicalPath, verifyIdleProjection, worktrees, availableBytes } from './workspace.ts';
// Cleanup builds on this module; the cycle is safe because neither module calls the other while loading.
import { reclaimUnusedWorkspace } from './cleanup.ts';
import { formatBytes } from '../web/lib/format.js';
import { readFileSync, existsSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { automationHold, taskDifficulty, taskHold } from './policy.ts';
import { T3, Kanvil, KanvilTaskNotFound, listTasks, relationsSchema, type Task, type Epic } from './clients.ts';
import { commandWait, executing, providerExecuting, subagentDescendants, waiting, stalledMonitor, DEFAULT_MONITORING_TIMEOUT_MINUTES, ticketDifficulty, ticketLabelRank, branchKind, compareTicketPriority, mentionsTicket, threadsReferencingTicket, selectTicket, queueOrder, acceptsDifficulty, selectAssignment, type Thread, type Candidate, type TicketPriority } from './policy.ts';
import { Store, jobLabel, planTickets, cleanupActionPending, type Job, type Plan, type PlanTicket, type Decision } from './store.ts';
import { promptFor } from './prompts.ts';
import { loadConfig, overridableLimits, type Config, type OverridableLimit, type OverrideLimits, type Project, type DispatchProvider } from './config.ts';

import { modelQuota, liveModelQuota, readModelQuota, readModelQuotas } from './models.ts';
import { launched, projectUnavailable, sessionTicketStatus } from './session-tickets.ts';
import { pullRequestsSchema, type GitHub } from './github-client.ts';

const exec = promisify(execFile);
// Blocked cleanups wait for something outside the scheduler to change, so retrying every cycle only repeats their cost.
const CLEANUP_RETRY_MINUTES = 15;
// An unrecorded or unreadable block time retries now.
const cleanupDue = (job: Job) => !(Date.now() - Date.parse(job.workspaceCleanupBlockedAt ?? '') < CLEANUP_RETRY_MINUTES * 60_000);
const cleanupPending = (job: Job) => (job.state === 'complete' || job.state === 'dismissed' || !!job.workspaceCleanup) && !job.workspaceCleanedAt && cleanupDue(job);
const reportSchema = z.object({
  jobId: z.string(), status: z.enum(['complete', 'awaiting-human', 'no-work']), reason: z.string(),
  prUrls: z.array(z.url()).default([]), createdTaskIds: z.array(z.string()).default([]),
}).strict();
function projectFor(c: Config, job: Job): Project {
  const p = c.projects.find(p => p.kanvilId === job.projectId);
  if (!p) throw new Error(`Keep project ${job.projectId} configured while its jobs are unfinished; disable it instead of removing it`);
  return p;
}
export function log(event: string, fields: Record<string, unknown> = {}) {
  if (event === 'decision') {
    const streams = fields.streams as { driver: string; reason: string }[] | undefined, skipped = fields.skipped as { key: string; reason: string }[] | undefined;
    fields = { reason: fields.reason, at: fields.at, ticket: fields.ticket, jobId: fields.jobId, threadId: fields.threadId, message: fields.message,
      eligible: fields.eligible, streams: streams?.map(({ driver, reason }) => ({ driver, reason })), skippedCount: skipped?.length,
      skipped: skipped?.slice(0, 5).map(({ key, reason }) => ({ key, reason })), triageSandbox: fields.triageSandbox };
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
export function safeError(error: unknown): string {
  // Read only diagnostic fields, never headers, bodies, stacks or socket/SDK objects.
  const redact = (text: string) => text.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/(?:Bearer\s+|sk-)[^\s"']+/gi, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|wsTicket|token|password|secret)["']?\s*[:=]\s*)(["']?)[^&\s"']+\2/gi, '$1$2[redacted]$2');
  const parts: string[] = [], seen = new Set<unknown>();
  let value = error;
  for (let depth = 0; depth < 4 && !seen.has(value); depth++) {
    seen.add(value);
    if (value === null || typeof value !== 'object') { parts.push(redact(String(value)).slice(0, 180)); break; }
    const fields = value as Record<string, unknown>;
    const type = value instanceof Error ? value.name === 'Error' ? undefined : value.name : fields._tag;
    const code = typeof fields.code === 'string' || typeof fields.code === 'number' ? `[${fields.code}]` : undefined;
    const message = value instanceof Error ? value.message : fields.message ?? fields.detail;
    const text = [type, code, message].filter(v => typeof v === 'string' && v).join(': ') || 'Unknown error';
    parts.push(redact(text).slice(0, 180));
    if (fields.cause === undefined) break;
    value = fields.cause;
  }
  const read = readFailure(error), prefix = read ? `${read.stage} failed after ${read.elapsedMs}ms: ` : '';
  return (prefix + parts.join('; caused by ')).slice(0, 800);
}
async function git(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  return readPhase('git.read', async scoped => (await exec('git', ['-C', path, ...args], { timeout: 20_000, maxBuffer: 2_000_000, signal: signal && scoped ? AbortSignal.any([signal, scoped]) : signal ?? scoped })).stdout.trim());
}
async function gh(args: string[]): Promise<unknown> {
  return readPhase('github.read', async signal => JSON.parse((await exec('gh', args, { timeout: 30_000, maxBuffer: 3_000_000, signal })).stdout));
}
const releasesSchema = z.array(z.object({ tagName: z.string().min(1), publishedAt: z.string() }));
export interface PendingReview { project: Project; upstream: NonNullable<Job['upstream']> }
// Each watched repository yields at most one review: from its last reviewed release to its newest one.
// GitHub is read at most every checkMinutes (the upstream's own, else upstream.checkMinutes); a repository with an unfinished review is not read at all.
// refresh=false (dry runs and doctor) reads only the cached releases and writes nothing.
type Watched = Project['upstreams'][number];
// The single reading of a watched repository's stored state; dispatch and status both use it.
function releaseState(project: Project, watched: Watched, store: Store, jobs: Job[]) {
  const owned = jobs.filter(j => j.upstream?.repo === watched.repo);
  const reviewing = owned.some(j => !['complete', 'dismissed'].includes(j.state));
  const reviewed = store.get(`upstreamReviewed:${watched.repo}`) ?? watched.firstBase, latest = store.get(`upstreamLatest:${watched.repo}`);
  // A candidate that already had a review, even one dismissed by settling it, is never dispatched again.
  const due = project.enabled && !reviewing && !!latest && latest !== reviewed && !owned.some(j => j.upstream!.candidate === latest);
  return { reviewing, reviewed, latest, due };
}
export async function pendingReviews(c: Config, store: Store, jobs: Job[], now = Date.now(), refresh = true): Promise<PendingReview[]> {
  const watched = c.projects.filter(project => project.enabled).flatMap(project => project.upstreams.map(watched => ({ project, watched })));
  const pending = await readAll(watched.map(async ({ project, watched }): Promise<PendingReview | undefined> => {
    await backgroundCheckpoint();
    if (releaseState(project, watched, store, jobs).reviewing) return undefined;
    const checkedKey = `upstreamCheckedAt:${watched.repo}`, errorKey = `upstreamCheckError:${watched.repo}`;
    if (refresh && now - Number(store.get(checkedKey) ?? 0) >= (watched.checkMinutes ?? c.upstream!.checkMinutes) * 60_000) {
      store.set(checkedKey, String(now)); // A failed read also waits checkMinutes before retrying.
      try {
        // gh excludes drafts (which have no publish date) and skipped pre-releases before its limit, so they cannot hide a release.
        const latest = releasesSchema.parse(await backgroundRead(() => gh(['release', 'list', '--repo', watched.repo, '--limit', '30', '--exclude-drafts', ...watched.prereleases ? [] : ['--exclude-pre-releases'], '--json', 'tagName,publishedAt'])))
          .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
        if (latest) store.set(`upstreamLatest:${watched.repo}`, latest.tagName);
        store.set(errorKey, '');
      } catch (error) { store.set(errorKey, safeError(error)); log('upstream-check-failed', { repo: watched.repo, reason: safeError(error) }); }
    }
    const { reviewed, latest, due } = releaseState(project, watched, store, jobs);
    return due ? { project, upstream: { name: watched.name, repo: watched.repo, base: reviewed, candidate: latest! } } : undefined;
  }));
  return pending.filter((row): row is PendingReview => !!row);
}
async function verifyMerged(project: Project, urls: string[]) {
  for (const url of urls) {
    const u = new URL(url);
    if (u.origin !== 'https://github.com' || !new RegExp(`^/${project.githubRepo}/pull/[0-9]+$`).test(u.pathname)) throw new Error('Completion report PR belongs to the wrong repository');
    const pr = z.object({ state: z.literal('MERGED'), baseRefName: z.string(), mergeCommit: z.object({ oid: z.string().min(40) }) }).parse(await gh(['pr', 'view', u.pathname.split('/').at(-1)!, '--repo', project.githubRepo, '--json', 'state,baseRefName,mergeCommit']));
    if (pr.baseRefName !== project.baseBranch) throw new Error('Completed PR targets the wrong release branch');
  }
}
async function released(project: Project, head: string, release = `refs/remotes/origin/${project.baseBranch}`, signal?: AbortSignal): Promise<boolean> {
  const repo = project.repoPath;
  if (await git(repo, ['merge-base', '--is-ancestor', head, release], signal).then(() => true, () => false)) return true;
  // A squash merge leaves no ancestry. The branch's whole tree committed once onto its merge base has the same
  // patch-id as the squash commit, so `git cherry` can find it in the release branch.
  try {
    const base = await git(repo, ['merge-base', head, release], signal);
    const tree = await git(repo, ['rev-parse', `${head}^{tree}`], signal);
    if (tree === await git(repo, ['rev-parse', `${base}^{tree}`], signal)) return true;
    const squashed = await git(repo, ['-c', 'user.name=t3-factory', '-c', 'user.email=cleanup@t3-factory.invalid', 'commit-tree', tree, '-p', base, '-m', 'squash-merge check'], signal);
    const cherry = await git(repo, ['cherry', release, squashed, base], signal);
    return cherry.split('\n').filter(Boolean).every(line => line.startsWith('-'));
  } catch { return false; }
}
// Manual deletion verifies the remote release tip without mutating repository refs or trusting an old tracking ref.
export async function verifyReleasedWorkspaceHead(project: Project, head: string, signal?: AbortSignal): Promise<string> {
  const ref = `refs/heads/${project.baseBranch}`;
  const remote = await git(project.repoPath, ['ls-remote', '--exit-code', 'origin', ref], signal);
  const fields = remote.split(/\s+/);
  if (fields.length !== 2 || fields[1] !== ref || !/^[a-f0-9]{40,64}$/.test(fields[0])) throw new Error('Remote release branch could not be verified');
  // The tip is only comparable once its commit is local.
  if (!await git(project.repoPath, ['cat-file', '-e', `${fields[0]}^{commit}`], signal).then(() => true, () => false)) await git(project.repoPath, ['fetch', '--quiet', 'origin', ref], signal);
  if (!await released(project, head, fields[0], signal)) throw new Error('Workspace HEAD is not verified merged into the remote release branch');
  return fields[0];
}
async function branchTip(project: Project, branch: string): Promise<string> {
  return git(project.repoPath, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).catch(() => '');
}
// Every commit a ref has pointed at, newest first; empty when Git keeps no reflog for it.
async function refHistory(path: string, ref: string): Promise<string[]> {
  return (await git(path, ['reflog', 'show', '--format=%H', ref]).catch(() => '')).split('\n').filter(Boolean);
}
// A Factory branch that never moved from its released creation commit, in a checkout that never left it, holds no work of its run.
// A commit pushed straight to the release branch would pass an ancestry check alone.
async function untouchedHead(project: Project, branch: string, worktreePath?: string | null): Promise<string> {
  const history = await refHistory(project.repoPath, `refs/heads/${branch}`), created = history.at(-1);
  if (!created) return '';
  history.push(await branchTip(project, branch));
  // A leftover directory without its .git link is no checkout; only the branch refs can speak for it.
  if (worktreePath && existsSync(join(worktreePath, '.git'))) history.push(await git(worktreePath, ['rev-parse', 'HEAD']), ...await refHistory(worktreePath, 'HEAD'));
  return history.every(head => head === created) && await released(project, created) ? created : '';
}
// A ticket closed without delivery must have left the ready queue and abandon no work.
async function verifyClosedWithoutDelivery(project: Project, task: Task, job: Job, thread: Thread) {
  if (!project.doneStatuses.includes(task.status) && project.readyStatuses.includes(task.status) && task.automationReady && !task.holdReason && !task.archived) {
    throw new Error('Ticket is still ready; record why no change is needed and remove it from the ready queue');
  }
  const unmerged = new Error('Unmerged work remains; deliver it through a PR or report awaiting-human');
  const branch = assignedBranch(job), worktree = thread.worktreePath && existsSync(thread.worktreePath) ? thread.worktreePath : null;
  if (worktree && (await git(worktree, ['status', '--porcelain']) || await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch)) throw unmerged;
  if (!branch || !await branchTip(project, branch)) throw new Error('Workspace head cannot be verified; inspect the work in T3 or report awaiting-human');
  if (!await untouchedHead(project, branch, worktree)) throw unmerged;
}
// A report describes the current wait unless it is an awaiting-human report answered since it was written.
function currentReport(job: Job, t: Thread): boolean {
  if (!existsSync(job.reportPath)) return false;
  const answeredAt = Math.max(0, ...[job.resumedAt, t.latestUserMessageAt].map(at => Date.parse(at ?? '') || 0));
  if (statSync(job.reportPath).mtimeMs > answeredAt) return true;
  try { return JSON.parse(readFileSync(job.reportPath, 'utf8')).status !== 'awaiting-human'; } catch { return true; }
}
export function readCompletionReport(job: Job) {
  if (!existsSync(job.reportPath)) throw new Error('Turn ended without a completion report; inspect in T3');
  const report = reportSchema.parse(JSON.parse(readFileSync(job.reportPath, 'utf8')));
  if (report.jobId !== job.id) throw new Error('Completion report job ID mismatch');
  return report;
}
export async function verifyCompletionReport(c: Config, kanvil: Kanvil, job: Job, t: Thread, report: z.infer<typeof reportSchema>) {
  const project = projectFor(c, job);
  if (job.kind === 'ticket') {
    if (report.status !== 'complete' && report.prUrls.length) throw new Error('Ticket cannot finish as no-work');
    const task = await kanvil.task(job.taskId!, project.kanvilId);
    if (!report.prUrls.length) await verifyClosedWithoutDelivery(project, task, job, t);
    else {
      if (!project.doneStatuses.includes(task.status)) throw new Error('Ticket not yet verified Done in Kanvil');
      await verifyMerged(project, report.prUrls);
    }
  } else {
    // An upstream review that created nothing reports no-work, so a truncated report cannot mark a release reviewed.
    if (job.kind === 'upstream' && report.status === 'complete' && !report.createdTaskIds.length) throw new Error('Upstream review reported complete without created tickets; report no-work if none were needed');
    for (const id of report.createdTaskIds) {
      const task = await kanvil.task(id, project.kanvilId);
      if (task.projectId !== project.kanvilId) throw new Error(`${job.kind === 'upstream' ? 'Upstream review' : 'Discovery'} report includes another project`);
      if (job.kind === 'upstream' && Date.parse(task.createdAt) < Date.parse(job.createdAt)) throw new Error('Upstream review report lists a ticket created before the review started');
    }
  }
}
// Dismissal keeps the workspace's branch, path and head so cleanup can still verify it.
async function dismissJob(store: Store, job: Job, reason: string, at?: { branch: string | null; worktreePath: string | null }) {
  job.state = 'dismissed'; job.reason = reason; job.dismissedAt = new Date().toISOString();
  job.dismissedBranch = at?.branch ?? undefined; job.dismissedWorktreePath = at?.worktreePath ?? undefined;
  if (at?.worktreePath && existsSync(at.worktreePath)) {
    try { job.dismissedHead = await git(at.worktreePath, ['rev-parse', 'HEAD']); } catch { /* Keep unknown artifacts protected. */ }
  }
  store.save(job); log('job-dismissed', { jobId: job.id, threadId: job.threadId });
}

export async function reconcile(c: Config, store: Store, t3: T3, kanvil: Kanvil, threads: Thread[], allowMonitorStop = true, allowCleanup = true) {
  let listed: Promise<Thread[]> | undefined;
  await readAll(store.jobs().filter(j => j.state !== 'dismissed' || !j.workspaceCleanedAt).map(original => store.exclusive([`job:${original.id}`], async () => {
    await backgroundCheckpoint();
    const job = store.job(original.id)!;
    const t = threads.find(t => t.id === job.threadId);
    if (t && allowMonitorStop && allowCleanup && cleanupPending(job)) await cleanupCompletedWorkspace(c, store, t3, kanvil, job);
    if (job.state === 'dismissed') return;
    if (t?.settledOverride === 'settled' && !executing(t, c.monitoringTimeoutMinutes)) { await dismissJob(store, job, 'Dismissed by settling the task in T3', t); return; }
    if (job.state === 'complete') return;
    if (!t) {
      // A thread T3 has shown before and no longer lists, even among archived threads, was deleted: its run cannot resume.
      if (job.thread && !(await (listed ??= t3.shell(true).then(s => s.threads))).some(x => x.id === job.threadId)) {
        await dismissJob(store, job, 'Dismissed because its T3 thread was deleted', job.thread); return;
      }
      if (Date.now() - Date.parse(job.createdAt) > 5 * 60_000) {
        job.state = 'dispatching'; job.reason = 'Dispatch outcome unknown; retain the execution slot until T3 can be reconciled';
      }
      store.save(job); return;
    }
    if (stalledMonitor(t, c.monitoringTimeoutMinutes)) {
      if (!allowMonitorStop) {
        job.state = 'running'; job.reason = 'Stalled background monitor; normal service cycle will stop it before releasing the slot';
        store.save(job); return;
      }
      // Stop only this owned idle session before releasing its slot: an old watcher
      // must not wake the agent in parallel with the next autonomous job.
      const fresh = (await t3.shell()).threads.find(x => x.id === job.threadId);
      if (fresh && stalledMonitor(fresh, c.monitoringTimeoutMinutes)) {
        await t3.stop(job.threadId);
        job.state = 'running'; job.reason = 'Stopping stalled background monitor; awaiting T3 confirmation';
        if (!existsSync(job.reportPath)) {
          writeFileSync(`${job.reportPath}.tmp`, JSON.stringify({ jobId: job.id, status: 'awaiting-human', reason: `Background monitor made no turn progress for ${c.monitoringTimeoutMinutes} minutes. Session stopped; inspect review results and resume this thread. Merge authorization and required human validation still apply.`, prUrls: job.prUrls, createdTaskIds: [] }) + '\n', { mode: 0o600 });
          renameSync(`${job.reportPath}.tmp`, job.reportPath);
        }
        log('stalled-monitor-stop-requested', { jobId: job.id, threadId: job.threadId });
      }
      store.save(job); return;
    }
    if (executing(t, c.monitoringTimeoutMinutes) || ['dispatching', 'running'].includes(job.state)) job.lastExecutionAt = t.updatedAt;
    job.thread = { title: t.title, status: t.status, branch: t.branch, worktreePath: t.worktreePath, updatedAt: t.updatedAt, pending: t.pendingRuntimeRequest?.kind ?? null, background: t.pendingBackgroundTasks.map(b => b.kind) };
    if (waiting(t)) { job.state = 'waiting'; job.reason = 'T3 is awaiting human input'; }
    else if (executing(t, c.monitoringTimeoutMinutes)) {
      if (job.state === 'waiting') job.resumedAt = new Date().toISOString();
      job.state = 'running'; job.reason = 'Claude is executing';
    }
    // An unfinished turn yielded to its commands; their notification resumes it. A current report is still verified below.
    else if (commandWait(t, c.monitoringTimeoutMinutes) && !currentReport(job, t)) { job.state = 'running'; job.reason = 'Waiting for background commands'; }
    else {
      try {
        const report = readCompletionReport(job);
        job.prUrls = report.prUrls;
        if (report.status === 'awaiting-human') { job.state = 'waiting'; job.reason = report.reason; }
        else {
          await verifyCompletionReport(c, kanvil, job, t, report);
          if (job.kind === 'upstream') store.set(`upstreamReviewed:${job.upstream!.repo}`, job.upstream!.candidate);
          else if (job.kind === 'discovery' && !report.createdTaskIds.length) store.set(`discoveryAfter:${job.projectId}`, String(Date.now() + c.discovery.emptyCooldownHours * 3_600_000));
          job.state = 'complete'; job.reason = report.reason; job.completedAt = new Date().toISOString();
          log('job-complete', { jobId: job.id, ticket: job.ticketKey, prUrls: job.prUrls });
        }
      } catch (e) { job.state = 'waiting'; job.reason = safeError(e); }
    }
    store.save(job);
  })));
}

// One existing cleanup step per job per sweep. Re-read durable state after every queued command;
// intermediate steps resume on the next pass, even after a service restart. Factory jobs go first;
// then the catalog's merged unused worktrees, one removal per step.
export async function cleanupNextWorkspace(c: Config, store: Store, t3: T3, kanvil: Kanvil, visited: Set<string>, boundary: Parameters<typeof reclaimUnusedWorkspace>[5] = {}): Promise<boolean> {
  const job = store.jobs().find(job => !visited.has(job.id) && cleanupPending(job));
  if (!job) return reclaimUnusedWorkspace(c, store, t3, kanvil, visited, boundary);
  visited.add(job.id);
  const path = job.workspaceCleanup?.path ?? job.thread?.worktreePath ?? job.dismissedWorktreePath;
  await store.exclusive([`job:${job.id}`, ...path ? [`path:${canonicalPath(path)}`] : []], async () => {
    const current = store.job(job.id);
    if (current && cleanupPending(current)) await cleanupCompletedWorkspace(c, store, t3, kanvil, current);
  });
  return true;
}

function assignedBranch(job: Job): string | undefined {
  const command = z.union([
    z.object({ bootstrap: z.object({ prepareWorktree: z.object({ branch: z.string() }) }) }).transform(c => c.bootstrap.prepareWorktree.branch),
    z.object({ workspaceStrategy: z.object({ branch: z.string() }) }).transform(c => c.workspaceStrategy.branch),
  ]).safeParse(job.command);
  return command.success ? command.data : undefined;
}
export async function verifyCleanupHead(c: Config, store: Store, kanvil: Kanvil, job: Job, threads: Thread[], branch: string, path: string): Promise<string> {
  const project = projectFor(c, job);
  let head: string;
  if (job.kind === 'ticket' && job.prUrls.length) {
    const task = await kanvil.task(job.taskId!, project.kanvilId);
    if (!project.doneStatuses.includes(task.status)) throw new Error('Ticket is no longer Done');
    const history = await historicalArtifacts(project, [{ ...job, state: 'complete' }], threads, branch, store);
    if (!history.branches.has(branch)) throw new Error('Workspace head is not verified merged');
    head = history.branches.get(branch)!;
  } else {
    // Discovery and tickets closed without delivery verify their head against the release branch.
    head = job.workspaceCleanup?.head ?? await git(path, ['rev-parse', 'HEAD']);
    if (!await released(project, head)) throw new Error('Workspace head is not part of the release branch');
  }
  return head;
}

export async function cleanupCompletedWorkspace(c: Config, store: Store, t3: T3, kanvil: Kanvil, job: Job, boundary: { processes?: typeof processWorkspaces; actionId?: string } = {}) {
  let mutationUncertain = false;
  const mutate = async (work: () => Promise<unknown>) => { mutationUncertain = true; await work(); mutationUncertain = false; };
  const identity = (j: Job) => JSON.stringify([j.threadId, j.projectId, j.taskId, j.messageId, j.command, j.reportPath, j.state, j.createdAt]);
  job.workspaceCleanupAttemptedAt = new Date().toISOString(); store.save(job);
  const maintenance = (patch: Record<string, unknown>) => store.set('cleanupMaintenance', JSON.stringify({ ...JSON.parse(store.get('cleanupMaintenance') ?? '{}'), lastAttempt: job.workspaceCleanupAttemptedAt, jobId: job.id, error: undefined, ...patch }));
  maintenance({ state: 'inspecting' });
  const ownership = identity(job);
  const checkOwner = () => {
    const current = store.job(job.id);
    if (!current || identity(current) !== ownership) throw new Error('Factory ownership changed before command stop');
  };
  try {
    if (store.cleanupActions().some(a => a.id !== boundary.actionId && [job.workspaceCleanup?.path, job.thread?.worktreePath, job.dismissedWorktreePath].some(p => p && cleanupActionPending(a, p)))) throw new Error('Operator cleanup outcome is uncertain; preserve workspace pending inspection');
    // A recorded workspace that is neither on disk nor registered leaves nothing to clean; verifying it every retry only churns.
    const recorded = [...new Set([job.workspaceCleanup?.path, job.thread?.worktreePath, job.dismissedWorktreePath].filter((p): p is string => !!p).map(canonicalPath))];
    const configured = c.projects.find(p => p.kanvilId === job.projectId);
    const registered = recorded.length && configured ? (await worktrees(configured.repoPath)).map(t => canonicalPath(t.path)) : [];
    if (recorded.length && recorded.every(p => !existsSync(p) && !registered.includes(p))) {
      store.record('cleanup.confirmed', 'Already-absent workspace finalized', { path: recorded[0], outcome: 'already-absent', physicalRemoval: false }, job.id);
      job.workspaceCleanedAt = new Date().toISOString(); job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job);
      maintenance({ state: 'complete', lastSuccess: job.workspaceCleanedAt });
      return;
    }
    // A worktree of a project that is no longer configured cannot be verified; keep it quietly instead of alarming every retry.
    if (!configured) { job.workspaceCleanupError = 'Project is no longer configured; worktree kept'; job.workspaceCleanupBlockedAt = new Date().toISOString(); store.save(job); return; }
    const project = projectFor(c, job), fresh = await t3.shell(true), thread = structuredClone(fresh.threads.find(t => t.id === job.threadId));
    if (!thread) throw new Error('Completion thread is unavailable; use explicit deletion review');
    if (thread.projectId !== project.t3Id) throw new Error('Thread no longer belongs to its Factory project');
    const commands = thread.pendingBackgroundTasks.some(t => t.kind === 'command');
    let reportText: string | undefined, reportWrittenAt = Infinity;
    if (commands || job.commandStop || !job.completedAt) {
      reportText = readFileSync(job.reportPath, 'utf8');
      reportWrittenAt = statSync(job.reportPath).mtimeMs;
      const report = readCompletionReport(job);
      if (report.status === 'awaiting-human') throw new Error('Completion is awaiting human input');
      await verifyCompletionReport(c, kanvil, job, thread, report);
      if (job.kind === 'ticket') {
        const task = await kanvil.task(job.taskId!, project.kanvilId);
        if (!project.doneStatuses.includes(task.status)) throw new Error('Ticket is no longer Done');
      }
      checkOwner();
      job.prUrls = report.prUrls;
      job.completedAt ??= job.dismissedAt ?? new Date().toISOString();
      store.save(job);
    }
    const snapshotAt = thread.updatedAt;
    const completedAt = Date.parse(job.completedAt!);
    const userCompletedAt = Math.min(completedAt, reportWrittenAt);
    const busy = (t: Thread) => executing(t, c.monitoringTimeoutMinutes, false) || waiting(t) || !!t.orphanedRun || t.pendingBackgroundTasks.some(task => task.kind !== 'monitor' && !(t.id === job.threadId && task.kind === 'command'));
    const resumed = (t: Thread) => Date.parse(t.latestUserMessageAt ?? job.createdAt) > userCompletedAt || Date.parse(t.latestRunCompletedAt ?? job.createdAt) > completedAt;
    // T3 could still recover an orphaned run, so its workspace stays until T3 ends the run.
    if (thread.orphanedRun) throw new Error('Thread has an orphaned T3 run; settle it in T3 before workspace cleanup');
    if (busy(thread)) throw new Error('Workspace still has active or pending work');
    if (resumed(thread)) throw new Error('Completed thread has resumed since completion');
    const pending = job.workspaceCleanup, workspace = pending?.path ?? thread.worktreePath;
    if (!workspace && commands) throw new Error('Command workspace ownership cannot be verified');
    if (!workspace) { job.workspaceCleanedAt = new Date().toISOString(); store.save(job); return; }
    const path = canonicalPath(workspace);
    // The job's own record of this path is the evidence that lets a leftover directory count as removable.
    const physical = await inspectWorkspace(project.repoPath, path, false, undefined, true);
    if ((physical.present || physical.registered) && !physical.removable) throw new Error('Preserve unregistered, locked or primary workspace');
    if (physical.tracked || physical.untracked) throw new Error(`Preserve workspace changes: ${physical.tracked} tracked, ${physical.untracked} untracked`);
    const assigned = assignedBranch(job);
    if (!assigned) throw new Error('Workspace was not assigned by a Factory launch');
    const checkout = physical.present && !physical.leftover;
    const checkoutBranch = checkout ? await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
    const branch = pending?.branch ?? (checkoutBranch && checkoutBranch !== 'HEAD' ? checkoutBranch : thread.branch ?? assigned);
    if (thread.worktreePath && canonicalPath(thread.worktreePath) !== path) throw new Error('Thread workspace changed during cleanup');
    if (path === canonicalPath(project.repoPath)) throw new Error('Preserve the primary checkout');
    const bound = (t: Thread) => t.worktreePath != null && (canonicalPath(t.worktreePath) === path || canonicalPath(t.worktreePath).startsWith(path + sep));
    // T3 binds subagents to their parent's worktree. They belong to the job, but only once idle.
    const shared = (threads: Thread[], subagents: Thread[]) => threads.some(t => t.id !== thread.id && !subagents.some(s => s.id === t.id) && bound(t));
    const subagents = subagentDescendants(fresh.threads, thread.id);
    if (shared(fresh.threads, subagents)) throw new Error('Workspace is shared with another thread');
    if (subagents.some(t => busy(t) || resumed(t))) throw new Error('Workspace is shared with an active subagent');
    const head = await verifyCleanupHead(c, store, kanvil, job, fresh.threads, branch, path);
    if (pending && pending.head !== head) throw new Error('Verified workspace head changed');
    if (checkout) {
      if ((await dirtyEntries(path)).length || await git(path, ['rev-parse', 'HEAD']) !== head || (checkoutBranch !== branch && checkoutBranch !== 'HEAD')) throw new Error('Preserve dirty or changed workspace');
    }
    if (commands) {
      if (job.commandStop && job.commandStop.status !== 'confirmed') throw new Error(`Command stop ${job.commandStop.status}; awaiting T3 confirmation`);
      await t3.stop(thread.id, async raw => {
        const bounded = z.object({
          thread: z.object({ id: z.literal(thread.id), projectId: z.literal(thread.projectId), worktreePath: z.literal(thread.worktreePath), branch: z.literal(thread.branch) }).passthrough(),
          runs: z.array(z.object({ status: z.string() })),
          messages: z.array(z.object({ role: z.string(), createdAt: z.iso.datetime({ offset: true }) })),
          runtimeRequests: z.array(z.object({ status: z.string(), resolvedAt: z.string().nullable() })),
          turnItems: z.array(z.object({ type: z.string(), status: z.string() })),
          providerThreads: z.array(z.object({ pendingBackgroundTasks: z.array(z.object({ kind: z.string() })).nullish() })),
          subagents: z.array(z.object({ status: z.string() })),
        }).parse(raw);
        // Persisted todo lists display the plan; their item status is not background execution.
        if (bounded.runs.some(r => !['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'].includes(r.status)) ||
            bounded.runtimeRequests.some(r => r.status === 'pending' || (r.resolvedAt && Date.parse(r.resolvedAt) > completedAt)) ||
            bounded.messages.some(m => m.role === 'user' && Date.parse(m.createdAt) > userCompletedAt) ||
            bounded.turnItems.some(i => !['completed', 'failed', 'cancelled', 'interrupted'].includes(i.status) && !['command_execution', 'todo_list'].includes(i.type)) ||
            bounded.providerThreads.some(p => p.pendingBackgroundTasks?.some(t => t.kind !== 'command')) ||
            bounded.subagents.some(a => !['completed', 'failed', 'cancelled', 'interrupted'].includes(a.status))) throw new Error('Bounded thread has new or non-command work');
        await verifyCompletionReport(c, kanvil, job, thread, readCompletionReport(job));
        if (readFileSync(job.reportPath, 'utf8') !== reportText || (await dirtyEntries(path)).length || await git(path, ['rev-parse', 'HEAD']) !== head || await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']) !== checkoutBranch) throw new Error('Completion report or workspace changed before command stop');
        const latest = await t3.shell(true), confirmed = latest.threads.find(t => t.id === thread.id), children = subagentDescendants(latest.threads, thread.id);
        checkOwner();
        if (!confirmed || confirmed.updatedAt !== snapshotAt || confirmed.projectId !== thread.projectId || confirmed.worktreePath !== thread.worktreePath || confirmed.branch !== thread.branch || busy(confirmed) || resumed(confirmed) || confirmed.activeRunId || confirmed.pendingRuntimeRequest || confirmed.pendingBackgroundTasks.some(t => t.kind !== 'command') || shared(latest.threads, children) || children.some(t => busy(t) || resumed(t) || t.pendingBackgroundTasks.length)) throw new Error('Thread or workspace changed before command stop');
        job.commandStop = { status: 'requested', requestedAt: new Date().toISOString() };
        job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job);
        log('job-command-stop-requested', { jobId: job.id, threadId: thread.id });
      });
      const confirmation = (await t3.shell(true)).threads.find(t => t.id === thread.id);
      checkOwner();
      if (!confirmation || confirmation.pendingBackgroundTasks.length || busy(confirmation) || resumed(confirmation)) throw new Error('Command stop requested; awaiting T3 confirmation');
      // Even immediate confirmation advances removal only on a subsequent maintenance pass.
      job.commandStop!.status = 'confirmed'; job.commandStop!.confirmedAt = new Date().toISOString(); store.save(job);
      return;
    }
    if (job.commandStop && job.commandStop.status !== 'confirmed') {
      job.commandStop.status = 'confirmed'; job.commandStop.confirmedAt = new Date().toISOString();
      job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job);
      log('job-command-stop-confirmed', { jobId: job.id, threadId: thread.id });
    }
    const monitored = [thread, ...subagents].filter(t => t.pendingBackgroundTasks.length);
    if (monitored.length) {
      for (const t of monitored) await mutate(() => t3.stop(t.id));
      return;
    }
    const boundSubagents = subagents.filter(bound);
    if (boundSubagents.length) {
      for (const t of boundSubagents) await mutate(() => t3.dispatch({ type: 'thread.metadata.update', commandId: randomUUID(), threadId: t.id, expectedWorktreePath: t.worktreePath, worktreePath: null, branch: null }));
      return; // Detach owned subagents before the job thread, one step per cycle.
    }
    if (thread.worktreePath) {
      job.workspaceCleanup = { path, branch, head }; job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job);
      await mutate(() => t3.dispatch({ type: 'thread.metadata.update', commandId: randomUUID(), threadId: thread.id, expectedWorktreePath: thread.worktreePath, worktreePath: null, branch: null }));
      return; // Let T3 detach the idle provider session before removing its directory.
    }
    // T3 can leave this thread's idle setup shell open in the workspace. Close only its idle terminals; the process check stays authoritative.
    const terminals = (await t3.terminals()).filter(t => t.threadId === thread.id && (t.status === 'starting' || t.status === 'running'));
    if (terminals.some(t => t.status === 'starting' || t.hasRunningSubprocess)) throw new Error('A T3 terminal for this thread is still running a command');
    if (terminals.length) {
      for (const t of terminals) await mutate(() => t3.closeTerminal(thread.id, t.terminalId));
      return; // Let the shells exit before checking running processes.
    }
    const removal = await removeWorkspace(project.repoPath, path, false, async () => {
      if (!boundary.processes) await reapOrphans(path);
      const cwds = await (boundary.processes ?? processWorkspaces)();
      if (cwds.some(cwd => cwd === path || cwd.startsWith(path + sep))) throw new Error('A running process is still using the workspace');
      const latest = await t3.shell(true), confirmed = latest.threads.find(t => t.id === thread.id), latestSubagents = subagentDescendants(latest.threads, thread.id);
      if (!confirmed || confirmed.updatedAt !== snapshotAt || confirmed.worktreePath !== null || executing(confirmed, c.monitoringTimeoutMinutes) || waiting(confirmed) || confirmed.pendingBackgroundTasks.length || shared(latest.threads, latestSubagents) || latestSubagents.some(t => bound(t) || busy(t) || resumed(t) || t.pendingBackgroundTasks.length)) throw new Error('Thread or workspace changed before removal');
      await verifyIdleProjection(t3, confirmed, job.commandStop?.status === 'confirmed');
      for (const child of latestSubagents) await verifyIdleProjection(t3, child);
      if (checkout && (await git(path, ['rev-parse', 'HEAD']) !== head || (await dirtyEntries(path)).length || await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']) !== checkoutBranch)) throw new Error('Workspace changed before removal');
      checkOwner();
    }, () => { mutationUncertain = true; }, true);
    mutationUncertain = false;
    store.record('cleanup.confirmed', removal.outcome === 'removed' ? 'Worktree physically removed' : 'Already-absent workspace finalized', { path, ...removal }, job.id);
    job.workspaceCleanedAt = new Date().toISOString(); job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job);
    maintenance({ state: 'complete', lastSuccess: job.workspaceCleanedAt });
    log('job-workspace-cleaned', { jobId: job.id, threadId: job.threadId, path });
  } catch (error) {
    const reason = safeError(error);
    maintenance({ state: 'blocked', error: reason });
    const current = store.job(job.id);
    if (!current) { log('job-workspace-cleanup-blocked', { jobId: job.id, reason }); return; }
    if (identity(current) !== ownership) {
      current.workspaceCleanupError = reason; current.workspaceCleanupBlockedAt = new Date().toISOString(); store.save(current); return;
    }
    if (job.commandStop?.status === 'requested' && !reason.startsWith('Command stop requested;')) {
      job.commandStop.status = 'uncertain'; job.commandStop.error = reason;
    }
    if (job.workspaceCleanupError !== reason) log('job-workspace-cleanup-blocked', { jobId: job.id, reason });
    job.workspaceCleanupError = reason; job.workspaceCleanupBlockedAt = new Date().toISOString(); store.save(job);
    return { uncertain: mutationUncertain };
  } finally {
    if (JSON.parse(store.get('cleanupMaintenance') ?? '{}').state === 'inspecting') maintenance({ state: 'pending' });
  }
}

// The owner used this provider too recently for ticket and discovery work; reviews ignore it.
const idleBlocked = (c: Config, activity: { active: boolean; idleMinutes: number }) => activity.active || activity.idleMinutes < c.idleMinutes;
export async function personalActivity(t3: T3, threads: Thread[], jobs: Job[], store: Store, monitoringTimeoutMinutes = DEFAULT_MONITORING_TIMEOUT_MINUTES, driver = 'claudeAgent', instances = new Map<string, string>()) {
  // Old polling-based timestamps can be inflated by passive commands and stale child markers. Rebuild once
  // from T3's actual events, then retain this corrected clock across archiving/restarts.
  const clockKey = driver === 'claudeAgent' ? 'lastPersonalActivity.v3' : `lastPersonalActivity.${driver}.v3`;
  const autonomousRoots = t3.config?.autonomousThreadIds ?? [];
  const scopeKey = `personalActivityScope.${driver}`, scope = JSON.stringify([...new Set(autonomousRoots)].sort());
  const rebuild = store.get(scopeKey) !== scope;
  let last = (!rebuild && store.get(clockKey)) || '1970-01-01T00:00:00.000Z';
  const owned = new Map(jobs.map(j => [j.threadId, j]));
  const threadsById = new Map(threads.map(t => [t.id, t]));
  const autonomous = new Set(autonomousRoots);
  const children = new Map<string, string[]>();
  for (const t of threads) {
    if (t.lineage?.relationshipToParent !== 'subagent' || !t.lineage.parentThreadId) continue;
    const parent = t.lineage.parentThreadId;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(t.id);
  }
  for (const id of autonomous) {
    for (const child of children.get(id) ?? []) autonomous.add(child);
    for (const task of threadsById.get(id)?.pendingBackgroundTasks ?? []) {
      if (typeof task.childThreadId === 'string') autonomous.add(task.childThreadId);
    }
  }
  let active = false;
  for (const t of threads) {
    if (autonomous.has(t.id)) continue;
    if ((instances.get(t.providerInstanceId) ?? t.providerInstanceId) !== driver && t.modelSelection.instanceId !== driver) continue;
    const job = owned.get(t.id);
    if (job?.state === 'dismissed' && t.settledOverride === 'settled' && !executing(t, monitoringTimeoutMinutes)) continue;
    if ((!job || ['complete', 'dismissed'].includes(job.state)) && providerExecuting(t, threadsById, monitoringTimeoutMinutes)) {
      active = true; last = new Date().toISOString();
    }
    if (job) {
      // T3 responses resume directly. Count replies even in already-completed factory threads.
      if (store.get(`seenOwned:${t.id}`) !== t.updatedAt) {
        const detail = await backgroundRead(() => t3.detail(t.id));
        const personal = detail.messages.filter(m => m.role === 'user' && m.id !== job.messageId && !job.automationMessageIds?.includes(m.id));
        const latest = [...personal.map(m => m.createdAt), ...detail.responses.map(a => a.createdAt)].sort().at(-1);
        if (latest && latest > (job.lastPersonalActivity ?? '')) { job.lastPersonalActivity = latest; store.save({ ...store.job(job.id)!, lastPersonalActivity: latest }); }
        store.set(`seenOwned:${t.id}`, t.updatedAt);
      }
      if (job.lastPersonalActivity && job.lastPersonalActivity > last) last = job.lastPersonalActivity;
      if (['complete', 'dismissed'].includes(job.state) && job.lastPersonalActivity && t.latestRunCompletedAt && t.latestRunCompletedAt > last) last = t.latestRunCompletedAt;
      continue;
    }
    // A personal CI/test watcher consumes no Claude turn and must not renew idle time.
    if (t.latestRunCompletedAt && t.latestRunCompletedAt > last) last = t.latestRunCompletedAt;
    if (t.latestUserMessageAt && t.latestUserMessageAt > last) last = t.latestUserMessageAt;
    // An approval response can resume a turn without updating latestUserMessageAt.
    const seenKey = `seenPersonal.v3:${t.id}`;
    const seen = rebuild ? undefined : store.get(seenKey);
    if (t.updatedAt !== seen && Date.parse(t.updatedAt) > Date.now() - 86_400_000) {
      const detail = await backgroundRead(() => t3.detail(t.id));
      for (const a of detail.responses) if (a.createdAt > last) last = a.createdAt;
      store.set(seenKey, t.updatedAt);
    }
  }
  store.set('lastPersonalActivity', last);
  store.set(clockKey, last);
  store.set(scopeKey, scope);
  return { active, last, idleMinutes: Math.max(0, (Date.now() - Date.parse(last)) / 60_000) };
}

const mergedSchema = z.object({ state: z.string(), headRefName: z.string(), headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/) });
// A merged pull request is immutable, so its head is remembered and never read from GitHub twice.
async function mergedPullRequest(project: Project, url: string, store?: Store) {
  const key = `prMerged:${url}`, known = store?.get(key);
  if (known) return mergedSchema.parse(JSON.parse(known));
  const pr = mergedSchema.parse(await gh(['pr', 'view', url, '--repo', project.githubRepo, '--json', 'state,headRefName,headRefOid']));
  if (pr.state === 'MERGED') store?.set(key, JSON.stringify(pr));
  return pr;
}
async function historicalArtifacts(project: Project, history: Job[], threads: Thread[], expectedBranch?: string, store?: Store) {
  const branches = new Map<string, string>(), inactiveThreads = new Set<string>();
  for (const job of history) {
    const thread = threads.find(t => t.id === job.threadId);
    // Jobs dispatched before protocol v2 stored a turn-start bootstrap; newer ones store the launch input.
    const branch = expectedBranch ?? job.workspaceCleanup?.branch ?? job.dismissedBranch ?? assignedBranch(job) ?? thread?.branch;
    if (!branch) continue;
    if (job.state === 'dismissed') {
      // Settled after cleanup unbound the thread: the head cleanup verified as released stands in for the one dismissal could not read.
      const dismissedHead = job.dismissedHead ?? job.workspaceCleanup?.head;
      if (!job.dismissedAt || !dismissedHead) continue;
      const cleanedBinding = (job.workspaceCleanedAt || job.workspaceCleanup) && thread?.branch === null && thread.worktreePath === null;
      if (thread && (thread.settledOverride !== 'settled' || executing(thread) || (thread.branch !== branch && !cleanedBinding) || Date.parse(thread.latestUserMessageAt ?? job.createdAt) > Date.parse(job.dismissedAt) || Date.parse(thread.latestRunCompletedAt ?? job.createdAt) > Date.parse(job.dismissedAt))) continue;
      const worktreePath = thread?.worktreePath ?? job.dismissedWorktreePath ?? job.workspaceCleanup?.path;
      if (worktreePath && existsSync(join(worktreePath, '.git'))) {
        const [head, changes] = await readAll([git(worktreePath, ['rev-parse', 'HEAD']), dirtyEntries(worktreePath)]);
        if (head !== dismissedHead || changes.length) continue;
      }
      branches.set(branch, dismissedHead); if (thread) inactiveThreads.add(thread.id); continue;
    }
    // The completed thread is inactive while idle, unresumed, and clean at its verified head.
    const release = async (head: string) => {
      if (!thread || executing(thread) || waiting(thread) || !(thread.branch === branch || (thread.branch === null && thread.worktreePath === null)) || !job.completedAt ||
          Date.parse(thread.latestUserMessageAt ?? job.createdAt) > Date.parse(job.completedAt) ||
          Date.parse(thread.latestRunCompletedAt ?? job.createdAt) > Date.parse(job.completedAt)) return;
      if (thread.worktreePath && existsSync(join(thread.worktreePath, '.git'))) {
        const [current, changes] = await readAll([git(thread.worktreePath, ['rev-parse', 'HEAD']), dirtyEntries(thread.worktreePath)]);
        if (current !== head || changes.length) return;
      }
      inactiveThreads.add(thread.id);
    };
    if (!job.prUrls.length) {
      // Closed without delivery: the branch must still be untouched at its released creation commit.
      const tip = await untouchedHead(project, branch, thread?.worktreePath);
      if (tip) { branches.set(branch, tip); await release(tip); }
      continue;
    }
    for (const url of job.prUrls) {
      const u = new URL(url), prefix = `/${project.githubRepo}/pull/`;
      if (u.origin !== 'https://github.com' || !u.pathname.startsWith(prefix) || !/^\d+$/.test(u.pathname.slice(prefix.length))) continue;
      const pr = await mergedPullRequest(project, url, store);
      if (pr.state !== 'MERGED') continue;
      // Agents may push the Factory branch under another name; the local branch tip then identifies the delivered PR.
      if (pr.headRefName !== branch && await branchTip(project, branch) !== pr.headRefOid) continue;
      branches.set(branch, pr.headRefOid); branches.set(pr.headRefName, pr.headRefOid);
      await release(pr.headRefOid);
      break;
    }
  }
  return { branches, inactiveThreads };
}

async function openPullRequests(project: Project, store?: Store, fresh = false) {
  const read = async () => {
    const client = store && githubClients.get(store);
    return pullRequestsSchema.parse(client ? await client.pullRequests(project.githubRepo) : await gh(['pr', 'list', '--repo', project.githubRepo, '--state', 'open', '--limit', '1000', '--json', 'title,headRefName,body']));
  };
  return store ? repositoryRead(store, `prs:${project.githubRepo}`, read, fresh) : read();
}
// Extend historical release checks to explicit settlements outside Factory, without releasing any Factory-owned work by this path.
async function ticketArtifacts(project: Project, key: string, taskId: string, threads: Thread[], jobs: Job[], store: Store, prs = openPullRequests(project, store)) {
  const openPR = (await prs).some(pr => mentionsTicket(`${pr.title}\n${pr.headRefName}\n${pr.body}`, key));
  const history = jobs.filter(j => j.taskId === taskId && ['complete', 'dismissed'].includes(j.state));
  const artifacts = await historicalArtifacts(project, history, threads, undefined, store);
  for (const thread of threadsReferencingTicket(threads, project.t3Id, key)) {
    if (jobs.some(j => j.threadId === thread.id) || thread.settledOverride !== 'settled' || executing(thread) || waiting(thread) || thread.activeRunId || thread.pendingRuntimeRequest || thread.pendingBackgroundTasks.length || !thread.branch || !thread.worktreePath || !existsSync(thread.worktreePath)) continue;
    // A shared checkout or branch can still belong to work whose title does not mention this ticket.
    if (threads.some(t => t.id !== thread.id && (t.worktreePath === thread.worktreePath || t.projectId === project.t3Id && t.branch === thread.branch))) continue;
    try {
      const head = await untouchedHead(project, thread.branch, thread.worktreePath);
      if (!head || await git(thread.worktreePath, ['status', '--porcelain']) || await git(thread.worktreePath, ['branch', '--show-current']) !== thread.branch) continue;
      artifacts.branches.set(thread.branch, head); artifacts.inactiveThreads.add(thread.id);
    } catch { /* Unverifiable discussions retain their duplicate protection. */ }
  }
  return { ...artifacts, openPR };
}

const READ_CONCURRENCY = 6;
const githubClients = new WeakMap<Store, Pick<GitHub, 'pullRequests'>>();
const repositoryReads = new WeakMap<Store, { context: ReadContext; entries: Map<string, { at?: number; settled: boolean; pending: Promise<unknown> }> }>();
function repositoryRead<T>(store: Store, key: string, read: () => Promise<T>, fresh = false): Promise<T> {
  let cache = repositoryReads.get(store);
  if (!cache) {
    cache = { context: new ReadContext(), entries: new Map() }; repositoryReads.set(store, cache);
    const owned = cache;
    store.onClose = () => { owned.context.controller.abort(new Error('Factory ledger closed')); owned.entries.clear(); };
  }
  let entry = cache.entries.get(key);
  if (!entry || (!readContext() && entry.settled) || (fresh ? entry.settled || entry.at !== undefined && entry.at < (readContext()?.startedAtMonotonic ?? performance.now()) : entry.at !== undefined && performance.now() - entry.at > 1000)) {
    let at: number | undefined;
    const pending = cache.context.run(async () => {
      // Let already-queued callers join before starting I/O or a blocking spawn.
      // Once capture starts, later fresh callers must obtain a new snapshot.
      await backgroundCheckpoint(); at = performance.now(); return read();
    });
    entry = { get at() { return at; }, settled: false, pending }; cache.entries.set(key, entry);
    const owned = entry, entries = cache.entries;
    void pending.then(() => { owned.settled = true; }, () => { if (entries.get(key) === owned) entries.delete(key); });
  }
  const pending = entry.pending as Promise<T>;
  return readPhase(key.startsWith('prs:') ? 'github.read' : 'git.read', signal => waitFor(pending, signal));
}
// Limit I/O, rather than recursive walks, so deep or shared ancestry cannot deadlock.
function readLimiter() {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (active < READ_CONCURRENCY) active++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try { return await read(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

// Retain successful/shared reads, but let a cancelled or failed read be retried in a fresh context.
function cachedRead<T>(cache: Map<string, Promise<T>>, id: string, read: () => Promise<T>): Promise<T> {
  if (!cache.has(id)) cache.set(id, read().catch(error => { cache.delete(id); throw error; }));
  return cache.get(id)!;
}

const taskOwners = (jobs: Job[]) => new Map(jobs.filter(job => !['complete', 'dismissed'].includes(job.state)).map(job => [job.taskId, job]));
const ticketPreparations = new WeakMap<Store, Map<string, Candidate>>();
function preparingLabels(store: Store) {
  return [...(ticketPreparations.get(store)?.values() ?? [])].map(ticket => ({ state: 'dispatching' as const, threadId: '', projectId: ticket.projectId, labels: ticket.labels?.map(label => label.name) }));
}
function branchConflict(key: string, refs: string, released: Map<string, string>) {
  if (!released.size) return mentionsTicket(refs, key);
  const unmatched = refs.split('\n').filter(line => {
    const [ref, head] = line.split('\t');
    return ![...released].some(([branch, mergedHead]) => head === mergedHead && (ref === `refs/heads/${branch}` || ref.startsWith('refs/remotes/') && ref.endsWith(`/${branch}`)));
  }).join('\n');
  return mentionsTicket(unmatched, key);
}

// Unnamed scheduling never takes a ticket from a running Epic, so the model and overrides chosen for the Epic always apply.
const activeEpicPlans = (store: Store) => store.plans().filter(plan => plan.state === 'active' && plan.epic);
function runningPlanHold(store: Store) {
  const active = activeEpicPlans(store);
  const queued = new Set(store.plans().filter(plan => plan.state === 'active' && plan.queued).flatMap(plan => planTickets(plan).map(ticket => ticket.id)));
  const epics = new Set(active.map(plan => plan.epic!.id)), tickets = new Set(active.flatMap(plan => plan.tickets.map(ticket => ticket.id)));
  return (ticket: Pick<Task, 'id' | 'epicId'>) => queued.has(ticket.id) ? 'Waits for its queued run' : tickets.has(ticket.id) || ticket.epicId && epics.has(ticket.epicId) ? 'Runs with its Epic' : '';
}
// An archived Epic can never start, so its members are not held for it. An unreadable catalog holds every member.
const unstartedEpicHold = (epics: Epic[] | undefined) => (ticket: Pick<Task, 'epicId'>) =>
  ticket.epicId && !epics?.find(epic => epic.id === ticket.epicId)?.archived ? 'Waits for its Epic to start' : '';
// Why unnamed scheduling leaves a ticket to its Epic. `epics` is the catalog read when the setting is on.
function epicHold(c: Config, store: Store, epics?: Epic[]) {
  const running = runningPlanHold(store), unstarted = unstartedEpicHold(epics);
  return (ticket: Pick<Task, 'id' | 'epicId'>) => running(ticket) || (c.holdEpicTicketsUntilStarted ? unstarted(ticket) : '');
}

export async function inventory(c: Config, kanvil: Kanvil, threads: Thread[], jobs: Job[], store: Store, ticketKey?: string, cancelledFinished = false) {
  const projects = c.projects.filter(p => p.enabled);
  const heldForEpic = ticketKey ? () => '' : epicHold(c, store, c.holdEpicTicketsUntilStarted ? await kanvil.epics().catch(() => undefined) : undefined);
  const all = new Map<string, Task>();
  const listedProjects = ticketKey ? projects.filter(p => ticketKey.startsWith(`${p.key}-`)) : projects;
  // Only ready columns can yield work; a named ticket is read from every column so its real status can be reported.
  await readAll(listedProjects.map(async p => {
    try {
      const tasks = ticketKey ? [await kanvil.findTask(ticketKey, p.kanvilId)] : await listTasks(kanvil, p.kanvilId, p.readyStatuses);
      for (const task of tasks) all.set(task.id, task);
    } catch (error) { if (!(ticketKey && error instanceof KanvilTaskNotFound)) throw error; }
  }));
  const owned = taskOwners(jobs);
  const ready: Candidate[] = [], skipped: Skipped[] = [];
  const potential = [...all.values()].filter(t => {
    const p = projects.find(p => p.kanvilId === t.projectId)!;
    const key = `${p.key}-${t.number}`;
    if (ticketKey && key !== ticketKey) return false;
    const reason = !p.readyStatuses.includes(t.status) ? `Ticket is ${t.status}; it must be in ${p.readyStatuses.join(' or ')}`
      : owned.has(t.id) ? `Ticket already has a ${owned.get(t.id)!.state} factory run`
      : taskHold(t);
    if (reason && ticketKey) skipped.push({ key, reason, id: t.id });
    return !reason;
  });
  if (ticketKey && ![...all.values()].some(t => `${projects.find(p => p.kanvilId === t.projectId)!.key}-${t.number}` === ticketKey)) skipped.push({ key: ticketKey, reason: 'Ticket was not found in the enabled project' });
  // Caches hold promises so concurrent lookups of one task share a single read.
  const finalStatuses = new Map<string, Promise<string[]>>(c.projects.map(p => [p.kanvilId, Promise.resolve(cancelledFinished ? [...p.doneStatuses, 'cancelled'] : p.doneStatuses)]));
  const fetched = new Map<string, Promise<Task>>();
  const getTask = (id: string): Promise<Task> => {
    const known = all.get(id);
    if (known) return Promise.resolve(known);
    return cachedRead(fetched, id, () => kanvil.task(id, undefined, true).then(task => { all.set(id, task); return task; }));
  };
  const isDone = async (id: string) => {
    const task = await getTask(id);
    const statuses = await cachedRead(finalStatuses, task.projectId, () => kanvil.columns(task.projectId).then(r => z.array(z.object({ slug: z.string(), isFinal: z.boolean() }).passthrough()).parse(r).filter(c => c.isFinal).map(c => c.slug)));
    return statuses.includes(task.status);
  };
  const relationCache = new Map<string, Promise<z.infer<typeof relationsSchema>>>();
  const nativeLeaf = (task: Task) => task.version !== undefined && task.readiness?.ready === true;
  const relationsFor = (id: string) => cachedRead(relationCache, id, async () => {
    const task = await getTask(id);
    return relationsSchema.parse(await kanvil.relations(id, false, !nativeLeaf(task), task));
  });
  // Drain each project's independent artifact reads before moving on to ticket batches.
  const needed = [...new Set(potential.map(t => t.projectId))].map(id => projects.find(p => p.kanvilId === id)!);
  const refs = new Map<string, string>(), prs = new Map<string, Awaited<ReturnType<typeof openPullRequests>>>();
  await readAll(needed.map(async p => {
    const [branches, pulls] = await backgroundRead(() => readAll([repositoryRead(store, `refs:${p.repoPath}`, () => git(p.repoPath, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes'])), openPullRequests(p, store)]));
    refs.set(p.kanvilId, branches); prs.set(p.kanvilId, pulls);
  }));
  const limit = readLimiter();
  const { blockersOf, openChildren } = dependencyRules(relationsFor, isDone, limit);
  const priorityFor = (task: Task, project: Project): TicketPriority => ({ priority: task.priority, labelRank: ticketLabelRank(task.labels ?? [], project.priorityLabels) });
  const inheritedPriority = async (task: Task, project: Project): Promise<TicketPriority> => {
    let priority = priorityFor(task, project);
    const pending = [task.id], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const relation of await limit(() => relationsFor(id))) {
        if (relation.relationType !== 'blocks' || relation.sourceTaskId !== id) continue;
        const dependent = await limit(() => getTask(relation.targetTaskId)).catch(() => undefined);
        const owner = dependent && projects.find(p => p.kanvilId === dependent.projectId);
        if (!dependent || !owner || owner.doneStatuses.includes(dependent.status)) continue;
        const downstream = priorityFor(dependent, owner);
        if (compareTicketPriority(downstream, priority) < 0) priority = downstream;
        pending.push(dependent.id);
      }
    }
    return priority;
  };
  // Tickets are examined concurrently (bounded) and recorded in their original order.
  type Verdict = Skipped | { candidate: Candidate };
  const examine = async (t: Task): Promise<Verdict> => {
    const p = projects.find(p => p.kanvilId === t.projectId)!;
    const key = `${p.key}-${t.number}`;
    const hold = taskHold(t);
    if (hold) return { key, id: t.id, reason: hold };
    const leftToEpic = heldForEpic(t);
    if (leftToEpic) return { key, id: t.id, reason: leftToEpic };
    let difficulty: Candidate['difficulty'];
    try { difficulty = taskDifficulty(t); }
    catch { return { key, id: t.id, reason: 'Conflicting difficulty labels' }; }
    if (!difficulty) return { key, id: t.id, reason: 'Ticket needs a native difficulty before dispatch' };
    let reason = '';
    const blockers = await blockersOf(t.id), blockedBy: string[] = blockers === 'cycle' ? [] : blockers;
    if (blockers === 'cycle' || blockers.length) reason = 'Ticket or ancestor has an unfinished blocker or relation cycle';
    const children = nativeLeaf(t) ? [] : await openChildren(t.id);
    if (children.length) { reason = 'Umbrella has unfinished children; select leaves instead'; blockedBy.push(...children); }
    const candidate = async (): Promise<Candidate> => ({ id: t.id, projectId: t.projectId, key, title: t.title, createdAt: t.createdAt, difficulty, automationReady: t.automationReady, labels: t.labels ?? [], ...await inheritedPriority(t, p) });
    // A blocked ticket keeps what the queue needs to place it behind its blockers.
    if (reason && blockedBy.length) return { key, id: t.id, reason, blockedBy, ticket: await candidate() };
    let artifacts = { branches: new Map<string, string>(), inactiveThreads: new Set<string>(), openPR: false };
    if (!reason) {
      try { artifacts = await ticketArtifacts(p, key, t.id, threads, jobs, store, Promise.resolve(prs.get(p.kanvilId)!)); }
      catch { reason = 'Previous work could not be verified; inspect its PR and worktree before restarting'; }
    }
    if (!reason && threadsReferencingTicket(threads, p.t3Id, key).some(thread => !artifacts.inactiveThreads.has(thread.id))) reason = 'Existing T3 thread or branch references this ticket';
    if (!reason) {
      if (branchConflict(key, refs.get(p.kanvilId)!, artifacts.branches)) reason = 'Existing Git branch references this ticket';
      if (artifacts.openPR) reason = 'Existing open PR references this ticket';
    }
    if (reason) return { key, id: t.id, reason };
    return { candidate: await candidate() };
  };
  const verdicts: Verdict[] = new Array(potential.length);
  for (let start = 0; start < potential.length; start += READ_CONCURRENCY) {
    await backgroundCheckpoint();
    const batch = await backgroundRead(() => readAll(potential.slice(start, start + READ_CONCURRENCY).map(examine)));
    batch.forEach((verdict, i) => { verdicts[start + i] = verdict; });
  }
  for (const v of verdicts) {
    if ('candidate' in v) ready.push(v.candidate);
    else {
      const task = all.get(v.id!)!;
      let difficulty: Candidate['difficulty'];
      try { difficulty = taskDifficulty(task); } catch { /* Keep the classification refusal. */ }
      skipped.push({ ...v, ticket: { id: task.id, key: v.key, projectId: task.projectId, title: task.title, createdAt: task.createdAt, priority: task.priority, difficulty, automationReady: task.automationReady, ...v.ticket, labels: task.labels ?? [] } });
    }
  }
  return { ready, skipped, selected: selectTicket(ready, store.get('lastProject'), projects.map(p => p.kanvilId)) };
}

// Queue display is independent of provider admission and completion verification.
export async function refreshInventory(c: Config, store: Store, t3: T3, kanvil: Kanvil) {
  await publishQueue(c, store, kanvil, await inventory(c, kanvil, (await t3.shell()).threads, store.jobs(), store));
}
async function publishQueue(c: Config, store: Store, kanvil: Kanvil, queue: Pick<Queue, 'ready' | 'skipped'>) {
  store.set('upNext', JSON.stringify(upNext(c, store, queue)));
  await refreshEpics(c, store, kanvil);
}

export interface Skipped { key: string; reason: string; id?: string; blockedBy?: string[]; ticket?: Candidate }
export interface CycleOptions { requestId?: string; dryRun?: boolean; doctor?: boolean; manual?: boolean; overrideLimits?: OverrideLimits; ticket?: string; upstream?: string; epic?: string; model?: string; provider?: DispatchProvider; chain?: 'first' | 'all'; continuation?: boolean }
// The thresholds this start skips; automatic work skips none.
export const skips = (options: Pick<CycleOptions, 'manual' | 'overrideLimits'>) => new Set<OverridableLimit>(!options.manual ? [] : options.overrideLimits === true ? overridableLimits : options.overrideLimits || []);
// The dependency rules every start obeys: unfinished blockers (a parent's count for its subtasks) and an umbrella's open children.
function dependencyRules(rels: (id: string) => Promise<z.infer<typeof relationsSchema>>, done: (id: string) => Promise<boolean>, limit = readLimiter()) {
  const relations = new Map<string, Promise<z.infer<typeof relationsSchema>>>(), finished = new Map<string, Promise<boolean>>();
  const relationsFor = (id: string) => cachedRead(relations, id, () => limit(() => rels(id)));
  const isDone = (id: string) => cachedRead(finished, id, () => limit(() => done(id)));
  const blockersOf = async (id: string, ancestors = new Set<string>()): Promise<string[] | 'cycle'> => {
    if (ancestors.has(id)) return 'cycle';
    const visited = new Set([...ancestors, id]);
    const found = await readAll((await relationsFor(id)).map(async r => {
      if (r.relationType === 'blocks' && r.targetTaskId === id && !await isDone(r.sourceTaskId)) return [r.sourceTaskId];
      if (r.relationType === 'subtask' && r.targetTaskId === id) return blockersOf(r.sourceTaskId, visited);
      return [];
    }));
    if (found.some(value => value === 'cycle')) return 'cycle';
    return [...new Set(found.flatMap(value => value === 'cycle' ? [] : value))];
  };
  const openChildren = async (id: string) => {
    const children = await readAll((await relationsFor(id)).filter(r => r.relationType === 'subtask' && r.sourceTaskId === id).map(async r => await isDone(r.targetTaskId) ? [] : [r.targetTaskId]));
    return [...new Set(children.flat())];
  };
  return { blockersOf, openChildren };
}
// A long-lived caller (the service) keeps one T3 client and one connected Kanvil client across passes;
// a one-shot caller leaves these out and the pass opens and closes its own.
export interface Clients { t3?: T3; kanvil?: Kanvil; github?: Pick<GitHub, 'pullRequests'>; deferCleanup?: boolean; deferReconcile?: boolean; backgroundInventory?: boolean; workKind?: 'tickets' | 'upstream' | 'chains'; providerDriver?: string; currentConfig?: () => Config; decide?: ReturnType<Store['decisionRecorder']> }
export type { Decision } from './store.ts';
type Queue = Awaited<ReturnType<typeof inventory>>;

// Running jobs retain reservations while commands can wake them without another admission check.
const holdsSlot = (job: Pick<Job, 'state'>, thread: Thread | undefined, timeout: number) =>
  !['complete', 'dismissed'].includes(job.state) && (['running', 'dispatching'].includes(job.state) || !!(thread && executing(thread, timeout)));

export function busyProviders(jobs: Job[], threads: Thread[], instances: Map<string, string>, timeout: number, limits: Config['concurrency'] = { claude: 1, codex: 1 }, planned = new Map<string, number>(), options: CycleOptions = {}): Set<string> {
  if (skips(options).has('providers')) return new Set();
  const counts = new Map(planned);
  for (const job of jobs) {
    const thread = threads.find(t => t.id === job.threadId);
    if (!holdsSlot(job, thread, timeout)) continue;
    const instance = job.modelSelection?.instanceId ?? thread?.modelSelection.instanceId ?? 'claudeAgent';
    const driver = job.providerDriver ?? instances.get(instance) ?? (thread && instances.get(thread.providerInstanceId)) ?? (['codex', 'claudeAgent'].includes(instance) ? instance : null);
    // Unknown ownership must be reconciled before any further automatic starts.
    if (driver !== 'codex' && driver !== 'claudeAgent') return new Set(['codex', 'claudeAgent']);
    counts.set(driver, (counts.get(driver) ?? 0) + 1);
  }
  return new Set(['claudeAgent', 'codex'].filter(driver => (counts.get(driver) ?? 0) >= limits[driver === 'codex' ? 'codex' : 'claude']));
}

// One occupancy snapshot serves every candidate in a synchronous selection. A new
// snapshot is taken after asynchronous work and again at the reservation boundary.
function labelCapacity(c: Config, jobs: Pick<Job, 'state' | 'threadId' | 'projectId' | 'labels'>[], threads: Thread[]) {
  const byThread = new Map<string, Thread>();
  for (const thread of threads) if (!byThread.has(thread.id)) byThread.set(thread.id, thread);
  const counts = new Map<string, Map<string, { running: number; full: number }>>();
  for (const job of jobs) {
    if (!counts.has(job.projectId)) counts.set(job.projectId, new Map());
    const project = counts.get(job.projectId)!, running = holdsSlot(job, byThread.get(job.threadId), c.monitoringTimeoutMinutes), full = !['complete', 'dismissed'].includes(job.state);
    for (const label of new Set(job.labels)) {
      const usage = project.get(label) ?? { running: 0, full: 0 };
      usage.running += Number(running); usage.full += Number(full); project.set(label, usage);
    }
  }
  return (ticket: { projectId: string; labels?: { name: string }[] }) => {
    const limits = c.projects.find(project => project.kanvilId === ticket.projectId)?.labelLimits ?? {};
    return ticket.labels?.map(label => label.name).find(name => {
      if (!(name in limits)) return false;
      const setting = limits[name], full = typeof setting !== 'number' && setting.mode === 'full';
      const held = counts.get(ticket.projectId)?.get(name)?.[full ? 'full' : 'running'] ?? 0;
      return held >= (typeof setting === 'number' ? setting : setting.limit);
    });
  };
}
// The first of a ticket's limited labels whose runs in its project already fill the limit.
export function fullLabel(c: Config, jobs: Pick<Job, 'state' | 'threadId' | 'projectId' | 'labels'>[], threads: Thread[], ticket: { projectId: string; labels?: { name: string }[] }): string | undefined {
  return labelCapacity(c, jobs, threads)(ticket);
}

type ProviderStream = {
  driver: string; provider: string; reason: string; active: string[]; planned: string[];
  models: { id: string; name: string; reason: string }[];
  quota?: Awaited<ReturnType<typeof readModelQuota>>; quotaError?: string;
};

// Admission and quota refreshes share publication ownership, independently per provider.
function streamUpdate(store: Store, key: string, drivers = ['claudeAgent', 'codex']) {
  const revisions = new Map(drivers.map(id => {
    const name = `${key}Revision:${id}`, revision = Number(store.get(name) ?? 0) + 1;
    store.set(name, String(revision)); return [id, revision] as const;
  }));
  return <T extends { driver: string }>(streams: T[]) => {
    const previous = JSON.parse(store.get(key) ?? '[]') as T[];
    const rows = new Map(previous.map(row => [row.driver, row]));
    for (const stream of streams) if (!rows.has(stream.driver) || revisions.get(stream.driver) === Number(store.get(`${key}Revision:${stream.driver}`))) rows.set(stream.driver, stream);
    store.set(key, JSON.stringify([...rows.values()]));
  };
}

// Temporary policy holds retain manual intent; invalid requests and uncertain launches never retry.
const limitHold = (reason: string) => ['label-limit', 'provider-disabled', 'provider-running', 'quota-reserve', 'quota-budget', 'waiting-for-idle', 'personal-provider-running', 'personal-provider-recently-active', 'gate-changed-before-dispatch', 'job-resumed-before-dispatch'].includes(reason);
const queuedPlan = (store: Store, key: string) => store.plans().find(plan => plan.state === 'active' && plan.queued && plan.target?.key === key);

export async function cycle(c: Config, store: Store, options: CycleOptions = {}, clients: Clients = {}): Promise<Decision> {
  if (options.provider && (!options.manual || options.model && options.model !== 'auto')) throw new Error('A provider choice requires manual automatic model selection');
  if (options.upstream && (!options.manual || !/^[\w.-]+\/[\w.-]+$/.test(options.upstream) || options.ticket || options.chain)) throw new Error('An upstream review requires a specific manual repository and no ticket options');
  if (options.epic && (!options.manual || options.ticket || options.chain || options.upstream)) throw new Error('An Epic start requires a manual request and no ticket, chain or upstream options');
  clients = { ...clients, decide: clients.decide ?? store.decisionRecorder({ workKind: clients.workKind ?? 'tickets', providerDriver: clients.providerDriver, manual: options.manual }) };
  if (!options.manual || options.upstream || options.epic || options.chain || options.dryRun || options.doctor) return cycleNow(c, store, options, clients);
  const run = () => queueManual(c, store, options, clients);
  return options.ticket ? store.exclusive([`manual-ticket:${options.ticket.trim().toUpperCase()}`], run) : run();
}

async function queueManual(c: Config, store: Store, options: CycleOptions, clients: Clients): Promise<Decision> {
  const queued = (plan: Plan): Decision => {
    const result = { reason: 'plan-started', at: new Date().toISOString(), ticket: plan.target!.key, planId: plan.id, plan, message: `${plan.target!.key} queued: ${plan.target!.note ?? 'waiting for run limits'}` };
    clients.decide!(result); log('decision', result); return result;
  };
  const existing = options.ticket && queuedPlan(store, options.ticket.trim().toUpperCase());
  if (existing) return queued(existing);
  const result = await cycleNow(c, store, options, clients);
  const outcomes = [result, ...(result.dispatches as Decision[] | undefined ?? [])];
  const hold = outcomes.find(outcome => limitHold(outcome.reason) || outcome.reason === 'no-ready-model' && (outcome.streams as { reason: string; models: { reason: string }[] }[] | undefined)?.some(stream => limitHold(stream.reason) || stream.models.some(model => limitHold(model.reason))));
  if (readContext()?.launched || outcomes.some(outcome => outcome.reason === 'dispatched') || !hold) return result;
  const t3 = clients.t3 ?? new T3(c.t3), kanvil = clients.kanvil ?? new Kanvil(c.kanvil, c.projects);
  if (!clients.kanvil) await kanvil.connect();
  try {
    const [shell, providers] = await readAll([t3.shell(), t3.providers()]);
    const instances = new Map(providers.map(provider => [provider.instanceId, provider.driver]));
    const inventoryNow = await inventory(c, kanvil, shell.threads, store.jobs(), store, options.ticket?.trim().toUpperCase());
    const models = c.models.filter(model => options.model && options.model !== 'auto' ? model.id === options.model : (model.automatic || !!options.provider) && (!options.provider || instances.get(model.model.instanceId) === options.provider));
    // Provider capacity can refuse before quota is read; only existing hard allowance may become queued intent.
    const compatible = models.filter(model => inventoryNow.ready.some(ticket => acceptsDifficulty(model, ticket)));
    const quotas = (await readAll([...Map.groupBy(compatible, model => model.model.instanceId).values()].map(models => readModelQuotas(t3, c, store.jobSummaries(), models.map(model => model.id))))).flat();
    const allowance = new Set(quotas.filter(result => result.quota?.hasAllowance).map(result => result.id));
    const candidate = selectTicket(inventoryNow.ready.filter(ticket => models.some(model => allowance.has(model.id) && acceptsDifficulty(model, ticket))), store.get('lastProject'), c.projects.filter(project => project.enabled).map(project => project.kanvilId));
    if (!candidate) return result;
    const task = await kanvil.task(candidate.id), target = await taskReader(c, kanvil).node(task);
    const prior = queuedPlan(store, target.key);
    if (prior) return queued(prior);
    // Recheck ownership after the reads, then save without yielding to another admission.
    if (store.isLocked(`ticket:${target.id}`) || taskOwners(store.jobSummaries()).has(target.id) || automationHold(task)) return result;
    target.note = String(hold.message ?? hold.reason);
    const { plan } = await beginPlan(c, store, t3, kanvil, instances, shell.threads, options, skips(options), { target, tickets: [], queued: true }, clients.currentConfig, clients.decide);
    return queued(plan);
  } finally { if (!clients.kanvil) await kanvil.close(); }
}

async function cycleNow(c: Config, store: Store, options: CycleOptions, clients: Clients): Promise<Decision> {
  if (clients.github) githubClients.set(store, clients.github);
  if (options.manual && !options.epic && options.model && options.model !== 'auto') return dispatchOne(c, store, options, undefined, clients);
  if (!options.manual && options.model && options.model !== 'auto') throw new Error('Explicit models require manual dispatch');
  const decision = (reason: string, extra: Record<string, unknown> = {}) => {
    const result = { reason, at: new Date().toISOString(), ...extra };
    clients.decide!(result);
    log('decision', result); return result;
  };
  const skip = skips(options);
  const t3 = clients.t3 ?? new T3(c.t3), kanvil = clients.kanvil ?? new Kanvil(c.kanvil, c.projects), ownsKanvil = !clients.kanvil;
  const publishStreams = streamUpdate(store, clients.workKind === 'upstream' ? 'upstreamStreams' : 'streams', clients.providerDriver ? [clients.providerDriver] : undefined);
  let [shell, providers] = await backgroundRead(() => { return readAll([t3.shell(), t3.providers()]); });
  await backgroundCheckpoint();
  const instances = new Map(providers.map(p => [p.instanceId, p.driver]));
  if (ownsKanvil) await kanvil.connect();
  try {
    if (options.epic) return await startEpic(c, store, t3, kanvil, instances, shell.threads, options, skip, decision, clients.currentConfig, clients.decide);
    if (!options.manual && !clients.deferReconcile) await reconcile(c, store, t3, kanvil, shell.threads, !options.dryRun && !options.doctor, !clients.deferCleanup);
    // Chains the user started run whether or not automation is on; they take their slots first.
    if (!options.manual && !options.doctor && !options.dryRun && (!clients.workKind || clients.workKind === 'chains')) {
      const dispatches = await runPlans(c, store, t3, kanvil, instances, shell.threads, undefined, clients.providerDriver, clients.currentConfig, clients.decide);
      if (clients.workKind === 'chains') return decision(dispatches.some(result => result.reason === 'dispatched') ? 'dispatched' : 'plans-checked', { dispatches });
    }
    const jobs = store.jobs();
    const busy = busyProviders(jobs, shell.threads, instances, c.monitoringTimeoutMinutes, c.concurrency, undefined, options);
    const streams: ProviderStream[] = ['claudeAgent', 'codex'].map(driver => ({
      driver, provider: driver === 'codex' ? 'Codex' : 'Claude',
      reason: busy.has(driver) ? c.concurrency[driver === 'codex' ? 'codex' : 'claude'] === 0 ? 'provider-disabled' : 'provider-running' : 'no-eligible-model',
      active: jobs.filter(j => ['running', 'dispatching'].includes(j.state) && (j.providerDriver ?? instances.get(j.modelSelection?.instanceId ?? 'claudeAgent')) === driver).map(jobLabel),
      planned: [], models: [],
    }));
    const saveStreams = () => publishStreams(streams);
    const readyModels: { preset: Config['models'][number]; driver: string }[] = [];
    // Blocked only by provider idle time: reviews may still use these, ticket and discovery work may not.
    const idleModels: typeof readyModels = [];
    const activityCache = new Map<string, Awaited<ReturnType<typeof personalActivity>>>();
    for (const preset of c.models.filter(p => (p.automatic || !!options.provider) && (!options.provider || instances.get(p.model.instanceId) === options.provider) && (!clients.providerDriver || instances.get(p.model.instanceId) === clients.providerDriver))) {
      await backgroundCheckpoint();
      const driver = instances.get(preset.model.instanceId);
      const stream = streams.find(s => s.driver === driver);
      if (!stream || busy.has(driver!)) continue;
      let reason = 'ready';
      try {
        const quota = await backgroundRead(() => readModelQuota(t3, c, store.jobSummaries(), preset.id, !!options.manual));
        stream.quota ??= quota;
        const manualCodex = options.manual && driver === 'codex';
        if (!quota.hasAllowance) reason = 'quota-exhausted';
        else if (!quota.allowed && (manualCodex || !skip.has('reserve'))) reason = 'quota-budget';
        else if (!options.upstream && !manualCodex && !skip.has('idle')) {
          // An unreadable activity state holds ticket work back but, like idle time, never a review.
          try {
            if (!activityCache.has(driver!)) activityCache.set(driver!, await personalActivity(t3, shell.threads, jobs, store, c.monitoringTimeoutMinutes, driver, instances));
            if (idleBlocked(c, activityCache.get(driver!)!)) reason = 'waiting-for-idle';
          } catch (error) { reason = safeError(error); idleModels.push({ preset, driver: driver! }); }
        }
        if (reason === 'ready') { readyModels.push({ preset, driver: driver! }); stream.quota = quota; }
        else if (reason === 'waiting-for-idle') idleModels.push({ preset, driver: driver! });
      } catch (error) { reason = safeError(error); }
      stream.models.push({ id: preset.id, name: preset.name, reason });
      if (stream.reason !== 'ready') stream.reason = reason;
    }
    // A provider with no automatic model, or none free, still shows its allowance.
    for (const stream of streams.filter(s => !s.quota && (!clients.providerDriver || s.driver === clients.providerDriver))) {
      await backgroundCheckpoint();
      const preset = c.models.find(p => instances.get(p.model.instanceId) === stream.driver);
      if (!preset) { stream.quotaError = 'No model is configured for this provider'; continue; }
      try { stream.quota = await backgroundRead(() => readModelQuota(t3, c, store.jobSummaries(), preset.id)); }
      catch (error) { stream.quotaError = safeError(error); }
    }
    // The queue is read on every pass, paused or not, so the page always shows what would start next.
    const reviewsOn = clients.workKind !== 'tickets' && (!!options.upstream || !!c.upstream?.enabled), ticketsOn = clients.workKind !== 'upstream' && !options.upstream && (c.enabled || !!options.manual || !!options.doctor);
    // While tickets are paused the read is for display only, so a Kanvil failure must not hold up reviews.
    await backgroundCheckpoint();
    let queue: Queue = { ready: [], skipped: [], selected: undefined }, queueRead = true;
    try {
      if (!options.upstream && clients.workKind !== 'upstream' && (ticketsOn || !clients.workKind)) {
        const hints = clients.backgroundInventory && !options.ticket && !options.doctor ? preparedInventory(c, store) : undefined;
        queue = hints ?? await inventory(c, kanvil, shell.threads, store.jobs(), store, options.ticket?.trim().toUpperCase());
      }
    }
    catch (error) { if (ticketsOn) throw error; queueRead = false; log('queue-read-failed', { message: safeError(error) }); }
    if (options.manual && options.ticket && !queue.ready.length) {
      const chained = await chainResponse(c, store, t3, kanvil, instances, shell.threads, options, queue, skip, decision, clients.currentConfig, clients.decide);
      if (chained) return chained;
    }
    await backgroundCheckpoint();
    // The service inventory lane owns this catalogue. Other lanes may read a scoped
    // or empty queue; publishing those would hide ready tickets from manual starts.
    if (!clients.backgroundInventory && !options.ticket && !options.upstream && queueRead) await publishQueue(c, store, kanvil, queue);
    // Fully paused: provider status, quota, and the queue stay fresh, nothing is dispatched. With only reviews on, only reviews dispatch.
    if (!ticketsOn && !reviewsOn) { saveStreams(); return decision('disabled', { streams, eligible: queue.ready.length }); }
    // Upstream reviews are bounded and time-sensitive, so they go ahead of ticket work.
    const reviews = options.upstream ? (await pendingReviews(c, store, store.jobs(), Date.now(), false)).filter(r => r.upstream.repo === options.upstream!.toLowerCase())
      : options.manual || (!reviewsOn && !options.doctor) ? [] : await pendingReviews(c, store, store.jobs(), Date.now(), !clients.workKind && !options.dryRun && !options.doctor);
    if (options.upstream && !reviews.length) return decision('upstream-not-due', { message: 'This repository has no review due. Refresh its status before trying again.' });
    const candidates = ticketsOn ? [...queue.ready] : [];
    if (options.manual && options.ticket && candidates.some(ticket => store.isLocked(`ticket:${ticket.id}`))) return decision('ticket-preparing', { ticket: options.ticket, message: 'Another request is already preparing this ticket.' });
    const skipped = [...queue.skipped];
    const results: Record<string, any>[] = [];
    const claimedProjects = new Set<string>();
    const planned = new Map<string, number>();
    let planningLastProject = store.get('lastProject');
    // Dry runs record nothing, so their would-be runs count against label limits here.
    const started: Pick<Job, 'state' | 'threadId' | 'projectId' | 'labels'>[] = [];
    const labelAvailability = () => {
      if (skip.has('labels')) return (_ticket: Candidate) => true;
      const full = labelCapacity(c, [...store.jobSummaries(), ...preparingLabels(store), ...started], shell.threads);
      return (ticket: Candidate) => !full(ticket);
    };
    // CLI callers hold Store.claim across this entire pass; each durable task claim precedes its RPC.
    const free = (m: { driver: string }) => !busy.has(m.driver);
    const launches: Promise<Decision>[] = [];
    while (readyModels.some(free) || (reviews.length && idleModels.some(free))) {
      if (options.manual) await backgroundCheckpoint();
      const labelOpen = labelAvailability();
      const review = reviews[0];
      const assignment = review ? undefined : selectAssignment(candidates.filter(ticket => labelOpen(ticket) && !store.isLocked(`ticket:${ticket.id}`)), readyModels, busy, planningLastProject, c.projects.filter(p => p.enabled).map(p => p.kanvilId));
      const discovery = ticketsOn && !review && !options.manual && !queue.ready.length && !skipped.some(s => /difficulty/.test(s.reason));
      const selected = assignment ?? (review ? readyModels.find(free) ?? idleModels.find(free) : discovery ? readyModels.find(free) : undefined);
      if (!selected) break;
      const skipProjects = new Set(claimedProjects);
      if (discovery) {
        const target = c.projects.filter(project => discoveryAvailable(project, jobs, store, skipProjects))
          .toSorted((a, b) => Number(store.get(`discoveryLast:${a.kanvilId}`) ?? 0) - Number(store.get(`discoveryLast:${b.kanvilId}`) ?? 0))[0];
        if (!target) break;
        claimedProjects.add(target.kanvilId);
      }
      const stream = streams.find(s => s.driver === selected.driver)!;
      const scoped: Queue = { ready: assignment ? queue.ready.filter(t => t.id === assignment.ticket.id) : [], skipped: queue.skipped, selected: undefined };
      const attempt = async (): Promise<Decision> => {
        try {
          const result = await dispatchOne(c, store, { ...options, doctor: false, dryRun: options.dryRun || options.doctor, model: selected.preset.id, ticket: assignment?.ticket.key }, { driver: selected.driver, instanceDrivers: instances, skipProjects, inspect: options.doctor, review, shell, queue: scoped, t3, kanvil, currentConfig: clients.currentConfig, unnamed: !options.ticket }, clients);
          stream.reason = result.reason;
          if ('quota' in result) stream.quota = result.quota as typeof stream.quota;
          if (result.reason === 'dispatched' || result.reason === 'would-dispatch') (result.reason === 'dispatched' ? stream.active : stream.planned).push(assignment?.ticket.key ?? jobLabel({ ticketKey: null, upstream: review?.upstream }));
          else if (!(options.manual && !options.ticket && selectionChanged(result.reason))) for (const list of [readyModels, idleModels]) {
            const index = list.findIndex(model => model.preset.id === selected.preset.id);
            if (index >= 0) list.splice(index, 1);
          }
          return result;
        } catch (error) {
          if (options.manual) throw error;
          stream.reason = safeError(error);
          return { reason: 'error', at: new Date().toISOString(), driver: selected.driver, message: stream.reason };
        }
      };
      const execute = () => {
        const run = () => assignment ? store.exclusive([`ticket:${assignment.ticket.id}`], attempt) : attempt();
        return options.manual ? run() : independentOperation(run);
      };
      if (options.manual) {
        const result = await execute(); results.push(result);
        if (result.reason === 'dispatched' || result.reason === 'would-dispatch') return result;
        if (assignment && selectionChanged(result.reason)) candidates.splice(candidates.findIndex(ticket => ticket.id === assignment.ticket.id), 1);
        continue;
      } else {
        // Plan the bounded batch without yielding; durable admissions still recheck every shared limit.
        planned.set(selected.driver, (planned.get(selected.driver) ?? 0) + 1);
        if (assignment) started.push({ state: 'running', threadId: '', projectId: assignment.ticket.projectId, labels: (assignment.ticket.labels ?? []).map(label => label.name) });
        for (const driver of busyProviders(jobs, shell.threads, instances, c.monitoringTimeoutMinutes, c.concurrency, planned)) busy.add(driver);
        launches.push(execute());
      }
      if (review) reviews.shift();
      if (assignment) planningLastProject = assignment.ticket.projectId;
      if (assignment) candidates.splice(candidates.findIndex(ticket => ticket.id === assignment.ticket.id), 1);
    }
    results.push(...await readAll(launches));
    const labelOpen = labelAvailability();
    for (const stream of streams) if (stream.reason === 'ready') stream.reason = candidates.length && !candidates.some(labelOpen) ? 'label-limit' : queue.ready.length ? 'difficulty-limit' : skipped.some(s => /difficulty/.test(s.reason)) ? 'needs-classification' : 'no-eligible-ticket';
    const reason = options.doctor ? 'doctor' : results.some(r => r.reason === 'dispatched') ? 'dispatched'
      : results.some(r => r.reason === 'would-dispatch') ? 'would-dispatch'
      : options.upstream ? results.at(-1)?.reason ?? 'no-eligible-model' : options.manual ? candidates.length && !candidates.some(labelOpen) ? 'label-limit' : 'no-eligible-ticket' : !ticketsOn ? results.at(-1)?.reason ?? 'disabled' : streams.every(s => s.reason === 'provider-running') ? 'autonomous-job-running' : 'watching-streams';
    saveStreams();
    // Operators run this after every Claude CLI upgrade: the sandbox must still refuse both probes.
    const triageSandbox = options.doctor && c.triage ? await triageCanary() : undefined;
    if (options.manual && queue.ready.length && !readyModels.length && !results.length) return decision('no-ready-model', { streams, eligible: queue.ready.length, message: 'No configured model is ready. ' + streams.flatMap(stream => stream.models.length ? stream.models.map(model => `${model.name}: ${model.reason}`) : [`${stream.provider}: ${stream.reason === 'provider-disabled' ? 'provider limit is Off' : stream.reason === 'provider-running' ? 'provider limit is full' : 'no automatic model configured'}`]).join('; ') });
    return decision(reason, { streams, dispatches: results, skipped, eligible: queue.ready.length, ...triageSandbox ? { triageSandbox } : {} });
  } finally { if (ownsKanvil) await kanvil.close(); }
}

function discoveryAvailable(project: Project, jobs: Job[], store: Store, skipProjects = new Set<string>()) {
  return project.enabled && !skipProjects.has(project.kanvilId) && !jobs.some(job => job.projectId === project.kanvilId && job.kind === 'discovery' && !['complete', 'dismissed'].includes(job.state)) && Number(store.get(`discoveryAfter:${project.kanvilId}`) ?? 0) <= Date.now();
}

const selectionChanged = (reason: string) => ['ticket-changed-before-dispatch', 'ticket-order-or-eligibility-changed', 'ticket-preparing', 'no-eligible-ticket', 'label-limit'].includes(reason);

// Prepared rows are selection hints. The shared final boundary still authorizes the selected ticket.
function preparedInventory(c: Config, store: Store): Queue | undefined {
  let value: unknown;
  try { value = JSON.parse(store.get('upNext') ?? 'null'); } catch { return; }
  const rows = z.object({ tickets: z.array(z.unknown()), held: z.array(z.object({ key: z.string(), reason: z.string() })) }).safeParse(value);
  if (!rows.success) return;
  const rowSchema = z.object({ id: z.string(), key: z.string(), projectId: z.string(), title: z.string(), priority: z.string(), createdAt: z.string(), difficulty: z.enum(['low', 'med', 'high']), automationReady: z.literal(true), labelRank: z.number().nullable().optional(), labels: z.array(z.string()), after: z.array(z.string()) });
  const ready: Candidate[] = [], owned = taskOwners(store.jobSummaries()), running = runningPlanHold(store);
  for (const row of rows.data.tickets) {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) return; // Older projections are warmed once, not silently reinterpreted.
    const task = parsed.data;
    if (owned.has(task.id) || running(task) || task.after.length || !c.projects.some(project => project.enabled && project.kanvilId === task.projectId && task.key.startsWith(project.key + '-'))) continue;
    ready.push({ ...task, labelRank: task.labelRank ?? undefined, labels: task.labels.map(name => ({ name })) });
  }
  return { ready, skipped: rows.data.held, selected: undefined };
}

async function dispatchOne(c: Config, store: Store, options: CycleOptions, plan?: { driver: string; instanceDrivers: Map<string, string>; skipProjects: Set<string>; inspect?: boolean; review?: PendingReview; shell?: Awaited<ReturnType<T3['shell']>>; queue?: Queue; t3?: T3; kanvil?: Kanvil; currentConfig?: () => Config; unnamed?: boolean }, clients: Clients = {}, activePlanId?: string): Promise<Decision> {
  const recordDecision = clients.decide ?? store.decisionRecorder({ workKind: clients.workKind ?? 'tickets', providerDriver: clients.providerDriver, manual: options.manual && !options.continuation });
  const preset = options.model && options.model !== 'auto' ? c.models.find(p => p.id === options.model) : undefined;
  if (options.model && options.model !== 'auto' && !preset) throw new Error('Unknown model; select a configured model');
  if (!preset) throw new Error('Select a configured model');
  if (!options.manual && !plan) throw new Error('Automatic work requires a provider plan');
  const skip = skips(options);
  const ticketKey = options.ticket?.trim().toUpperCase();
  if (ticketKey && ((!options.manual && !plan) || !/^[A-Z0-9]+-\d+$/.test(ticketKey))) throw new Error('Enter a ticket key such as APP-123');
  if (ticketKey && !c.projects.some(p => p.enabled && ticketKey.startsWith(`${p.key}-`))) throw new Error('Ticket project is not enabled in the factory settings');
  const decision = (reason: string, extra: Record<string, unknown> = {}) => {
    const result = { reason, at: new Date().toISOString(), ...extra };
    recordDecision(result); log('decision', result); return result;
  };
  if (!c.enabled && !options.doctor && !options.manual && !plan?.inspect && !(plan?.review && c.upstream?.enabled)) return decision('disabled');
  const t3 = plan?.t3 ?? clients.t3 ?? new T3(c.t3);
  const [shell, instances] = await readAll([
    plan?.shell ?? t3.shell(),
    plan?.instanceDrivers ?? t3.providers().then(ps => new Map(ps.map(p => [p.instanceId, p.driver]))),
  ]);
  for (const p of c.projects.filter(p => p.enabled)) {
    const live = shell.projects.find(x => x.id === p.t3Id);
    if (!live || live.workspaceRoot !== p.repoPath) throw new Error(`T3 project mapping mismatch for ${p.name}`);
  }
  const kanvil = plan?.kanvil ?? clients.kanvil ?? new Kanvil(c.kanvil, c.projects), ownsKanvil = !(plan?.kanvil ?? clients.kanvil);
  if (ownsKanvil) await kanvil.connect();
  let prepared: Awaited<ReturnType<T3['prepareLaunch']>> | undefined, releaseTicket: (() => void) | undefined, clearPreparation: (() => void) | undefined;
  try {
    if (!plan && !options.manual && !clients.deferReconcile) await reconcile(c, store, t3, kanvil, shell.threads, !options.dryRun && !options.doctor, !clients.deferCleanup);
    const jobs = store.jobs();
    const running = jobs.filter(j => ['running', 'dispatching'].includes(j.state));
    const parked = jobs.filter(j => j.state === 'waiting');
    // A cancelled ticket counts as finished for an Epic, so a launch from one must agree with the plan that chose it.
    const cancelledFinished = !!(activePlanId && store.plan(activePlanId)?.epic);
    const driver = plan?.driver ?? instances.get(preset.model.instanceId);
    const queued = ticketKey && queuedPlan(store, ticketKey);
    if (queued && queued.id !== activePlanId) return decision('ticket-queued', { ticket: ticketKey, planId: queued.id, message: 'Ticket has a queued run. Cancel it before starting with different choices.' });
    if (driver && busyProviders(jobs, shell.threads, instances, c.monitoringTimeoutMinutes, c.concurrency, undefined, options).has(driver)) return decision(c.concurrency[driver === 'codex' ? 'codex' : 'claude'] === 0 ? 'provider-disabled' : 'provider-running', { driver });
    const review = plan?.review ?? (options.upstream ? (await pendingReviews(c, store, jobs, Date.now(), false)).find(r => r.upstream.repo === options.upstream!.toLowerCase()) : undefined);
    if (options.upstream && !review) return decision('upstream-not-due', { message: 'This repository has no review due. Refresh its status before trying again.' });
    // A review needs no ticket queue, so ticket-only reads cannot block it.
    const queue = plan?.queue ?? (clients.backgroundInventory && options.manual && !ticketKey && !review && !options.doctor ? preparedInventory(c, store) : undefined) ?? (review && !plan?.inspect ? { ready: [], skipped: [], selected: undefined } as Queue : await inventory(c, kanvil, shell.threads, jobs, store, ticketKey, cancelledFinished));
    const discovery = !ticketKey && !options.manual && !review;
    if (discovery && (queue.ready.length || queue.skipped.some(s => /difficulty/.test(s.reason)))) return decision('ticket-work-takes-priority');
    queue.ready = queue.ready.filter(t => acceptsDifficulty(preset, t));
    // Label limits bind every start except a manual one, or a chain started as one, with them overridden.
    const labelGated = !skip.has('labels');
    if (labelGated && !ticketKey && !review) {
      const full = labelCapacity(c, [...jobs, ...preparingLabels(store)], shell.threads), open = queue.ready.filter(ticket => !full(ticket));
      if (queue.ready.length && !open.length) return decision('label-limit', { message: 'Every eligible ticket is waiting for a free label slot' });
      queue.ready = open;
    }
    if (!discovery && !review && !queue.ready.length) {
      const chained = options.manual && ticketKey ? await chainResponse(c, store, t3, kanvil, instances, shell.threads, options, queue, skip, decision, clients.currentConfig ?? plan?.currentConfig, recordDecision) : undefined;
      return chained ?? decision('no-eligible-ticket', { ticket: ticketKey, skipped: queue.skipped, message: 'Ticket must be classified, within the model difficulty limit, SF-ready, unblocked, and not already owned.' });
    }
    // A chain continuation is still user-authorized work, but it starts later and on its own, so only the chain's recorded overrides waive the automatic quota and idle policy.
    const manualPolicy = !!options.manual && !options.continuation;
    const quotaBaseline = store.jobSummaries();
    const readSelectedQuota = (refresh = false) => {
      const live = liveModelQuota(t3, c, quotaBaseline, preset.id, manualPolicy);
      return live ? Promise.resolve(live) : readModelQuota(t3, c, store.jobSummaries(), preset.id, manualPolicy, refresh);
    };
    const quota = await readSelectedQuota();
    if (plan && quota.driver !== plan.driver || options.provider && quota.driver !== options.provider) return decision('provider-mapping-changed');
    const isManualCodex = manualPolicy && quota.provider === 'Codex';
    // Reviews do not wait for idle time, so they never read (or fail on) personal activity.
    const readActivity = async (threads: Thread[]) => review || isManualCodex || skip.has('idle') ? { active: false, last: '', idleMinutes: Infinity }
      : personalActivity(t3, threads, store.jobs(), store, c.monitoringTimeoutMinutes, quota.provider === 'Codex' ? 'codex' : 'claudeAgent', instances);
    const activity = await readActivity(shell.threads);
    const gate = !quota.hasAllowance ? isManualCodex ? 'codex-quota-exhausted' : 'quota-exhausted'
      : !skip.has('reserve') && !quota.allowed ? discovery ? 'discovery-quota-reserve' : 'quota-reserve'
      : c.maxWaitingPRs !== null && parked.length >= c.maxWaitingPRs ? 'waiting-cap'
      : !isManualCodex && !skip.has('idle') && activity.active ? 'personal-provider-running'
      : !isManualCodex && !skip.has('idle') && activity.idleMinutes < c.idleMinutes ? 'personal-provider-recently-active' : null;
    const reservePreparation = !!options.manual && !plan && !activePlanId;
    const pickTicket = () => {
      releaseTicket?.(); releaseTicket = undefined; clearPreparation = undefined;
      const current = store.jobSummaries(), owned = taskOwners(current);
      const full = labelGated && !ticketKey ? labelCapacity(c, [...current, ...preparingLabels(store)], shell.threads) : undefined;
      const candidates = queue.ready.filter(candidate => !owned.has(candidate.id) && (!reservePreparation || !store.isLocked(`ticket:${candidate.id}`)) && !full?.(candidate));
      const ticket = selectTicket(candidates, store.get('lastProject'), c.projects.filter(project => project.enabled).map(project => project.kanvilId));
      if (ticket && reservePreparation) {
        const release = store.tryLock(`ticket:${ticket.id}`); if (!release) return;
        const preparations = ticketPreparations.get(store) ?? new Map<string, Candidate>(); ticketPreparations.set(store, preparations); preparations.set(ticket.id, ticket);
        const clear = () => { if (preparations.get(ticket.id) === ticket) preparations.delete(ticket.id); };
        clearPreparation = clear; releaseTicket = () => { clear(); release(); };
      }
      return ticket;
    };
    queue.selected = review ? undefined : pickTicket();
    if (!review && !discovery && !queue.selected && queue.ready.length) return decision('ticket-preparing', { message: 'Other starts are preparing these tickets.' });
    if (options.doctor) return decision('doctor', { quota, activity, running: running.length, waiting: parked.length, gate: running.length ? 'autonomous-job-running' : gate, eligible: queue.ready.length, next: queue.selected, skipped: queue.skipped });
    if (gate) return decision(gate, { quota, activity, running: running.length, waiting: parked.length, ...(!quota.hasAllowance ? { message: 'The selected model has no allowance left. Choose another model or wait for its quota to reset.' } : {}) });

    let project: Project | undefined;
    if (review) project = review.project;
    else if (queue.selected) project = c.projects.find(p => p.kanvilId === queue.selected!.projectId);
    else {
      project = c.projects.filter(p => discoveryAvailable(p, jobs, store, plan?.skipProjects))
        .toSorted((a, b) => Number(store.get(`discoveryLast:${a.kanvilId}`) ?? 0) - Number(store.get(`discoveryLast:${b.kanvilId}`) ?? 0))[0];
    }
    if (!project) return decision('no-eligible-work', { skipped: queue.skipped });
    prepared = await t3.prepareLaunch();
    for (;;) {
      const reservationIds = () => store.jobSummaries().filter(job => (job.modelSelection?.instanceId ?? 'claudeAgent') === preset.model.instanceId).map(job => job.id).join(',');
      const quotaGeneration = reservationIds(), streamingQuota = !!t3.peekProvider?.(preset.model.instanceId), streamingShell = !!t3.peekShell?.();
      const trackerRevision = kanvil.generations();
      // Each final phase owns fresh snapshots; only independent reads overlap. Artifact cache writes stay after the reads.
      let { fresh, currentQuota, checked, currentActivity, artifacts, space } = await backgroundRead(async () => {
        const [fresh, currentQuota, checked, space] = await readAll([
          t3.shell(false, true),
          readSelectedQuota(true),
          (async () => {
            if (!queue.selected) return undefined;
            const reader = taskReader(c, kanvil, { cancelledFinished });
            const rootId = queue.selected.id, watched = new Set<string>([rootId]);
            const rules = dependencyRules(async id => { watched.add(id); return relationsSchema.parse(await kanvil.relations(id, true, id === rootId, await reader.task(id))); }, async id => reader.done(await reader.task(id)));
            const [task, blockers, children, prs, refs] = await readAll([
              reader.task(queue.selected.id), rules.blockersOf(queue.selected.id), rules.openChildren(queue.selected.id), openPullRequests(project!, store, true), repositoryRead(store, `refs:${project!.repoPath}`, () => git(project!.repoPath, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes']), true),
            ]);
            // Prepared rows can predate the setting or the ticket's membership, so an unnamed start judges the fresh ticket.
            const epics = (!options.ticket || plan?.unnamed) && c.holdEpicTicketsUntilStarted && task.epicId ? await kanvil.epics().catch(() => undefined) : undefined;
            return { task, labels: task.labels ?? [], blockers, children, prs, refs, epics, projects: reader.projects, tickets: new Set([...watched, ...reader.ids]) };
          })(),
          // Read with the other final snapshots; the verdict below stays inside the synchronous admission checks.
          c.minFreeSpaceBytes ? availableBytes(project!.repoPath).then(bytes => ({ bytes }), (error: unknown) => ({ error })) : Promise.resolve(undefined),
        ]);
        const [artifacts, currentActivity] = await readAll([
          checked && queue.selected ? ticketArtifacts(project!, queue.selected.key, checked.task.id, fresh.threads, store.jobs(), store, Promise.resolve(checked.prs)) : Promise.resolve(undefined),
          readActivity(fresh.threads),
        ]);
        return { fresh, currentQuota, checked, artifacts, currentActivity, space };
      });
      const currentJobs = store.jobSummaries();
      const latestShell = t3.peekShell?.();
      if (streamingShell && !latestShell) continue; // Lost trust: read the authoritative fallback in a new pass.
      if (latestShell) {
        if (!latestShell.projects.some(live => live.id === project!.t3Id && live.workspaceRoot === project!.repoPath)) return decision('configuration-changed-before-dispatch', { message: 'The T3 project workspace changed during final validation.' });
        // An inactive-thread proof belongs to the snapshot that was checked. A
        // changed live thread must retain duplicate protection until revalidated.
        if (artifacts) for (const id of artifacts.inactiveThreads) {
          if (JSON.stringify(fresh.threads.find(thread => thread.id === id)) !== JSON.stringify(latestShell.threads.find(thread => thread.id === id))) artifacts.inactiveThreads.delete(id);
        }
        fresh = latestShell;
      }
      // Another launch consumed this provider after our quota read began. Revalidate without blocking its worker.
      const latestQuota = liveModelQuota(t3, c, quotaBaseline, preset.id, manualPolicy);
      if (streamingQuota && !latestQuota) continue;
      if (latestQuota) currentQuota = latestQuota;
      else if (reservationIds() !== quotaGeneration) continue;
      const selected = queue.selected, selectionProject = project;
      const refusal = selected && (() => {
        if (!checked || checked.task.projectId !== selectionProject.kanvilId || `${selectionProject.key}-${checked.task.number}` !== selected.key || !selectionProject.readyStatuses.includes(checked.task.status) || taskHold(checked.task) || checked.task.readiness?.ready !== true) return { reason: 'ticket-changed-before-dispatch' };
        // An Epic can also start after this pass read the queue. Its choices win over unnamed selection.
        const heldForEpic = (!options.ticket || plan?.unnamed) && epicHold(c, store, checked.epics)(checked.task);
        if (heldForEpic) return { reason: 'ticket-changed-before-dispatch', message: heldForEpic };
        const { task, blockers, children } = checked, key = selected.key;
        let difficulty: Candidate['difficulty'];
        try { difficulty = taskDifficulty(task); } catch { difficulty = undefined; }
        if (difficulty !== selected.difficulty || !acceptsDifficulty(preset, { ...selected, difficulty })) return { reason: 'ticket-changed-before-dispatch', message: "The ticket's difficulty changed." };
        if (blockers === 'cycle' || blockers.length || children.length) return { reason: 'ticket-changed-before-dispatch', message: 'The ticket gained a blocker or an unfinished child.' };
        if (!artifacts || artifacts.openPR || branchConflict(key, checked.refs, artifacts.branches) || currentJobs.some(job => job.taskId === task.id && !['complete', 'dismissed'].includes(job.state)) || threadsReferencingTicket(fresh.threads, selectionProject.t3Id, key).some(thread => !artifacts.inactiveThreads.has(thread.id))) return { reason: 'ticket-order-or-eligibility-changed' };
        if (kanvil.realtime && (!kanvil.projectSynchronized(selectionProject.kanvilId) || !kanvil.unchanged(trackerRevision, checked.projects, checked.tickets))) return { reason: 'ticket-changed-before-dispatch', message: 'Kanvil changed or disconnected during final validation.' };
        const full = labelGated && fullLabel(c, currentJobs, fresh.threads, { ...selected, labels: checked.labels });
        if (full) return { reason: 'label-limit', message: `Waiting for a free ${full} slot` };
      })();
      if (refusal) {
        queue.ready = queue.ready.filter(candidate => candidate.id !== selected!.id);
        const next = !ticketKey && !discovery && pickTicket();
        const nextProject = next && c.projects.find(project => project.kanvilId === next.projectId);
        if (next && nextProject) { queue.selected = next; project = nextProject; continue; }
        return decision(refusal.reason, refusal);
      }
      if (plan && currentQuota.driver !== plan.driver || options.provider && currentQuota.driver !== options.provider) return decision('provider-mapping-changed');
      const currentManualCodex = manualPolicy && currentQuota.provider === 'Codex';
      if (!currentQuota.hasAllowance) return decision(currentManualCodex ? 'codex-quota-exhausted' : 'quota-exhausted', { quota: currentQuota });
      if (c.maxWaitingPRs !== null && currentJobs.filter(job => job.state === 'waiting').length >= c.maxWaitingPRs) return decision('waiting-cap');
      // Reviews start as soon as a release is found, so only ticket and discovery work wait for idle time.
      if ((!skip.has('idle') && !currentManualCodex && idleBlocked(c, currentActivity)) || (!skip.has('reserve') && !currentQuota.allowed)) return decision('gate-changed-before-dispatch', { quota: currentQuota });
      // Recheck capacity at reservation; only an explicit manual override can exceed it.
      if (busyProviders(currentJobs, fresh.threads, instances, c.monitoringTimeoutMinutes, c.concurrency, undefined, options).has(currentQuota.driver)) return decision('job-resumed-before-dispatch');
      if (review) {
        const watched = project.upstreams.find(watched => watched.repo === review.upstream.repo);
        const state = watched && releaseState(project, watched, store, currentJobs);
        if (!state?.due || state.reviewed !== review.upstream.base || state.latest !== review.upstream.candidate) return decision('upstream-changed-before-dispatch', { message: 'The review changed or is already owned. Refresh its status before trying again.' });
      }
      if (JSON.stringify((clients.currentConfig ?? plan?.currentConfig ?? loadConfig)()) !== JSON.stringify(c)) return decision('configuration-changed-before-dispatch');
      if (activePlanId && store.plan(activePlanId)?.state !== 'active') return decision('plan-cancelled-before-dispatch');
      if (discovery && !discoveryAvailable(project, currentJobs, store, plan?.skipProjects)) return decision('discovery-changed-before-dispatch');
      // Admission only: a later run can still fill the volume, and a foreground start never deletes worktrees to make room.
      if (space) {
        const at = { path: project.repoPath, requiredBytes: c.minFreeSpaceBytes };
        if ('error' in space) return decision('disk-space-check-failed', { ...at, message: `Not launched: free space on ${project.repoPath} could not be read (${safeError(space.error)}). Check the volume, or set minFreeSpaceBytes to 0 to skip this check.` });
        if (space.bytes < c.minFreeSpaceBytes) return decision('disk-space-low', { ...at, availableBytes: space.bytes, message: `Not launched: ${project.repoPath} has ${formatBytes(space.bytes)} free; ${formatBytes(c.minFreeSpaceBytes)} required. Open Cleanup to delete unused worktrees.` });
      }
      if (options.dryRun) { prepared.check(); return decision('would-dispatch', { kind: review ? 'upstream' : discovery ? 'discovery' : 'ticket', project: project.name, projectId: project.kanvilId, ticket: queue.selected?.key, upstream: review?.upstream, model: currentQuota.factoryRouting.model, quota: currentQuota }); }
      const selectedModel = currentQuota.factoryRouting.model;
      // Manual Codex runs already skip idle and reserve checks.
      const waived = [...skip].filter(l => !currentManualCodex || !['idle', 'reserve'].includes(l)).map(l => ({ idle: 'idle', reserve: 'quota reserve', labels: 'label-limit', providers: 'provider-limit' })[l]);
      const modelReason = (options.continuation ? 'Started by a chain the user requested. ' : options.manual ? `Manual dispatch${waived.length ? ` with ${waived.join('/')} thresholds overridden for this run` : ''}. ` : '') + currentQuota.factoryRouting.reason;
      const now = new Date().toISOString(), id = randomUUID();
      const job: Job = { id, providerDriver: currentQuota.driver, modelSelection: selectedModel, modelReason, ...(queue.selected?.difficulty ? { difficulty: queue.selected.difficulty } : {}), kind: review ? 'upstream' : queue.selected ? 'ticket' : 'discovery', ...(review ? { upstream: review.upstream } : {}), projectId: project.kanvilId, taskId: queue.selected?.id ?? null, ticketKey: queue.selected?.key ?? null, threadId: randomUUID(), messageId: randomUUID(), createdAt: now, state: 'dispatching', reason: 'Dispatch prepared', lastPersonalActivity: null, reportPath: join(c.stateDir, 'reports', `${id}.json`), command: null, prUrls: [], completedAt: null };
      if (checked) {
        job.labels = checked.labels.map(l => l.name);
        job.priority = checked.task.priority;
      }
      const u = job.upstream;
      const title = job.kind === 'ticket' ? `Factory: ${job.ticketKey}` : u ? `Upstream review: ${u.name} ${u.base}..${u.candidate}` : `Factory discovery: ${project.name}`;
      // Ticket branches carry the ticket's kind (fix, feat, perf, ...) so release tooling can bump versions from them.
      // Keep the final native ticket metadata with the job for status and filtering.
      const branch = job.kind === 'ticket' ? `${branchKind(checked?.labels ?? queue.selected?.labels ?? [])}/${job.ticketKey}-factory-${id.slice(0, 8)}` : `chore/factory-${job.kind}-${id.slice(0, 8)}`;
      // T3 creates the worktree from the project's workspace root, which must match project.repoPath (checked above).
      job.command = { commandId: randomUUID(), threadId: job.threadId, projectId: project.t3Id, title,
        modelSelection: selectedModel, runtimeMode: c.runtimeMode, interactionMode: 'default',
        workspaceStrategy: { type: 'worktree', baseRef: project.baseBranch, branch, startFromOrigin: true },
        initialMessage: { messageId: job.messageId, text: promptFor(job, project, c, manualPolicy), attachments: [] },
      };
      job.requestId = options.requestId;
      prepared.check();
      const context = readContext();
      if (context) context.own({ jobId: job.id, threadId: job.threadId }, () => store.save(job));
      else store.save(job); // Durable ownership precedes the external write, including ambiguous timeouts.
      clearPreparation?.(); // The durable job now accounts for its labels; do not count it twice.
      store.set('lastProject', project.kanvilId);
      if (job.kind === 'discovery') store.set(`discoveryLast:${project.kanvilId}`, String(Date.now()));
      await prepared.launch(job.command);
      const accepted = store.job(job.id)!; accepted.reason = 'T3 accepted dispatch'; store.save(accepted);
      return decision('dispatched', { jobId: job.id, threadId: job.threadId, project: project.name, projectId: project.kanvilId, ticket: job.ticketKey, upstream: job.upstream, model: selectedModel.model, modelReason, difficulty: job.difficulty, quota: currentQuota });
    }
  } finally { releaseTicket?.(); await prepared?.close(); if (ownsKanvil) await kanvil.close(); }
}

// Ask T3 to stop a run's thread; the next pass reconciles the job from T3.
export async function stopJob(c: Config, store: Store, t3: T3, jobId: string) {
  const job = store.job(jobId);
  if (!job || job.historyOnly || ['complete', 'dismissed'].includes(job.state)) throw new Error('That run is not active');
  try { await t3.stop(job.threadId); }
  catch (error) { throw new Error(`Stop not confirmed: ${safeError(error)}`); }
  const current = store.job(job.id)!;
  current.reason = 'Stop requested from the web app; waiting for T3 to confirm'; store.save(current);
  store.record('job.stop', `${jobLabel(job)} stop requested`, { ticketKey: job.ticketKey, projectId: job.projectId }, job.id);
  return { ok: true, jobId: job.id };
}

// Chains ------------------------------------------------------------------------------------------
// Reads tickets and tells whether they are finished, for configured projects and, through their columns, any other.
// `cached` serves display reads from the live projection; admission always reads fresh.
function taskReader(c: Config, kanvil: Kanvil, { cancelledFinished = false, cached = false } = {}) {
  const tasks = new Map<string, Promise<Task>>(), columns = new Map<string, Promise<string[]>>(), projects = new Set<string>();
  const relationReads = new Map<string, Promise<z.infer<typeof relationsSchema>>>();
  const task = (id: string) => cachedRead(tasks, id, () => (cached ? kanvil.task(id, undefined, true).then(task => kanvil.eligibleTask(task)) : kanvil.task(id)).then(task => { projects.add(task.projectId); return task; }));
  const relations = (id: string) => cachedRead(relationReads, id, () => (cached ? kanvil.relations(id, false) : kanvil.relations(id)).then(r => relationsSchema.parse(r)));
  const done = async (t: Task) => {
    if (cancelledFinished && t.status === 'cancelled') return true;
    const p = c.projects.find(p => p.kanvilId === t.projectId);
    if (p) return p.doneStatuses.includes(t.status);
    if (!columns.has(t.projectId)) columns.set(t.projectId, kanvil.columns(t.projectId).then(r => z.array(z.object({ slug: z.string(), isFinal: z.boolean() }).passthrough()).parse(r).filter(c => c.isFinal).map(c => c.slug)));
    return (await columns.get(t.projectId)!).includes(t.status);
  };
  const node = async (t: Task): Promise<PlanTicket> => {
    const p = c.projects.find(p => p.kanvilId === t.projectId), labels = t.labels ?? [];
    let difficulty: PlanTicket['difficulty'];
    try { difficulty = taskDifficulty(t); } catch { /* reported when it is its turn */ }
    return { id: t.id, key: p ? `${p.key}-${t.number}` : t.key ?? `#${t.number}`, title: t.title, projectId: t.projectId, status: t.status, priority: t.priority, createdAt: t.createdAt, difficulty, automationReady: t.automationReady, hold: automationHold(t) || undefined, labels: labels.map(label => label.name), labelRank: p ? ticketLabelRank(labels, p.priorityLabels) : undefined, runnable: !!p?.enabled, blockedBy: [], done: await done(t), ...t.readiness ? { readiness: t.readiness } : {} };
  };
  return { task, relations, done, node, projects, get ids() { return tasks.keys(); } };
}
// Every unfinished ticket that must finish before `rootId` may start: its blockers, their blockers, a parent's blockers, and an umbrella's children.
// Several roots are walked as one graph: each root joins the result, and a root that blocks another is its blocker like any other.
export async function blockerTree(c: Config, kanvil: Kanvil, root: string): Promise<{ target: PlanTicket; tickets: PlanTicket[] }>;
export async function blockerTree(c: Config, kanvil: Kanvil, roots: string[], reader?: ReturnType<typeof taskReader>): Promise<{ tickets: PlanTicket[] }>;
export async function blockerTree(c: Config, kanvil: Kanvil, roots: string | string[], reader = taskReader(c, kanvil)): Promise<{ target?: PlanTicket; tickets: PlanTicket[] }> {
  const nodes = new Map<string, PlanTicket>(), seen = new Set<string>();
  const ensure = async (id: string) => { if (!nodes.has(id)) nodes.set(id, await reader.node(await reader.task(id))); return nodes.get(id)!; };
  const require = async (attach: PlanTicket, id: string) => {
    if (await reader.done(await reader.task(id))) return;
    const b = await ensure(id);
    if (b.id !== attach.id && !attach.blockedBy.includes(b.id)) attach.blockedBy.push(b.id);
    await visit(b.id, b);
  };
  const visit = async (id: string, attach: PlanTicket) => {
    const key = `${id}:${attach.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const r of await reader.relations(id)) {
      if (r.relationType === 'blocks' && r.targetTaskId === id) await require(attach, r.sourceTaskId);
      else if (r.relationType === 'subtask' && r.targetTaskId === id) await visit(r.sourceTaskId, attach); // a parent's blockers block its subtasks
      else if (r.relationType === 'subtask' && r.sourceTaskId === id && attach.id === id) { // an umbrella waits for its children; they do not wait for each other
        await require(attach, r.targetTaskId);
        if (attach.blockedBy.includes(r.targetTaskId)) attach.umbrella = true;
      }
    }
  };
  if (Array.isArray(roots)) {
    for (const id of roots) await visit(id, await ensure(id));
    return { tickets: [...nodes.values()] };
  }
  const target = await ensure(roots);
  await visit(roots, target);
  return { target, tickets: [...nodes.values()].filter(t => t.id !== roots) };
}
const byPlanPriority = (a: PlanTicket, b: PlanTicket) => compareTicketPriority(a, b) || a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key);
// Tickets of a chain that could start now: unfinished, unblocked, not already owned by an open run. The target waits for every other ticket.
export function chainReady(plan: Pick<Plan, 'target' | 'tickets'>, jobs: Job[]) {
  const owned = new Set(jobs.filter(j => !['complete', 'dismissed'].includes(j.state)).map(j => j.taskId));
  const byId = new Map(planTickets(plan).map(t => [t.id, t]));
  const free = (t: PlanTicket) => !t.done && !owned.has(t.id) && t.blockedBy.every(id => byId.get(id)?.done ?? true);
  return [...plan.tickets.filter(free), ...(plan.target && plan.tickets.every(t => t.done) && free(plan.target) ? [plan.target] : [])].toSorted(byPlanPriority);
}
// A blocked manual ticket: describe its chain, run the first runnable blocker, or start the whole chain.
async function chainResponse(c: Config, store: Store, t3: T3, kanvil: Kanvil, instances: Map<string, string>, threads: Thread[], options: CycleOptions, queue: Pick<Queue, 'skipped'>, skip: Set<OverridableLimit>, decision: (reason: string, extra?: Record<string, unknown>) => Decision, currentConfig?: () => Config, decide?: ReturnType<Store['decisionRecorder']>): Promise<Decision | undefined> {
  const ticketKey = options.ticket!.trim().toUpperCase();
  const blocked = queue.skipped.find(s => s.key === ticketKey && s.id && /blocker|Umbrella/.test(s.reason));
  if (!blocked?.id) return undefined;
  const tree = await blockerTree(c, kanvil, blocked.id);
  const count = tree.tickets.length;
  if (!options.chain) return decision('blocked-ticket-plan-required', { ticket: ticketKey, tree, message: `${ticketKey} waits on ${count} unfinished ticket${count === 1 ? '' : 's'}. Run the first one that can start, or the whole chain and then ${ticketKey}.` });
  const run = (opts: CycleOptions): Promise<Decision> => opts.model && opts.model !== 'auto' ? dispatchOne(c, store, opts, undefined, { t3, kanvil, currentConfig, decide }) : cycle(c, store, opts, { t3, kanvil, currentConfig, decide });
  if (options.chain === 'first') {
    const pick = chainReady(tree, store.jobs()).find(t => t.runnable && t.id !== tree.target.id);
    if (!pick) return decision('chain-nothing-runnable', { ticket: ticketKey, tree, message: `Nothing in the chain to ${ticketKey} can start right now.` });
    const result = await run({ ...options, chain: undefined, ticket: pick.key });
    return { ...result, chain: { target: ticketKey, picked: pick.key } };
  }
  const { plan, dispatches, started } = await beginPlan(c, store, t3, kanvil, instances, threads, options, skip, { target: tree.target, tickets: tree.tickets }, currentConfig, decide);
  return decision('plan-started', { ticket: ticketKey, planId: plan.id, plan: store.plan(plan.id), dispatches, message: `Chain to ${ticketKey} started: ${started} of ${count} ticket${count === 1 ? '' : 's'} running now, the rest as they unblock.` });
}
// Durable before its first launch, and saved before the first await so a caller's checks stay atomic with it.
async function beginPlan(c: Config, store: Store, t3: T3, kanvil: Kanvil, instances: Map<string, string>, threads: Thread[], options: CycleOptions, skip: Set<OverridableLimit>, contents: Pick<Plan, 'target' | 'epic' | 'tickets' | 'queued'>, currentConfig?: () => Config, decide?: ReturnType<Store['decisionRecorder']>) {
  const plan: Plan = { requestId: options.requestId, id: randomUUID(), createdAt: new Date().toISOString(), ...contents, model: options.model ?? 'auto', ...(options.provider ? { provider: options.provider } : {}), overrideLimits: [...skip], state: 'active' };
  const context = readContext();
  if (context) context.own({ planId: plan.id }, () => store.savePlan(plan));
  else store.savePlan(plan);
  const dispatches = contents.queued ? [] : await runPlans(c, store, t3, kanvil, instances, threads, plan.id, undefined, currentConfig, decide);
  return { plan, dispatches, started: dispatches.filter(d => d.reason === 'dispatched').length };
}

// Epics --------------------------------------------------------------------------------------------
// An Epic's unfinished members and everything they wait for. A cancelled ticket counts as finished, so it cannot stall the group.
async function epicTree(c: Config, kanvil: Kanvil, epicId: string, cached = false) {
  const { tickets: members, restrictedCount } = await kanvil.epicTickets(epicId);
  const reader = taskReader(c, kanvil, { cancelledFinished: true, cached }), memberIds = new Set(members.map(member => member.id));
  const open = (await readAll(members.map(async member => await reader.done(member) ? [] : [member.id]))).flat();
  const { tickets } = await blockerTree(c, kanvil, open, reader);
  return { tickets: tickets.map(ticket => memberIds.has(ticket.id) ? ticket : { ...ticket, outside: true }), restrictedCount, memberIds };
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
// The one answer to whether an Epic may start, for the start path and for status.epics. Overrides never waive it.
function epicStartBlock(c: Config, epic: Pick<Epic, 'title' | 'archived'>, tickets: PlanTicket[], restrictedCount: number, running: boolean) {
  if (epic.archived) return { reason: 'epic-archived', message: `Epic ${epic.title} is archived.` };
  if (running) return { reason: 'epic-already-running', message: `Epic ${epic.title} is already running.` };
  const open = tickets.filter(ticket => !ticket.done);
  const excluded = open.filter(ticket => !ticket.runnable).map(ticket => ({ key: ticket.key, project: c.projects.find(project => project.kanvilId === ticket.projectId)?.name ?? ticket.key.match(/^([A-Z0-9]+)-\d+$/)?.[1] ?? ticket.projectId }));
  // A held umbrella's work runs through its children, so only its own ticket waits. Launches still refuse it.
  const held = open.filter(ticket => ticket.runnable && ticket.hold && !ticket.umbrella);
  if (excluded.length || restrictedCount || held.length) return {
    reason: excluded.length ? 'epic-project-not-included' : restrictedCount ? 'epic-restricted-tickets' : 'epic-tickets-not-ready', tickets: excluded, restrictedCount,
    message: [
      excluded.length ? `Epic ${epic.title} has unfinished tickets in projects the factory does not run: ${excluded.map(ticket => `${ticket.key} (${ticket.project})`).join(', ')}.` : '',
      restrictedCount ? `Epic ${epic.title} has ${plural(restrictedCount, 'ticket')} in projects the factory cannot read.` : '',
      held.length ? `Epic ${epic.title} has tickets the factory will not start: ${held.map(ticket => `${ticket.key} (${ticket.hold})`).join(', ')}.` : '',
    ].filter(Boolean).join(' '),
  };
  if (!open.length) return { reason: 'epic-no-unfinished', message: `Epic ${epic.title} has no unfinished tickets.` };
  return null;
}
// Reads run before the verdict, and the verdict and the saved plan share a synchronous step, so simultaneous starts make one plan.
async function startEpic(c: Config, store: Store, t3: T3, kanvil: Kanvil, instances: Map<string, string>, threads: Thread[], options: CycleOptions, skip: Set<OverridableLimit>, decision: (reason: string, extra?: Record<string, unknown>) => Decision, currentConfig?: () => Config, decide?: ReturnType<Store['decisionRecorder']>): Promise<Decision> {
  if (options.model && options.model !== 'auto' && !c.models.some(model => model.id === options.model)) throw new Error('Unknown model; select a configured model');
  const epic = (await kanvil.epics()).find(epic => epic.id === options.epic);
  if (!epic) return decision('epic-not-found', { epic: options.epic, message: 'Kanvil has no such Epic in the configured workspaces.' });
  const { tickets, restrictedCount } = await epicTree(c, kanvil, epic.id);
  const block = epicStartBlock(c, epic, tickets, restrictedCount, activeEpicPlans(store).some(plan => plan.epic!.id === epic.id));
  if (block) return decision(block.reason, { epic: epic.id, ...block });
  if (options.dryRun) return decision('would-dispatch', { kind: 'epic', epic: epic.id, tickets, message: `Epic ${epic.title} would start with ${plural(tickets.length, 'ticket')}.` });
  const { plan, dispatches, started } = await beginPlan(c, store, t3, kanvil, instances, threads, options, skip, { epic: { id: epic.id, title: epic.title, restrictedCount }, tickets }, currentConfig, decide);
  return decision('plan-started', { epic: epic.id, planId: plan.id, plan: store.plan(plan.id), dispatches, message: `Epic ${epic.title} started: ${started} of ${plural(tickets.length, 'ticket')} running now, the rest as they unblock.` });
}
// Members may have joined or left since the last pass. Returns the tickets this read refreshed, or nothing when it failed.
async function refreshEpicPlan(c: Config, store: Store, kanvil: Kanvil, plan: Plan) {
  const epic = plan.epic!, withoutError = (ticket: PlanTicket) => ticket.note === epic.error ? { ...ticket, note: undefined } : ticket;
  try {
    const { tickets, restrictedCount, memberIds } = await backgroundRead(() => epicTree(c, kanvil, epic.id));
    const fresh = new Map(tickets.map(ticket => [ticket.id, ticket])), listed = new Set(plan.tickets.map(ticket => ticket.id));
    const ran = new Set(store.jobSummaries().filter(job => job.state !== 'dismissed' && (job.state !== 'complete' || job.createdAt >= plan.createdAt)).map(job => job.taskId));
    plan.tickets = [
      ...plan.tickets.flatMap(ticket => {
        const next = fresh.get(ticket.id);
        return next ? [withoutError({ ...next, note: ticket.note })] : memberIds.has(ticket.id) || ran.has(ticket.id) ? [withoutError(ticket)] : [];
      }),
      ...tickets.filter(ticket => !listed.has(ticket.id)),
    ];
    epic.restrictedCount = restrictedCount; delete epic.error;
    return new Set(fresh.keys());
  } catch (error) {
    if (readContext()?.controller.signal.aborted) throw error;
    epic.error = safeError(error);
    log('epic-read-failed', { planId: plan.id, message: epic.error });
  }
}
// Runs with the Up next inventory rather than on every status write. A failed read keeps the last list.
async function refreshEpics(c: Config, store: Store, kanvil: Kanvil) {
  try {
    const rows = await backgroundRead(async () => {
      const limit = readLimiter(), epics = (await kanvil.epics()).filter(epic => !epic.archived);
      return readAll(epics.map(epic => limit(async () => {
        const { tickets, restrictedCount } = await epicTree(c, kanvil, epic.id, true);
        return { id: epic.id, title: epic.title, restrictedCount, tickets };
      })));
    });
    store.set('epics', JSON.stringify(rows.filter(row => row.tickets.length || row.restrictedCount)));
    store.set('epicsError', '');
  } catch (error) {
    if (readContext()?.controller.signal.aborted) throw error;
    const message = safeError(error);
    log('epics-read-failed', { message });
    store.set('epicsError', JSON.stringify({ at: new Date().toISOString(), message, problems: [{ title: "Couldn't read Kanvil Epics", cause: message, subjects: [], raw: [] }] }));
  }
}
// The stored reading, judged against the current configuration and plans so a start and its status cannot disagree.
function epicRows(c: Config, store: Store) {
  const rows = JSON.parse(store.get('epics') || '[]') as { id: string; title: string; restrictedCount: number; tickets: PlanTicket[] }[], active = activeEpicPlans(store);
  return rows.map(row => {
    const tickets = row.tickets.map(ticket => ({ ...ticket, runnable: !!c.projects.find(project => project.kanvilId === ticket.projectId)?.enabled }));
    const plan = active.find(plan => plan.epic!.id === row.id);
    return { ...row, tickets, planId: plan?.id ?? null, startBlock: epicStartBlock(c, { title: row.title, archived: false }, tickets, row.restrictedCount, !!plan) };
  });
}

// Advance every active chain: refresh ticket states, finish chains whose tickets are all done, start what can start within the run limits.
export async function runPlans(c: Config, store: Store, t3: T3, kanvil: Kanvil, instances: Map<string, string>, threads: Thread[], only?: string, providerDriver?: string, currentConfig?: () => Config, decide = store.decisionRecorder({ workKind: 'chains', providerDriver })): Promise<Decision[]> {
  const results: Decision[] = [];
  for (const original of store.plans().filter(p => p.state === 'active' && (!only || p.id === only))) {
    await backgroundCheckpoint();
    const plan = store.plan(original.id)!;
    if (plan.state !== 'active') continue;
    const refreshed = plan.epic ? await refreshEpicPlan(c, store, kanvil, plan) : undefined;
    const all = planTickets(plan);
    const limit = readLimiter();
    await readAll(all.filter(t => !refreshed?.has(t.id)).map(t => limit(async () => {
      try {
        const result = await backgroundRead(async () => { const reader = taskReader(c, kanvil, { cancelledFinished: !!plan.epic }), { status, difficulty, hold, done } = await reader.node(await reader.task(t.id)); return { status, difficulty, hold, done }; });
        Object.assign(t, result);
      }
      catch (error) { t.note = safeError(error); }
    })));
    if (store.plan(plan.id)?.state !== 'active') continue;
    // An Epic also waits for a good read of its members and for any tickets hidden from the factory.
    if (all.every(t => t.done) && !plan.epic?.error && !plan.epic?.restrictedCount) { plan.state = 'done'; plan.finishedAt = new Date().toISOString(); store.savePlan(plan); continue; }
    const pending: Promise<void>[] = [], planned = new Map<string, number>();
    const jobs = store.jobSummaries();
    for (const t of chainReady(plan, jobs)) {
      if (store.plan(plan.id)?.state !== 'active') break;
      if (providerDriver && plan.provider && providerDriver !== plan.provider) continue;
      if (!t.runnable) { t.note = 'Its project is not included in the factory'; continue; }
      const models = c.models.filter(model => plan.model !== 'auto' ? model.id === plan.model
        : (model.automatic || !!plan.provider) && (!plan.provider || instances.get(model.model.instanceId) === plan.provider) && acceptsDifficulty(model, t as Candidate) && (!providerDriver || instances.get(model.model.instanceId) === providerDriver));
      const presets = plan.queued ? models : models.slice(0, 1);
      if (!presets.length) {
        if (providerDriver && plan.model === 'auto' && c.models.some(model => model.automatic && acceptsDifficulty(model, t as Candidate))) continue;
        t.note = t.difficulty ? (plan.model === 'auto' ? 'No automatic model accepts this difficulty' : 'The chosen model is no longer configured') : 'Ticket needs a native difficulty before dispatch'; continue;
      }
      const busy = busyProviders(jobs, threads, instances, c.monitoringTimeoutMinutes, c.concurrency, planned, { manual: true, overrideLimits: plan.overrideLimits });
      const available = presets.filter(preset => (!providerDriver || instances.get(preset.model.instanceId) === providerDriver) && !busy.has(instances.get(preset.model.instanceId) ?? 'claudeAgent'));
      if (!available.length) { const driver = instances.get(presets[0].model.instanceId); if (providerDriver && driver !== providerDriver) continue; t.note = `Waiting for a free ${driver === 'codex' ? 'Codex' : 'Claude'} slot`; continue; }
      if (store.isLocked(`ticket:${t.id}`)) continue;
      for (const driver of new Set(available.map(preset => instances.get(preset.model.instanceId) ?? 'claudeAgent'))) planned.set(driver, (planned.get(driver) ?? 0) + 1);
      pending.push(independentOperation(() => store.exclusive([`ticket:${t.id}`], async () => {
        try {
          for (const preset of available) {
            const result = await dispatchOne(c, store, { manual: true, continuation: !only, ticket: t.key, model: preset.id, provider: plan.provider, overrideLimits: plan.overrideLimits }, undefined, { t3, kanvil, currentConfig, decide }, plan.id);
            results.push(result);
            t.note = result.reason === 'dispatched' ? undefined : String((result as any).skipped?.[0]?.reason ?? (result as any).message ?? result.reason);
            if (plan.queued && result.reason === 'dispatched' && store.plan(plan.id)?.state === 'active') { plan.state = 'done'; plan.finishedAt = new Date().toISOString(); store.savePlan(plan); }
            if (!limitHold(result.reason) && !['quota-exhausted', 'codex-quota-exhausted'].includes(result.reason)) break;
          }
        } catch (error) { t.note = safeError(error); results.push({ reason: 'error', at: new Date().toISOString(), ticket: t.key, message: t.note }); }
      })));
    }
    await readAll(pending);
    if (plan.epic?.error) for (const t of plan.tickets) if (!t.done) t.note = plan.epic.error;
    if (store.plan(plan.id)?.state === 'active') store.savePlan(plan);
  }
  return results;
}
export function cancelPlan(store: Store, id: string) {
  const plan = store.plan(id);
  if (!plan || plan.state !== 'active') throw new Error('That chain is not active');
  plan.state = 'cancelled'; plan.finishedAt = new Date().toISOString(); store.savePlan(plan);
  return { ok: true, planId: id };
}

// What the factory would start next, in order, and which automatic model would take each ticket.
// A blocked ticket whose blockers are all queued ahead of it or already running joins the queue behind them.
export function upNext(c: Config, store: Store, queue: Pick<Queue, 'ready' | 'skipped'>) {
  const activeJobs = store.jobSummaries().filter(job => !['complete', 'dismissed'].includes(job.state));
  const owned = new Set(activeJobs.map(job => job.taskId));
  const order: (Candidate & { after?: string[] })[] = queueOrder(queue.ready.filter(ticket => !owned.has(ticket.id)), store.get('lastProject'), c.projects.filter(p => p.enabled).map(p => p.kanvilId));
  const placed = new Map(order.map(t => [t.id, t.key]));
  for (const j of activeJobs) if (j.taskId) placed.set(j.taskId, j.ticketKey ?? j.taskId);
  const blocked = queue.skipped.filter((s): s is Skipped & { ticket: Candidate; blockedBy: string[] } => !!s.ticket && !!s.blockedBy?.length);
  const projected = new Set<string>();
  for (let round = blocked.filter(s => !placed.has(s.ticket.id) && s.blockedBy.every(id => placed.has(id))); round.length; round = blocked.filter(s => !placed.has(s.ticket.id) && s.blockedBy.every(id => placed.has(id)))) {
    for (const s of round.toSorted((a, b) => compareTicketPriority(a.ticket, b.ticket) || a.ticket.createdAt.localeCompare(b.ticket.createdAt))) {
      order.push({ ...s.ticket, after: s.blockedBy.map(id => placed.get(id)!) });
      placed.set(s.ticket.id, s.ticket.key); projected.add(s.ticket.id);
    }
  }
  const result = {
    at: new Date().toISOString(),
    tickets: order.map(t => {
      const preset = c.models.find(m => m.automatic && acceptsDifficulty(m, t));
      return { id: t.id, key: t.key, title: t.title ?? '', projectId: t.projectId, createdAt: t.createdAt, difficulty: t.difficulty, automationReady: t.automationReady, priority: t.priority, labels: (t.labels ?? []).map(l => l.name), labelRank: t.labelRank, after: t.after ?? [], model: preset?.name ?? null, modelId: preset?.id ?? null };
    }),
    held: queue.skipped.filter(s => !s.id || !projected.has(s.id) && !owned.has(s.id)).map(s => ({ key: s.key, reason: s.reason, ...(s.ticket ? { projectId: s.ticket.projectId, title: s.ticket.title, priority: s.ticket.priority, difficulty: s.ticket.difficulty, automationReady: s.ticket.automationReady, labels: (s.ticket.labels ?? []).map(l => l.name) } : {}) })),
  };
  const previous = JSON.parse(store.get('upNext') ?? 'null');
  return previous && JSON.stringify(previous.tickets) === JSON.stringify(result.tickets) && JSON.stringify(previous.held) === JSON.stringify(result.held) ? { ...result, at: previous.at } : result;
}

// Re-read each provider's allowance without a full pass; a reading older than quota.maxAgeSeconds is refreshed.
// Resolves false when a read failed or only a retained reading served. `instanceId` limits it to one provider.
export async function refreshQuota(c: Config, store: Store, t3: T3, currentConfig = () => c, instanceId?: string) {
  const streams = JSON.parse(store.get('streams') ?? '[]') as ProviderStream[];
  const publish = streamUpdate(store, 'streams', streams.map(stream => stream.driver));
  const identity = (config: Config) => JSON.stringify([config.t3, config.models, config.quota, config.enabled, config.concurrency, config.idleMinutes, config.monitoringTimeoutMinutes]);
  const startedWith = identity(c);
  const instances = new Map((await backgroundRead(() => { return t3.providers(); })).map(p => [p.instanceId, p.driver]));
  let threads: Thread[] = [], shellError: string | undefined;
  try { threads = (await backgroundRead(() => t3.shell())).threads; }
  catch (error) { shellError = safeError(error); }
  let fresh = true, covered = !instanceId;
  const read = async (instance: string, ids: string[]) => {
    const results = await backgroundRead(() => readModelQuotas(t3, c, store.jobs(), ids, false, true));
    if (!instanceId || instance === instanceId) fresh &&= results.every(result => result.quota && !result.quota.retained);
    return results;
  };
  for (const stream of streams) {
    const presets = c.models.filter(p => instances.get(p.model.instanceId) === stream.driver);
    if (instanceId && !presets.some(preset => preset.model.instanceId === instanceId)) continue;
    covered = true;
    const previousReasons = stream.models?.map(model => model.reason) ?? [];
    // A dispatch/queue refusal belongs to admission, rather than the model evaluator.
    const admission = !previousReasons.includes(stream.reason) && stream.reason !== stream.quotaError && !['ready', 'disabled', 'provider-disabled', 'provider-running', 'no-eligible-model', 'quota-exhausted', 'quota-budget'].includes(stream.reason) ? stream.reason : undefined;
    let results: Awaited<ReturnType<typeof readModelQuotas>> = [];
    const evaluatedProviders = new Map<string, ReturnType<T3['peekProvider']>>();
    for (const instance of new Set(presets.map(preset => preset.model.instanceId))) {
      results.push(...await read(instance, presets.filter(preset => preset.model.instanceId === instance).map(preset => preset.id)));
      evaluatedProviders.set(instance, t3.peekProvider(instance));
    }
    const jobs = store.jobs();
    const providerConstraint = () => {
      const busy = busyProviders(store.jobs(), threads, instances, c.monitoringTimeoutMinutes, c.concurrency);
      return c.concurrency[stream.driver === 'codex' ? 'codex' : 'claude'] === 0 ? 'provider-disabled' : busy.has(stream.driver) ? 'provider-running' : !c.enabled ? 'disabled' : undefined;
    };
    let constraint = providerConstraint();
    let activity = shellError;
    if (!constraint && presets.some(preset => preset.automatic)) {
      try { if (!shellError && idleBlocked(c, await personalActivity(t3, threads, jobs, store, c.monitoringTimeoutMinutes, stream.driver, instances))) activity = 'waiting-for-idle'; }
      catch (error) { activity = safeError(error); }
    }
    constraint = providerConstraint();
    // Events received during another model/activity read remain authoritative at publication.
    results = results.map(result => {
      const preset = presets.find(preset => preset.id === result.id)!, current = t3.peekProvider(preset.model.instanceId);
      const changed = JSON.stringify(current) !== JSON.stringify(evaluatedProviders.get(preset.model.instanceId));
      if (!changed && 'error' in result) return result;
      const snapshot = changed ? current : result.snapshot;
      try {
        if (!snapshot || snapshot.driver !== stream.driver) throw new Error('Provider identity changed during quota refresh');
        return { id: result.id, quota: modelQuota(c, store.jobs(), result.id, snapshot, false) };
      } catch (error) { return { id: result.id, error }; }
    });
    stream.models = presets.map(preset => {
      const result = results.find(result => result.id === preset.id)!;
      const reason = 'error' in result ? safeError(result.error) : !result.quota!.hasAllowance ? 'quota-exhausted' : !result.quota!.allowed ? 'quota-budget' : constraint ?? (!preset.automatic ? 'no-eligible-model' : activity ?? 'ready');
      return { id: preset.id, name: preset.name, reason };
    });
    const quota = results.find(result => result.quota)?.quota;
    if (quota) stream.quota = quota;
    if (!presets.length) stream.quota = undefined;
    const failed = results.find(result => 'error' in result);
    stream.quotaError = failed ? safeError(failed.error) : presets.length ? undefined : 'No model is configured for this provider';
    // A quota-only check never proves that a ticket can start.
    const reasons = stream.models.map(model => model.reason);
    stream.reason = constraint ?? (reasons.includes('ready') ? admission ?? 'no-eligible-ticket' : reasons[0] ?? 'no-eligible-model');
    if (identity(currentConfig()) === startedWith) publish([stream]);
  }
  // A provider without a displayed row still gets its read.
  const unlisted = c.models.filter(p => !covered && p.model.instanceId === instanceId).map(p => p.id);
  if (unlisted.length) await read(instanceId!, unlisted);
  return fresh;
}

// One row per watched repository: the release reviewed through, the newest release seen, and whether a review runs or is due.
export function upstreamRows(c: Config, store: Store) {
  const jobs = store.jobSummaries();
  return c.projects.flatMap(p => p.upstreams.map(u => {
    const { reviewing, reviewed, latest, due } = releaseState(p, u, store, jobs), checked = Number(store.get(`upstreamCheckedAt:${u.repo}`) ?? 0);
    return { project: p.name, name: u.name, repo: u.repo, prereleases: u.prereleases, reviewed, latest, checkedAt: checked ? new Date(checked).toISOString() : null,
      checkError: store.get(`upstreamCheckError:${u.repo}`) || null, reviewing, pending: due };
  }));
}

// The lane publishes each inbox's queue from the live projections; rows follow the current config.
export function triageRows(c: Config, store: Store, now = Date.now()) {
  const rows = JSON.parse(store.get('triageStreams') || '[]') as TriageRow[];
  return inboxes(c).map(({ project, inbox }) => {
    const row: TriageRow = rows.find(row => row.inboxId === inbox.kanvilId && row.projectId === project.kanvilId)
      ?? { project: project.name, projectId: project.kanvilId, inboxId: inbox.kanvilId, label: inbox.label, synchronized: false, untriaged: null, failed: null, running: null, oldestUntriagedAt: null, promoted: null, queued: null, blocked: null, needsOwner: null, limit: null };
    // The limit is the current config's, so an edit shows before the next pass.
    return { ...row, limit: inbox.maxPromotionsPerDay ?? null, oldestAgeSeconds: row.oldestUntriagedAt ? Math.max(0, Math.round((now - Date.parse(row.oldestUntriagedAt)) / 1000)) : null };
  });
}
/** How many triage results the status file and the Triage page carry. */
export const TRIAGE_RESULTS = 30;
// Recent triage results, each promoted one with its ticket as the triage lane last read it and why it cannot start now.
// `listed` keeps a promoted ticket on the page's ticket list until a run launches or it leaves the ready statuses.
export function triageResults(c: Config, store: Store) {
  const promoted = JSON.parse(store.get('triagePromoted') || '{}') as Record<number, { taskId: string; projectId: string; status: string }>;
  const jobs = store.jobSummaries();
  return store.events(TRIAGE_RESULTS, undefined, 'triage').map(event => {
    const t = promoted[event.id];
    if (!t) return event;
    const project = c.projects.find(p => p.kanvilId === t.projectId), ready = !project || project.readyStatuses.includes(t.status);
    const unavailable = projectUnavailable(project) ?? (ready ? null : `Ticket is ${t.status}; it must be in ${project!.readyStatuses.join(' or ')}`);
    const listed = event.data.outcome === 'promoted' && ready && !jobs.some(j => j.taskId === t.taskId && launched(j));
    return { ...event, promotedTicket: { ...t, unavailable, listed } };
  });
}
const iso = (ms: string | null) => (ms && Number(ms) ? new Date(Number(ms)).toISOString() : null);
export function writeStatus(c: Config, store: Store) {
  const result = {
    ticketKeyRevision: store.get('ticketKeyRevision') ?? undefined,
    work: JSON.parse(store.get('serviceWork') ?? 'null'),
    triageEnabled: !!c.triage?.enabled, triageStreams: triageRows(c, store), triageDecision: JSON.parse(store.get('triageDecision') ?? 'null'), triageResults: triageResults(c, store),
    enabled: c.enabled, upstreamEnabled: !!c.upstream?.enabled, concurrency: c.concurrency, at: new Date().toISOString(), upstreams: upstreamRows(c, store), models: c.models, streams: JSON.parse(store.get('streams') ?? '[]'), decision: store.currentDecision(),
    discovery: c.projects.map(p => ({ projectId: p.kanvilId, lastAt: iso(store.get(`discoveryLast:${p.kanvilId}`)), nextAt: iso(store.get(`discoveryAfter:${p.kanvilId}`)) })),
    upNext: JSON.parse(store.get('upNext') ?? 'null'),
    plans: store.plans().filter(p => p.state === 'active' || Date.now() - Date.parse(p.finishedAt ?? p.createdAt) < 86_400_000),
    epics: epicRows(c, store), epicsError: JSON.parse(store.get('epicsError') || 'null'),
    sessionTickets: sessionTicketStatus(c, store),
    jobs: store.jobSummaries().filter(j => j.state !== 'dismissed').map(({ ...job }) => ({ ...job, label: jobLabel(job) })),
    // The menu app reads only this file, so it gets the recent journal and the last finished runs here.
    journal: store.events(60),
    recent: store.recentJobs().map(job => ({ ...job, label: jobLabel(job) })),
  };
  const file = join(c.stateDir, 'status.json'); writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  return result;
}
