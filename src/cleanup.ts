import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { T3, Kaneo } from './clients.ts';
import { cleanupActionPending, type Store, type Job } from './store.ts';
import { subagentDescendants, type Thread } from './policy.ts';
import { cleanupCompletedWorkspace, verifyCleanupHead, verifyCompletionReport, readCompletionReport, safeError } from './scheduler.ts';
import { canonicalPath, inspectWorkspace, worktrees, freeBytes, processWorkspaces, usesWorkspace, removeWorkspace, verifyIdleProjection } from './workspace.ts';

const target = { projectId: z.string().min(1).max(200), path: z.string().startsWith('/').max(4096) };
export const cleanupRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inventory'), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), query: z.string().max(500).optional(), repository: z.string().max(4096).optional(), ownership: z.string().max(40).optional(), state: z.string().max(40).optional(), sort: z.enum(['path', 'branch', 'repository', 'attempt', 'size']).optional(), inspectionId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('inspect'), ...target, size: z.boolean().default(false), inspectionId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('review'), ...target, inspectionId: z.uuid().optional() }).strict(),
  z.object({ type: z.enum(['retry', 'remove']), id: z.uuid(), targets: z.array(z.object(target).strict()).min(1).max(20), reason: z.string().trim().min(1).max(800) }).strict(),
  z.object({ type: z.literal('force'), id: z.uuid(), reviewId: z.uuid(), confirmation: z.string().max(4096), reason: z.string().trim().min(1).max(800) }).strict(),
]);
export type CleanupRequest = z.infer<typeof cleanupRequestSchema>;
export interface CleanupAction {
  id: string; input: unknown; operator: string; requestedAt: string; updatedAt: string;
  state: 'requested' | 'confirmed' | 'failed' | 'uncertain';
  targets: { projectId: string; path: string }[]; reason: string; reviewId?: string;
  outcomes: { path: string; state: string; message: string; physicalRemoval?: boolean; freeSpaceChange?: number | null }[];
  overridden?: string[]; identity?: string;
}
type Boundary = { processes?: typeof processWorkspaces; signal?: AbortSignal };
const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const jobPaths = (job: Job) => [job.workspaceCleanup?.path, job.dismissedWorktreePath, job.thread?.worktreePath].filter((p): p is string => !!p);
const jobIdentity = (j: Job) => [j.id, j.projectId, j.threadId, j.state, j.createdAt, j.completedAt, j.dismissedAt, j.resumedAt, j.command, j.workspaceCleanup, j.workspaceCleanedAt, j.prUrls, j.reportPath,
  existsSync(j.reportPath) ? digest(readFileSync(j.reportPath, 'utf8')) : null];
const publicJob = (j: Job) => ({ id: j.id, taskId: j.taskId, ticketKey: j.ticketKey, projectId: j.projectId, threadId: j.threadId, state: j.state,
  completedAt: j.completedAt, resumedAt: j.resumedAt, prUrls: j.prUrls, workspaceCleanedAt: j.workspaceCleanedAt,
  stage: j.workspaceCleanedAt ? 'complete' : j.workspaceCleanup ? 'detached / removal pending' : 'verification / detach pending',
  error: j.workspaceCleanupError ? safeError(j.workspaceCleanupError) : undefined, lastAttempt: j.workspaceCleanupAttemptedAt ?? j.workspaceCleanupBlockedAt,
  nextRetry: j.workspaceCleanupBlockedAt ? new Date(Date.parse(j.workspaceCleanupBlockedAt) + 15 * 60_000).toISOString() : null,
});
const threadIdentity = (t: Thread) => ({ id: t.id, projectId: t.projectId, worktreePath: t.worktreePath, branch: t.branch, status: t.status,
  activeRunId: t.activeRunId, updatedAt: t.updatedAt, latestUserMessageAt: t.latestUserMessageAt, latestRunCompletedAt: t.latestRunCompletedAt,
  pending: t.pendingRuntimeRequest ? { kind: t.pendingRuntimeRequest.kind, createdAt: t.pendingRuntimeRequest.createdAt } : null, background: t.pendingBackgroundTasks.map(b => ({ taskId: b.taskId, kind: b.kind })), lineage: t.lineage ? { parentThreadId: t.lineage.parentThreadId, relationshipToParent: t.lineage.relationshipToParent } : null, orphanedRun: t.orphanedRun });
