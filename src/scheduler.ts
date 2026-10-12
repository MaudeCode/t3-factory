import { readFileSync, realpathSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { T3, Kaneo, listTasks, listTaskLabels, taskSchema, type Task } from './clients.ts';
import { executing, providerExecuting, subagentDescendants, waiting, stalledMonitor, DEFAULT_MONITORING_TIMEOUT_MINUTES, ticketDifficulty, ticketLabelRank, compareTicketPriority, mentionsTicket, selectTicket, acceptsDifficulty, selectAssignment, type Thread, type Candidate, type TicketPriority } from './policy.ts';
import { Store, jobLabel, type Job } from './store.ts';
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
      const history = await historicalArtifacts(project, [{ ...job, state: 'complete' }], fresh.threads, branch);
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

async function historicalArtifacts(project: Project, history: Job[], threads: Thread[], expectedBranch?: string) {
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
      const pr = z.object({ state: z.string(), headRefName: z.string(), headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/) }).parse(await gh(['pr', 'view', url, '--repo', project.githubRepo, '--json', 'state,headRefName,headRefOid']));
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
  for (const p of projects) for (const t of await listTasks(kaneo, p.kaneoId, labels)) all.set(t.id, t);
  const owned = new Map(jobs.filter(j => !['complete', 'dismissed'].includes(j.state)).map(j => [j.taskId, j]));
  const ready: Candidate[] = [], skipped: { key: string; reason: string; missingReadyLabel?: boolean }[] = [];
  const potential = [...all.values()].filter(t => {
    const p = projects.find(p => p.kaneoId === t.projectId)!;
    const key = `${p.key}-${t.number}`;
    if (ticketKey && key !== ticketKey) return false;
    const missingReadyLabel = !t.labels?.some(l => l.name === c.kaneo.readyLabel) && !(ticketKey === key && allowMissingReadyLabel);
    const reason = !p.readyStatuses.includes(t.status) ? `Ticket is ${t.status}; it must be in ${p.readyStatuses.join(' or ')}`
      : owned.has(t.id) ? `Ticket already has a ${owned.get(t.id)!.state} factory run`
      : missingReadyLabel ? `Ticket is missing the ${c.kaneo.readyLabel} label` : '';
    if (reason && ticketKey) skipped.push({ key, reason, ...(missingReadyLabel && p.readyStatuses.includes(t.status) && !owned.has(t.id) ? { missingReadyLabel: true } : {}) });
    return !reason;
  });
  if (ticketKey && ![...all.values()].some(t => `${projects.find(p => p.kaneoId === t.projectId)!.key}-${t.number}` === ticketKey)) skipped.push({ key: ticketKey, reason: 'Ticket was not found in the enabled project' });
  const refs = new Map<string, string>(), prs = new Map<string, { title: string; headRefName: string; body: string }[]>();
  const finalStatuses = new Map(c.projects.map(p => [p.kaneoId, p.doneStatuses]));
  const getTask = async (id: string) => {
    if (!all.has(id)) all.set(id, taskSchema.parse(await kaneo.call('get_task', { taskId: id })));
    return all.get(id)!;
  };
  const isDone = async (id: string) => {
    const task = await getTask(id);
    if (!finalStatuses.has(task.projectId)) {
      const columns = z.array(z.object({ slug: z.string(), isFinal: z.boolean() }).passthrough()).parse(await kaneo.call('list_project_columns', { projectId: task.projectId }));
      finalStatuses.set(task.projectId, columns.filter(c => c.isFinal).map(c => c.slug));
    }
    return finalStatuses.get(task.projectId)!.includes(task.status);
  };
  const relationCache = new Map<string, z.infer<typeof relationsSchema>>();
  const relationsFor = async (id: string) => {
    if (!relationCache.has(id)) relationCache.set(id, relationsSchema.parse(await kaneo.call('get_task_relations', { taskId: id })));
    return relationCache.get(id)!;
  };
  const incomingBlocker = async (id: string, ancestors = new Set<string>()): Promise<boolean> => {
    if (ancestors.has(id)) return true;
    const visited = new Set([...ancestors, id]);
    for (const r of await relationsFor(id)) {
      if (r.relationType === 'blocks' && r.targetTaskId === id && !await isDone(r.sourceTaskId)) return true;
      if (r.relationType === 'subtask' && r.targetTaskId === id && await incomingBlocker(r.sourceTaskId, visited)) return true;
    }
    return false;
  };
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
        const dependent = all.get(relation.targetTaskId);
        const owner = dependent && projects.find(p => p.kaneoId === dependent.projectId);
        if (!dependent || !owner || owner.doneStatuses.includes(dependent.status)) continue;
        const downstream = priorityFor(dependent, owner);
        if (compareTicketPriority(downstream, priority) < 0) priority = downstream;
        pending.push(dependent.id);
      }
    }
    return priority;
  };
  for (const t of potential) {
    const p = projects.find(p => p.kaneoId === t.projectId)!;
    const key = `${p.key}-${t.number}`;
    let difficulty: Candidate['difficulty'];
    try { difficulty = ticketDifficulty(t.labels ?? []); }
    catch { skipped.push({ key, reason: 'Conflicting difficulty labels' }); continue; }
    if (!difficulty) { skipped.push({ key, reason: 'Ticket needs a difficulty label before dispatch' }); continue; }
    let reason = '';
    const relations = await relationsFor(t.id);
    if (await incomingBlocker(t.id)) reason = 'Ticket or ancestor has an unfinished blocker or relation cycle';
    for (const r of relations) {
      if (r.relationType === 'subtask' && r.sourceTaskId === t.id && !await isDone(r.targetTaskId)) reason = 'Umbrella has unfinished children; select leaves instead';
    }
    const history = jobs.filter(j => j.taskId === t.id && ['complete', 'dismissed'].includes(j.state));
    let artifacts = { branches: new Map<string, string>(), inactiveThreads: new Set<string>() };
    if (!reason && history.length) {
      try { artifacts = await historicalArtifacts(p, history, threads); }
      catch { reason = 'Previous work could not be verified; inspect its PR and worktree before restarting'; }
    }
    if (!reason && threads.some(s => !artifacts.inactiveThreads.has(s.id) && mentionsTicket(`${s.title}\n${s.branch ?? ''}`, key))) reason = 'Existing T3 thread or branch references this ticket';
    if (!reason) {
      if (!refs.has(p.kaneoId)) refs.set(p.kaneoId, await git(p.repoPath, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes']));
      const unmatched = refs.get(p.kaneoId)!.split('\n').filter(line => {
        const [ref, head] = line.split('\t');
        return ![...artifacts.branches].some(([branch, mergedHead]) => head === mergedHead && (ref === `refs/heads/${branch}` || ref.startsWith('refs/remotes/') && ref.endsWith(`/${branch}`)));
      }).join('\n');
      if (mentionsTicket(unmatched, key)) reason = 'Existing Git branch references this ticket';
      if (!prs.has(p.kaneoId)) prs.set(p.kaneoId, z.array(z.object({ title: z.string(), headRefName: z.string(), body: z.string() })).parse(await gh(['pr', 'list', '--repo', p.githubRepo, '--state', 'open', '--limit', '1000', '--json', 'title,headRefName,body'])));
      if (prs.get(p.kaneoId)!.some(pr => mentionsTicket(`${pr.title}\n${pr.headRefName}\n${pr.body}`, key))) reason = 'Existing open PR references this ticket';
    }
    if (reason) skipped.push({ key, reason });
    else ready.push({ id: t.id, projectId: t.projectId, key, createdAt: t.createdAt, difficulty, ...await inheritedPriority(t, p) });
  }
  return { ready, skipped, selected: selectTicket(ready, store.get('lastProject'), projects.map(p => p.kaneoId)) };
}

export interface CycleOptions { dryRun?: boolean; doctor?: boolean; manual?: boolean; overrideLimits?: boolean; allowMissingReadyLabel?: boolean; ticket?: string; model?: string; }

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

export async function cycle(c: Config, store: Store, options: CycleOptions = {}) {
  if (options.allowMissingReadyLabel && (!options.manual || !options.ticket?.trim())) throw new Error('The readiness-label override requires a specific manual ticket');
  if (options.manual && options.model && options.model !== 'auto') return dispatchOne(c, store, options);
  if (options.model && options.model !== 'auto') throw new Error('Explicit models require manual dispatch');
  const decision = (reason: string, extra: Record<string, unknown> = {}) => {
    const result = { reason, at: new Date().toISOString(), ...extra };
    store.set('lastDecision', JSON.stringify(result)); log('decision', result); return result;
  };
  const override = !!options.manual && !!options.overrideLimits;
  const t3 = new T3(c.t3), kaneo = new Kaneo(c.kaneo);
  const shell = await t3.shell();
  const providers = await t3.providers();
  const instances = new Map(providers.map(p => [p.instanceId, p.driver]));
  await kaneo.connect();
  try {
    await reconcile(c, store, t3, kaneo, shell.threads, !options.dryRun && !options.doctor);
    const jobs = store.jobs();
    const busy = options.manual ? new Set<string>() : busyProviders(jobs, shell.threads, instances, c.monitoringTimeoutMinutes, c.concurrency);
    const streams = ['claudeAgent', 'codex'].map(driver => ({
      driver, provider: driver === 'codex' ? 'Codex' : 'Claude',
      reason: !options.manual && c.concurrency[driver === 'codex' ? 'codex' : 'claude'] === 0 ? 'provider-disabled' : busy.has(driver) ? 'provider-running' : 'no-eligible-model',
      active: jobs.filter(j => ['running', 'dispatching'].includes(j.state) && (j.providerDriver ?? instances.get(j.modelSelection?.instanceId ?? 'claudeAgent')) === driver).map(jobLabel),
      planned: [] as string[], models: [] as { id: string; name: string; reason: string }[], quota: undefined as Awaited<ReturnType<typeof readModelQuota>> | undefined,
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
    // Fully paused: provider status and quota stay fresh, nothing is dispatched. With only reviews on, only reviews dispatch.
    const reviewsOn = !!c.upstream?.enabled, ticketsOn = c.enabled || !!options.manual || !!options.doctor;
    if (!ticketsOn && !reviewsOn) { store.set('streams', JSON.stringify(streams)); return decision('disabled', { streams }); }
    const queue = !ticketsOn ? { ready: [], skipped: [], selected: undefined } as Awaited<ReturnType<typeof inventory>> : await inventory(c, kaneo, shell.threads, store.jobs(), store, options.ticket?.trim().toUpperCase(), !!options.manual && !!options.allowMissingReadyLabel);
    if (options.manual && queue.skipped.some(s => s.missingReadyLabel)) return decision('ready-label-confirmation-required', { ticket: options.ticket?.trim().toUpperCase(), requiredLabel: c.kaneo.readyLabel, message: `Ticket is missing the ${c.kaneo.readyLabel} label. Confirm this run to continue without it.` });
    // Upstream reviews are bounded and time-sensitive, so they go ahead of ticket work.
    const reviews = options.manual || (!reviewsOn && !options.doctor) ? [] : await pendingReviews(c, store, store.jobs(), Date.now(), !options.dryRun && !options.doctor);
    const candidates = [...queue.ready];
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
        const result = await dispatchOne(c, store, { ...options, doctor: false, dryRun: options.dryRun || options.doctor, model: selected.preset.id, ticket: assignment?.ticket.key }, { driver: selected.driver, instanceDrivers: instances, skipProjects: claimedProjects, inspect: options.doctor, review });
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
  } finally { await kaneo.close(); }
}

async function dispatchOne(c: Config, store: Store, options: CycleOptions, plan?: { driver: string; instanceDrivers: Map<string, string>; skipProjects: Set<string>; inspect?: boolean; review?: PendingReview }) {
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
    store.set('lastDecision', JSON.stringify(result)); log('decision', result); return result;
  };
  if (!c.enabled && !options.doctor && !options.manual && !plan?.inspect && !(plan?.review && c.upstream?.enabled)) return decision('disabled');
  const t3 = new T3(c.t3);
  const shell = await t3.shell();
  const instances = plan?.instanceDrivers ?? new Map((await t3.providers()).map(p => [p.instanceId, p.driver]));
  for (const p of c.projects.filter(p => p.enabled)) {
    const live = shell.projects.find(x => x.id === p.t3Id);
    if (!live || live.workspaceRoot !== p.repoPath) throw new Error(`T3 project mapping mismatch for ${p.name}`);
  }
  const kaneo = new Kaneo(c.kaneo);
  await kaneo.connect();
  try {
    if (!plan) await reconcile(c, store, t3, kaneo, shell.threads, !options.dryRun && !options.doctor);
    const jobs = store.jobs();
    const running = jobs.filter(j => ['running', 'dispatching'].includes(j.state));
    const parked = jobs.filter(j => j.state === 'waiting');
    if (plan && !options.manual && busyProviders(jobs, shell.threads, plan.instanceDrivers, c.monitoringTimeoutMinutes, c.concurrency).has(plan.driver)) return decision('provider-running', { driver: plan.driver });
    const review = plan?.review;
    // A review needs no ticket queue, so ticket-only reads cannot block it.
    const queue = review && !plan?.inspect ? { ready: [], skipped: [], selected: undefined } as Awaited<ReturnType<typeof inventory>> : await inventory(c, kaneo, shell.threads, jobs, store, ticketKey, !!options.manual && !!options.allowMissingReadyLabel);
    if (options.manual && queue.skipped.some(s => s.missingReadyLabel)) return decision('ready-label-confirmation-required', { ticket: ticketKey, requiredLabel: c.kaneo.readyLabel, message: `Ticket is missing the ${c.kaneo.readyLabel} label. Confirm this run to continue without it.` });
    const discovery = !ticketKey && !options.manual && !review;
    if (discovery && (queue.ready.length || queue.skipped.some(s => /difficulty/.test(s.reason)))) return decision('ticket-work-takes-priority');
    queue.ready = queue.ready.filter(t => acceptsDifficulty(preset, t));
    if (!discovery && !review && !queue.ready.length) return decision('no-eligible-ticket', { ticket: ticketKey, skipped: queue.skipped, message: 'Ticket must be classified, within the model difficulty limit, SF-ready, unblocked, and not already owned.' });
    const readSelectedQuota = (refresh = false) => readModelQuota(t3, c, store.jobs(), preset.id, !!options.manual, refresh);
    const quota = await readSelectedQuota();
    if (plan && quota.driver !== plan.driver) return decision('provider-mapping-changed');
    const isManualCodex = options.manual && quota.provider === 'Codex';
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
    if (queue.selected) {
      const task = taskSchema.parse(await kaneo.call('get_task', { taskId: queue.selected.id }));
      if (task.projectId !== project.kaneoId || !project.readyStatuses.includes(task.status)) return decision('ticket-changed-before-dispatch');
      const recheck = await inventory(c, kaneo, (await t3.shell()).threads, store.jobs(), store, ticketKey, !!options.manual && !!options.allowMissingReadyLabel);
      if (recheck.selected?.id !== task.id || !acceptsDifficulty(preset, recheck.selected)) return decision('ticket-order-or-eligibility-changed');
    }
    const fresh = await t3.shell();
    const currentQuota = await readSelectedQuota(true);
    if (plan && currentQuota.driver !== plan.driver) return decision('provider-mapping-changed');
    const currentManualCodex = options.manual && currentQuota.provider === 'Codex';
    const currentActivity = await readActivity(fresh.threads);
    if (!currentQuota.hasAllowance) return decision(currentManualCodex ? 'codex-quota-exhausted' : 'quota-exhausted', { quota: currentQuota });
    // Reviews start as soon as a release is found, so only ticket and discovery work wait for idle time.
    if (!override && ((!currentManualCodex && idleBlocked(c, currentActivity)) || !currentQuota.allowed)) return decision('gate-changed-before-dispatch', { quota: currentQuota });
    if (!options.manual && plan && busyProviders(store.jobs(), fresh.threads, plan.instanceDrivers, c.monitoringTimeoutMinutes, c.concurrency).has(plan.driver)) return decision('job-resumed-before-dispatch');
    if (JSON.stringify(loadConfig()) !== JSON.stringify(c)) return decision('configuration-changed-before-dispatch');
    const selectedModel = currentQuota.factoryRouting.model;
    const modelReason = (options.manual ? `Manual dispatch${override && !currentManualCodex ? ' with idle/quota thresholds overridden for this run' : ''}. ` : '') + currentQuota.factoryRouting.reason + (options.allowMissingReadyLabel ? ` The user explicitly confirmed this run without the ${c.kaneo.readyLabel} readiness label. Waive only that label check; do not add the label or skip other readiness, dependency, validation, or merge gates.` : '');
    const now = new Date().toISOString(), id = randomUUID();
    const job: Job = { id, providerDriver: currentQuota.driver, modelSelection: selectedModel, modelReason, ...(queue.selected?.difficulty ? { difficulty: queue.selected.difficulty } : {}), kind: review ? 'upstream' : queue.selected ? 'ticket' : 'discovery', ...(review ? { upstream: review.upstream } : {}), projectId: project.kaneoId, taskId: queue.selected?.id ?? null, ticketKey: queue.selected?.key ?? null, threadId: randomUUID(), messageId: randomUUID(), createdAt: now, state: 'dispatching', reason: 'Dispatch prepared', lastPersonalActivity: null, reportPath: join(c.stateDir, 'reports', `${id}.json`), command: null, prUrls: [], completedAt: null };
    const u = job.upstream;
    const title = job.kind === 'ticket' ? `Factory: ${job.ticketKey}` : u ? `Upstream review: ${u.name} ${u.base}..${u.candidate}` : `Factory discovery: ${project.name}`;
    const branch = job.kind === 'ticket' ? `chore/${job.ticketKey}-factory-${id.slice(0, 8)}` : `chore/factory-${job.kind}-${id.slice(0, 8)}`;
    // T3 creates the worktree from the project's workspace root, which must match project.repoPath (checked above).
    job.command = { commandId: randomUUID(), threadId: job.threadId, projectId: project.t3Id, title,
      modelSelection: selectedModel, runtimeMode: c.runtimeMode, interactionMode: 'default',
      workspaceStrategy: { type: 'worktree', baseRef: project.baseBranch, branch, startFromOrigin: true },
      initialMessage: { messageId: job.messageId, text: promptFor(job, project, c, !!options.manual), attachments: [] },
    };
    store.save(job); // Durable ownership precedes the external write, including ambiguous timeouts.
    store.set('lastProject', project.kaneoId);
    if (job.kind === 'discovery') store.set(`discoveryLast:${project.kaneoId}`, String(Date.now()));
    await t3.launch(job.command);
    job.reason = 'T3 accepted dispatch'; store.save(job);
    return decision('dispatched', { jobId: job.id, threadId: job.threadId, project: project.name, projectId: project.kaneoId, ticket: job.ticketKey, upstream: job.upstream, model: selectedModel.model, modelReason, difficulty: job.difficulty, quota: currentQuota });
  } finally { await kaneo.close(); }
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

export function writeStatus(c: Config, store: Store) {
  const result = { enabled: c.enabled, upstreams: upstreamRows(c, store), models: c.models, streams: JSON.parse(store.get('streams') ?? '[]'), decision: JSON.parse(store.get('lastDecision') ?? 'null'), jobs: store.jobs().filter(j => j.state !== 'dismissed').map(({ command, ...job }) => ({ ...job, label: jobLabel(job) })) };
  const file = join(c.stateDir, 'status.json'); writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  return result;
}
