import { z } from 'zod';
import type { ModelPreset } from './config.ts';

export const threadSchema = z.object({
  id: z.string(), projectId: z.string(), title: z.string(),
  modelSelection: z.object({ instanceId: z.string(), model: z.string() }).passthrough(),
  branch: z.string().nullable(), worktreePath: z.string().nullable(),
  updatedAt: z.iso.datetime({ offset: true }), latestUserMessageAt: z.iso.datetime({ offset: true }).nullable(),
  archivedAt: z.string().nullable(), hasPendingApprovals: z.boolean(), hasPendingUserInput: z.boolean(),
  latestTurn: z.object({ state: z.string(), completedAt: z.string().nullable() }).passthrough().nullable(),
  session: z.object({ status: z.string(), providerName: z.string().nullable(), updatedAt: z.string() }).passthrough().nullable(),
  backgroundLiveness: z.enum(['working', 'monitoring']).nullish(),
}).passthrough();
export type Thread = z.infer<typeof threadSchema>;
export const DEFAULT_MONITORING_TIMEOUT_MINUTES = 30;
export function waiting(t: Thread): boolean { return (t.hasPendingApprovals || t.hasPendingUserInput) && t.backgroundLiveness !== 'working'; }
export function stalledMonitor(t: Thread, timeoutMinutes = DEFAULT_MONITORING_TIMEOUT_MINUTES): boolean {
  if (t.backgroundLiveness !== 'monitoring' || waiting(t) || !['ready', 'idle'].includes(t.session?.status ?? '') || t.latestTurn?.state === 'running') return false;
  const lastActivity = Math.max(Date.parse(t.updatedAt), Date.parse(t.session!.updatedAt), Date.parse(t.latestTurn?.completedAt ?? t.updatedAt));
  return Number.isFinite(lastActivity) && Date.now() - lastActivity >= timeoutMinutes * 60_000;
}
export function executing(t: Thread, timeoutMinutes = DEFAULT_MONITORING_TIMEOUT_MINUTES, includeMonitoring = true): boolean {
  if (t.backgroundLiveness === 'working') return true;
  if (waiting(t)) return false;
  if (['error', 'stopped', 'interrupted'].includes(t.session?.status ?? '')) return false;
  if (includeMonitoring && t.backgroundLiveness === 'monitoring') return !stalledMonitor(t, timeoutMinutes);
  if (['error', 'stopped', 'interrupted', 'idle', 'ready'].includes(t.session?.status ?? '')) return false;
  return ['starting', 'running'].includes(t.session?.status ?? '') || t.latestTurn?.state === 'running';
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
export interface Candidate { id: string; projectId: string; key: string; priority: string; createdAt: string; difficulty?: Difficulty; }
export function selectTicket(candidates: Candidate[], lastProject: string | null, projectOrder: string[]): Candidate | undefined {
  for (const priority of priorities) {
    let at = candidates.filter(t => t.priority === priority);
    if (!at.length) continue;
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

export function acceptsDifficulty(model: Pick<ModelPreset, 'maxDifficulty'>, ticket: Candidate): boolean {
  const levels = ['low', 'med', 'high'];
  return ticket.difficulty !== undefined && levels.indexOf(ticket.difficulty) <= levels.indexOf(model.maxDifficulty);
}
export function selectAssignment(candidates: Candidate[], models: { preset: ModelPreset; driver: string }[], busy: Set<string>, lastProject: string | null, projectOrder: string[]) {
  for (const priority of priorities) {
    for (const model of models) {
      if (busy.has(model.driver)) continue;
      const ticket = selectTicket(candidates.filter(t => t.priority === priority && acceptsDifficulty(model.preset, t)), lastProject, projectOrder);
      if (ticket) return { ...model, ticket };
    }
  }
  return undefined;
}
