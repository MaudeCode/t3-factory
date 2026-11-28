import { runManualRequest } from './manual-request.ts';
import { manageCleanup, cleanupRequestSchema, readCleanupCatalog } from './cleanup.ts';
import { readFileSync, existsSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parse } from 'jsonc-parser';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, defaultConfigPath } from './config.ts';
import { Store, jobLabel, planTickets } from './store.ts';
import { cycle, log, safeError, stopJob, dismissDeletedJob, cancelPlan, setPlanOverrides, orderPlans, readStatus, readCachedStatus } from './scheduler.ts';
import { FactoryService } from './service.ts';
import { callControl, commandFor, dispatchOptions } from './control.ts';
import { codexApprovalCommand } from './codex-approval.ts';
import { dismissSessionTicket } from './session-tickets.ts';
import { saveSettings, editConfig } from './settings.ts';
import type { CycleOptions } from './scheduler.ts';
import { z, ZodError } from 'zod';
import { T3, Kanvil } from './clients.ts';
import { ticketDetail, epicDetail } from './ticket-detail.ts';
import { createFactoryWeb, runFactory, webSettings } from './web.ts';
import { serveMcp } from './mcp.ts';
import { CowtailNotifier, cowtailSettings } from './cowtail.ts';
import { runtimeVersion } from './version.ts';

import { loadEnvironment } from './env.ts';
import { milestoneHooks } from './milestones.ts';
import { createOidc } from './oidc.ts';

