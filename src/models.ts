import { z } from 'zod';
import { T3 } from './clients.ts';
import { configuredModel, type Config } from './config.ts';
import { providerQuotaSnapshot, quotaDecision, reserveAt } from './policy.ts';
import type { Job } from './store.ts';

type ModelConfig = Pick<Config, 'models' | 'quota'>;
class QuotaRefreshError extends Error {}

// One evaluator serves network reads and the synchronous reservation boundary.
export function modelQuota(c: ModelConfig, jobs: Job[], id: string, provider: Awaited<ReturnType<T3['provider']>>, manual: boolean, requireFreshAfter?: number) {
  const preset = configuredModel(c, id);
  const consumedAfter = jobs.filter(job => (job.modelSelection?.instanceId ?? 'claudeAgent') === preset.model.instanceId).reduce((latest, job) => Math.max(latest, Date.parse(job.createdAt)), 0);
  const name = provider.driver === 'codex' ? 'Codex' : 'Claude';
  if (!['codex', 'claudeAgent'].includes(provider.driver) || !provider.enabled || !provider.installed || provider.status !== 'ready') throw new Error(`Configured ${name} provider is not ready in T3`);
  if (!provider.models.some(m => m.slug === preset.model.model || m.aliases?.includes(preset.model.model))) throw new Error(`T3 does not advertise model ${preset.model.model}`);
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable) throw new QuotaRefreshError(`T3 could not read ${name} subscription quota`);
  const now = Date.now(), checked = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checked) || checked <= consumedAfter || checked > now + 60_000 || now - checked > c.quota.maxAgeSeconds * 1000 || (requireFreshAfter !== undefined && checked < requireFreshAfter - 1000)) throw new QuotaRefreshError(`${name} quota snapshot is stale`);
  let windows: { name: string; remaining: number; reserved: number; resetsAt: string }[];
  let specificRemaining: number | null = null;
  let specificRequired = 0;
  if (provider.driver === 'codex') {
    windows = z.array(z.object({ id: z.string(), usedPercent: z.number().min(0).max(100), windowDurationMins: z.number().positive(), resetsAt: z.iso.datetime({ offset: true }).optional() })).min(1).parse(limits.windows).map(w => {
      const reset = w.resetsAt ?? (w.usedPercent === 0 ? new Date(now + w.windowDurationMins * 60_000).toISOString() : '');
      if (!Number.isFinite(Date.parse(reset)) || Date.parse(reset) <= now || Date.parse(reset) > now + w.windowDurationMins * 60_000 + 60_000) throw new Error('Invalid or expired Codex quota window; refresh required');
      const rule = w.windowDurationMins === 10080 ? c.quota.codex.weekly : { reservePercent: 0, minRemainingPercent: 0 };
      const start = manual || w.windowDurationMins !== 10080 ? 0 : rule.reservePercent;
      return { name: w.windowDurationMins === 10080 ? 'weekly' : w.windowDurationMins === 300 ? 'fiveHour' : w.id, remaining: 100 - w.usedPercent, reserved: Math.max(reserveAt(start, Date.parse(reset), w.windowDurationMins * 60_000, now), manual ? 0 : rule.minRemainingPercent), resetsAt: reset };
    });
  } else {
    if (preset.quotaWindowId) {
      const found = limits.windows.filter(w => w.id === preset.quotaWindowId);
      if (found.length !== 1) throw new Error('Model allowance is missing or ambiguous; refresh required');
      const w = z.object({ usedPercent: z.number().min(0).max(100), windowDurationMins: z.literal(10080), resetsAt: z.iso.datetime({ offset: true }).optional() }).parse(found[0]);
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : w.usedPercent === 0 ? now + 7 * 86_400_000 : NaN;
      if (!Number.isFinite(reset) || reset <= now || reset > now + 7 * 86_400_000 + 60_000) throw new Error('Invalid or expired model allowance; refresh required');
      specificRemaining = 100 - w.usedPercent;
      const rule = c.quota.claude.fable;
      specificRequired = Math.max(reserveAt(rule.reservePercent, reset, 10080 * 60_000, now), rule.minRemainingPercent);
    }
    windows = quotaDecision(providerQuotaSnapshot(limits.checkedAt, limits.windows), { maxAgeSeconds: c.quota.maxAgeSeconds, fiveHourReservePercent: c.quota.claude.fiveHour.reservePercent, weeklyReservePercent: c.quota.claude.weekly.reservePercent }, now, specificRemaining !== null).windows.map(w => ({ ...w, reserved: specificRemaining !== null && w.name === 'weekly' ? 0 : Math.max(w.reserved, c.quota.claude[w.name === 'fiveHour' ? 'fiveHour' : 'weekly'].minRemainingPercent) }));
  }
  // Report the model allowance for display even when another preset on this provider was routed.
  let displayedRemaining = specificRemaining;
  if (displayedRemaining === null && provider.driver !== 'codex') {
    for (const id of new Set(c.models.filter(p => p.model.instanceId === preset.model.instanceId && p.quotaWindowId).map(p => p.quotaWindowId!))) {
      const found = limits.windows.filter(w => w.id === id);
      const used = found.length === 1 ? Number((found[0] as { usedPercent?: unknown }).usedPercent) : NaN;
      if (used >= 0 && used <= 100) { displayedRemaining = 100 - used; break; }
    }
  }
  return {
    provider: name, driver: provider.driver, hasAllowance: windows.every(w => (specificRemaining !== null && w.name === 'weekly') || w.remaining > 0) && (specificRemaining === null || specificRemaining > 0), allowed: windows.every(w => (specificRemaining !== null && w.name === 'weekly') || w.remaining > w.reserved) && (specificRemaining === null || specificRemaining > specificRequired),
    capturedAt: limits.checkedAt, windows,
    weeklyReserveApplied: provider.driver === 'codex' ? !manual : specificRemaining === null,
    factoryRouting: { model: preset.model, modelId: preset.id, reason: `Assigned model: ${preset.name}`, fableRemainingPercent: displayedRemaining },
  };
}