const projectFor = (c: Config, id: string) => { const p = c.projects.find(p => p.kaneoId === id); if (!p) throw new Error('Repository is not configured'); return p; };

async function verifyDetachedOwners(t3: T3, bindings: ReturnType<typeof threadIdentity>[]) {
  const shell = await t3.shell(true);
  for (const binding of bindings) {
    const thread = shell.threads.find(t => t.id === binding.id);
    if (!thread || thread.projectId !== binding.projectId || thread.worktreePath !== null || thread.branch !== null || thread.status !== binding.status || thread.activeRunId || thread.pendingRuntimeRequest || thread.pendingBackgroundTasks.length || thread.latestUserMessageAt !== binding.latestUserMessageAt || thread.latestRunCompletedAt !== binding.latestRunCompletedAt || subagentDescendants(shell.threads, thread.id).some(t => !bindings.some(b => b.id === t.id))) throw new Error('Detached owner or subagent changed before removal');
    await verifyIdleProjection(t3, thread);
  }
}

export async function inspectCleanup(c: Config, store: Store, t3: T3, kaneo: Kaneo, input: { projectId: string; path: string; size?: boolean }, boundary: Boundary = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...boundary.signal ? [boundary.signal] : []]);
  const project = projectFor(c, input.projectId), checkedAt = new Date().toISOString();
  const checks: { name: string; state: 'pass' | 'blocked' | 'unknown'; override: boolean; detail: string; checkedAt: string }[] = [];
  const check = async (name: string, override: boolean, run: () => Promise<string> | string) => {
    signal.throwIfAborted();
    try { const detail = await run(); checks.push({ name, state: 'pass', override, detail, checkedAt: new Date().toISOString() }); }
    catch (e) { checks.push({ name, state: e instanceof z.ZodError ? 'unknown' : 'blocked', override, detail: safeError(e), checkedAt: new Date().toISOString() }); }
  };
  let workspace: Awaited<ReturnType<typeof inspectWorkspace>> | null = null;
  await check('Repository and worktree identity', false, async () => {
    workspace = await inspectWorkspace(project.repoPath, input.path, !!input.size, signal);
    if ((workspace.present || workspace.registered) && !workspace.removable) throw new Error('Preserve primary, locked or unregistered checkout');
    return workspace.present ? 'Registered worktree belongs to the configured repository' : workspace.registered ? 'Directory absent; stale Git registration remains' : 'Directory and Git registration absent';
  });
  // Separate locals keep narrowed types across asynchronous check callbacks.
  const physical = workspace as Awaited<ReturnType<typeof inspectWorkspace>> | null;
  const path = physical?.path ?? resolve(input.path);
  let threads: Thread[] = [], owners: Thread[] = [], shellKnown = false, projections: string[] = [];
  await check('Live ownership and activity', false, async () => {
    const shell = await t3.shell(true); threads = shell.threads; shellKnown = true;
    const configured = shell.projects.find(p => p.id === project.t3Id);
    if (!configured || canonicalPath(configured.workspaceRoot) !== canonicalPath(project.repoPath)) throw new Error('T3 project repository mapping is unknown or changed');
    const bound = threads.filter(t => t.worktreePath && (usesWorkspace(t.worktreePath, path) || usesWorkspace(path, canonicalPath(t.worktreePath))));
    owners = [...new Map(bound.flatMap(t => [t, ...subagentDescendants(threads, t.id)]).map(t => [t.id, t])).values()];
    for (const t of owners) {
      signal.throwIfAborted();
      if (t.worktreePath && canonicalPath(t.worktreePath) !== path) throw new Error('Overlapping binding uses a different workspace identity');
      if (t.projectId !== project.t3Id) throw new Error('Worktree is bound to another project');
      if (t.activeRunId || t.pendingRuntimeRequest || t.orphanedRun || ['preparing', 'queued', 'starting', 'running', 'waiting'].includes(t.status) || t.pendingBackgroundTasks.length) throw new Error(`Thread ${t.id} has active or pending work`);
      projections.push(await verifyIdleProjection(t3, t));
    }
    return owners.length ? `${owners.length} idle bindings and subagents verified` : 'No live T3 binding';
  });
  const jobs = store.jobs().filter(j => owners.some(t => t.id === j.threadId) || jobPaths(j).some(p => canonicalPath(p) === path));
  await check('Factory activity', false, () => {
    if (!shellKnown) throw new Error('T3 ownership is unknown');
    if (c.stateDir && usesWorkspace(c.stateDir, path)) throw new Error('Preserve Factory state and completion reports');
    if (c.projects.some(p => usesWorkspace(p.repoPath, path))) throw new Error('Preserve configured repository checkouts');
    for (const job of jobs) {
      if (usesWorkspace(job.reportPath, path)) throw new Error('A completion report is stored inside this worktree; preserve it before removal');
      if (!['complete', 'dismissed'].includes(job.state)) throw new Error(`Job ${job.id} is ${job.state}`);
      const t = threads.find(t => t.id === job.threadId);
      const finishedAt = job.completedAt ?? job.dismissedAt;
      if (finishedAt && [job.resumedAt, t?.latestUserMessageAt, t?.latestRunCompletedAt].some(at => Date.parse(at ?? '') > Date.parse(finishedAt))) throw new Error(`Job ${job.id} resumed after completion`);
    }
    return `${jobs.length} historical jobs, none active or resumed`;
  });
  let terminals: { threadId: string; terminalId: string; status: string; hasRunningSubprocess: boolean }[] = [];
  await check('Terminals', false, async () => {
    const all = await t3.terminals();
    if (all.some(t => ['starting', 'running'].includes(t.status) && !t.cwd)) throw new Error('A live terminal has an unknown working directory');
    terminals = all.filter(t => (t.status === 'running' || t.status === 'starting') && (usesWorkspace(t.cwd, path) || (!!t.worktreePath && usesWorkspace(t.worktreePath, path)) || owners.some(o => o.id === t.threadId))).map(t => ({ threadId: t.threadId, terminalId: t.terminalId, status: t.status, hasRunningSubprocess: t.hasRunningSubprocess }));
    if (terminals.length) throw new Error('Open T3 terminals retain this workspace; close idle terminals or retry normal maintenance first');
    return 'No open terminals use this workspace';
  });
  let processes: string[] = [], processKnown = false;
  await check('Process working directories', false, async () => {
    processes = (await (boundary.processes ?? processWorkspaces)(signal)).filter(cwd => usesWorkspace(cwd, path));
    processKnown = true;
    if (processes.length) throw new Error('A running process is using the worktree');
    return 'No process working directory uses this worktree';
  });
  await check('Contents', true, () => {
    if (!physical) throw new Error('Contents unknown');
    if (physical.status) throw new Error(`${physical.tracked} tracked changes, ${physical.untracked} untracked files, ${physical.ignored} ignored entries will be lost`);
    return 'No tracked, untracked or ignored changes';
  });
  let reports: { jobId: string; status: string; reason: string; prUrls: string[] }[] = [];
  await check('Verified completion and merged HEAD', true, async () => {
    if (!physical || !shellKnown || jobs.length !== 1 || owners.some(t => t.id !== jobs[0].threadId && !subagentDescendants(threads, jobs[0].threadId).some(s => s.id === t.id))) throw new Error('Completion ownership is missing or shared');
    const job = jobs[0], thread = threads.find(t => t.id === job.threadId);
    if (!thread) throw new Error('Completion thread is unavailable');
    if (existsSync(job.reportPath)) {
      const report = readCompletionReport(job);
      if (report.status === 'awaiting-human') throw new Error('Completion is awaiting human input');
      await verifyCompletionReport(c, kaneo, job, thread, report);
      reports.push({ jobId: job.id, status: report.status, reason: safeError(report.reason), prUrls: report.prUrls });
    } else throw new Error('Completion report is missing');
    const head = await verifyCleanupHead(c, store, kaneo, job, threads, physical.branch, path);
    if (head !== physical.head) throw new Error('Workspace HEAD differs from verified merged HEAD');
    return 'Completion, tracker and merged HEAD verified';
  });
  signal.throwIfAborted();
  const hard = checks.filter(c => !c.override && c.state !== 'pass'), overridden = checks.filter(c => c.override && c.state !== 'pass').map(c => `${c.name}: ${c.detail}`);
  const fingerprint = digest([project, physical?.fingerprint, owners.map(threadIdentity), projections, jobs.map(jobIdentity), checks.map(c => [c.name, c.state, c.override, c.detail])]);
  const actions = store.cleanupActions().filter(a => a.targets.some(t => t.projectId === input.projectId && canonicalPath(t.path) === path));
  return { projectId: input.projectId, repository: project.repoPath, path, checkedAt, workspace: physical && { ...physical, status: undefined },
    checks, ownership: !shellKnown ? 'unknown' : jobs.length > 1 || owners.length > 1 ? 'shared' : jobs.length ? 'factory' : owners.length ? 't3-only' : 'orphan',
    jobs: jobs.map(publicJob), bindings: owners.map(threadIdentity), terminals, processCount: processKnown ? processes.length : null, reports, actions,
    state: hard.length ? 'blocked' : !physical?.present ? physical?.registered ? 'stale-registration' : 'missing' : overridden.length ? 'blocked' : 'eligible',
    forceAllowed: !hard.length && !!physical?.removable, overridden, fingerprint,
    size: { state: input.size && !physical ? 'error' : physical?.bytes == null ? 'unknown' : 'known', bytes: physical?.bytes ?? null, checkedAt: input.size ? checkedAt : null },
  };
}