loadEnvironment();
process.umask(0o077);
const command = process.argv[2] ?? 'status';
const configPath = process.env.T3_FACTORY_CONFIG ?? defaultConfigPath;
// Config switches the CLI and web toggles flip.
const switches: Record<string, { path: string[]; value: boolean; message: string }> = {
  pause: { path: ['enabled'], value: false, message: 'New dispatches paused. Existing T3 jobs continue.' },
  resume: { path: ['enabled'], value: true, message: 'New dispatches enabled; quota and idle gates still apply.' },
  'queue-pause': { path: ['queue', 'enabled'], value: false, message: 'Queued runs held. Running jobs continue.' },
  'queue-resume': { path: ['queue', 'enabled'], value: true, message: 'Queued runs start again; run limits still apply.' },
  'upstream-pause': { path: ['upstream', 'enabled'], value: false, message: 'New upstream reviews paused. Running reviews continue.' },
  'upstream-resume': { path: ['upstream', 'enabled'], value: true, message: 'Upstream reviews enabled; quota and run limits still apply.' },
  'repair-pause': { path: ['repair', 'enabled'], value: false, message: 'New CI repairs paused. Running repairs continue.' },
  'repair-resume': { path: ['repair', 'enabled'], value: true, message: 'CI repairs enabled; the cooldown, quota and run limits still apply.' },
  'triage-pause': { path: ['triage', 'enabled'], value: false, message: 'Inbox triage paused. A running report finishes.' },
  'triage-resume': { path: ['triage', 'enabled'], value: true, message: 'Inbox triage enabled; the Claude quota reserve still applies.' },
};
// A section switch needs its section; the message names what is missing.
// Sections that need a prompt in the file before their switch means anything. Repairs default theirs, so they are not here.
const sections: Record<string, string> = { upstream: 'No upstream reviews are configured', triage: 'No inbox triage is configured' };
if (command === 'web') {
  const { config, secret, oidc } = webSettings();
  const c = loadConfig(configPath), store = new Store(c.stateDir), version = runtimeVersion(join(import.meta.dirname, '..'));
  // A run stores its ticket's title from dispatch on. Earlier runs borrow one from the plans and session tickets that named
  // their ticket. ponytail: re-read at most every 30 s; drop the lookup once runs without a stored title have aged out.
  let titles = new Map<string, string>(), titlesAt = 0;
  const knownTitle = (taskId: string | null) => {
    if (!taskId) return undefined;
    if (Date.now() - titlesAt > 30_000) {
      titles = new Map([...store.sessionTickets().map(t => [t.taskId, t.title] as const), ...store.plans().flatMap(p => planTickets(p).map(t => [t.id, t.title] as const))]);
      titlesAt = Date.now();
    }
    return titles.get(taskId);
  };
  const compact = (j: any) => ({ id: j.id, historyOnly: j.historyOnly, taskId: j.taskId, title: j.title || j.reconcile?.title || knownTitle(j.taskId), projectId: j.projectId, ticketKey: j.ticketKey, kind: j.kind, upstream: j.upstream, repair: j.repair, label: jobLabel(j), state: j.state, reason: j.reason, createdAt: j.createdAt, completedAt: j.completedAt, dismissedAt: j.dismissedAt, threadId: j.threadId, thread: j.thread, workspaceCleanup: j.workspaceCleanup, workspaceCleanedAt: j.workspaceCleanedAt, workspaceCleanupError: j.workspaceCleanupError, workspaceCleanupBlockedAt: j.workspaceCleanupBlockedAt, prUrls: j.prUrls, modelSelection: j.modelSelection, modelReason: j.modelReason, providerDriver: j.providerDriver, difficulty: j.difficulty, labels: j.labels, priority: j.priority, lastExecutionAt: j.lastExecutionAt, lastPersonalActivity: j.lastPersonalActivity });
  // Dispatches and stops go straight to the running scheduler; without one, the CLI does the work.
  const viaService = async (args: string[], input?: unknown) => {
    const command = args[0] === 'cleanup' ? { type: 'cleanup' as const, input: cleanupRequestSchema.parse(input), operator: args[1] } : commandFor(args);
    return (command && await callControl(c.stateDir, command)) ?? runFactory(args, input);
  };
  let inventoryRefresh: Promise<unknown> | undefined, inventoryError: string | undefined;
  let cachedStatus: ReturnType<typeof readCachedStatus> | undefined;
  let cachedConfig: ReturnType<typeof loadConfig> | undefined, configJSON: string | undefined;
  let compactSource: NonNullable<typeof cachedStatus>['status']['jobs'] | undefined;
  let refreshRequested = false;
  let compactJobs: ReturnType<typeof compact>[] = [];
  const hooks = milestoneHooks(store, () => loadConfig(configPath), config.publicOrigin);
  const leases = new AbortController();
  store.onEvent = new CowtailNotifier(store, () => cowtailSettings(loadConfig(configPath))).notify;
  const server = createFactoryWeb({ config, secret, milestone: hooks.receive, oidc: oidc ? await createOidc(oidc, config.publicOrigin, undefined, Date.now, join(c.stateDir, "web-sessions.json")) : undefined, dataDir: c.stateDir, run: viaService,
    readState: () => {
      refreshRequested = true;
      const current = loadConfig(configPath), serialized = JSON.stringify(current);
      if (serialized !== configJSON) {
        cachedConfig = current;
        configJSON = serialized;
        cachedStatus = undefined;
      }
      cachedStatus = readCachedStatus(cachedConfig!, store, cachedStatus);
      const { status } = cachedStatus;
      if (status.jobs !== compactSource) {
        compactSource = status.jobs;
        compactJobs = status.jobs.map(compact);
      }
      refreshRequested = false;
      return { config: cachedConfig!, status: { ...status, jobs: compactJobs }, version, now: new Date().toISOString() };
    },
    cleanupInventory: input => {
      const current = loadConfig(configPath), data = readCleanupCatalog(current, store, input.offset, input.limit, input);
      if ((input.refresh || !data.checkedAt) && !inventoryRefresh) {
        inventoryError = undefined;
        inventoryRefresh = viaService(['cleanup'], input).then(result => { if (result.code) inventoryError = safeError(result.data?.message ?? 'Inventory refresh failed'); }).catch(error => { inventoryError = safeError(error); }).finally(() => { inventoryRefresh = undefined; });
      }
      return { ...data, errors: inventoryError ? [...data.errors, { repository: 'Inventory', message: inventoryError }] : data.errors, refreshing: !inventoryError && (data.refreshing || !!input.refresh) };
    },
    history: (after) => {
      if (after === undefined) return store.history().map(compact).toReversed();
      const { jobs, changed } = store.historySince(after);
      return { jobs: jobs.map(compact).toReversed(), cursor: new Date(changed).toISOString() };
    },
    threadLink: (id) => new T3(loadConfig(configPath).t3).threadLink(id),
    report: (id) => {
      const job = store.job(id);
      if (!job) return undefined;
      const pending = job.thread?.pendingId;
      const resolvedInputId = pending && store.inputResolved(id, pending) ? pending : undefined;
      return { job: compact(job), resolvedInputId, events: store.events(200, id).sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.id - b.id), report: existsSync(job.reportPath) ? JSON.parse(readFileSync(job.reportPath, 'utf8')) : null };
    },
    // Runs only while a page is subscribed: the scheduler's writes show in the Store's data version, settings in the config file.
    watch: (notify) => {
      const stopStore = store.watch(notify, 1000, () => refreshRequested || (cachedStatus?.expiresAt ?? 0) <= Date.now());
      const config = watch(dirname(configPath), (_, name) => { if (!name || name === basename(configPath)) refreshRequested = true; });
      return () => { stopStore(); config.close(); };
    },
  });
  server.listen(config.port, config.host, () => {
    console.log(`Factory web controls listening on ${config.host}:${config.port}`);
    void hooks.follow(leases.signal);
  });
  const shutdown = () => { leases.abort(); server.closeAllConnections(); server.close(); store.close(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
} else if (command === 'cleanup-cancel') {
  const c = loadConfig(configPath);
  const result = await callControl(c.stateDir, { type: 'cleanup-cancel', inspectionId: z.uuid().parse(process.argv[3]) });
  console.log(JSON.stringify(result?.data ?? { cancelled: false }));
} else if (command === 'cleanup') {
  let store: Store | undefined, kanvil: Kanvil | undefined;
  try {
    const input = cleanupRequestSchema.parse(JSON.parse(readFileSync(0, 'utf8'))), c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'cleanup', input, operator: process.argv[3] });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else {
      store = new Store(c.stateDir);
      if (!store.claim()) throw new Error('Scheduler owns this state directory but is not answering; cleanup refused');
      const lazy = { task: async (id: string) => { if (!kanvil) { kanvil = new Kanvil(c.kanvil, c.projects); await kanvil.connect(); } return kanvil.task(id); } } as Kanvil;
      console.log(JSON.stringify(await manageCleanup(c, store, new T3(c.t3), lazy, input, process.argv[3] ?? 'local CLI operator')));
    }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
  finally { await kanvil?.close().catch(() => {}); store?.close(); }
} else if (command === 'job-stop') {
  // The running scheduler stops the thread and reconciles at once; otherwise stop it here and leave reconciliation to the next pass.
  try {
    const c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'job-stop', jobId: process.argv[3] ?? '' });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else {
      const store = new Store(c.stateDir);
      const result = await stopJob(c, store, new T3(c.t3), process.argv[3] ?? '');
      store.close();
      console.log(JSON.stringify(result));
    }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'job-dismiss') {
  // The running scheduler dismisses through its writer. Without one, this process claims the state directory first;
  // a request the scheduler took and never answered is reported, never repeated here.
  let store: Store | undefined, kanvil: Kanvil | undefined;
  try {
    const c = loadConfig(configPath), owner = commandFor(process.argv.slice(2));
    if (owner?.type !== 'job-dismiss') throw new Error('Usage: t3-factory job-dismiss JOB_ID [--reset-ticket]');
    const forwarded = await callControl(c.stateDir, owner);
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else {
      store = new Store(c.stateDir);
      if (!store.claim()) throw new Error('Scheduler owns this state directory but is not answering; dismissal refused');
      const connect = async () => { if (!kanvil) { kanvil = new Kanvil(c.kanvil, c.projects); await kanvil.connect(); } return kanvil; };
      console.log(JSON.stringify(await dismissDeletedJob(c, store, new T3(c.t3), connect, owner.jobId, owner.resetTicket)));
    }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
  finally { await kanvil?.close().catch(() => {}); store?.close(); }
} else if (command === 'plan-cancel') {
  try {
    const c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'plan-cancel', planId: process.argv[3] ?? '' });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else { const store = new Store(c.stateDir); console.log(JSON.stringify(cancelPlan(store, process.argv[3] ?? ''))); store.close(); }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'plan-order') {
  // Set which active queued runs, chains and Epics get free slots first.
  try {
    const c = loadConfig(configPath), owner = commandFor(process.argv.slice(2));
    if (owner?.type !== 'plan-order') throw new Error('Usage: t3-factory plan-order PLAN_ID...');
    const forwarded = await callControl(c.stateDir, owner);
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else { const store = new Store(c.stateDir); console.log(JSON.stringify(orderPlans(store, owner.planIds))); store.close(); }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'plan-override') {
  // Change the limits an active chain or Epic overrides; no flag means it respects them all from here on.
  try {
    const c = loadConfig(configPath), owner = commandFor(process.argv.slice(2));
    if (owner?.type !== 'plan-override') throw new Error('Usage: t3-factory plan-override PLAN_ID [--override-limits | --override idle,reserve,labels,providers]');
    const forwarded = await callControl(c.stateDir, owner);
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else { const store = new Store(c.stateDir); console.log(JSON.stringify(setPlanOverrides(store, owner.planId, owner.overrideLimits))); store.close(); }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'session-dismiss') {
  try {
    const c = loadConfig(configPath);
    const forwarded = await callControl(c.stateDir, { type: 'session-dismiss', taskId: process.argv[3] ?? '' });
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else { const store = new Store(c.stateDir); console.log(JSON.stringify(dismissSessionTicket(store, process.argv[3] ?? ''))); store.close(); }
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'triage-run') {
  // Triage now: one forced pass in the running scheduler, past the pause and the quota reserve.
  const forwarded = await callControl(loadConfig(configPath).stateDir, { type: 'triage-run' });
  console.log(JSON.stringify(forwarded?.data ?? { message: 'The scheduler is not running. Start it to triage reports.' }));
  process.exitCode = forwarded?.code ?? 1;
} else if (command === 'triage-retry' || command === 'triage-close' || command === 'triage-promote') {
  // The owner's decision on one open inbox report, by its tracker ticket ID.
  const owner = commandFor(process.argv.slice(2)), forwarded = owner ? await callControl(loadConfig(configPath).stateDir, owner) : null;
  console.log(JSON.stringify(forwarded?.data ?? { message: owner ? 'The scheduler is not running. Start it to change reports.' : `Usage: t3-factory ${command} TICKET_ID [--override-limits]` }));
  process.exitCode = forwarded?.code ?? 1;
} else if (command === 'ticket' || command === 'epic') {
  // Ticket reads may reuse the scheduler; Epic reads stay compatible with older control sockets.
  try {
    const c = loadConfig(configPath), key = process.argv[3] ?? '';
    const forwarded = command === 'ticket' ? await callControl(c.stateDir, { type: 'ticket', key }) : null;
    if (forwarded) { console.log(JSON.stringify(forwarded.data)); process.exitCode = forwarded.code; }
    else {
      const kanvil = new Kanvil(c.kanvil, c.projects);
      try {
        await kanvil.connect();
        const detail = await (command === 'epic' ? epicDetail : ticketDetail)(c, kanvil, key);
        console.log(JSON.stringify(detail ?? { notFound: true, message: `${command === 'epic' ? 'Epic' : 'Ticket'} not found` }));
        process.exitCode = detail ? 0 : 1;
      } finally { await kanvil.close(); }
    }
  } catch (e) { console.log(JSON.stringify({ message: safeError(e) })); process.exitCode = 1; }
} else if (command === 'mcp') {
  serveMcp(loadConfig(configPath).stateDir, () => loadConfig(configPath));
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
  // Catalogs the settings pages pick from: T3 projects, Kanvil projects with their columns, and workspace labels.
  const c = loadConfig(configPath), kanvil = new Kanvil(c.kanvil, c.projects);
  try {
    const t3 = z.object({ projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }).passthrough()) }).parse(await new T3(c.t3).request('/api/orchestration/shell')).projects;
    await kanvil.connect();
    const workspaces = await kanvil.workspaces();
    const projects = await kanvil.projects(true);
    const labels = await kanvil.labels(projects);
    const columns = await Promise.all(projects.map(async p => [p.id, await kanvil.columns(p.id)] as const));
    console.log(JSON.stringify({
      t3: t3.map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })),
      kanvil: {
        workspaces,
        projects: projects.map(p => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, slug: p.slug, githubRepo: p.description?.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\s.,;)]|$)/)?.[1] ?? null })),
        columns: Object.fromEntries(columns),
        labels: labels,
      },
    }));
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; } finally { await kanvil.close().catch(() => {}); }
} else if (command === 'cowtail-test') {
  // The Settings test button: one push through the configured Cowtail source, whatever the per-event settings say.
  try {
    const outcome = await new CowtailNotifier({ job: () => undefined }, () => cowtailSettings(loadConfig(configPath))).test();
    console.log(JSON.stringify(outcome));
    if (!outcome.ok && !('reason' in outcome)) process.exitCode = 1;
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
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
  if (sections[path[0]] && !parse(text, [], { allowTrailingComma: true })?.[path[0]]) {
    console.error(sections[path[0]]); process.exitCode = 1;
  } else {
    editConfig(configPath, [[path, value]]);
    console.log(message);
  }
} else if (command === 'status') {
  const c = loadConfig(configPath), store = new Store(c.stateDir);
  console.log(JSON.stringify(readStatus(c, store), null, 2)); store.close();
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
  let decide: ReturnType<Store['decisionRecorder']> | undefined;
  try {
    const c = loadConfig(configPath);
    store = new Store(c.stateDir);
    let claimed = store.claim();
    for (let retry = 0; !claimed && options.manual && retry < 20 && !stop; retry++) {
      await delay(500); claimed = store.claim();
    }
    if (!claimed) { store.close(); store = undefined; throw new Error('The scheduler is busy and not answering on its control socket. Try again shortly.'); }
    if (!(options.manual && options.dryRun)) decide = store.decisionRecorder({ workKind: 'tickets', manual: options.manual });
    const result = options.manual
      ? (await runManualRequest(c, store, options, async (work, _foreground, meta) => { await meta.context.run(() => work(0)); }, opts => cycle(c, store!, opts, { decide }))).data
      : await cycle(c, store, options, { decide });
    if (options.doctor && (result as { triageSandbox?: { ok: boolean } }).triageSandbox?.ok === false) process.exitCode = 1;
    if (options.manual) {
      log('decision', result as Record<string, unknown>);
      if (!['dispatched', 'would-dispatch', 'plan-started'].includes((result as { reason: string }).reason)) process.exitCode = 1;
    }
  } catch (e) {
    const message = safeError(e); log('error', { message });
    if (store && !(options.manual && options.dryRun)) {
      (decide ?? store.decisionRecorder({ workKind: 'tickets', manual: options.manual }))({ reason: 'error', message, at: new Date().toISOString() });
    }
    process.exitCode = 1;
  } finally { store?.close(); }
  }
} else {
  console.error('Usage: t3-factory status | doctor | once [--dry-run] | run | pause | resume | queue-pause | queue-resume | upstream-pause | upstream-resume | repair-pause | repair-resume | triage-pause | triage-resume | triage-run | triage-retry TICKET_ID [--override-limits] | triage-promote TICKET_ID [--override-limits] | triage-close TICKET_ID | ticket KEY | epic EPIC_ID | config-get | config-save | model-catalog | sources | cowtail-test | web | web-pair | mcp | job-stop JOB_ID | job-dismiss JOB_ID [--reset-ticket] | plan-cancel PLAN_ID | plan-order PLAN_ID... | plan-override PLAN_ID [--override-limits | --override idle,reserve,labels,providers] | session-dismiss TASK_ID | dispatch [--ticket KEY | --upstream OWNER/REPO | --epic EPIC_ID] [--model auto|MODEL_ID] [--provider codex|claudeAgent] [--override-limits | --override idle,reserve,labels,providers] [--chain first|all] [--dry-run]');
  process.exitCode = 2;
}