export function liveModelQuota(t3: T3, c: ModelConfig, jobs: Job[], id: string, manual = false) {
  const preset = configuredModel(c, id), provider = t3.peekProvider?.(preset.model.instanceId);
  if (!provider) return;
  // The caller supplies the reservations its preparation must account for. Native usage
  // updates are reevaluated synchronously immediately before reservation.
  try { return modelQuota(c, jobs, id, provider, manual); }
  catch (error) { if (!(error instanceof QuotaRefreshError)) throw error; }
}

export async function readModelQuota(t3: T3, c: ModelConfig, jobs: Job[], id: string, manual = false, refresh = false) {
  const result = (await readModelQuotas(t3, c, jobs, [id], manual, refresh))[0];
  if ('error' in result) throw result.error;
  return result.quota!;
}

// Evaluate every preset on an instance from one authoritative allowance snapshot.
export async function readModelQuotas(t3: T3, c: ModelConfig, jobs: Job[], ids: string[], manual = false, refresh = false) {
  const preset = configuredModel(c, ids[0]);
  if (ids.some(id => configuredModel(c, id).model.instanceId !== preset.model.instanceId)) throw new Error('Quota models must share a provider instance');
  type Result = ({ id: string; quota: ReturnType<typeof modelQuota>; error?: never } | { id: string; error: unknown; quota?: never }) & { snapshot?: Awaited<ReturnType<T3['provider']>> };
  const live = t3.peekProvider(preset.model.instanceId);
  if (live) {
    const results: Result[] = ids.map(id => {
      try { return { id, quota: modelQuota(c, jobs, id, live, manual), snapshot: live }; }
      catch (error) { return { id, error, snapshot: live }; }
    });
    if (!results.some(result => result.error instanceof QuotaRefreshError)) return results;
  }
  for (let attempt = 0; ; attempt++) {
    const force = refresh || attempt > 0;
    const requestedAt = Date.now(), before = t3.peekProvider(preset.model.instanceId);
    let results: Result[];
    try {
      let provider = await t3.provider(preset.model.instanceId, force);
      const current = t3.peekProvider(preset.model.instanceId);
      if (before && !current) throw new Error('Provider identity changed during quota refresh');
      if (current && JSON.stringify(current) !== JSON.stringify(before)) provider = current;
      results = ids.map(id => {
        try { return { id, quota: modelQuota(c, jobs, id, provider, manual, force ? requestedAt : undefined), snapshot: provider }; }
        catch (error) { return { id, error, snapshot: provider }; }
      });
    } catch (error) {
      results = ids.map(id => ({ id, error }));
    }
    if (attempt < (refresh ? 1 : 2) && results.some(result => 'error' in result && (!force || result.error instanceof QuotaRefreshError))) continue;
    return results.map(result => result.error instanceof QuotaRefreshError
      ? { ...result, error: new Error(`Quota automatic refresh failed: ${result.error.message}. No run was started.`, { cause: result.error }) }
      : result);
  }
}