// Job cannot represent a Git-only worktree; this row joins physical identity with optional owners.
interface CleanupInventoryItem {
  projectId: string; repository: string; path: string; branch: string; head: string; present: boolean; registered: boolean;
  ownership: string; state: string; checkedAt: string; lastAttempt: string | null; jobs: ReturnType<typeof publicJob>[]; bindings: ReturnType<typeof threadIdentity>[];
  size: { state: string; bytes: number | null; checkedAt?: string | null };
}

export async function cleanupInventory(c: Config, store: Store, t3: T3, offset = 0, limit = 50, signal?: AbortSignal, filters: { query?: string; repository?: string; ownership?: string; state?: string; sort?: string } = {}) {
  signal = AbortSignal.any([AbortSignal.timeout(30_000), ...signal ? [signal] : []]);
  const at = new Date().toISOString(), jobs = store.jobs(), actions = store.cleanupActions(), errors: { repository: string; message: string }[] = [];
  let threads: Thread[] = [], shellKnown = false;
  try { threads = (await t3.shell(true)).threads; shellKnown = true; } catch (e) { errors.push({ repository: 'T3', message: safeError(e) }); }
  const items: CleanupInventoryItem[] = [], repositories: { path: string; freeBytes: number | null }[] = [];
  for (const project of c.projects) {
    signal?.throwIfAborted();
    let registered: Awaited<ReturnType<typeof worktrees>> = [];
    try { registered = await worktrees(project.repoPath, signal); } catch (e) { errors.push({ repository: project.repoPath, message: safeError(e) }); }
    repositories.push({ path: project.repoPath, freeBytes: await freeBytes(project.repoPath) });
    const localJobs = jobs.filter(j => j.projectId === project.kaneoId), localThreads = threads.filter(t => t.projectId === project.t3Id);
    const localActions = actions.filter(a => a.targets.some(t => t.projectId === project.kaneoId));
    const paths = new Set([...registered.map(t => t.path), ...localJobs.flatMap(jobPaths), ...localThreads.flatMap(t => t.worktreePath ? [t.worktreePath] : []), ...localActions.flatMap(a => a.targets.filter(t => t.projectId === project.kaneoId).map(t => t.path))].map(canonicalPath));
    for (const path of paths) {
      const bindings = threads.filter(t => t.worktreePath && canonicalPath(t.worktreePath) === path);
      const owned = localJobs.filter(j => bindings.some(t => t.id === j.threadId) || jobPaths(j).some(p => canonicalPath(p) === path));
      const history = localActions.filter(a => a.targets.some(t => t.projectId === project.kaneoId && canonicalPath(t.path) === path));
      const unresolved = history.some(a => cleanupActionPending(a, path));
      const confirmed = history.some(a => a.outcomes.some(o => canonicalPath(o.path) === path && o.state === 'confirmed'));
      const jobRows = owned.map(publicJob), lastAttempt = [...jobRows.map(j => j.lastAttempt), ...history.map(a => a.updatedAt)].filter((at): at is string => !!at).sort().at(-1) ?? null;
      const tree = registered.find(t => canonicalPath(t.path) === path), present = existsSync(path), primary = registered[0] && canonicalPath(registered[0].path) === path;
      const active = bindings.some(t => t.activeRunId || t.pendingRuntimeRequest || t.pendingBackgroundTasks.length || ['preparing', 'queued', 'starting', 'running', 'waiting'].includes(t.status)) || owned.some(j => !['complete', 'dismissed'].includes(j.state));
      const state = primary ? 'primary' : active ? 'active' : !shellKnown ? 'unknown' : unresolved ? 'blocked' : !present ? tree ? 'stale-registration' : confirmed || owned.some(j => j.workspaceCleanedAt) ? 'complete' : 'missing' : owned.some(j => j.workspaceCleanupError) ? 'blocked' : owned.some(j => !j.workspaceCleanedAt) ? 'pending' : 'review';
      const cached = JSON.parse(store.get(`cleanupSize:${digest([project.kaneoId, path])}`) ?? 'null');
      const size = cached ? { state: cached.state === 'error' ? 'error' : Date.now() - Date.parse(cached.checkedAt) < 300_000 && cached.head === tree?.head ? 'known' : 'stale', bytes: cached.bytes, checkedAt: cached.checkedAt } : { state: 'unknown', bytes: null };
      items.push({ projectId: project.kaneoId, repository: project.repoPath, path, branch: tree?.branch ?? bindings[0]?.branch ?? '', head: tree?.head ?? '', present, registered: !!tree,
        ownership: !shellKnown ? 'unknown' : owned.length > 1 || bindings.length > 1 ? 'shared' : owned.length ? 'factory' : bindings.length ? 't3-only' : 'orphan',
        state, lastAttempt, jobs: jobRows, bindings: bindings.map(threadIdentity), size, checkedAt: at });
    }
  }
  const query = filters.query?.toLowerCase() ?? '';
  const filtered = items.filter(i => (!filters.repository || i.repository === filters.repository) && (!filters.ownership || i.ownership === filters.ownership) && (!filters.state || i.state === filters.state) && JSON.stringify([i.path, i.branch, i.repository, i.jobs, i.bindings]).toLowerCase().includes(query));
  filtered.sort((a, b) => filters.sort === 'size' ? (b.size.bytes ?? -1) - (a.size.bytes ?? -1) : filters.sort === 'attempt' ? String(b.lastAttempt ?? '').localeCompare(a.lastAttempt ?? '') : String(filters.sort === 'branch' ? a.branch : filters.sort === 'repository' ? a.repository : a.path).localeCompare(String(filters.sort === 'branch' ? b.branch : filters.sort === 'repository' ? b.repository : b.path)));
  if (!errors.length) store.set('cleanupLastScan', at);
  const maintenance = JSON.parse(store.get('cleanupMaintenance') ?? 'null');
  const stalled = !!maintenance && ['pending', 'inspecting'].includes(maintenance.state) && Date.now() - Date.parse(maintenance.lastAttempt) > Math.max(c.pollSeconds ?? 60, 900) * 2000;
  const nextRetry = items.flatMap(i => i.jobs.map(j => j.nextRetry)).filter((at): at is string => !!at && Date.parse(at) > Date.now()).sort()[0] ?? null;
  return { lastSuccessfulScan: store.get('cleanupLastScan'), nextRetry, stalled, items: filtered.slice(offset, offset + limit), total: filtered.length, inventoryTotal: items.length, offset, limit, checkedAt: at, errors, repositories,
    counts: Object.fromEntries(['pending', 'blocked', 'active', 'missing', 'complete', 'stale-registration', 'review', 'unknown', 'primary'].map(s => [s, items.filter(i => i.state === s).length])),
    present: items.filter(i => i.present).length, automationEnabled: c.enabled, maintenance, actions: actions.slice(0, 50) };
}

