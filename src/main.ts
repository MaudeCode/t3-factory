import { manageCleanup, cleanupRequestSchema } from './cleanup.ts';
import { readFileSync, writeFileSync, renameSync, existsSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { modify, applyEdits, parse } from 'jsonc-parser';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, defaultConfigPath } from './config.ts';
import { Store, jobLabel } from './store.ts';
import { cycle, log, safeError, stopJob, cancelPlan, writeStatus } from './scheduler.ts';
import { FactoryService } from './service.ts';
import { callControl, commandFor, dispatchOptions } from './control.ts';
import { codexApprovalCommand } from './codex-approval.ts';
import { dismissSessionTicket } from './session-tickets.ts';
import { saveSettings } from './settings.ts';
import type { CycleOptions } from './scheduler.ts';
import { z, ZodError } from 'zod';
import { T3, Kaneo } from './clients.ts';
import { createFactoryWeb, runFactory, webSettings } from './web.ts';

import { loadEnvironment } from './env.ts';
import { createOidc } from './oidc.ts';

loadEnvironment();
process.umask(0o077);
const command = process.argv[2] ?? 'status';
const configPath = process.env.T3_FACTORY_CONFIG ?? defaultConfigPath;
// Config switches the CLI and web toggles flip.
const switches: Record<string, { path: string[]; value: boolean; message: string }> = {
  pause: { path: ['enabled'], value: false, message: 'New dispatches paused. Existing T3 jobs continue.' },
  resume: { path: ['enabled'], value: true, message: 'New dispatches enabled; quota and idle gates still apply.' },
  'upstream-pause': { path: ['upstream', 'enabled'], value: false, message: 'New upstream reviews paused. Running reviews continue.' },
  'upstream-resume': { path: ['upstream', 'enabled'], value: true, message: 'Upstream reviews enabled; quota and run limits still apply.' },
};
if (command === 'web') {
  const { config, secret, oidc } = webSettings();
  const c = loadConfig(configPath), store = new Store(c.stateDir);
  const compact = (j: any) => ({ id: j.id, taskId: j.taskId, projectId: j.projectId, ticketKey: j.ticketKey, kind: j.kind, upstream: j.upstream, label: jobLabel(j), state: j.state, reason: j.reason, createdAt: j.createdAt, completedAt: j.completedAt, dismissedAt: j.dismissedAt, threadId: j.threadId, thread: j.thread, workspaceCleanup: j.workspaceCleanup, workspaceCleanedAt: j.workspaceCleanedAt, workspaceCleanupError: j.workspaceCleanupError, workspaceCleanupBlockedAt: j.workspaceCleanupBlockedAt, prUrls: j.prUrls, modelSelection: j.modelSelection, modelReason: j.modelReason, providerDriver: j.providerDriver, difficulty: j.difficulty, labels: j.labels, priority: j.priority, lastExecutionAt: j.lastExecutionAt, lastPersonalActivity: j.lastPersonalActivity });
  // Dispatches and stops go straight to the running scheduler; without one, the CLI does the work.
  const viaService = async (args: string[], input?: unknown) => {
    const command = args[0] === 'cleanup' ? { type: 'cleanup' as const, input: cleanupRequestSchema.parse(input), operator: args[1] } : commandFor(args);
    return (command && await callControl(c.stateDir, command)) ?? runFactory(args, input);
  };
  const server = createFactoryWeb({ config, secret, oidc: oidc ? await createOidc(oidc, config.publicOrigin, undefined, Date.now, join(c.stateDir, "web-sessions.json")) : undefined, dataDir: c.stateDir, run: viaService,
    readState: () => {
      const config = loadConfig(configPath), file = join(config.stateDir, 'status.json');
      const status = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { jobs: [], streams: [] };
      const jobs = (status.jobs ?? []).filter((j: any) => j.state !== 'dismissed');
      status.jobs = [...jobs.filter((j: any) => j.state !== 'complete'), ...jobs.filter((j: any) => j.state === 'complete').slice(-30)].map(compact);
      status.journal = store.events(80);
      return { config, status, now: new Date().toISOString() };
    },
    history: () => store.jobs().map(compact).toReversed(),
    threadLink: (id) => new T3(loadConfig(configPath).t3).threadLink(id),
    report: (id) => {
      const job = store.job(id);
      if (!job) return undefined;
      return { job: compact(job), events: store.events(200, id).toReversed(), report: existsSync(job.reportPath) ? JSON.parse(readFileSync(job.reportPath, 'utf8')) : null };
    },
    watch: (notify) => {
      const watchers = [watch(c.stateDir, (_, name) => { if (name === 'status.json') notify(); }), watch(dirname(configPath), (_, name) => { if (name === basename(configPath)) notify(); })];
      return () => { for (const w of watchers) w.close(); };
    },
  });
  server.listen(config.port, config.host, () => console.log(`Factory web controls listening on ${config.host}:${config.port}`));
  const shutdown = () => { server.closeAllConnections(); server.close(); store.close(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
} else if (command === 'cleanup-cancel') {
  const c = loadConfig(configPath);
  const result = await callControl(c.stateDir, { type: 'cleanup-cancel', inspectionId: z.uuid().parse(process.argv[3]) });
  console.log(JSON.stringify(result?.data ?? { cancelled: false }));
} else if (command === 'cleanup') {
  let store: Store | undefined, kaneo: Kaneo | undefined;
  try {
    const input = cleanupRequestSchema.parse(JSON.parse(readFileSync(0, 'utf8'))), c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'cleanup', input, operator: process.argv[3] });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else {
      store = new Store(c.stateDir);
      if (!store.claim()) throw new Error('Scheduler owns this state directory but is not answering; cleanup refused');
      const lazy = { call: async (tool: string, args: any) => { if (!kaneo) { kaneo = new Kaneo(c.kaneo); await kaneo.connect(); } return kaneo.call(tool, args); } } as Kaneo;
      console.log(JSON.stringify(await manageCleanup(c, store, new T3(c.t3), lazy, input, process.argv[3] ?? 'local CLI operator')));
      if (!['inventory', 'inspect', 'review'].includes(input.type)) writeStatus(c, store);
    }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
  finally { await kaneo?.close().catch(() => {}); store?.close(); }
} else if (command === 'job-stop') {
  // The running scheduler stops the thread and reconciles at once; otherwise stop it here and leave reconciliation to the next pass.
  try {
    const c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'job-stop', jobId: process.argv[3] ?? '' });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else {
      const store = new Store(c.stateDir);
      const result = await stopJob(c, store, new T3(c.t3), process.argv[3] ?? '');
      writeStatus(c, store); store.close();
      console.log(JSON.stringify(result));
    }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'plan-cancel') {
  try {
    const c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'plan-cancel', planId: process.argv[3] ?? '' });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else { const store = new Store(c.stateDir); console.log(JSON.stringify(cancelPlan(store, process.argv[3] ?? ''))); writeStatus(c, store); store.close(); }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'session-dismiss') {
  try {
    const c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'session-dismiss', taskId: process.argv[3] ?? '' });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else { const store = new Store(c.stateDir); console.log(JSON.stringify(dismissSessionTicket(store, process.argv[3] ?? ''))); writeStatus(c, store); store.close(); }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'web-pair') {
  try {
    const { config, secret, oidc } = webSettings();
    if (oidc) throw new Error('Pairing is disabled. Open the public address and sign in with SSO.');
    const result = await fetch(`http://${config.host}:${config.port}/api/pair`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
    if (!result.ok) throw new Error('Could not create a pairing link. Check that the web service is running.');
    console.log(JSON.stringify(await result.json()));
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'model-catalog') {
  try {
    const providers = await new T3(loadConfig(configPath).t3).providers();
    console.log(JSON.stringify({ providers: providers.filter(p => ['claudeAgent', 'codex'].includes(p.driver)).map(({ instanceId, driver, status, enabled, installed, models }) => ({ instanceId, driver, status, enabled, installed, models })) }));
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'sources') {
  // Catalogs the settings pages pick from: T3 projects, Kaneo projects with their columns, and workspace labels.
  const c = loadConfig(configPath), kaneo = new Kaneo(c.kaneo);
  try {
    const t3 = z.object({ projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }).passthrough()) }).parse(await new T3(c.t3).request('/api/orchestration/shell')).projects;
    await kaneo.connect();
    const projects = z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), description: z.string().nullish(), archivedAt: z.string().nullish() }).passthrough()).parse(await kaneo.call('list_projects', { workspaceId: c.kaneo.workspaceId })).filter(p => !p.archivedAt);
    const labels = z.array(z.object({ name: z.string().min(1), deletionStartedAt: z.string().nullish() }).passthrough()).parse(await kaneo.call('list_workspace_labels', { workspaceId: c.kaneo.workspaceId }));
    const column = z.object({ slug: z.string(), name: z.string(), isFinal: z.boolean(), position: z.number() }).passthrough();
    const columns = await Promise.all(projects.map(async p => [p.id, z.array(column).parse(await kaneo.call('list_project_columns', { projectId: p.id })).sort((a, b) => a.position - b.position).map(({ slug, name, isFinal }) => ({ slug, name, isFinal }))] as const));
    console.log(JSON.stringify({
      t3: t3.map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })),
      kaneo: {
        projects: projects.map(p => ({ id: p.id, name: p.name, slug: p.slug, githubRepo: p.description?.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\s.,;)]|$)/)?.[1] ?? null })),
        columns: Object.fromEntries(columns),
        labels: [...new Set(labels.filter(l => !l.deletionStartedAt).map(l => l.name))].sort(),
      },
    }));
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; } finally { await kaneo.close().catch(() => {}); }
} else if (command === 'config-get' || command === 'config-save') {
  try {
    const result = command === 'config-get' ? loadConfig(configPath) : saveSettings(JSON.parse(readFileSync(0, 'utf8')), configPath);
    console.log(JSON.stringify(result));
  } catch (e) { console.error(e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : safeError(e)); process.exitCode = 1; }
} else if (command === 'approval-record' || command === 'approval-check') {
  try {
    const [, , , repository, number, file] = process.argv;
    if (!repository || !number || !file) throw new Error('Usage: t3-factory approval-record|approval-check owner/repo PR_NUMBER PROOF_FILE');
    const result = await codexApprovalCommand(command, repository, number, file);
    console.log(JSON.stringify(result));
    if ('approved' in result && !result.approved) process.exitCode = 1;
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (Object.hasOwn(switches, command)) {
  const { path, value, message } = switches[command];
  const text = readFileSync(configPath, 'utf8');
  if (path[0] === 'upstream' && !parse(text, [], { allowTrailingComma: true })?.upstream) {
    console.error('No upstream reviews are configured'); process.exitCode = 1;
  } else {
    const next = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    writeFileSync(`${configPath}.tmp`, next, { mode: 0o600 }); renameSync(`${configPath}.tmp`, configPath);
    console.log(message);
  }
} else if (command === 'status') {
  const c = loadConfig(configPath), store = new Store(c.stateDir);
  console.log(JSON.stringify(writeStatus(c, store), null, 2)); store.close();
} else if (command === 'run') {
  const service = new FactoryService(configPath);
  const shutdown = () => { service.stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try { await service.start(); } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (['doctor', 'once', 'dispatch'].includes(command)) {
  const options: CycleOptions = command === 'dispatch' ? dispatchOptions(process.argv.slice(3)) : { dryRun: process.argv.includes('--dry-run'), doctor: command === 'doctor' };
  // A running scheduler runs dispatches, checks, dry runs, and diagnostics itself, so they never wait on its store claim.
  const forwarded = await callControl(loadConfig(configPath).stateDir, commandFor(process.argv.slice(2))!);
  if (forwarded) {
    log('decision', forwarded.data as Record<string, unknown>);
    process.exitCode = forwarded.code;
  } else {
  let stop = false;
  process.once('SIGTERM', () => { stop = true; });
  process.once('SIGINT', () => { stop = true; });
  let store: Store | undefined;
  try {
    const c = loadConfig(configPath);
    store = new Store(c.stateDir);
    let claimed = store.claim();
    for (let retry = 0; !claimed && options.manual && retry < 20 && !stop; retry++) {
      await delay(500); claimed = store.claim();
    }
    if (!claimed) { store.close(); store = undefined; throw new Error('The scheduler is busy and not answering on its control socket. Try again shortly.'); }
    const result = await cycle(c, store, options);
    if (options.manual && !['dispatched', 'would-dispatch', 'plan-started'].includes(result.reason)) process.exitCode = 1;
    writeStatus(c, store);
  } catch (e) {
    const message = safeError(e); log('error', { message });
    if (store) {
      store.decide({ reason: 'error', message, at: new Date().toISOString() });
      try { writeStatus(loadConfig(configPath), store); } catch { /* Invalid config is already logged. */ }
    }
    process.exitCode = 1;
  } finally { store?.close(); }
  }
} else {
  console.error('Usage: t3-factory status | doctor | once [--dry-run] | run | pause | resume | upstream-pause | upstream-resume | config-get | config-save | model-catalog | sources | web | web-pair | job-stop JOB_ID | plan-cancel PLAN_ID | session-dismiss TASK_ID | dispatch [--ticket KEY | --upstream OWNER/REPO] [--model auto|MODEL_ID] [--override-limits] [--allow-missing-ready-label] [--chain first|all] [--dry-run]');
  process.exitCode = 2;
}
