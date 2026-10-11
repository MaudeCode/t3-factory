import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { DEFAULT_MONITORING_TIMEOUT_MINUTES } from './policy.ts';

const positive = z.number().positive();
const absolute = z.string().startsWith('/');
const model = z.object({
  instanceId: z.string().min(1), model: z.string().min(1),
  options: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }).strict()).default([]),
}).strict();
export type ModelSelection = z.infer<typeof model>;
const preset = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), name: z.string().min(1), model,
  automatic: z.boolean().default(false), maxDifficulty: z.enum(['low', 'med', 'high']).default('high'), quotaWindowId: z.string().min(1).optional(),
}).strict();

function migrateLegacy(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'models' in value) return value;
  const { model: oldModel, fable, codex, manualModels, ...rest } = value as Record<string, unknown>;
  if (!oldModel) return value;
  const fallback = model.parse(oldModel);
  const preferred = z.object({ enabled: z.boolean(), model, quotaWindowId: z.string().default('seven_day_fable'), minRemainingPercent: z.number().min(0).max(100).default(5) }).strict().optional().parse(fable);
  const oldCodex = z.object({ sol: model, astra: model }).strict().optional().parse(codex);
  const manual = manualModels === undefined ? [
    { id: 'sol', name: 'Sol', model: oldCodex?.sol ?? { instanceId: 'codex', model: 'gpt-5.6-sol', options: [{ id: 'reasoningEffort', value: 'high' }] }, preferHard: false },
    { id: 'astra', name: 'Astra', model: oldCodex?.astra ?? { instanceId: 'codex', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] }, preferHard: true },
  ] : z.array(z.object({ id: z.string(), name: z.string(), model, preferHard: z.boolean().optional(), quotaWindowId: z.string().optional() }).strict()).parse(manualModels);
  return { ...rest, models: [
    ...(preferred ? [{ id: 'fable', name: 'Fable', model: preferred.model, preferHard: true, quotaWindowId: preferred.quotaWindowId }] : []),
    { id: 'opus', name: 'Opus', model: fallback, preferHard: false }, ...manual,
  ], routing: {
    automaticModel: preferred?.enabled ? 'fable' : 'opus', fallbackModel: preferred?.enabled ? 'opus' : null,
    discoveryModel: 'opus', fallbackAtRemainingPercent: preferred?.minRemainingPercent ?? 15,
  } };
}
const budget = z.object({ reservePercent: z.number().min(0).max(100), minRemainingPercent: z.number().min(0).max(100).default(0) }).strict();
export const configSchema = z.preprocess(input => {
  const value = migrateLegacy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('routing' in value)) return value;
  const { routing, models, quota, ...rest } = value as Record<string, unknown>;
  const oldRouting = z.object({ automaticModel: z.string(), fallbackModel: z.string().nullable(), discoveryModel: z.string(), fallbackAtRemainingPercent: z.number().min(0).max(100) }).strict().parse(routing);
  const oldQuota = z.object({ maxAgeSeconds: positive, fiveHourReservePercent: z.number().min(0).max(100), weeklyReservePercent: z.number().min(0).max(100) }).strict().parse(quota);
  const oldModels = z.array(z.object({ id: z.string(), name: z.string(), model, preferHard: z.boolean().optional(), quotaWindowId: z.string().optional(), automatic: z.boolean().optional(), maxDifficulty: z.enum(['low', 'med', 'high']).optional() }).strict()).parse(models);
  return { ...rest, models: oldModels.map(({ preferHard, ...p }) => ({ ...p, automatic: p.automatic ?? true, maxDifficulty: p.maxDifficulty ?? 'high' })), quota: {
    maxAgeSeconds: oldQuota.maxAgeSeconds,
    claude: {
      fiveHour: { reservePercent: oldQuota.fiveHourReservePercent, minRemainingPercent: 0 },
      weekly: { reservePercent: oldQuota.weeklyReservePercent, minRemainingPercent: 0 },
      fable: { reservePercent: 0, minRemainingPercent: oldRouting.fallbackAtRemainingPercent },
    },
    codex: { weekly: { reservePercent: oldQuota.weeklyReservePercent, minRemainingPercent: 0 } },
  } };
}, z.object({
  enabled: z.boolean(), pollSeconds: positive.min(15), idleMinutes: positive,
  maxWaitingPRs: z.number().int().positive().nullable(),
  concurrency: z.object({ claude: z.number().int().min(0).default(1), codex: z.number().int().min(0).default(1) }).strict().default({ claude: 1, codex: 1 }),
  models: z.array(preset).min(1),
  monitoringTimeoutMinutes: positive.default(DEFAULT_MONITORING_TIMEOUT_MINUTES),
  runtimeMode: z.enum(['full-access', 'auto', 'auto-accept-edits']),
  stateDir: absolute,
  t3: z.object({ url: z.url(), credentialFile: absolute, autonomousThreadIds: z.array(z.string().min(1)).optional() }).strict(),
  kaneo: z.object({ url: z.url(), workspaceId: z.string().min(1), readyLabel: z.string().min(1) }).strict(),
  quota: z.object({
    maxAgeSeconds: positive,
    claude: z.object({ fiveHour: budget, weekly: budget, fable: budget }).strict(),
    codex: z.object({ weekly: budget }).strict(),
  }).strict(),
  discovery: z.object({ promptFile: absolute, emptyCooldownHours: positive }).strict(),
  upstream: z.object({ promptFile: absolute, checkMinutes: positive.default(360) }).strict().optional(),
  factorySkill: absolute,
  projects: z.array(z.object({
    name: z.string().min(1), enabled: z.boolean(), key: z.string().regex(/^[A-Z0-9]+$/),
    kaneoId: z.string().min(1), t3Id: z.string().min(1), repoPath: absolute,
    githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), baseBranch: z.string().min(1),
    readyStatuses: z.array(z.string()).min(1), doneStatuses: z.array(z.string()).min(1),
    discoveryPromptFile: absolute.optional(),
    upstreams: z.array(z.object({
      name: z.string().min(1), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      prereleases: z.boolean().default(false), firstBase: z.string().min(1),
    }).strict()).default([]),
  }).strict()).min(1),
}).strict().superRefine((c, ctx) => {
  const ids = c.models.map(p => p.id);
  if (new Set(ids).size !== ids.length || ids.includes('auto')) {
    ctx.addIssue({ code: 'custom', path: ['models'], message: 'Model IDs must be unique and cannot be auto' });
  }
  for (const key of ['kaneoId', 't3Id', 'key'] as const) {
    if (new Set(c.projects.map(p => p[key])).size !== c.projects.length) ctx.addIssue({ code: 'custom', message: `Duplicate project ${key}` });
  }
  const upstreams = c.projects.flatMap(p => p.upstreams.map(u => u.repo));
  if (new Set(upstreams).size !== upstreams.length) ctx.addIssue({ code: 'custom', message: 'Each upstream repository can be watched by only one project' });
  if (upstreams.length && !c.upstream) ctx.addIssue({ code: 'custom', path: ['upstream'], message: 'Watched upstreams need upstream.promptFile' });
  const u = new URL(c.t3.url);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    ctx.addIssue({ code: 'custom', message: 'T3 must be a loopback HTTP(S) endpoint on this Mac' });
  }
}));
export type Config = z.infer<typeof configSchema>;
export type Project = Config['projects'][number];
export type ModelPreset = Config['models'][number];
export function configuredModel(c: Pick<Config, 'models'>, id: string): ModelPreset {
  const selected = c.models.find(p => p.id === id);
  if (!selected) throw new Error(`Model ${id} is not configured`);
  return selected;
}
export const defaultConfigPath = resolve(homedir(), '.config/t3-factory/config.jsonc');
export function loadConfig(path = process.env.T3_FACTORY_CONFIG ?? defaultConfigPath): Config {
  const errors: ParseError[] = [];
  const data = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Invalid JSONC: ${errors.map(e => `${printParseErrorCode(e.error)} at ${e.offset}`).join(', ')}`);
  return configSchema.parse(data);
}
