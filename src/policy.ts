import { z } from 'zod';
import type { ModelPreset } from './config.ts';

// T3 orchestration protocol v2 thread shell. `status` is the latest run's status, or idle before any run.
const activeStatuses = ['preparing', 'queued', 'starting', 'running'] as const;
const stoppedStatuses = ['failed', 'interrupted', 'cancelled', 'rolled_back'] as const;
const at = z.iso.datetime({ offset: true });
export const threadSchema = z.object({
  id: z.string(), projectId: z.string(), title: z.string(), providerInstanceId: z.string(),
  modelSelection: z.object({ instanceId: z.string(), model: z.string() }).passthrough(),
  branch: z.string().nullable(), worktreePath: z.string().nullable(),
  updatedAt: at, latestUserMessageAt: at.nullable(), archivedAt: z.string().nullable(),
  status: z.enum(['idle', ...activeStatuses, 'waiting', 'completed', ...stoppedStatuses]),
  activeRunId: z.string().nullable(), latestRunCompletedAt: at.nullish(),
  pendingRuntimeRequest: z.object({ kind: z.string(), createdAt: z.string() }).passthrough().nullable(),
  // T3 lists background work only once the latest run settles. Monitors include pull request watches.
  pendingBackgroundTasks: z.array(z.object({ taskId: z.string(), kind: z.string() }).passthrough()).default([]),
  lineage: z.object({ parentThreadId: z.string().nullish(), relationshipToParent: z.string().nullish() }).passthrough().nullish(),
  settledOverride: z.enum(['settled', 'active']).nullable(),
  // Set by `T3.shell()`: the active run outlived every provider session, so it can never progress.
  orphanedRun: z.boolean().optional(),
}).passthrough();
export type Thread = z.infer<typeof threadSchema>;
export const DEFAULT_MONITORING_TIMEOUT_MINUTES = 30;
/** How long a thread must be unchanged before its active run is checked for stopped provider sessions. */
export const ORPHANED_RUN_GRACE_MINUTES = 30;
const workerTask = (task: { kind: string }) => task.kind !== 'monitor' && task.kind !== 'command';
function background(t: Thread): 'working' | 'monitoring' | null {
  const tasks = t.pendingBackgroundTasks ?? [];
  return tasks.some(workerTask) ? 'working' : tasks.some(task => task.kind === 'monitor') ? 'monitoring' : null;
}
export function humanRequest(kind: string): boolean { return !['dynamic_tool_call', 'auth_refresh'].includes(kind); }
function awaitingInput(t: Thread): boolean { return t.pendingRuntimeRequest != null && humanRequest(t.pendingRuntimeRequest.kind); }
function active(t: Thread): boolean {
  // A waiting shell without a human request is a runtime handoff; keep its slot until T3 settles it.
  return t.pendingRuntimeRequest != null || t.activeRunId != null || t.status === 'waiting' || (activeStatuses as readonly string[]).includes(t.status);
}
export function waiting(t: Thread): boolean { return awaitingInput(t) && background(t) !== 'working'; }
function expiredMonitor(t: Thread, timeoutMinutes: number): boolean {
  if (background(t) !== 'monitoring' || active(t) || !['idle', 'completed'].includes(t.status)) return false;
  const lastActivity = Math.max(Date.parse(t.updatedAt), Date.parse(t.latestRunCompletedAt ?? t.updatedAt));
  return Number.isFinite(lastActivity) && Date.now() - lastActivity >= timeoutMinutes * 60_000;
}
export function stalledMonitor(t: Thread, timeoutMinutes = DEFAULT_MONITORING_TIMEOUT_MINUTES): boolean {
  return !t.pendingBackgroundTasks.some(task => task.kind === 'command') && expiredMonitor(t, timeoutMinutes);
}
export function executing(t: Thread, timeoutMinutes = DEFAULT_MONITORING_TIMEOUT_MINUTES, includeMonitoring = true): boolean {
  if (background(t) === 'working') return true;
  if (waiting(t) || t.orphanedRun) return false;
  if (active(t)) return true;
  if ((stoppedStatuses as readonly string[]).includes(t.status)) return false;
  return includeMonitoring && background(t) === 'monitoring' && !expiredMonitor(t, timeoutMinutes);
}
/** A settled turn whose local commands will resume it. No provider executes; the running job retains its automatic-run reservation. */
export function commandWait(t: Thread, timeoutMinutes = DEFAULT_MONITORING_TIMEOUT_MINUTES): boolean {
  return t.pendingBackgroundTasks.some(task => task.kind === 'command') && !t.orphanedRun && !(stoppedStatuses as readonly string[]).includes(t.status) &&
    !waiting(t) && !executing(t, timeoutMinutes);
}
/** Threads reachable from `rootId` through subagent lineage, transitively. Lineage cycles cannot repeat or include the root. */
export function subagentDescendants(threads: readonly Thread[], rootId: string): Thread[] {
  const found = new Map<string, Thread>(), queue = [rootId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const t of threads) {
      if (t.lineage?.relationshipToParent !== 'subagent' || t.lineage.parentThreadId !== id || t.id === rootId || found.has(t.id)) continue;
      found.set(t.id, t); queue.push(t.id);
    }
  }
  return [...found.values()];
}
/** Provider usage excludes local commands and resolves stale child-task markers through the live shell. */
export function providerExecuting(t: Thread, threads: ReadonlyMap<string, Thread>, timeoutMinutes = DEFAULT_MONITORING_TIMEOUT_MINUTES, seen = new Set<string>()): boolean {
  if (seen.has(t.id)) return false;
  seen.add(t.id);
  if (!awaitingInput(t) && !t.orphanedRun && active(t)) return true;
  for (const task of t.pendingBackgroundTasks) {
    if (!workerTask(task)) continue;
    if (task.kind === 'subagent' && typeof task.childThreadId === 'string') {
      const child = threads.get(task.childThreadId);
      if (child) {
        // ponytail: native idle children lack a run lifecycle; protect fresh markers until T3 exposes terminal task state.
        const lastActivity = Math.max(Date.parse(t.updatedAt), Date.parse(child.updatedAt));
        if (child.status === 'idle' && Date.now() - lastActivity < timeoutMinutes * 60_000) return true;
        if (providerExecuting(child, threads, timeoutMinutes, seen)) return true;
        continue;
      }
    }
    return true; // Unknown workers remain protected until their activity can be established.
  }
  return false;
}
export function reserveAt(start: number, resetMs: number, durationMs: number, now: number): number {
  return start * Math.max(0, Math.min(1, (resetMs - now) / durationMs));
}
const windowSchema = z.object({
  usedPercent: z.number().min(0).max(100), windowMinutes: z.number().positive(),
  resetsAt: z.iso.datetime({ offset: true }),
}).passthrough();
export function providerQuotaSnapshot(checkedAt: string, windows: { id: string; usedPercent: number; resetsAt?: string; windowDurationMins?: number }[], now = Date.now()) {
  const map = (id: string) => {
    const w = windows.find(w => w.id === id);
    if (!w) return undefined;
    // An explicitly unused, inactive window has no reset until its first request.
    // Protect its full starting reserve. Never infer zero from a missing window.
    const reset = w.resetsAt ?? (w.usedPercent === 0 && w.windowDurationMins ? new Date(now + w.windowDurationMins * 60_000).toISOString() : undefined);
    return { usedPercent: w.usedPercent, resetsAt: reset, windowMinutes: w.windowDurationMins };
  };
  return { entries: [{ provider: 'claude', updatedAt: checkedAt, primary: map('five_hour'), secondary: map('seven_day') }] };
}
export function quotaDecision(raw: unknown, c: { maxAgeSeconds: number; fiveHourReservePercent: number; weeklyReservePercent: number }, now = Date.now(), ignoreWeeklyReserve = false) {
  const snapshot = z.object({ entries: z.array(z.object({ provider: z.string() }).passthrough()) }).parse(raw);
  const entries = snapshot.entries.filter(e => e.provider === 'claude');
  if (entries.length !== 1) throw new Error('Expected exactly one Claude quota account');
  const entry = z.object({ updatedAt: z.iso.datetime({ offset: true }), primary: windowSchema, secondary: z.unknown().optional() }).passthrough().parse(entries[0]);
  const age = now - Date.parse(entry.updatedAt);
  if (age < -60_000 || age > c.maxAgeSeconds * 1000) throw new Error('Claude quota snapshot is stale or future-dated');
  const windows = [
    { name: 'fiveHour', w: entry.primary, minutes: 300, start: c.fiveHourReservePercent },
    { name: 'weekly', w: windowSchema.parse(entry.secondary), minutes: 10080, start: ignoreWeeklyReserve ? 0 : c.weeklyReservePercent },
  ].map(({ name, w, minutes, start }) => {
    const reset = Date.parse(w.resetsAt);
    if (w.windowMinutes !== minutes || reset <= now || reset > now + minutes * 60_000 + 60_000) throw new Error(`Invalid or expired ${name} quota window; wait for a fresh snapshot`);
    const reserved = reserveAt(start, reset, minutes * 60_000, now);
    return { name, remaining: 100 - w.usedPercent, reserved, resetsAt: w.resetsAt };
  });
  return { allowed: windows.every(w => (ignoreWeeklyReserve && w.name === 'weekly') || w.remaining > w.reserved), capturedAt: entry.updatedAt, windows, weeklyReserveApplied: !ignoreWeeklyReserve };
}
export const priorities = ['urgent', 'high', 'medium', 'low', 'no-priority'] as const;
export type Difficulty = 'low' | 'med' | 'high';
export function ticketDifficulty(labels: { name: string }[]): Difficulty | undefined {
  const found = [...new Set(labels.map(l => l.name).filter((s): s is Difficulty => ['low', 'med', 'high'].includes(s)))];
  if (found.length > 1) throw new Error('Conflicting difficulty labels');
  return found[0];
}
// Branch prefix from the ticket's kind label, in conventional-commit terms so release tooling can read it.
const BRANCH_KINDS: Record<string, string> = { bug: 'fix', sec: 'fix', feat: 'feat', ux: 'feat', perf: 'perf', test: 'test', ci: 'ci', docs: 'docs', chore: 'chore' };
export function branchKind(labels: { name: string }[]): string {
  return labels.map(l => BRANCH_KINDS[l.name]).find(Boolean) ?? 'chore';
}
export function ticketLabelRank(labels: { name: string }[], priorityLabels: string[]): number | undefined {
  const rank = priorityLabels.findIndex(name => labels.some(label => label.name === name));
  return rank < 0 ? undefined : rank;
}
export interface Candidate { id: string; projectId: string; key: string; priority: string; createdAt: string; difficulty?: Difficulty; labelRank?: number; title?: string; labels?: { name: string }[] }
export type TicketPriority = Pick<Candidate, 'priority' | 'labelRank'>;
export function compareTicketPriority(a: TicketPriority, b: TicketPriority): number {
  const aRank = a.labelRank ?? Infinity, bRank = b.labelRank ?? Infinity;
  if (aRank !== bRank) return aRank < bRank ? -1 : 1;
  return priorities.findIndex(p => p === a.priority) - priorities.findIndex(p => p === b.priority);
}
// Both ticket and model selection must visit the same label-rank / urgency tiers.
function* ticketTiers(candidates: Candidate[]) {
  const ordered = candidates.filter(t => priorities.some(p => p === t.priority)).toSorted(compareTicketPriority);
  let tier: Candidate[] = [];
  for (const candidate of ordered) {
    if (tier.length && compareTicketPriority(tier[0], candidate) !== 0) { yield tier; tier = []; }
    tier.push(candidate);
  }
  if (tier.length) yield tier;
}
export function selectTicket(candidates: Candidate[], lastProject: string | null, projectOrder: string[]): Candidate | undefined {
  for (const at of ticketTiers(candidates)) {
    const count = (id: string) => at.filter(t => t.projectId === id).length;
    const start = (projectOrder.indexOf(lastProject ?? '') + 1) % projectOrder.length;
    const rotated = [...projectOrder.slice(start), ...projectOrder.slice(0, start)];
    const project = rotated.toSorted((a, b) => count(b) - count(a))[0];
    return at.filter(t => t.projectId === project).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))[0];
  }
}
export function mentionsTicket(text: string, key: string): boolean {
  return new RegExp(`(?:^|[^A-Z0-9])${key}(?![0-9])`, 'i').test(text);
}
export function threadReferencesTicket(thread: Thread, projectId: string, key: string): boolean {
  return thread.projectId === projectId && mentionsTicket(`${thread.title}\n${thread.branch ?? ''}`, key);
}