function confirmAbsentActions(store: Store, detail: Awaited<ReturnType<typeof inspectCleanup>>) {
  if (!detail.workspace || detail.workspace.present || detail.workspace.registered || detail.bindings.length || detail.checks.some(c => !c.override && c.state !== 'pass')) return;
  for (const action of store.cleanupActions().filter(a => cleanupActionPending(a, detail.path))) {
    action.outcomes = action.outcomes.filter(o => canonicalPath(o.path) !== detail.path);
    action.outcomes.push({ path: detail.path, state: 'confirmed', message: 'Already-absent finalization after uncertain response; removal attribution unknown', physicalRemoval: false, freeSpaceChange: null });
    action.updatedAt = new Date().toISOString();
    action.state = action.targets.every(t => action.outcomes.some(o => o.path === t.path && ['confirmed', 'failed'].includes(o.state))) ? action.outcomes.some(o => o.state === 'failed') ? 'failed' : 'confirmed' : 'uncertain';
    store.saveCleanupAction(action);
    store.record('cleanup.confirmed', 'Verified already-absent outcome after uncertain response', { actionId: action.id, path: detail.path, physicalRemoval: false, fingerprint: detail.fingerprint });
    for (const job of store.jobs().filter(j => detail.jobs.some(o => o.id === j.id))) { job.workspaceCleanedAt = action.updatedAt; job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job); }
  }
  detail.actions = store.cleanupActions().filter(a => a.targets.some(t => t.projectId === detail.projectId && canonicalPath(t.path) === detail.path));
}

