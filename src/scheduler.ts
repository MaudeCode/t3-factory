import { readFileSync, realpathSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { T3, Kaneo, listTasks, listTaskLabels, taskSchema, type Task } from './clients.ts';
import { executing, providerExecuting, subagentDescendants, waiting, stalledMonitor, DEFAULT_MONITORING_TIMEOUT_MINUTES, ticketDifficulty, ticketLabelRank, branchKind, compareTicketPriority, mentionsTicket, selectTicket, queueOrder, acceptsDifficulty, selectAssignment, type Thread, type Candidate, type TicketPriority } from './policy.ts';
import { Store, jobLabel, type Job, type Plan, type PlanTicket } from './store.ts';
import { promptFor } from './prompts.ts';
import { loadConfig, type Config, type Project } from './config.ts';

import { readModelQuota } from './models.ts';

const exec = promisify(execFile);
// Blocked cleanups wait for something outside the scheduler to change, so retrying every cycle only repeats their cost.
const CLEANUP_RETRY_MINUTES = 15;
// An unrecorded or unreadable block time retries now.
const cleanupDue = (job: Job) => !(Date.now() - Date.parse(job.workspaceCleanupBlockedAt ?? '') < CLEANUP_RETRY_MINUTES * 60_000);
const reportSchema = z.object({
  jobId: z.string(), status: z.enum(['complete', 'awaiting-human', 'no-work']), reason: z.string(),
  prUrls: z.array(z.url()).default([]), createdTaskIds: z.array(z.string()).default([]),
}).strict();
const relationsSchema = z.array(z.object({ sourceTaskId: z.string(), targetTaskId: z.string(), relationType: z.enum(['blocks', 'subtask', 'related']) }).passthrough());
function projectFor(c: Config, job: Job): Project {
  const p = c.projects.find(p => p.kaneoId === job.projectId);
  if (!p) throw new Error(`Keep project ${job.projectId} configured while its jobs are unfinished; disable it instead of removing it`);
  return p;
}
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
export function safeError(error: unknown): string {
  // Never log HTTP headers, credentials, prompts, or complete SDK error objects.
  return String(error instanceof Error ? error.message ?? error.name : error).replace(/(?:Bearer\s+|sk-ant-)[^\s"']+/g, '[redacted]').replace(/([?&](?:wsTicket|token|access_token)=)[^&\s)]+/gi, '$1[redacted]').slice(0, 800);
}
async function git(path: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', path, ...args], { timeout: 20_000, maxBuffer: 2_000_000 })).stdout.trim();
}
async function gh(args: string[]): Promise<unknown> {
  return JSON.parse((await exec('gh', args, { timeout: 30_000, maxBuffer: 3_000_000 })).stdout);
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
  const pending: PendingReview[] = [];
  for (const project of c.projects.filter(p => p.enabled)) for (const watched of project.upstreams) {
    if (releaseState(project, watched, store, jobs).reviewing) continue;
    const checkedKey = `upstreamCheckedAt:${watched.repo}`, errorKey = `upstreamCheckError:${watched.repo}`;
    if (refresh && now - Number(store.get(checkedKey) ?? 0) >= (watched.checkMinutes ?? c.upstream!.checkMinutes) * 60_000) {
      store.set(checkedKey, String(now)); // A failed read also waits checkMinutes before retrying.
      try {
        // gh excludes drafts (which have no publish date) and skipped pre-releases before its limit, so they cannot hide a release.
        const latest = releasesSchema.parse(await gh(['release', 'list', '--repo', watched.repo, '--limit', '30', '--exclude-drafts', ...watched.prereleases ? [] : ['--exclude-pre-releases'], '--json', 'tagName,publishedAt']))
          .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
        if (latest) store.set(`upstreamLatest:${watched.repo}`, latest.tagName);
        store.set(errorKey, '');
      } catch (error) { store.set(errorKey, safeError(error)); log('upstream-check-failed', { repo: watched.repo, reason: safeError(error) }); }
    }
    const { reviewed, latest, due } = releaseState(project, watched, store, jobs);
    if (due) pending.push({ project, upstream: { name: watched.name, repo: watched.repo, base: reviewed, candidate: latest! } });
  }
  return pending;
}
async function verifyMerged(project: Project, urls: string[]) {
  for (const url of urls) {
    const u = new URL(url);
    if (u.origin !== 'https://github.com' || !new RegExp(`^/${project.githubRepo}/pull/[0-9]+$`).test(u.pathname)) throw new Error('Completion report PR belongs to the wrong repository');
    const pr = z.object({ state: z.literal('MERGED'), baseRefName: z.string(), mergeCommit: z.object({ oid: z.string().min(40) }) }).parse(await gh(['pr', 'view', u.pathname.split('/').at(-1)!, '--repo', project.githubRepo, '--json', 'state,baseRefName,mergeCommit']));
    if (pr.baseRefName !== project.baseBranch) throw new Error('Completed PR targets the wrong release branch');
  }
}
async function released(project: Project, head: string): Promise<boolean> {
  return git(project.repoPath, ['merge-base', '--is-ancestor', head, `refs/remotes/origin/${project.baseBranch}`]).then(() => true, () => false);
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
  if (worktreePath && existsSync(worktreePath)) history.push(await git(worktreePath, ['rev-parse', 'HEAD']), ...await refHistory(worktreePath, 'HEAD'));
  return history.every(head => head === created) && await released(project, created) ? created : '';
}
// A ticket closed without delivery must have left the ready queue and abandon no work.
async function verifyClosedWithoutDelivery(c: Config, project: Project, kaneo: Kaneo, task: Task, job: Job, thread: Thread) {
  if (!project.doneStatuses.includes(task.status) && project.readyStatuses.includes(task.status) && (await listTaskLabels(kaneo)).get(task.id)?.some(l => l.name === c.kaneo.readyLabel)) {
    throw new Error('Ticket is still ready; record why no change is needed and remove it from the ready queue');
  }
  const unmerged = new Error('Unmerged work remains; deliver it through a PR or report awaiting-human');
  const branch = assignedBranch(job), worktree = thread.worktreePath && existsSync(thread.worktreePath) ? thread.worktreePath : null;
  if (worktree && (await git(worktree, ['status', '--porcelain']) || await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch)) throw unmerged;
  if (!branch || !await branchTip(project, branch)) throw new Error('Workspace head cannot be verified; inspect the work in T3 or report awaiting-human');
  if (!await untouchedHead(project, branch, worktree)) throw unmerged;
}
export async function reconcile(c: Config, store: Store, t3: T3, kaneo: Kaneo, threads: Thread[], allowMonitorStop = true) {
  for (const job of store.jobs().filter(j => j.state !== 'dismissed' || (j.workspaceCleanup && !j.workspaceCleanedAt))) {
    const t = threads.find(t => t.id === job.threadId);
    if (t && allowMonitorStop && (job.state === 'complete' || job.workspaceCleanup) && !job.workspaceCleanedAt && cleanupDue(job)) await cleanupCompletedWorkspace(c, store, t3, kaneo, job);
    if (job.state === 'dismissed') continue;
    if (t?.settledOverride === 'settled' && !executing(t, c.monitoringTimeoutMinutes)) {
      job.state = 'dismissed'; job.reason = 'Dismissed by settling the task in T3'; job.dismissedAt = new Date().toISOString();
      job.dismissedBranch = t.branch ?? undefined; job.dismissedWorktreePath = t.worktreePath ?? undefined;
      if (t.worktreePath && existsSync(t.worktreePath)) {
        try { job.dismissedHead = await git(t.worktreePath, ['rev-parse', 'HEAD']); } catch { /* Keep unknown artifacts protected. */ }
      }
      store.save(job); log('job-dismissed', { jobId: job.id, threadId: job.threadId }); continue;
    }
    if (job.state === 'complete') continue;
    if (!t) {
      if (Date.now() - Date.parse(job.createdAt) > 5 * 60_000) {
        job.state = 'dispatching'; job.reason = 'Dispatch outcome unknown; retain the execution slot until T3 can be reconciled';
      }
      store.save(job); continue;
    }
    if (stalledMonitor(t, c.monitoringTimeoutMinutes)) {
      if (!allowMonitorStop) {
        job.state = 'running'; job.reason = 'Stalled background monitor; normal service cycle will stop it before releasing the slot';
        store.save(job); continue;
      }
      // Stop only this owned idle session before releasing its slot: an old watcher
      // must not wake the agent in parallel with the next autonomous job.
      const fresh = (await t3.shell()).threads.find(x => x.id === job.threadId);
      if (fresh && stalledMonitor(fresh, c.monitoringTimeoutMinutes)) {
        await t3.dispatch({ type: 'thread.stop', commandId: randomUUID(), threadId: job.threadId, reason: 'Stalled background monitor' });
        job.state = 'running'; job.reason = 'Stopping stalled background monitor; awaiting T3 confirmation';
        if (!existsSync(job.reportPath)) {
          writeFileSync(`${job.reportPath}.tmp`, JSON.stringify({ jobId: job.id, status: 'awaiting-human', reason: `Background monitor made no turn progress for ${c.monitoringTimeoutMinutes} minutes. Session stopped; inspect review results and resume this thread. Merge authorization and required human validation still apply.`, prUrls: job.prUrls, createdTaskIds: [] }) + '\n', { mode: 0o600 });
          renameSync(`${job.reportPath}.tmp`, job.reportPath);
        }
        log('stalled-monitor-stop-requested', { jobId: job.id, threadId: job.threadId });
      }
      store.save(job); continue;
    }
    if (executing(t, c.monitoringTimeoutMinutes) || ['dispatching', 'running'].includes(job.state)) job.lastExecutionAt = t.updatedAt;
    job.thread = { title: t.title, status: t.status, branch: t.branch, worktreePath: t.worktreePath, updatedAt: t.updatedAt, pending: t.pendingRuntimeRequest?.kind ?? null, background: t.pendingBackgroundTasks.map(b => b.kind) };
    if (waiting(t)) { job.state = 'waiting'; job.reason = 'T3 is awaiting human input'; }
    else if (executing(t, c.monitoringTimeoutMinutes)) { job.state = 'running'; job.reason = 'Claude is executing'; }
    else {
      try {
        if (!existsSync(job.reportPath)) throw new Error('Turn ended without a completion report; inspect in T3');
        const report = reportSchema.parse(JSON.parse(readFileSync(job.reportPath, 'utf8')));
        if (report.jobId !== job.id) throw new Error('Completion report job ID mismatch');
        job.prUrls = report.prUrls;
        if (report.status === 'awaiting-human') { job.state = 'waiting'; job.reason = report.reason; }
        else {
          const project = projectFor(c, job);
          if (job.kind === 'ticket') {
            if (report.status !== 'complete' && report.prUrls.length) throw new Error('Ticket cannot finish as no-work');
            const task = taskSchema.parse(await kaneo.call('get_task', { taskId: job.taskId }));
            if (!report.prUrls.length) await verifyClosedWithoutDelivery(c, project, kaneo, task, job, t);
            else {
              if (!project.doneStatuses.includes(task.status)) throw new Error('Ticket not yet verified Done in Kaneo');
              await verifyMerged(project, report.prUrls);
            }
          } else {
            // An upstream review that created nothing reports no-work, so a truncated report cannot mark a release reviewed.
            if (job.kind === 'upstream' && report.status === 'complete' && !report.createdTaskIds.length) throw new Error('Upstream review reported complete without created tickets; report no-work if none were needed');
            for (const id of report.createdTaskIds) {
              const task = taskSchema.parse(await kaneo.call('get_task', { taskId: id }));
              if (task.projectId !== project.kaneoId) throw new Error(`${job.kind === 'upstream' ? 'Upstream review' : 'Discovery'} report includes another project`);
              if (job.kind === 'upstream' && Date.parse(task.createdAt) < Date.parse(job.createdAt)) throw new Error('Upstream review report lists a ticket created before the review started');
            }
            if (job.kind === 'upstream') store.set(`upstreamReviewed:${job.upstream!.repo}`, job.upstream!.candidate);
            else if (!report.createdTaskIds.length) store.set(`discoveryAfter:${job.projectId}`, String(Date.now() + c.discovery.emptyCooldownHours * 3_600_000));
          }
          job.state = 'complete'; job.reason = report.reason; job.completedAt = new Date().toISOString();
          log('job-complete', { jobId: job.id, ticket: job.ticketKey, prUrls: job.prUrls });
        }
      } catch (e) { job.state = 'waiting'; job.reason = safeError(e); }
    }
    store.save(job);
  }
}

function assignedBranch(job: Job): string | undefined {
  const command = z.union([
    z.object({ bootstrap: z.object({ prepareWorktree: z.object({ branch: z.string() }) }) }).transform(c => c.bootstrap.prepareWorktree.branch),
    z.object({ workspaceStrategy: z.object({ branch: z.string() }) }).transform(c => c.workspaceStrategy.branch),
  ]).safeParse(job.command);
  return command.success ? command.data : undefined;
}
// Resolve a removed directory through its nearest existing ancestor so it compares equal to Git's registered path.
function canonicalPath(path: string): string { return existsSync(path) ? realpathSync(path) : join(canonicalPath(dirname(path)), basename(path)); }

async function cleanupCompletedWorkspace(c: Config, store: Store, t3: T3, kaneo: Kaneo, job: Job) {
  try {
    if (!job.completedAt) return;
    const project = projectFor(c, job), fresh = await t3.shell(), thread = fresh.threads.find(t => t.id === job.threadId);
    if (!thread) return;
    if (thread.projectId !== project.t3Id) throw new Error('Thread no longer belongs to its Factory project');
    const snapshotAt = thread.updatedAt;
    const completedAt = Date.parse(job.completedAt);
    const busy = (t: Thread) => executing(t, c.monitoringTimeoutMinutes, false) || waiting(t) || !!t.orphanedRun || t.pendingBackgroundTasks.some(t => t.kind !== 'monitor');
    const resumed = (t: Thread) => Date.parse(t.latestUserMessageAt ?? job.createdAt) > completedAt || Date.parse(t.latestRunCompletedAt ?? job.createdAt) > completedAt;
    // T3 could still recover an orphaned run, so its workspace stays until T3 ends the run.
    if (thread.orphanedRun) throw new Error('Thread has an orphaned T3 run; settle it in T3 before workspace cleanup');
    if (busy(thread)) throw new Error('Workspace still has active or pending work');
    if (resumed(thread)) throw new Error('Completed thread has resumed since completion');
    const pending = job.workspaceCleanup, workspace = pending?.path ?? thread.worktreePath;
    if (!workspace) { job.workspaceCleanedAt = new Date().toISOString(); store.save(job); return; }
    const path = canonicalPath(workspace);
    const assigned = assignedBranch(job);
    if (!assigned) throw new Error('Workspace was not assigned by a Factory launch');
    const checkoutBranch = existsSync(path) ? await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
    const branch = pending?.branch ?? (checkoutBranch && checkoutBranch !== 'HEAD' ? checkoutBranch : thread.branch ?? assigned);
    if (thread.worktreePath && canonicalPath(thread.worktreePath) !== path) throw new Error('Thread workspace changed during cleanup');
    if (path === canonicalPath(project.repoPath)) throw new Error('Preserve the primary checkout');
    const bound = (t: Thread) => t.worktreePath != null && (canonicalPath(t.worktreePath) === path || canonicalPath(t.worktreePath).startsWith(path + sep));
    // T3 binds subagents to their parent's worktree. They belong to the job, but only once idle.
    const shared = (threads: Thread[], subagents: Thread[]) => threads.some(t => t.id !== thread.id && !subagents.some(s => s.id === t.id) && bound(t));
    const subagents = subagentDescendants(fresh.threads, thread.id);
    if (shared(fresh.threads, subagents)) throw new Error('Workspace is shared with another thread');
    if (subagents.some(t => busy(t) || resumed(t))) throw new Error('Workspace is shared with an active subagent');
    let head: string;
    if (job.kind === 'ticket' && job.prUrls.length) {
      const task = taskSchema.parse(await kaneo.call('get_task', { taskId: job.taskId }));
      if (!project.doneStatuses.includes(task.status)) throw new Error('Ticket is no longer Done');
      const history = await historicalArtifacts(project, [{ ...job, state: 'complete' }], fresh.threads, branch, store);
      if (!history.branches.has(branch)) throw new Error('Workspace head is not verified merged');
      head = history.branches.get(branch)!;
    } else {
      // Discovery and tickets closed without delivery verify their head against the release branch.
      head = pending?.head ?? await git(path, ['rev-parse', 'HEAD']);
      if (!await released(project, head)) throw new Error('Workspace head is not part of the release branch');
    }
    if (pending && pending.head !== head) throw new Error('Verified workspace head changed');
    if (existsSync(path)) {
      if (await git(path, ['status', '--porcelain']) || await git(path, ['rev-parse', 'HEAD']) !== head || (checkoutBranch !== branch && checkoutBranch !== 'HEAD')) throw new Error('Preserve dirty or changed workspace');
    }
    const monitored = [thread, ...subagents].filter(t => t.pendingBackgroundTasks.length);
    if (monitored.length) {
      for (const t of monitored) await t3.dispatch({ type: 'thread.stop', commandId: randomUUID(), threadId: t.id, reason: 'Verified Factory completion; close passive monitors before workspace cleanup' });
      return;
    }
    const boundSubagents = subagents.filter(bound);
    if (boundSubagents.length) {
      for (const t of boundSubagents) await t3.dispatch({ type: 'thread.metadata.update', commandId: randomUUID(), threadId: t.id, expectedWorktreePath: t.worktreePath, worktreePath: null, branch: null });
      return; // Detach owned subagents before the job thread, one step per cycle.
    }
    if (thread.worktreePath) {
      job.workspaceCleanup = { path, branch, head }; job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job);
      await t3.dispatch({ type: 'thread.metadata.update', commandId: randomUUID(), threadId: thread.id, expectedWorktreePath: thread.worktreePath, worktreePath: null, branch: null });
      return; // Let T3 detach the idle provider session before removing its directory.
    }
    // T3 can leave this thread's idle setup shell open in the workspace. Close only its idle terminals; the process check stays authoritative.
    const terminals = (await t3.terminals()).filter(t => t.threadId === thread.id && (t.status === 'starting' || t.status === 'running'));
    if (terminals.some(t => t.status === 'starting' || t.hasRunningSubprocess)) throw new Error('A T3 terminal for this thread is still running a command');
    if (terminals.length) {
      for (const t of terminals) await t3.closeTerminal(thread.id, t.terminalId);
      return; // Let the shells exit before checking running processes.
    }
    const cwds = (await exec('lsof', ['-b', '-n', '-d', 'cwd', '-Fn'], { timeout: 20_000, maxBuffer: 4_000_000 })).stdout.split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1));
    if (!cwds.length) throw new Error('Cannot verify running process workspaces');
    if (cwds.some(cwd => cwd === path || cwd.startsWith(path + sep))) throw new Error('A running process is still using the workspace');
    const latest = await t3.shell(), confirmed = latest.threads.find(t => t.id === thread.id), latestSubagents = subagentDescendants(latest.threads, thread.id);
    if (!confirmed || confirmed.updatedAt !== snapshotAt || confirmed.worktreePath !== null || executing(confirmed, c.monitoringTimeoutMinutes) || waiting(confirmed) || confirmed.pendingBackgroundTasks.length || shared(latest.threads, latestSubagents) || latestSubagents.some(t => bound(t) || busy(t) || resumed(t) || t.pendingBackgroundTasks.length)) throw new Error('Thread or workspace changed before removal');
    const present = async () => existsSync(path) || (await git(project.repoPath, ['worktree', 'list', '--porcelain'])).split('\n').includes(`worktree ${path}`);
    if (await present()) await t3.removeWorktree(project.repoPath, path); // A directory Git no longer registers has nothing left to remove.
    if (await present()) throw new Error('Workspace removal is not confirmed');
    job.workspaceCleanedAt = new Date().toISOString(); job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job);
    log('job-workspace-cleaned', { jobId: job.id, threadId: job.threadId, path });
  } catch (error) {
    const reason = safeError(error);
    if (job.workspaceCleanupError !== reason) log('job-workspace-cleanup-blocked', { jobId: job.id, reason });
    job.workspaceCleanupError = reason; job.workspaceCleanupBlockedAt = new Date().toISOString(); store.save(job);
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
        const detail = await t3.detail(t.id);
        const personal = detail.messages.filter(m => m.role === 'user' && m.id !== job.messageId && !job.automationMessageIds?.includes(m.id));
        const latest = [...personal.map(m => m.createdAt), ...detail.responses.map(a => a.createdAt)].sort().at(-1);
        if (latest && latest > (job.lastPersonalActivity ?? '')) { job.lastPersonalActivity = latest; store.save(job); }
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
      const detail = await t3.detail(t.id);
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
      if (!job.dismissedAt || !job.dismissedHead) continue;
      const cleanedBinding = job.workspaceCleanedAt && thread?.branch === null && thread.worktreePath === null;
      if (thread && (thread.settledOverride !== 'settled' || executing(thread) || (thread.branch !== branch && !cleanedBinding) || Date.parse(thread.latestUserMessageAt ?? job.createdAt) > Date.parse(job.dismissedAt) || Date.parse(thread.latestRunCompletedAt ?? job.createdAt) > Date.parse(job.dismissedAt))) continue;
      const worktreePath = thread?.worktreePath ?? job.dismissedWorktreePath;
      if (worktreePath && existsSync(worktreePath)) {
        const [head, changes] = await Promise.all([git(worktreePath, ['rev-parse', 'HEAD']), git(worktreePath, ['status', '--porcelain'])]);
        if (head !== job.dismissedHead || changes) continue;
      }
      branches.set(branch, job.dismissedHead); if (thread) inactiveThreads.add(thread.id); continue;
    }
    // The completed thread is inactive while idle, unresumed, and clean at its verified head.
    const release = async (head: string) => {
      if (!thread || executing(thread) || waiting(thread) || !(thread.branch === branch || (thread.branch === null && thread.worktreePath === null)) || !job.completedAt ||
          Date.parse(thread.latestUserMessageAt ?? job.createdAt) > Date.parse(job.completedAt) ||
          Date.parse(thread.latestRunCompletedAt ?? job.createdAt) > Date.parse(job.completedAt)) return;
      if (thread.worktreePath && existsSync(thread.worktreePath)) {
        const [current, changes] = await Promise.all([git(thread.worktreePath, ['rev-parse', 'HEAD']), git(thread.worktreePath, ['status', '--porcelain'])]);
        if (current !== head || changes) return;
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

export async function inventory(c: Config, kaneo: Kaneo, threads: Thread[], jobs: Job[], store: Store, ticketKey?: string, allowMissingReadyLabel = false) {
  const projects = c.projects.filter(p => p.enabled);
  const all = new Map<string, Task>();
  const labels = await listTaskLabels(kaneo);
  // Only ready columns can yield work; a named ticket is read from every column so its real status can be reported.
  for (const tasks of await Promise.all(projects.map(p => listTasks(kaneo, p.kaneoId, labels, ticketKey?.startsWith(`${p.key}-`) ? undefined : p.readyStatuses)))) for (const t of tasks) all.set(t.id, t);
  const owned = new Map(jobs.filter(j => !['complete', 'dismissed'].includes(j.state)).map(j => [j.taskId, j]));
  const ready: Candidate[] = [], skipped: Skipped[] = [];
  const potential = [...all.values()].filter(t => {
    const p = projects.find(p => p.kaneoId === t.projectId)!;
    const key = `${p.key}-${t.number}`;
    if (ticketKey && key !== ticketKey) return false;
    const missingReadyLabel = !t.labels?.some(l => l.name === c.kaneo.readyLabel) && !(ticketKey === key && allowMissingReadyLabel);
    const reason = !p.readyStatuses.includes(t.status) ? `Ticket is ${t.status}; it must be in ${p.readyStatuses.join(' or ')}`
      : owned.has(t.id) ? `Ticket already has a ${owned.get(t.id)!.state} factory run`
      : missingReadyLabel ? `Ticket is missing the ${c.kaneo.readyLabel} label` : '';
    if (reason && ticketKey) skipped.push({ key, reason, id: t.id, ...(missingReadyLabel && p.readyStatuses.includes(t.status) && !owned.has(t.id) ? { missingReadyLabel: true } : {}) });
    return !reason;
  });
  if (ticketKey && ![...all.values()].some(t => `${projects.find(p => p.kaneoId === t.projectId)!.key}-${t.number}` === ticketKey)) skipped.push({ key: ticketKey, reason: 'Ticket was not found in the enabled project' });
  // Caches hold promises so concurrent lookups of one task share a single read.
  const finalStatuses = new Map<string, Promise<string[]>>(c.projects.map(p => [p.kaneoId, Promise.resolve(p.doneStatuses)]));
  const fetched = new Map<string, Promise<Task>>();
  const getTask = (id: string): Promise<Task> => {
    const known = all.get(id);
    if (known) return Promise.resolve(known);
    if (!fetched.has(id)) fetched.set(id, kaneo.call('get_task', { taskId: id }).then(t => { const task = taskSchema.parse(t); all.set(id, task); return task; }));
    return fetched.get(id)!;
  };
  const isDone = async (id: string) => {
    const task = await getTask(id);
    if (!finalStatuses.has(task.projectId)) finalStatuses.set(task.projectId, kaneo.call('list_project_columns', { projectId: task.projectId }).then(r => z.array(z.object({ slug: z.string(), isFinal: z.boolean() }).passthrough()).parse(r).filter(c => c.isFinal).map(c => c.slug)));
    return (await finalStatuses.get(task.projectId)!).includes(task.status);
  };
  const relationCache = new Map<string, Promise<z.infer<typeof relationsSchema>>>();
  const relationsFor = (id: string) => {
    if (!relationCache.has(id)) relationCache.set(id, kaneo.call('get_task_relations', { taskId: id }).then(r => relationsSchema.parse(r)));
    return relationCache.get(id)!;
  };
  // Branch and open-PR mentions are read once per project, concurrently, while the tickets are examined.
  const needed = [...new Set(potential.map(t => t.projectId))].map(id => projects.find(p => p.kaneoId === id)!);
  const refs = new Map(needed.map(p => [p.kaneoId, git(p.repoPath, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes'])]));
  const prs = new Map(needed.map(p => [p.kaneoId, gh(['pr', 'list', '--repo', p.githubRepo, '--state', 'open', '--limit', '1000', '--json', 'title,headRefName,body']).then(r => z.array(z.object({ title: z.string(), headRefName: z.string(), body: z.string() })).parse(r))]));
  for (const pending of [...refs.values(), ...prs.values()]) pending.catch(() => {}); // Surfaced where a ticket needs them.
  const { blockersOf, openChildren } = dependencyRules(relationsFor, isDone);
  const priorityFor = (task: Task, project: Project): TicketPriority => ({ priority: task.priority, labelRank: ticketLabelRank(task.labels ?? [], project.priorityLabels) });
  const inheritedPriority = async (task: Task, project: Project): Promise<TicketPriority> => {
    let priority = priorityFor(task, project);
    const pending = [task.id], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const relation of await relationsFor(id)) {
        if (relation.relationType !== 'blocks' || relation.sourceTaskId !== id) continue;
        const dependent = await getTask(relation.targetTaskId).catch(() => undefined);
        const owner = dependent && projects.find(p => p.kaneoId === dependent.projectId);
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
    const p = projects.find(p => p.kaneoId === t.projectId)!;
    const key = `${p.key}-${t.number}`;
    let difficulty: Candidate['difficulty'];
    try { difficulty = ticketDifficulty(t.labels ?? []); }
    catch { return { key, id: t.id, reason: 'Conflicting difficulty labels' }; }
    if (!difficulty) return { key, id: t.id, reason: 'Ticket needs a difficulty label before dispatch' };
    let reason = '';
    const blockers = await blockersOf(t.id), blockedBy: string[] = blockers === 'cycle' ? [] : blockers;
    if (blockers === 'cycle' || blockers.length) reason = 'Ticket or ancestor has an unfinished blocker or relation cycle';
    const children = await openChildren(t.id);
    if (children.length) { reason = 'Umbrella has unfinished children; select leaves instead'; blockedBy.push(...children); }
    // A blocked ticket keeps what the queue needs to place it behind its blockers.
    if (reason && blockedBy.length) return { key, id: t.id, reason, blockedBy, ticket: { id: t.id, projectId: t.projectId, key, title: t.title, createdAt: t.createdAt, difficulty, ...await inheritedPriority(t, p) } };
    const history = jobs.filter(j => j.taskId === t.id && ['complete', 'dismissed'].includes(j.state));
    let artifacts = { branches: new Map<string, string>(), inactiveThreads: new Set<string>() };
    if (!reason && history.length) {
      try { artifacts = await historicalArtifacts(p, history, threads, undefined, store); }
      catch { reason = 'Previous work could not be verified; inspect its PR and worktree before restarting'; }
    }
    if (!reason && threads.some(s => !artifacts.inactiveThreads.has(s.id) && mentionsTicket(`${s.title}\n${s.branch ?? ''}`, key))) reason = 'Existing T3 thread or branch references this ticket';
    if (!reason) {
      const unmatched = (await refs.get(p.kaneoId)!).split('\n').filter(line => {
        const [ref, head] = line.split('\t');
        return ![...artifacts.branches].some(([branch, mergedHead]) => head === mergedHead && (ref === `refs/heads/${branch}` || ref.startsWith('refs/remotes/') && ref.endsWith(`/${branch}`)));
      }).join('\n');
      if (mentionsTicket(unmatched, key)) reason = 'Existing Git branch references this ticket';
      if ((await prs.get(p.kaneoId)!).some(pr => mentionsTicket(`${pr.title}\n${pr.headRefName}\n${pr.body}`, key))) reason = 'Existing open PR references this ticket';
    }
    if (reason) return { key, id: t.id, reason };
    return { candidate: { id: t.id, projectId: t.projectId, key, title: t.title, createdAt: t.createdAt, difficulty, labels: t.labels ?? [], ...await inheritedPriority(t, p) } };
  };
  const verdicts: Verdict[] = new Array(potential.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, potential.length) }, async () => { for (let i = next++; i < potential.length; i = next++) verdicts[i] = await examine(potential[i]); }));
  for (const v of verdicts) 'candidate' in v ? ready.push(v.candidate) : skipped.push(v);
  return { ready, skipped, selected: selectTicket(ready, store.get('lastProject'), projects.map(p => p.kaneoId)) };
}

export interface Skipped { key: string; reason: string; id?: string; missingReadyLabel?: boolean; blockedBy?: string[]; ticket?: Candidate }
export interface CycleOptions { dryRun?: boolean; doctor?: boolean; manual?: boolean; overrideLimits?: boolean; allowMissingReadyLabel?: boolean; ticket?: string; model?: string; chain?: 'first' | 'all'; continuation?: boolean }
// The dependency rules every start obeys: unfinished blockers (a parent's count for its subtasks) and an umbrella's open children.
function dependencyRules(rels: (id: string) => Promise<z.infer<typeof relationsSchema>>, done: (id: string) => Promise<boolean>) {
  const blockersOf = async (id: string, ancestors = new Set<string>()): Promise<string[] | 'cycle'> => {
    if (ancestors.has(id)) return 'cycle';
    const visited = new Set([...ancestors, id]), found: string[] = [];
    for (const r of await rels(id)) {
      if (r.relationType === 'blocks' && r.targetTaskId === id && !await done(r.sourceTaskId)) found.push(r.sourceTaskId);
      if (r.relationType === 'subtask' && r.targetTaskId === id) {
        const parent = await blockersOf(r.sourceTaskId, visited);
        if (parent === 'cycle') return 'cycle';
        found.push(...parent);
      }
    }
    return [...new Set(found)];
  };
  const openChildren = async (id: string) => {
    const children: string[] = [];
    for (const r of await rels(id)) if (r.relationType === 'subtask' && r.sourceTaskId === id && !await done(r.targetTaskId)) children.push(r.targetTaskId);
    return children;
  };
  return { blockersOf, openChildren };
}
// A long-lived caller (the service) keeps one T3 client and one connected Kaneo client across passes;
// a one-shot caller leaves these out and the pass opens and closes its own.
export interface Clients { t3?: T3; kaneo?: Kaneo }
export type Decision = { reason: string; at: string } & Record<string, unknown>;
type Queue = Awaited<ReturnType<typeof inventory>>;

export function busyProviders(jobs: Job[], threads: Thread[], instances: Map<string, string>, timeout: number, limits: Config['concurrency'] = { claude: 1, codex: 1 }, planned = new Map<string, number>()): Set<string> {
  const counts = new Map(planned);
  for (const job of jobs.filter(j => !['complete', 'dismissed'].includes(j.state))) {
    const thread = threads.find(t => t.id === job.threadId);
    if (!['running', 'dispatching'].includes(job.state) && !(thread && executing(thread, timeout))) continue;
    const instance = job.modelSelection?.instanceId ?? thread?.modelSelection.instanceId ?? 'claudeAgent';
    const driver = job.providerDriver ?? instances.get(instance) ?? (thread && instances.get(thread.providerInstanceId)) ?? (['codex', 'claudeAgent'].includes(instance) ? instance : null);
    // Unknown ownership must be reconciled before any further automatic starts.
    if (driver !== 'codex' && driver !== 'claudeAgent') return new Set(['codex', 'claudeAgent']);
    counts.set(driver, (counts.get(driver) ?? 0) + 1);
  }
  return new Set(['claudeAgent', 'codex'].filter(driver => (counts.get(driver) ?? 0) >= limits[driver === 'codex' ? 'codex' : 'claude']));
}

export async function cycle(c: Config, store: Store, options: CycleOptions = {}, clients: Clients = {}): Promise<Decision> {
  if (options.allowMissingReadyLabel && (!options.manual || !options.ticket?.trim())) throw new Error('The readiness-label override requires a specific manual ticket');
  if (options.manual && options.model && options.model !== 'auto') return dispatchOne(c, store, options, undefined, clients);
  if (options.model && options.model !== 'auto') throw new Error('Explicit models require manual dispatch');
  const decision = (reason: string, extra: Record<string, unknown> = {}) => {
    const result = { reason, at: new Date().toISOString(), ...extra };
    store.decide(result); log('decision', result); return result;
  };
  const override = !!options.manual && !!options.overrideLimits;
  const t3 = clients.t3 ?? new T3(c.t3), kaneo = clients.kaneo ?? new Kaneo(c.kaneo), ownsKaneo = !clients.kaneo;
  t3.reset();
  const [shell, providers] = await Promise.all([t3.shell(), t3.providers()]);
  const instances = new Map(providers.map(p => [p.instanceId, p.driver]));
  if (ownsKaneo) await kaneo.connect();
  try {
    await reconcile(c, store, t3, kaneo, shell.threads, !options.dryRun && !options.doctor);
    // Chains the user started run whether or not automation is on; they take their slots first.
    if (!options.manual && !options.doctor && !options.dryRun) await runPlans(c, store, t3, kaneo, instances, shell.threads);
    const jobs = store.jobs();
    const busy = options.manual ? new Set<string>() : busyProviders(jobs, shell.threads, instances, c.monitoringTimeoutMinutes, c.concurrency);
    const streams = ['claudeAgent', 'codex'].map(driver => ({
      driver, provider: driver === 'codex' ? 'Codex' : 'Claude',
      reason: !options.manual && c.concurrency[driver === 'codex' ? 'codex' : 'claude'] === 0 ? 'provider-disabled' : busy.has(driver) ? 'provider-running' : 'no-eligible-model',
      active: jobs.filter(j => ['running', 'dispatching'].includes(j.state) && (j.providerDriver ?? instances.get(j.modelSelection?.instanceId ?? 'claudeAgent')) === driver).map(jobLabel),
      planned: [] as string[], models: [] as { id: string; name: string; reason: string }[], quota: undefined as Awaited<ReturnType<typeof readModelQuota>> | undefined, quotaError: undefined as string | undefined,
    }));
    const readyModels: { preset: Config['models'][number]; driver: string }[] = [];
    // Blocked only by provider idle time: reviews may still use these, ticket and discovery work may not.
    const idleModels: typeof readyModels = [];
    const activityCache = new Map<string, Awaited<ReturnType<typeof personalActivity>>>();
    for (const preset of c.models.filter(p => p.automatic)) {
      const driver = instances.get(preset.model.instanceId);
      const stream = streams.find(s => s.driver === driver);
      if (!stream || busy.has(driver!)) continue;
      let reason = 'ready';
      try {
        const quota = await readModelQuota(t3, c, jobs, preset.id, !!options.manual);
        stream.quota ??= quota;
        const manualCodex = options.manual && driver === 'codex';
        if (!quota.hasAllowance) reason = 'quota-exhausted';
        else if (!quota.allowed && (manualCodex || !override)) reason = 'quota-budget';
        else if (!manualCodex && !override) {
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
    for (const stream of streams.filter(s => !s.quota)) {
      const preset = c.models.find(p => instances.get(p.model.instanceId) === stream.driver);
      if (!preset) { stream.quotaError = 'No model is configured for this provider'; continue; }
      try { stream.quota = await readModelQuota(t3, c, jobs, preset.id); }
      catch (error) { stream.quotaError = safeError(error); }
    }
    // The queue is read on every pass, paused or not, so the page always shows what would start next.
    const reviewsOn = !!c.upstream?.enabled, ticketsOn = c.enabled || !!options.manual || !!options.doctor;
    // While tickets are paused the read is for display only, so a Kaneo failure must not hold up reviews.
    let queue: Queue = { ready: [], skipped: [], selected: undefined }, queueRead = true;
    try { queue = await inventory(c, kaneo, shell.threads, store.jobs(), store, options.ticket?.trim().toUpperCase(), !!options.manual && !!options.allowMissingReadyLabel); }
    catch (error) { if (ticketsOn) throw error; queueRead = false; log('queue-read-failed', { message: safeError(error) }); }
    if (options.manual && queue.skipped.some(s => s.missingReadyLabel)) return decision('ready-label-confirmation-required', { ticket: options.ticket?.trim().toUpperCase(), requiredLabel: c.kaneo.readyLabel, message: `Ticket is missing the ${c.kaneo.readyLabel} label. Confirm this run to continue without it.` });
    if (options.manual && options.ticket && !queue.ready.length) {
      const chained = await chainResponse(c, store, t3, kaneo, instances, shell.threads, options, queue, override, decision);
      if (chained) return chained;
    }
    if (!options.ticket && queueRead) store.set('upNext', JSON.stringify(upNext(c, store, queue)));
    // Fully paused: provider status, quota, and the queue stay fresh, nothing is dispatched. With only reviews on, only reviews dispatch.
    if (!ticketsOn && !reviewsOn) { store.set('streams', JSON.stringify(streams)); return decision('disabled', { streams, eligible: queue.ready.length }); }
    // Upstream reviews are bounded and time-sensitive, so they go ahead of ticket work.
    const reviews = options.manual || (!reviewsOn && !options.doctor) ? [] : await pendingReviews(c, store, store.jobs(), Date.now(), !options.dryRun && !options.doctor);
    const candidates = ticketsOn ? [...queue.ready] : [];
    const skipped = [...queue.skipped];
    const results: Record<string, any>[] = [];
    const claimedProjects = new Set<string>();
    const planned = new Map<string, number>();
    // CLI callers hold Store.claim across this entire pass; each durable task claim precedes its RPC.
    const free = (m: { driver: string }) => !busy.has(m.driver);
    while (readyModels.some(free) || (reviews.length && idleModels.some(free))) {
      const review = reviews[0];
      const assignment = review ? undefined : selectAssignment(candidates, readyModels, busy, store.get('lastProject'), c.projects.filter(p => p.enabled).map(p => p.kaneoId));
      const discovery = ticketsOn && !review && !options.manual && !queue.ready.length && !skipped.some(s => /difficulty/.test(s.reason));
      const selected = assignment ?? (review ? readyModels.find(free) ?? idleModels.find(free) : discovery ? readyModels.find(free) : undefined);
      if (!selected) break;
      const stream = streams.find(s => s.driver === selected.driver)!;
      try {
        // The pass already read the shell and the queue seconds ago; the dispatch reuses them and re-reads only what can change.
        const scoped: Queue = { ready: assignment ? queue.ready.filter(t => t.id === assignment.ticket.id) : [], skipped: queue.skipped, selected: undefined };
        const result = await dispatchOne(c, store, { ...options, doctor: false, dryRun: options.dryRun || options.doctor, model: selected.preset.id, ticket: assignment?.ticket.key }, { driver: selected.driver, instanceDrivers: instances, skipProjects: claimedProjects, inspect: options.doctor, review, shell, queue: scoped, t3, kaneo });
        results.push(result);
        stream.reason = result.reason;
        if ('quota' in result) stream.quota = result.quota as typeof stream.quota;
        if (result.reason === 'dispatched' || result.reason === 'would-dispatch') {
          if (options.manual) return result;
          if (result.reason === 'would-dispatch') planned.set(selected.driver, (planned.get(selected.driver) ?? 0) + 1);
          for (const driver of busyProviders(store.jobs(), shell.threads, instances, c.monitoringTimeoutMinutes, c.concurrency, planned)) busy.add(driver);
          (result.reason === 'dispatched' ? stream.active : stream.planned).push(assignment?.ticket.key ?? jobLabel({ ticketKey: null, upstream: review?.upstream }));
          if (review) reviews.shift();
          if ('projectId' in result && discovery) claimedProjects.add(result.projectId as string);
          if (assignment) candidates.splice(candidates.findIndex(t => t.id === assignment.ticket.id), 1);
        } else {
          // A failed final check must not loop on the same selection in this pass.
          for (const list of [readyModels, idleModels]) {
            const i = list.findIndex(m => m.preset.id === selected.preset.id);
            if (i >= 0) list.splice(i, 1);
          }
          if (assignment && /ticket|eligib/.test(result.reason)) candidates.splice(candidates.findIndex(t => t.id === assignment.ticket.id), 1);
        }
      } catch (error) {
        stream.reason = safeError(error); busy.add(selected.driver);
        if (assignment && store.jobs().some(j => j.taskId === assignment.ticket.id)) candidates.splice(candidates.findIndex(t => t.id === assignment.ticket.id), 1);
        // An ambiguous launch still owns its review; another provider must not start the same range.
        if (review && store.jobs().some(j => j.upstream?.repo === review.upstream.repo && j.upstream.candidate === review.upstream.candidate)) reviews.shift();
        results.push({ reason: 'error', driver: selected.driver, message: stream.reason });
      }
    }
    for (const stream of streams) if (stream.reason === 'ready') stream.reason = queue.ready.length ? 'difficulty-limit' : skipped.some(s => /difficulty/.test(s.reason)) ? 'needs-classification' : 'no-eligible-ticket';
    const reason = options.doctor ? 'doctor' : results.some(r => r.reason === 'dispatched') ? 'dispatched'
      : results.some(r => r.reason === 'would-dispatch') ? 'would-dispatch'
      : options.manual ? 'no-eligible-ticket' : !ticketsOn ? results.at(-1)?.reason ?? 'disabled' : streams.every(s => s.reason === 'provider-running') ? 'autonomous-job-running' : 'watching-streams';
    store.set('streams', JSON.stringify(streams));
    return decision(reason, { streams, dispatches: results, skipped, eligible: queue.ready.length });
  } finally { if (ownsKaneo) await kaneo.close(); }
}

async function dispatchOne(c: Config, store: Store, options: CycleOptions, plan?: { driver: string; instanceDrivers: Map<string, string>; skipProjects: Set<string>; inspect?: boolean; review?: PendingReview; shell?: Awaited<ReturnType<T3['shell']>>; queue?: Queue; t3?: T3; kaneo?: Kaneo }, clients: Clients = {}): Promise<Decision> {
  const preset = options.model && options.model !== 'auto' ? c.models.find(p => p.id === options.model) : undefined;
  if (options.model && options.model !== 'auto' && !preset) throw new Error('Unknown model; select a configured model');
  if (!preset) throw new Error('Select a configured model');
  if (!options.manual && !plan) throw new Error('Automatic work requires a provider plan');
  const override = options.manual === true && options.overrideLimits === true;
  const ticketKey = options.ticket?.trim().toUpperCase();
  if (ticketKey && ((!options.manual && !plan) || !/^[A-Z0-9]+-\d+$/.test(ticketKey))) throw new Error('Enter a ticket key such as APP-123');
  if (ticketKey && !c.projects.some(p => p.enabled && ticketKey.startsWith(`${p.key}-`))) throw new Error('Ticket project is not enabled in the factory settings');
  const decision = (reason: string, extra: Record<string, unknown> = {}) => {
    const result = { reason, at: new Date().toISOString(), ...extra };
    store.decide(result); log('decision', result); return result;
  };
  if (!c.enabled && !options.doctor && !options.manual && !plan?.inspect && !(plan?.review && c.upstream?.enabled)) return decision('disabled');
  const t3 = plan?.t3 ?? clients.t3 ?? new T3(c.t3);
  if (!plan) t3.reset();
  const shell = plan?.shell ?? await t3.shell();
  const instances = plan?.instanceDrivers ?? new Map((await t3.providers()).map(p => [p.instanceId, p.driver]));
  for (const p of c.projects.filter(p => p.enabled)) {
    const live = shell.projects.find(x => x.id === p.t3Id);
    if (!live || live.workspaceRoot !== p.repoPath) throw new Error(`T3 project mapping mismatch for ${p.name}`);
  }
  const kaneo = plan?.kaneo ?? clients.kaneo ?? new Kaneo(c.kaneo), ownsKaneo = !(plan?.kaneo ?? clients.kaneo);
  if (ownsKaneo) await kaneo.connect();
  try {
    if (!plan) await reconcile(c, store, t3, kaneo, shell.threads, !options.dryRun && !options.doctor);
    const jobs = store.jobs();
    const running = jobs.filter(j => ['running', 'dispatching'].includes(j.state));
    const parked = jobs.filter(j => j.state === 'waiting');
    if (plan && !options.manual && busyProviders(jobs, shell.threads, plan.instanceDrivers, c.monitoringTimeoutMinutes, c.concurrency).has(plan.driver)) return decision('provider-running', { driver: plan.driver });
    const review = plan?.review;
    // A review needs no ticket queue, so ticket-only reads cannot block it.
    const queue = plan?.queue ?? (review && !plan?.inspect ? { ready: [], skipped: [], selected: undefined } as Queue : await inventory(c, kaneo, shell.threads, jobs, store, ticketKey, !!options.manual && !!options.allowMissingReadyLabel));
    if (options.manual && queue.skipped.some(s => s.missingReadyLabel)) return decision('ready-label-confirmation-required', { ticket: ticketKey, requiredLabel: c.kaneo.readyLabel, message: `Ticket is missing the ${c.kaneo.readyLabel} label. Confirm this run to continue without it.` });
    const discovery = !ticketKey && !options.manual && !review;
    if (discovery && (queue.ready.length || queue.skipped.some(s => /difficulty/.test(s.reason)))) return decision('ticket-work-takes-priority');
    queue.ready = queue.ready.filter(t => acceptsDifficulty(preset, t));
    if (!discovery && !review && !queue.ready.length) {
      const chained = options.manual && ticketKey ? await chainResponse(c, store, t3, kaneo, instances, shell.threads, options, queue, override, decision) : undefined;
      return chained ?? decision('no-eligible-ticket', { ticket: ticketKey, skipped: queue.skipped, message: 'Ticket must be classified, within the model difficulty limit, SF-ready, unblocked, and not already owned.' });
    }
    // A chain continuation is still user-authorized work, but it starts later and on its own, so it keeps the automatic quota and idle policy.
    const manualPolicy = !!options.manual && !options.continuation;
    const readSelectedQuota = (refresh = false) => readModelQuota(t3, c, store.jobs(), preset.id, manualPolicy, refresh);
    const quota = await readSelectedQuota();
    if (plan && quota.driver !== plan.driver) return decision('provider-mapping-changed');
    const isManualCodex = manualPolicy && quota.provider === 'Codex';
    // Reviews do not wait for idle time, so they never read (or fail on) personal activity.
    const readActivity = async (threads: Thread[]) => review ? { active: false, last: '', idleMinutes: Infinity }
      : personalActivity(t3, threads, store.jobs(), store, c.monitoringTimeoutMinutes, quota.provider === 'Codex' ? 'codex' : 'claudeAgent', instances);
    const activity = await readActivity(shell.threads);
    const gate = !quota.hasAllowance ? isManualCodex ? 'codex-quota-exhausted' : 'quota-exhausted'
      : !override && !quota.allowed ? discovery ? 'discovery-quota-reserve' : 'quota-reserve'
      : c.maxWaitingPRs !== null && parked.length >= c.maxWaitingPRs ? 'waiting-cap'
      : !isManualCodex && !override && activity.active ? 'personal-provider-running'
      : !isManualCodex && !override && activity.idleMinutes < c.idleMinutes ? 'personal-provider-recently-active' : null;
    queue.selected = review ? undefined : selectTicket(queue.ready, store.get('lastProject'), c.projects.filter(p => p.enabled).map(p => p.kaneoId));
    if (options.doctor) return decision('doctor', { quota, activity, running: running.length, waiting: parked.length, gate: running.length ? 'autonomous-job-running' : gate, eligible: queue.ready.length, next: queue.selected, skipped: queue.skipped });
    if (gate) return decision(gate, { quota, activity, running: running.length, waiting: parked.length, ...(!quota.hasAllowance ? { message: 'The selected model has no allowance left. Choose another model or wait for its quota to reset.' } : {}) });
    let project: Project | undefined;
    if (review) project = review.project;
    else if (queue.selected) project = c.projects.find(p => p.kaneoId === queue.selected!.projectId);
    else {
      project = c.projects.filter(p => p.enabled && !plan?.skipProjects.has(p.kaneoId) && !jobs.some(j => j.projectId === p.kaneoId && j.kind === 'discovery' && !['complete', 'dismissed'].includes(j.state)) && Number(store.get(`discoveryAfter:${p.kaneoId}`) ?? 0) <= Date.now())
        .toSorted((a, b) => Number(store.get(`discoveryLast:${a.kaneoId}`) ?? 0) - Number(store.get(`discoveryLast:${b.kaneoId}`) ?? 0))[0];
    }
    if (!project) return decision('no-eligible-work', { skipped: queue.skipped });
    if (options.dryRun) return decision('would-dispatch', { kind: review ? 'upstream' : discovery ? 'discovery' : 'ticket', project: project.name, projectId: project.kaneoId, ticket: queue.selected?.key, upstream: review?.upstream, model: quota.factoryRouting.model, quota });
    // Final checks read only what can have changed since the queue was built: the ticket itself, new threads, and the quota.
    const [task, fresh, currentQuota] = await Promise.all([
      queue.selected ? kaneo.call('get_task', { taskId: queue.selected.id }).then(t => taskSchema.parse(t)) : undefined,
      t3.shell(),
      readSelectedQuota(true),
    ]);
    if (queue.selected) {
      if (!task || task.projectId !== project.kaneoId || !project.readyStatuses.includes(task.status)) return decision('ticket-changed-before-dispatch');
      // Labels and blockers can change between the queue read and now; Kaneo's single-task read has no labels, so they come from the workspace.
      const labels = (await listTaskLabels(kaneo)).get(task.id) ?? [], key = queue.selected.key;
      let difficulty: Candidate['difficulty'];
      try { difficulty = ticketDifficulty(labels); } catch { difficulty = undefined; }
      if (difficulty !== queue.selected.difficulty || !acceptsDifficulty(preset, { ...queue.selected, difficulty })) return decision('ticket-changed-before-dispatch', { message: 'The ticket\'s difficulty label changed.' });
      if (!options.allowMissingReadyLabel && !labels.some(l => l.name === c.kaneo.readyLabel)) return decision('ticket-changed-before-dispatch', { message: `The ticket lost its ${c.kaneo.readyLabel} label.` });
      const reader = taskReader(c, kaneo);
      const rules = dependencyRules(id => kaneo.call('get_task_relations', { taskId: id }).then(r => relationsSchema.parse(r)), async id => reader.done(await reader.task(id)));
      const blockers = await rules.blockersOf(task.id);
      if (blockers === 'cycle' || blockers.length || (await rules.openChildren(task.id)).length) return decision('ticket-changed-before-dispatch', { message: 'The ticket gained a blocker or an unfinished child.' });
      const known = new Set(shell.threads.map(t => t.id));
      if (store.jobs().some(j => j.taskId === task.id && !['complete', 'dismissed'].includes(j.state)) || fresh.threads.some(t => !known.has(t.id) && mentionsTicket(`${t.title}\n${t.branch ?? ''}`, key))) return decision('ticket-order-or-eligibility-changed');
    }
    if (plan && currentQuota.driver !== plan.driver) return decision('provider-mapping-changed');
    const currentManualCodex = manualPolicy && currentQuota.provider === 'Codex';
    const currentActivity = await readActivity(fresh.threads);
    if (!currentQuota.hasAllowance) return decision(currentManualCodex ? 'codex-quota-exhausted' : 'quota-exhausted', { quota: currentQuota });
    // Reviews start as soon as a release is found, so only ticket and discovery work wait for idle time.
    if (!override && ((!currentManualCodex && idleBlocked(c, currentActivity)) || !currentQuota.allowed)) return decision('gate-changed-before-dispatch', { quota: currentQuota });
    // Automatic work and chain continuations re-check the run limit against the fresh shell: a run may have resumed since the slot was counted.
    if (!options.manual && plan && busyProviders(store.jobs(), fresh.threads, plan.instanceDrivers, c.monitoringTimeoutMinutes, c.concurrency).has(plan.driver)) return decision('job-resumed-before-dispatch');
    if (options.continuation && busyProviders(store.jobs(), fresh.threads, instances, c.monitoringTimeoutMinutes, c.concurrency).has(currentQuota.driver)) return decision('job-resumed-before-dispatch');
    if (JSON.stringify(loadConfig()) !== JSON.stringify(c)) return decision('configuration-changed-before-dispatch');
    const selectedModel = currentQuota.factoryRouting.model;
    const modelReason = (options.continuation ? 'Started by a chain the user requested. ' : options.manual ? `Manual dispatch${override && !currentManualCodex ? ' with idle/quota thresholds overridden for this run' : ''}. ` : '') + currentQuota.factoryRouting.reason + (options.allowMissingReadyLabel ? ` The user explicitly confirmed this run without the ${c.kaneo.readyLabel} readiness label. Waive only that label check; do not add the label or skip other readiness, dependency, validation, or merge gates.` : '');
    const now = new Date().toISOString(), id = randomUUID();
    const job: Job = { id, providerDriver: currentQuota.driver, modelSelection: selectedModel, modelReason, ...(queue.selected?.difficulty ? { difficulty: queue.selected.difficulty } : {}), kind: review ? 'upstream' : queue.selected ? 'ticket' : 'discovery', ...(review ? { upstream: review.upstream } : {}), projectId: project.kaneoId, taskId: queue.selected?.id ?? null, ticketKey: queue.selected?.key ?? null, threadId: randomUUID(), messageId: randomUUID(), createdAt: now, state: 'dispatching', reason: 'Dispatch prepared', lastPersonalActivity: null, reportPath: join(c.stateDir, 'reports', `${id}.json`), command: null, prUrls: [], completedAt: null };
    const u = job.upstream;
    const title = job.kind === 'ticket' ? `Factory: ${job.ticketKey}` : u ? `Upstream review: ${u.name} ${u.base}..${u.candidate}` : `Factory discovery: ${project.name}`;
    // Ticket branches carry the ticket's kind (fix, feat, perf, ...) so release tooling can bump versions from them.
    // Kaneo's single-task read carries no labels; the queue entry keeps the complete labels the inventory read.
    const branch = job.kind === 'ticket' ? `${branchKind(queue.selected?.labels ?? [])}/${job.ticketKey}-factory-${id.slice(0, 8)}` : `chore/factory-${job.kind}-${id.slice(0, 8)}`;
    // T3 creates the worktree from the project's workspace root, which must match project.repoPath (checked above).
    job.command = { commandId: randomUUID(), threadId: job.threadId, projectId: project.t3Id, title,
      modelSelection: selectedModel, runtimeMode: c.runtimeMode, interactionMode: 'default',
      workspaceStrategy: { type: 'worktree', baseRef: project.baseBranch, branch, startFromOrigin: true },
      initialMessage: { messageId: job.messageId, text: promptFor(job, project, c, manualPolicy), attachments: [] },
    };
    store.save(job); // Durable ownership precedes the external write, including ambiguous timeouts.
    store.set('lastProject', project.kaneoId);
    if (job.kind === 'discovery') store.set(`discoveryLast:${project.kaneoId}`, String(Date.now()));
    await t3.launch(job.command);
    job.reason = 'T3 accepted dispatch'; store.save(job);
    return decision('dispatched', { jobId: job.id, threadId: job.threadId, project: project.name, projectId: project.kaneoId, ticket: job.ticketKey, upstream: job.upstream, model: selectedModel.model, modelReason, difficulty: job.difficulty, quota: currentQuota });
  } finally { if (ownsKaneo) await kaneo.close(); }
}

// Ask T3 to stop a run's thread; the next pass reconciles the job from T3.
export async function stopJob(c: Config, store: Store, t3: T3, jobId: string) {
  const job = store.job(jobId);
  if (!job || ['complete', 'dismissed'].includes(job.state)) throw new Error('That run is not active');
  await t3.dispatch({ type: 'thread.stop', commandId: randomUUID(), threadId: job.threadId, reason: 'Stopped from the factory web app' });
  job.reason = 'Stop requested from the web app; waiting for T3 to confirm'; store.save(job);
  store.record('job.stop', `${jobLabel(job)} stop requested`, { ticketKey: job.ticketKey, projectId: job.projectId }, job.id);
  return { ok: true, jobId: job.id };
}

// Chains ------------------------------------------------------------------------------------------
// Reads tickets and tells whether they are finished, for configured projects and, through their columns, any other.
function taskReader(c: Config, kaneo: Kaneo) {
  const tasks = new Map<string, Promise<Task>>(), columns = new Map<string, Promise<string[]>>();
  // Kaneo's single-task read carries no labels; the workspace's label associations are read once and merged in.
  let labels: Promise<Awaited<ReturnType<typeof listTaskLabels>>> | undefined;
  const task = (id: string) => {
    if (!tasks.has(id)) tasks.set(id, kaneo.call('get_task', { taskId: id }).then(async t => {
      const parsed = taskSchema.parse(t);
      labels ??= listTaskLabels(kaneo);
      return { ...parsed, labels: (await labels).get(id) ?? parsed.labels ?? [] };
    }));
    return tasks.get(id)!;
  };
  const done = async (t: Task) => {
    const p = c.projects.find(p => p.kaneoId === t.projectId);
    if (p) return p.doneStatuses.includes(t.status);
    if (!columns.has(t.projectId)) columns.set(t.projectId, kaneo.call('list_project_columns', { projectId: t.projectId }).then(r => z.array(z.object({ slug: z.string(), isFinal: z.boolean() }).passthrough()).parse(r).filter(c => c.isFinal).map(c => c.slug)));
    return (await columns.get(t.projectId)!).includes(t.status);
  };
  const node = async (t: Task): Promise<PlanTicket> => {
    const p = c.projects.find(p => p.kaneoId === t.projectId), labels = t.labels ?? [];
    let difficulty: PlanTicket['difficulty'];
    try { difficulty = ticketDifficulty(labels); } catch { /* reported when it is its turn */ }
    return { id: t.id, key: p ? `${p.key}-${t.number}` : `#${t.number}`, title: t.title, projectId: t.projectId, status: t.status, priority: t.priority, createdAt: t.createdAt, difficulty, labelRank: p ? ticketLabelRank(labels, p.priorityLabels) : undefined, readyLabel: labels.some(l => l.name === c.kaneo.readyLabel), runnable: !!p?.enabled, blockedBy: [], done: await done(t) };
  };
  return { task, done, node };
}
// Every unfinished ticket that must finish before `rootId` may start: its blockers, their blockers, a parent's blockers, and an umbrella's children.
export async function blockerTree(c: Config, kaneo: Kaneo, rootId: string) {
  const reader = taskReader(c, kaneo), nodes = new Map<string, PlanTicket>(), seen = new Set<string>();
  const relations = new Map<string, Promise<z.infer<typeof relationsSchema>>>();
  const rels = (id: string) => { if (!relations.has(id)) relations.set(id, kaneo.call('get_task_relations', { taskId: id }).then(r => relationsSchema.parse(r))); return relations.get(id)!; };
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
    for (const r of await rels(id)) {
      if (r.relationType === 'blocks' && r.targetTaskId === id) await require(attach, r.sourceTaskId);
      else if (r.relationType === 'subtask' && r.targetTaskId === id) await visit(r.sourceTaskId, attach); // a parent's blockers block its subtasks
      else if (r.relationType === 'subtask' && r.sourceTaskId === id) await require(attach, r.targetTaskId); // an umbrella waits for its children
    }
  };
  const target = await ensure(rootId);
  await visit(rootId, target);
  return { target, tickets: [...nodes.values()].filter(t => t.id !== rootId) };
}
const byPlanPriority = (a: PlanTicket, b: PlanTicket) => compareTicketPriority(a, b) || a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key);
// Tickets of a chain that could start now: unfinished, unblocked, not already owned by an open run. The target waits for every other ticket.
export function chainReady(plan: Pick<Plan, 'target' | 'tickets'>, jobs: Job[]) {
  const owned = new Set(jobs.filter(j => !['complete', 'dismissed'].includes(j.state)).map(j => j.taskId));
  const all = [...plan.tickets, plan.target], byId = new Map(all.map(t => [t.id, t]));
  const free = (t: PlanTicket) => !t.done && !owned.has(t.id) && t.blockedBy.every(id => byId.get(id)?.done ?? true);
  return [...plan.tickets.filter(free), ...(plan.tickets.every(t => t.done) && free(plan.target) ? [plan.target] : [])].toSorted(byPlanPriority);
}
// A blocked manual ticket: describe its chain, run the first runnable blocker, or start the whole chain.
async function chainResponse(c: Config, store: Store, t3: T3, kaneo: Kaneo, instances: Map<string, string>, threads: Thread[], options: CycleOptions, queue: Pick<Queue, 'skipped'>, override: boolean, decision: (reason: string, extra?: Record<string, unknown>) => Decision): Promise<Decision | undefined> {
  const ticketKey = options.ticket!.trim().toUpperCase();
  const blocked = queue.skipped.find(s => s.key === ticketKey && s.id && /blocker|Umbrella/.test(s.reason));
  if (!blocked?.id) return undefined;
  const tree = await blockerTree(c, kaneo, blocked.id);
  const count = tree.tickets.length;
  if (!options.chain) return decision('blocked-ticket-plan-required', { ticket: ticketKey, tree, message: `${ticketKey} waits on ${count} unfinished ticket${count === 1 ? '' : 's'}. Run the first one that can start, or the whole chain and then ${ticketKey}.` });
  const run = (opts: CycleOptions): Promise<Decision> => opts.model && opts.model !== 'auto' ? dispatchOne(c, store, opts, undefined, { t3, kaneo }) : cycle(c, store, opts, { t3, kaneo });
  if (options.chain === 'first') {
    const pick = chainReady(tree, store.jobs()).find(t => t.runnable && t.id !== tree.target.id);
    if (!pick) return decision('chain-nothing-runnable', { ticket: ticketKey, tree, message: `Nothing in the chain to ${ticketKey} can start right now.` });
    const result = await run({ ...options, chain: undefined, ticket: pick.key, allowMissingReadyLabel: !pick.readyLabel });
    return { ...result, chain: { target: ticketKey, picked: pick.key } };
  }
  const plan: Plan = { id: randomUUID(), createdAt: new Date().toISOString(), target: tree.target, tickets: tree.tickets, model: options.model ?? 'auto', overrideLimits: override, state: 'active' };
  store.savePlan(plan);
  const dispatches = await runPlans(c, store, t3, kaneo, instances, threads, plan.id);
  const started = dispatches.filter(d => d.reason === 'dispatched').length;
  return decision('plan-started', { ticket: ticketKey, planId: plan.id, plan: store.plan(plan.id), dispatches, message: `Chain to ${ticketKey} started: ${started} of ${count} ticket${count === 1 ? '' : 's'} running now, the rest as they unblock.` });
}
// Advance every active chain: refresh ticket states, finish chains whose tickets are all done, start what can start within the run limits.
export async function runPlans(c: Config, store: Store, t3: T3, kaneo: Kaneo, instances: Map<string, string>, threads: Thread[], only?: string): Promise<Decision[]> {
  const results: Decision[] = [];
  for (const plan of store.plans().filter(p => p.state === 'active' && (!only || p.id === only))) {
    const reader = taskReader(c, kaneo), all = [...plan.tickets, plan.target];
    for (const t of all) {
      try { const task = await reader.task(t.id); t.status = task.status; t.done = await reader.done(task); }
      catch (error) { t.note = safeError(error); }
    }
    if (all.every(t => t.done)) { plan.state = 'done'; plan.finishedAt = new Date().toISOString(); store.savePlan(plan); continue; }
    for (const t of chainReady(plan, store.jobs())) {
      if (!t.runnable) { t.note = 'Its project is not included in the factory'; continue; }
      const preset = plan.model !== 'auto' ? c.models.find(m => m.id === plan.model) : c.models.find(m => m.automatic && acceptsDifficulty(m, t as Candidate));
      if (!preset) { t.note = t.difficulty ? (plan.model === 'auto' ? 'No automatic model accepts this difficulty' : 'The chosen model is no longer configured') : 'Ticket needs a difficulty label before dispatch'; continue; }
      const driver = instances.get(preset.model.instanceId) ?? 'claudeAgent';
      if (busyProviders(store.jobs(), threads, instances, c.monitoringTimeoutMinutes, c.concurrency).has(driver)) { t.note = `Waiting for a free ${driver === 'codex' ? 'Codex' : 'Claude'} slot`; continue; }
      try {
        const result = await dispatchOne(c, store, { manual: true, continuation: !only, ticket: t.key, model: preset.id, overrideLimits: plan.overrideLimits, allowMissingReadyLabel: !t.readyLabel }, undefined, { t3, kaneo });
        results.push(result);
        t.note = result.reason === 'dispatched' ? undefined : String((result as any).skipped?.[0]?.reason ?? (result as any).message ?? result.reason);
      } catch (error) { t.note = safeError(error); results.push({ reason: 'error', at: new Date().toISOString(), ticket: t.key, message: t.note }); }
    }
    store.savePlan(plan);
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
  const order: (Candidate & { after?: string[] })[] = queueOrder(queue.ready, store.get('lastProject'), c.projects.filter(p => p.enabled).map(p => p.kaneoId));
  const placed = new Map(order.map(t => [t.id, t.key]));
  for (const j of store.jobs()) if (j.taskId && !['complete', 'dismissed'].includes(j.state)) placed.set(j.taskId, j.ticketKey ?? j.taskId);
  const blocked = queue.skipped.filter((s): s is Skipped & { ticket: Candidate; blockedBy: string[] } => !!s.ticket && !!s.blockedBy?.length);
  const projected = new Set<string>();
  for (let round = blocked.filter(s => !placed.has(s.ticket.id) && s.blockedBy.every(id => placed.has(id))); round.length; round = blocked.filter(s => !placed.has(s.ticket.id) && s.blockedBy.every(id => placed.has(id)))) {
    for (const s of round.toSorted((a, b) => compareTicketPriority(a.ticket, b.ticket) || a.ticket.createdAt.localeCompare(b.ticket.createdAt))) {
      order.push({ ...s.ticket, after: s.blockedBy.map(id => placed.get(id)!) });
      placed.set(s.ticket.id, s.ticket.key); projected.add(s.ticket.id);
    }
  }
  return {
    at: new Date().toISOString(),
    tickets: order.map(t => {
      const preset = c.models.find(m => m.automatic && acceptsDifficulty(m, t));
      return { id: t.id, key: t.key, title: t.title ?? '', projectId: t.projectId, difficulty: t.difficulty, priority: t.priority, labelRank: t.labelRank, after: t.after ?? [], model: preset?.name ?? null, modelId: preset?.id ?? null };
    }),
    held: queue.skipped.filter(s => !s.id || !projected.has(s.id)).map(s => ({ key: s.key, reason: s.reason })),
  };
}

// Re-read each provider's allowance without a full pass; a reading older than quota.maxAgeSeconds is refreshed.
export async function refreshQuota(c: Config, store: Store, t3: T3) {
  t3.reset();
  const streams = JSON.parse(store.get('streams') ?? '[]') as { driver: string; quota?: unknown; quotaError?: string }[];
  const instances = new Map((await t3.providers()).map(p => [p.instanceId, p.driver]));
  const jobs = store.jobs();
  for (const stream of streams) {
    const preset = c.models.find(p => instances.get(p.model.instanceId) === stream.driver);
    if (!preset) continue;
    try { stream.quota = await readModelQuota(t3, c, jobs, preset.id); stream.quotaError = undefined; }
    catch (error) { stream.quotaError = safeError(error); }
  }
  store.set('streams', JSON.stringify(streams));
}

// One row per watched repository: the release reviewed through, the newest release seen, and whether a review runs or is due.
export function upstreamRows(c: Config, store: Store) {
  const jobs = store.jobs();
  return c.projects.flatMap(p => p.upstreams.map(u => {
    const { reviewing, reviewed, latest, due } = releaseState(p, u, store, jobs), checked = Number(store.get(`upstreamCheckedAt:${u.repo}`) ?? 0);
    return { project: p.name, name: u.name, repo: u.repo, prereleases: u.prereleases, reviewed, latest, checkedAt: checked ? new Date(checked).toISOString() : null,
      checkError: store.get(`upstreamCheckError:${u.repo}`) || null, reviewing, pending: due };
  }));
}

const iso = (ms: string | null) => (ms && Number(ms) ? new Date(Number(ms)).toISOString() : null);
export function writeStatus(c: Config, store: Store) {
  const result = {
    enabled: c.enabled, upstreamEnabled: !!c.upstream?.enabled, concurrency: c.concurrency, at: new Date().toISOString(), upstreams: upstreamRows(c, store), models: c.models, streams: JSON.parse(store.get('streams') ?? '[]'), decision: JSON.parse(store.get('lastDecision') ?? 'null'),
    discovery: c.projects.map(p => ({ projectId: p.kaneoId, lastAt: iso(store.get(`discoveryLast:${p.kaneoId}`)), nextAt: iso(store.get(`discoveryAfter:${p.kaneoId}`)) })),
    upNext: JSON.parse(store.get('upNext') ?? 'null'),
    plans: store.plans().filter(p => p.state === 'active' || Date.now() - Date.parse(p.finishedAt ?? p.createdAt) < 86_400_000),
    jobs: store.jobs().filter(j => j.state !== 'dismissed').map(({ command, ...job }) => ({ ...job, label: jobLabel(job) })),
    // The menu app reads only this file, so it gets the recent journal and the last finished runs here.
    journal: store.events(60),
    recent: store.jobs().filter(j => ['complete', 'dismissed'].includes(j.state)).map(({ command, ...job }) => ({ ...job, label: jobLabel(job) }))
      .toSorted((a, b) => (b.completedAt ?? b.dismissedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.dismissedAt ?? a.createdAt)).slice(0, 15),
  };
  const file = join(c.stateDir, 'status.json'); writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  return result;
}