// The order the scheduler would take these tickets in if nothing else changed: each pick rotates projects as a real dispatch would.
export function queueOrder(candidates: Candidate[], lastProject: string | null, projectOrder: string[]): Candidate[] {
  const order: Candidate[] = [];
  let pool = candidates, last = lastProject;
  for (let next = selectTicket(pool, last, projectOrder); next; next = selectTicket(pool, last, projectOrder)) {
    order.push(next); pool = pool.filter(t => t !== next); last = next.projectId;
  }
  return order;
}
export function acceptsDifficulty(model: Pick<ModelPreset, 'maxDifficulty'>, ticket: Candidate): boolean {
  const levels = ['low', 'med', 'high'];
  return ticket.difficulty !== undefined && levels.indexOf(ticket.difficulty) <= levels.indexOf(model.maxDifficulty);
}
export function selectAssignment(candidates: Candidate[], models: { preset: ModelPreset; driver: string }[], busy: Set<string>, lastProject: string | null, projectOrder: string[]) {
  for (const tier of ticketTiers(candidates)) {
    for (const model of models) {
      if (busy.has(model.driver)) continue;
      const ticket = selectTicket(tier.filter(t => acceptsDifficulty(model.preset, t)), lastProject, projectOrder);
      if (ticket) return { ...model, ticket };
    }
  }
  return undefined;
}