export async function manageCleanup(c: Config, store: Store, t3: T3, kaneo: Kaneo, raw: unknown, operator = 'authenticated operator', boundary: Boundary = {}): Promise<any> {
  boundary.signal?.throwIfAborted();
  const input = cleanupRequestSchema.parse(raw);
  if (input.type === 'inventory') return cleanupInventory(c, store, t3, input.offset, input.limit, boundary.signal, input);
  if (input.type === 'inspect') {
    const detail = await inspectCleanup(c, store, t3, kaneo, input, boundary);
    confirmAbsentActions(store, detail);
    if (input.size) store.set(`cleanupSize:${digest([input.projectId, detail.path])}`, JSON.stringify({ ...detail.size, head: detail.workspace?.head }));
    return detail;
  }
  if (input.type === 'review') {
    const detail = await inspectCleanup(c, store, t3, kaneo, { ...input, size: true }, boundary);
    boundary.signal?.throwIfAborted();
    const id = randomUUID(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const review = { id, expiresAt, input: { projectId: input.projectId, path: detail.path }, fingerprint: detail.fingerprint, detail };
    store.set(`cleanupReview:${id}`, JSON.stringify(review));
    return { ...detail, reviewId: id, expiresAt };
  }
  const previous = store.cleanupAction(input.id);
  if (previous) {
    if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw new Error('Request ID already belongs to another cleanup action');
    return { ...previous, state: previous.state === 'requested' ? 'uncertain' : previous.state };
  }
  let review: any;
  if (input.type === 'force') {
    review = JSON.parse(store.get(`cleanupReview:${input.reviewId}`) ?? 'null');
    if (!review || Date.parse(review.expiresAt) <= Date.now()) throw new Error('Review expired; inspect this worktree again');
    if (input.confirmation !== review.input.path) throw new Error('Confirmation must exactly match the reviewed path');
  }
  const targets = input.type === 'force' ? [review.input] : input.targets;
  const action: CleanupAction = { id: input.id, input, operator, reason: safeError(input.reason), requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'requested', targets, outcomes: [], ...(review ? { reviewId: review.id, overridden: review.detail.overridden, identity: review.fingerprint } : {}) };
  const save = (state: CleanupAction['state']) => { action.state = state; action.updatedAt = new Date().toISOString(); store.saveCleanupAction(action); store.record(`cleanup.${state}`, `Cleanup ${input.type}: ${state}`, { actionId: action.id, operator, reason: action.reason, targets, reviewId: action.reviewId, overridden: action.overridden, identity: action.identity, outcomes: action.outcomes }); };
  save('requested');
  for (const target of targets) {
    let mutated = false;
    try {
      const project = projectFor(c, target.projectId), beforeFree = await freeBytes(project.repoPath);
      if (store.cleanupActions().some(a => a.id !== action.id && cleanupActionPending(a, target.path))) throw new Error('An earlier cleanup response is uncertain. Inspect its result; destructive requests are never replayed');
      if (input.type === 'force') {
        const fresh = await inspectCleanup(c, store, t3, kaneo, { ...target, size: true }, boundary);
        if (!fresh.forceAllowed || fresh.fingerprint !== review.fingerprint) throw new Error('Reviewed identity, content or activity changed; review again');
        for (const job of store.jobs().filter(j => fresh.jobs.some(o => o.id === j.id))) { job.workspaceCleanup = { path: fresh.path, branch: fresh.workspace!.branch, head: fresh.workspace!.head }; store.save(job); }
        const ownedIdentity = digest(store.jobs().filter(j => fresh.jobs.some(o => o.id === j.id)).map(jobIdentity));
        // Detach only the reviewed idle bindings, using T3's expected-path contract. No Stop is authorized here.
        for (const binding of fresh.bindings.filter(t => t.worktreePath)) {
          mutated = true;
          await t3.dispatch({ type: 'thread.metadata.update', commandId: randomUUID(), threadId: binding.id, expectedWorktreePath: binding.worktreePath, worktreePath: null, branch: null });
          mutated = false;
        }
        const afterDetach = await inspectCleanup(c, store, t3, kaneo, { ...target, size: true }, boundary);
        if (afterDetach.workspace?.fingerprint !== fresh.workspace?.fingerprint || afterDetach.bindings.length || afterDetach.checks.some(c => !c.override && c.state !== 'pass')) throw new Error('Worktree or live state changed while detaching; removal refused');
        // Detached owners still need fresh bounded reads; their shell status alone cannot prove an empty queue.
        await verifyDetachedOwners(t3, fresh.bindings);
        if (digest(store.jobs().filter(j => fresh.jobs.some(o => o.id === j.id)).map(jobIdentity)) !== ownedIdentity) throw new Error('Factory ownership changed');
        const final = await inspectWorkspace(project.repoPath, target.path, true, boundary.signal);
        if (final.fingerprint !== fresh.workspace?.fingerprint) throw new Error('Worktree changed before removal');
        const result = await removeWorkspace(project.repoPath, target.path, t3, true, async () => {
          const evidence = await inspectCleanup(c, store, t3, kaneo, { ...target, size: true }, boundary);
          if (evidence.workspace?.fingerprint !== fresh.workspace?.fingerprint || evidence.bindings.length || evidence.checks.some(c => !c.override && c.state !== 'pass')) throw new Error('Final live or filesystem evidence changed; removal refused');
          await verifyDetachedOwners(t3, fresh.bindings);
          if (digest(store.jobs().filter(j => fresh.jobs.some(o => o.id === j.id)).map(jobIdentity)) !== ownedIdentity) throw new Error('Factory ownership changed before removal');
          mutated = true;
        });
        action.outcomes.push({ path: target.path, state: 'confirmed', message: result.outcome, physicalRemoval: result.physicalRemoval,
          freeSpaceChange: beforeFree === null ? null : await freeBytes(project.repoPath).then(n => n === null ? null : n - beforeFree) });
        for (const job of store.jobs().filter(j => fresh.jobs.some(o => o.id === j.id))) { job.workspaceCleanedAt = new Date().toISOString(); job.workspaceCleanupError = job.workspaceCleanupBlockedAt = undefined; store.save(job); }
      } else {
        const path = canonicalPath(target.path);
        if (path !== resolve(target.path)) throw new Error('Worktree path contains a symlink or alias; inspect its canonical registered path');
        const shell = await t3.shell(true);
        const jobs = store.jobs().filter(j => j.projectId === target.projectId && (jobPaths(j).some(p => canonicalPath(p) === path) || shell.threads.some(t => t.id === j.threadId && t.worktreePath && canonicalPath(t.worktreePath) === path)));
        if (jobs.length !== 1) throw new Error('Normal maintenance requires one Factory-owned job; use a force review for uncertain historical ownership');
        const job = jobs[0];
        if (!['complete', 'dismissed'].includes(job.state) && !job.workspaceCleanup) throw new Error('Job is active; cleanup cannot dispatch or finish work');
        const wasPresent = existsSync(target.path);
        // Calling the normal verifier directly bypasses only its retry cooldown. Each step re-reads ownership.
        for (let step = 0; step < (input.type === 'remove' ? 8 : 1); step++) {
          const result = await cleanupCompletedWorkspace(c, store, t3, kaneo, store.job(job.id)!, { ...boundary, actionId: action.id });
          mutated = !!result?.uncertain;
          const current = store.job(job.id)!;
          if (current.workspaceCleanedAt || current.workspaceCleanupError) break;
        }
        const current = store.job(job.id)!, physical = await inspectWorkspace(project.repoPath, target.path);
        if (current.workspaceCleanupError) throw new Error(current.workspaceCleanupError);
        const absent = !physical.present && !physical.registered;
        action.outcomes.push({ path: target.path, state: absent ? 'confirmed' : 'pending', message: absent ? 'Directory and Git registration absent' : 'Maintenance advanced; retry to continue', physicalRemoval: absent && wasPresent,
          freeSpaceChange: beforeFree === null ? null : await freeBytes(project.repoPath).then(n => n === null ? null : n - beforeFree) });
      }
    } catch (error) { action.outcomes.push({ path: target.path, state: mutated ? 'uncertain' : 'failed', message: safeError(error) }); }
    save('requested');
  }
  save(action.outcomes.some(o => o.state === 'uncertain') ? 'uncertain' : action.outcomes.some(o => o.state === 'failed') ? 'failed' : 'confirmed');
  return action;
}
