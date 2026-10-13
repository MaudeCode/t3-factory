import { readFileSync, writeFileSync, renameSync, existsSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { modify, applyEdits, parse } from 'jsonc-parser';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, defaultConfigPath } from './config.ts';
import { Store, jobLabel } from './store.ts';
import { cycle, log, safeError, writeStatus } from './scheduler.ts';
import { codexApprovalCommand } from './codex-approval.ts';
import { saveSettings } from './settings.ts';
import type { CycleOptions } from './scheduler.ts';
import { z, ZodError } from 'zod';
import { T3, Kaneo } from './clients.ts';
import { createFactoryWeb, webSettings } from './web.ts';

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
  const compact = (j: any) => ({ id: j.id, taskId: j.taskId, projectId: j.projectId, ticketKey: j.ticketKey, kind: j.kind, upstream: j.upstream, label: jobLabel(j), state: j.state, reason: j.reason, createdAt: j.createdAt, completedAt: j.completedAt, dismissedAt: j.dismissedAt, threadId: j.threadId, thread: j.thread, prUrls: j.prUrls, modelSelection: j.modelSelection, modelReason: j.modelReason, providerDriver: j.providerDriver, difficulty: j.difficulty, lastExecutionAt: j.lastExecutionAt, lastPersonalActivity: j.lastPersonalActivity });
  const server = createFactoryWeb({ config, secret, oidc: oidc ? await createOidc(oidc, config.publicOrigin, undefined, Date.now, join(c.stateDir, "web-sessions.json")) : undefined, dataDir: c.stateDir,
    readState: () => {
      const config = loadConfig(configPath), file = join(config.stateDir, 'status.json');
      const status = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { jobs: [], streams: [] };
      const jobs = (status.jobs ?? []).filter((j: any) => j.state !== 'dismissed');
      status.jobs = [...jobs.filter((j: any) => j.state !== 'complete'), ...jobs.filter((j: any) => j.state === 'complete').slice(-30)].map(compact);
      status.journal = store.events(80);
      return { config, status, now: new Date().toISOString() };
    },
    history: () => store.jobs().map(compact).toReversed(),
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
  const shutdown = () => { server.close(); store.close(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
} else if (command === 'job-stop') {
  // Ask T3 to stop a run's thread. The next scheduler cycle reconciles the job state from T3.
  try {
    const c = loadConfig(configPath), store = new Store(c.stateDir), job = store.job(process.argv[3] ?? '');
    if (!job || ['complete', 'dismissed'].includes(job.state)) throw new Error('That run is not active');
    await new T3(c.t3).dispatch({ type: 'thread.stop', commandId: randomUUID(), threadId: job.threadId, reason: 'Stopped from the factory web app' });
    job.reason = 'Stop requested from the web app; waiting for T3 to confirm'; store.save(job);
    store.record('job.stop', `${jobLabel(job)} stop requested`, { ticketKey: job.ticketKey, projectId: job.projectId }, job.id);
    writeStatus(c, store); store.close();
    console.log(JSON.stringify({ ok: true, jobId: job.id }));
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
} else if (['doctor', 'once', 'run', 'dispatch'].includes(command)) {
  const options: CycleOptions = { dryRun: process.argv.includes('--dry-run'), doctor: command === 'doctor', manual: command === 'dispatch', overrideLimits: process.argv.includes('--override-limits'), allowMissingReadyLabel: process.argv.includes('--allow-missing-ready-label') };
  if (command === 'dispatch') {
    const args = process.argv.slice(3);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ticket') options.ticket = args[++i];
      else if (args[i] === '--model') {
        const value = args[++i];
        if (!/^[a-z][a-z0-9-]*$/.test(value ?? '')) throw new Error('--model requires auto or a configured model ID');
        options.model = value as CycleOptions['model'];
      } else if (!['--override-limits', '--dry-run', '--allow-missing-ready-label'].includes(args[i])) throw new Error(`Unknown dispatch argument: ${args[i]}`);
    }
    if (args.includes('--ticket') && !options.ticket) throw new Error('--ticket requires a ticket key');
  }
  let stop = false;
  const signal = new AbortController();
  process.once('SIGTERM', () => { stop = true; signal.abort(); });
  process.once('SIGINT', () => { stop = true; signal.abort(); });
  let configuredStateDir: string | undefined;
  do {
    let store: Store | undefined;
    let seconds = 60;
    try {
      const c = loadConfig(configPath);
      if (configuredStateDir && configuredStateDir !== c.stateDir) throw new Error('stateDir changed while running; restart the service for a deliberate state migration');
      configuredStateDir = c.stateDir; seconds = c.pollSeconds;
      store = new Store(c.stateDir);
      let claimed = store.claim();
      for (let retry = 0; !claimed && options.manual && retry < 20 && !stop; retry++) {
        await delay(500); claimed = store.claim();
      }
      if (!claimed) { store.close(); store = undefined; throw new Error('Another scheduler cycle is checking the queue. Try again shortly.'); }
      const result = await cycle(c, store, options);
      if (options.manual && !['dispatched', 'would-dispatch'].includes(result.reason)) process.exitCode = 1;
      writeStatus(c, store);
    } catch (e) {
      const message = safeError(e); log('error', { message });
      if (store) {
        store.decide({ reason: 'error', message, at: new Date().toISOString() });
        try { writeStatus(loadConfig(configPath), store); } catch { /* Invalid config is already logged. */ }
      }
      if (command !== 'run') process.exitCode = 1;
    } finally { store?.close(); }
    if (command !== 'run' || stop) break;
    await delay(seconds * 1000, undefined, { signal: signal.signal }).catch(() => {});
  } while (!stop);
} else {
  console.error('Usage: t3-factory status | doctor | once [--dry-run] | run | pause | resume | upstream-pause | upstream-resume | config-get | config-save | model-catalog | sources | web | web-pair | job-stop JOB_ID | dispatch [--ticket KEY] [--model auto|MODEL_ID] [--override-limits] [--allow-missing-ready-label] [--dry-run]');
  process.exitCode = 2;
}
