import { manageCleanup, cleanupRequestSchema, readCleanupCatalog, refreshCleanupCatalog } from './cleanup.ts';
// One ledger owner, independent operation lifecycles. Only work on the same resource is ordered.
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadConfig, type Config } from './config.ts';
import { Store } from './store.ts';
import { T3, Kanvil } from './clients.ts';
import { cycle, reconcile, refreshInventory, pendingReviews, cleanupNextWorkspace, log, safeError, stopJob, cancelPlan, writeStatus, refreshQuota, type CycleOptions, type Clients } from './scheduler.ts';
import { collectSessionTickets, dismissSessionTicket, recordSessionTicketsFailure } from './session-tickets.ts';
import { serveControl, type ControlCommand, type ControlResult } from './control.ts';
import { readOperation, savedOperations } from './operations.ts';
import { recoverOperation, runManualRequest } from './manual-request.ts';
import { ReadContext, readPhase, waitFor, backgroundRead } from './read-context.ts';
import { GitHub } from './github-client.ts';
import { inboxes, triagePass, triageQueue } from './triage.ts';
import { readModelQuota } from './models.ts';

const EVENT_SETTLE_MS = 25;
const KINDS_WITHOUT_WORK = new Set(['snapshot', 'synchronized']);

export class FactoryService {
  private store!: Store;
  private t3!: T3;
  private github?: GitHub;
  private t3Settings = '';
  private configSnapshot?: string;
  private kanvilSettings = '';
  private stream?: AbortController;
  private kanvil?: Promise<Kanvil>; // one service-owned client and subscription shared by every caller
  private control?: Server;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private settle?: NodeJS.Timeout;
  private quotaTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private cleanupQueued = false;
  private inventoryTimer?: NodeJS.Timeout;
  private inventoryQueued = false;
  private inventoryRequested = 0;
  private collectionTimer?: NodeJS.Timeout;
  private collectionQueued = false;
  private readonly inspections = new Map<string, AbortController>();
  private readonly cleanupVisited = new Set<string>();
  private readonly operations = new Map<symbol, { foreground: boolean; reason: string; context: ReadContext; id?: string; queuedAt: string; startedAt: string; done: Promise<unknown> }>();
  private readonly lanes = new Map<string, { again: boolean; done: Promise<void> }>();
  private statusTimer?: NodeJS.Timeout;
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private readonly retiredClients = new Set<T3>();
  private readonly threadWork = new Map<string, string>();
  private readonly requests = new Map<string, Promise<ControlResult>>();
  private readonly uncertainRequests = new Set<string>();
  private stopped = false;
  private shutdown?: Promise<void>;
  private readonly abort = new AbortController();
  private stateDir = '';
  private readonly configPath: string;
  private pollSeconds = 60;
  constructor(configPath: string) { this.configPath = configPath; }

  async start() {
    const c = loadConfig(this.configPath);
    this.pollSeconds = c.pollSeconds;
    this.configSnapshot = JSON.stringify(c);
    this.stateDir = c.stateDir;
    this.store = new Store(c.stateDir);
    if (!this.store.claim()) throw new Error('Another scheduler owns this state directory');
    if (!process.env.GH_HOST || process.env.GH_HOST === 'github.com') {
      this.github = new GitHub();
    }
    for (const operation of savedOperations(c.stateDir)) if (operation.command) {
      if (['running', 'uncertain'].includes(operation.state)) recoverOperation(this.stateDir, this.store, operation);
      if (operation.state === 'uncertain') this.uncertainRequests.add(operation.id);
    }
    this.store.onCleanupChange = projectIds => {
      this.scheduleInventory();
    };
    this.connectT3(c);
    this.control = serveControl(c.stateDir, (command, receivedAt) => this.handle(command, receivedAt));
    this.watcher = watch(dirname(this.configPath), (_, name) => this.onConfigChange(name));
    this.wake('start');
    this.scheduleQuota(c);
    this.eventLoop.enable();
    log('service-started', { pid: process.pid, stateDir: c.stateDir });
  }

  // macOS may deliver duplicate or delayed startup events. Only changed settings need a pass.
  private onConfigChange(name: string | null) {
    if (this.stopped || name !== basename(this.configPath)) return;
    let snapshot: string | undefined;
    try { const c = loadConfig(this.configPath); this.pollSeconds = c.pollSeconds; snapshot = JSON.stringify(c); } catch { /* A broken configuration still needs its diagnostic pass. */ }
    if (snapshot !== undefined && snapshot === this.configSnapshot) return;
    this.configSnapshot = snapshot;
    this.wake('config');
  }

  // A new T3 client and shell stream whenever the connection settings change, so an edit applies without a restart.
  private connectT3(c: Config) {
    this.stream?.abort();
    this.threadWork.clear();
    const previous = this.t3;
    if (previous) {
      this.retiredClients.add(previous);
      void Promise.allSettled([...this.operations.values()].map(item => item.done)).then(() => previous.close()).finally(() => this.retiredClients.delete(previous));
    }
    this.t3 = new T3(c.t3, { persistent: true }); this.t3Settings = JSON.stringify(c.t3);
    if (this.stopped) return;
    const stream = new AbortController(); this.stream = stream;
    this.abort.signal.addEventListener('abort', () => stream.abort(), { once: true });
    void this.t3.subscribe(item => this.onShellItem(item), stream.signal, error => log('t3-stream-error', { message: safeError(error) }));
  }
  stop() { return this.shutdown ??= this.shutdownService(); }
  private async shutdownService() {
    this.stopped = true;
    for (const controller of this.inspections.values()) controller.abort();
    this.abort.abort();
    this.github?.close();
    for (const item of this.operations.values()) if (!item.foreground) item.context.stopBackground();
    clearTimeout(this.timer); clearTimeout(this.settle); clearTimeout(this.quotaTimer); clearTimeout(this.cleanupTimer); clearTimeout(this.collectionTimer); clearTimeout(this.inventoryTimer);
    this.watcher?.close();
    await new Promise<void>(resolve => this.control ? this.control.close(() => resolve()) : resolve());
    await this.drainWork();
    await this.kanvil?.then(k => k.close()).catch(() => {});
    await this.t3.close();
    await Promise.allSettled([...this.retiredClients].map(client => client.close()));
    clearTimeout(this.statusTimer); this.eventLoop.disable();
    this.flushWork();
    this.store.close();
  }

  // Invalidate reads on every change; wake background domains only for semantic thread changes.
  private onShellItem(item: unknown) {
    if (this.stopped) return;
    const kind = item && typeof item === 'object' && 'kind' in item ? String((item as { kind: unknown }).kind) : '';
    if (kind === 'providers.updated') {
      for (const workKind of ['tickets', 'chains', 'upstream'] as const) this.scheduleAdmissions('providers', workKind);
      return;
    }
    if (KINDS_WITHOUT_WORK.has(kind)) return;
    this.t3.invalidateShell();
    if (kind === 'thread.updated' && item && typeof item === 'object' && 'thread' in item) {
      const thread = item.thread;
      if (thread && typeof thread === 'object' && 'id' in thread && typeof thread.id === 'string') {
        // Streaming/visit counters change continually but do not alter admission or run state.
        // Cleanup retains its stronger identity, including updatedAt, for destructive checks.
        const { updatedAt, itemCount, visibleItemCount, latestVisibleMessage, lastVisitedAt, opens, ...work } = thread as Record<string, unknown>;
        const identity = JSON.stringify(work), previous = this.threadWork.get(thread.id);
        this.threadWork.set(thread.id, identity);
        if (previous === identity) return;
      }
    }
    if (!this.settle) this.settle = setTimeout(() => { this.settle = undefined; this.wake('t3'); }, EVENT_SETTLE_MS);
  }

  // Each domain coalesces only its own wake bursts. No domain owns another domain's worker.
  wake(reason: string) {
    if (this.stopped) return;
    if (reason === 'config') { clearTimeout(this.timer); this.timer = undefined; }
    // Maintenance cadence belongs to the service, even when no admission can run.
    // Ordinary events cannot postpone this fallback indefinitely.
    this.timer ??= setTimeout(() => { this.timer = undefined; this.wake('timer'); }, this.pollSeconds * 1000);
    this.runLane('reconcile', async () => {
      const c = this.configure(), kanvil = await this.ensureKanvil(c);
      await reconcile(c, this.store, this.t3, kanvil, (await this.t3.shell()).threads, true, false);
      this.publishWork();
      if (!this.stopped) this.scheduleAdmissions(reason, 'tickets');
    });
    this.runLane('inventory', async () => {
      const c = this.configure();
      await refreshInventory(c, this.store, this.t3, await this.ensureKanvil(c));
      this.publishWork();
      if (!this.stopped) this.scheduleAdmissions(reason, 'tickets');
    });
    this.scheduleAdmissions(reason, 'tickets');
    this.scheduleAdmissions(reason, 'chains');
    this.scheduleAdmissions(reason, 'upstream');
    this.runLane('upstream-sources', async () => {
      const c = this.configure();
      if (!c.upstream?.enabled) return;
      await pendingReviews(c, this.store, this.store.jobSummaries());
      if (!this.stopped) this.scheduleAdmissions(reason, 'upstream');
    });
    // One triage run at a time across every inbox. The queue status is published even while triage is off.
    this.runLane('inbox-triage', async () => {
      const c = this.configure();
      if (!inboxes(c).length) { this.store.set('triageStreams', '[]'); return; }
      const kanvil = await this.ensureKanvil(c);
      const publish = (running?: Parameters<typeof triageQueue>[2]) => { this.store.set('triageStreams', JSON.stringify(triageQueue(c, kanvil, running))); this.publishWork(); };
      const results = await triagePass(c, this.store, kanvil, { budget: () => this.triageBudget(), signal: this.abort.signal, onRun: publish });
      if (results.length) { this.store.set('triageDecision', JSON.stringify({ at: new Date().toISOString(), results })); this.publishWork(); }
    });
    this.scheduleCleanup(true); this.scheduleCollection();
    if (reason === 'start' || reason === 'config' || !this.store.get('cleanupCatalog') || Date.now() - (Date.parse(this.store.get('cleanupCatalogAttempt') ?? '') || 0) >= this.pollSeconds * 1000) this.scheduleInventory();
  }

  private scheduleAdmissions(reason: string, workKind: NonNullable<Clients['workKind']>) {
    for (const driver of ['codex', 'claudeAgent']) this.runLane(`${workKind}:${driver}`, async () => {
      const c = this.configure();
      const matches = (model: Config['models'][number]) => model.model.instanceId === driver || !['codex', 'claudeAgent'].includes(model.model.instanceId);
      if (workKind === 'chains') {
        if (!this.store.plans().some(plan => plan.state === 'active')) return;
        // One lane still observes completion when all capacities are zero; runPlans cannot launch.
        if (c.concurrency[driver === 'codex' ? 'codex' : 'claude'] === 0 && (driver === 'claudeAgent' || c.concurrency.claude > 0)) return;
      } else {
        if (c.concurrency[driver === 'codex' ? 'codex' : 'claude'] === 0) return;
        if (workKind === 'tickets' ? !c.enabled : !c.upstream?.enabled) return;
        if (!c.models.some(model => model.automatic && matches(model))) return;
      }
      await this.pass({}, reason, 0, workKind, driver);
    });
  }

  private runLane(reason: string, work: () => Promise<void>) {
    const running = this.lanes.get(reason);
    if (running) { running.again = true; return; }
    const lane = { again: false, done: Promise.resolve() };
    this.lanes.set(reason, lane);
    lane.done = (async () => {
      do {
        lane.again = false;
        try { await this.enqueue(work, false, { reason }); }
        catch (error) { if (!this.stopped) log('background-pass-failed', { reason, message: safeError(error) }); }
      } while (lane.again && !this.stopped);
    })().finally(() => { this.lanes.delete(reason); if (lane.again && !this.stopped) this.runLane(reason, work); });
  }

  private enqueue<T>(work: (queueWaitMs: number) => Promise<T>, foreground = true, metadata: { reason?: string; context?: ReadContext; id?: string } = {}): Promise<T> {
    const context = metadata.context ?? new ReadContext();
    context.onStage = () => this.publishWork();
    const key = Symbol(), started = performance.now(), at = new Date().toISOString();
    const result = Promise.resolve().then(() => context.run(() => work(0)));
    this.operations.set(key, { foreground, reason: metadata.reason ?? (foreground ? 'command' : 'maintenance'), context, id: metadata.id, queuedAt: at, startedAt: at, done: result });
    this.publishWork();
    return result.finally(() => {
      this.operations.delete(key);
      this.publishWork();
      log('work', { lane: metadata.reason ?? 'command', requestId: metadata.id, ms: Math.round(performance.now() - started), waitMs: 0 });
    });
  }

  private async drainWork() { while (this.operations.size || this.lanes.size) await Promise.allSettled([...this.operations.values()].map(item => item.done).concat([...this.lanes.values()].map(lane => lane.done))); }
  private get idle() { return this.drainWork(); }
  private workStatus() {
    const operations = [...this.operations.values()].map(item => ({ reason: item.reason, requestId: item.id, queuedAt: item.queuedAt, startedAt: item.startedAt, ageMs: Date.now() - Date.parse(item.startedAt), stage: item.context.stage }));
    return { queueDepth: 0, active: operations[0] ?? null, operations,
      eventLoop: { maxMs: this.eventLoop.max / 1e6, p99Ms: this.eventLoop.percentile(99) / 1e6 } };
  }
  private publishWork() {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => { this.statusTimer = undefined; this.flushWork(); }, 100);
    this.statusTimer.unref();
  }
  private flushWork() {
    if (!this.store) return;
    try { this.store.set('serviceWork', JSON.stringify(this.workStatus())); writeStatus(loadConfig(this.configPath), this.store); }
    catch (error) { log('work-status-failed', { message: safeError(error) }); }
  }

  // Cleanup owns its sweep; each step retains the existing job/path safety boundary.
  private scheduleCleanup(newSweep = false) {
    if (this.stopped) return;
    if (newSweep) this.cleanupVisited.clear();
    if (this.cleanupQueued) return;
    this.cleanupQueued = true;
    this.cleanupTimer = setTimeout(() => void this.enqueue(async () => {
      let more = false;
      try {
        if (this.stopped) return;
        const c = this.configure(), kanvil = await this.ensureKanvil(c);
        more = await cleanupNextWorkspace(c, this.store, this.t3, kanvil, this.cleanupVisited);
        this.publishWork();
      } catch (error) { log('workspace-maintenance-failed', { message: safeError(error) }); }
      finally {
        this.cleanupQueued = false;
        if (more) this.scheduleCleanup();
      }
    }, false, { reason: 'workspace-cleanup' }), 0);
  }

  private scheduleInventory() {
    if (this.stopped) return;
    this.inventoryRequested++;
    if (this.inventoryQueued) return;
    this.inventoryQueued = true;
    this.store.set('cleanupCatalogRefresh', JSON.stringify({ refreshing: true }));
    this.inventoryTimer = setTimeout(() => void this.enqueue(async () => {
      const requested = this.inventoryRequested;
      this.store.set('cleanupCatalogAttempt', new Date().toISOString());
      try {
        if (this.stopped) return;
        const c = this.configure();
        await refreshCleanupCatalog(c, this.store, this.t3, this.abort.signal);
        this.publishWork();
      } catch (error) {
        if (!this.stopped) {
          this.store.set('cleanupCatalogRefresh', JSON.stringify({ refreshing: false, errors: [{ repository: 'Inventory', message: safeError(error) }] }));
          this.publishWork();
        }
      } finally {
        this.inventoryQueued = false;
        if (!this.stopped && requested !== this.inventoryRequested) this.scheduleInventory();
      }
    }, false, { reason: 'cleanup-inventory' }), 0);
  }

  // Session collection owns bounded batches and durable cursors, independent of admission.
  private scheduleCollection() {
    if (this.stopped || this.collectionQueued) return;
    this.collectionQueued = true;
    this.collectionTimer = setTimeout(() => void this.enqueue(async () => {
      let more = false;
      try {
        if (this.stopped) return;
        const c = this.configure(), kanvil = await this.ensureKanvil(c);
        more = await collectSessionTickets(c, this.store, this.t3, kanvil);
        this.publishWork();
      } catch (error) {
        // A batch that could not even start (bad config, no tracker client) is a failure the page must show too.
        recordSessionTicketsFailure(this.store, [{ step: 'start', cause: safeError(error) }]);
        try { this.publishWork(); } catch { /* Invalid config is already logged. */ }
      }
      finally {
        this.collectionQueued = false;
        if (more) this.scheduleCollection();
      }
    }, false, { reason: 'session-tickets' }), 0);
  }

  private async handle(command: ControlCommand, receivedAt = new Date().toISOString()): Promise<ControlResult> {
    if (command.type === 'health') return { code: 0, data: { ok: true, pid: process.pid, ...this.workStatus() } };
    if (this.stopped) return { code: 1, data: { message: 'The scheduler is stopping' } };
    if (command.type === 'wake') { this.wake(command.reason ?? 'command'); return { code: 0, data: { ok: true } }; }
    if (command.type === 'job-stop') {
      const result = await this.enqueue(() => this.store.exclusive([`job:${command.jobId}`], () => stopJob(this.configure(), this.store, this.t3, command.jobId)), true, { reason: 'job-stop' });
      this.wake('job-stop');
      return { code: 0, data: result };
    }
    if (command.type === 'session-dismiss') {
      const result = await this.enqueue(async () => { const r = dismissSessionTicket(this.store, command.taskId); this.publishWork(); return r; });
      return { code: 0, data: result };
    }
    if (command.type === 'plan-cancel') {
      const result = await this.enqueue(async () => { const r = cancelPlan(this.store, command.planId); this.publishWork(); return r; });
      return { code: 0, data: result };
    }
    if (command.type === 'cleanup-cancel') { this.inspections.get(command.inspectionId)?.abort(); return { code: 0, data: { cancelled: this.inspections.has(command.inspectionId) } }; }
    if (command.type === 'cleanup') {
      const input = cleanupRequestSchema.parse(command.input);
      if (input.type === 'inventory') {
        const c = loadConfig(this.configPath), data = readCleanupCatalog(c, this.store, input.offset, input.limit, input);
        if (input.refresh || !data.checkedAt && !this.inventoryQueued) this.scheduleInventory();
        return { code: 0, data: { ...data, refreshing: data.refreshing || !!input.refresh } };
      }
      const inspectionId = 'inspectionId' in input ? input.inspectionId : undefined;
      const controller = new AbortController();
      if (inspectionId && this.inspections.has(inspectionId)) throw new Error('Inspection ID is already queued or running');
      if (inspectionId) this.inspections.set(inspectionId, controller);
      try {
        const result = await this.enqueue(async () => {
          controller.signal.throwIfAborted();
          const c = this.configure();
          // Inspection also verifies tracker evidence when present. Lazy connection keeps inventory available during tracker outages.
          const lazy = { task: async (id: string) => (await this.ensureKanvil(c)).task(id) } as Kanvil;
          const r = await manageCleanup(c, this.store, this.t3, lazy, input, command.operator ?? 'local operator', { signal: controller.signal });
          if (!['inventory', 'inspect', 'review'].includes(input.type)) this.publishWork();
          return r;
        });
        return { code: 0, data: result };
      } finally { if (inspectionId) this.inspections.delete(inspectionId); }
    }
    if (command.type === 'once') {
      const result = await this.enqueue(queueWaitMs => this.pass(command.options as CycleOptions, 'once', queueWaitMs));
      return { code: result.reason === 'error' || (result as { triageSandbox?: { ok: boolean } }).triageSandbox?.ok === false ? 1 : 0, data: result };
    }
    return runManualRequest(loadConfig(this.configPath), this.store, command.options as CycleOptions, this.enqueue.bind(this), (options, wait) => this.pass(options, 'dispatch', wait), this.requests, operation => { if (operation.state === 'uncertain') this.uncertainRequests.add(operation.id); }, receivedAt);
  }


  // Allowance readings stay within quota.maxAgeSeconds even when nothing else happens.
  private scheduleQuota(c: Config) {
    clearTimeout(this.quotaTimer);
    if (this.stopped) return;
    this.quotaTimer = setTimeout(() => void this.enqueue(async () => {
      if (this.stopped) return;
      let current: Config | undefined;
      try { current = loadConfig(this.configPath); await refreshQuota(current, this.store, this.t3); this.publishWork(); }
      catch (error) { log('quota-refresh-failed', { message: safeError(error) }); }
      finally { this.scheduleQuota(current ?? c); } // an unreadable config keeps the last cadence rather than stopping the refreshes
    }, false, { reason: 'quota-refresh' }), Math.max(15, c.quota.maxAgeSeconds / 2) * 1000);
  }

  // Reread before every report: pausing triage or Claude stops the next run, not only the next pass.
  private async triageBudget(): Promise<string | undefined> {
    try {
      const c = this.configure();
      if (!c.triage?.enabled) return 'triage-disabled';
      if (c.concurrency.claude === 0) return 'provider-disabled';
      const providers = await this.t3.providers();
      const preset = c.models.find(m => providers.find(p => p.instanceId === m.model.instanceId)?.driver === 'claudeAgent');
      if (!preset) return 'No Claude model is configured';
      const quota = await readModelQuota(this.t3, c, this.store.jobSummaries(), preset.id);
      return !quota.hasAllowance ? 'quota-exhausted' : !quota.allowed ? 'quota-budget' : undefined;
    } catch (error) { return safeError(error); }
  }

  private ensureKanvil(c: Config): Promise<Kanvil> {
    return readPhase('kanvil.connect', async signal => {
      this.kanvil ??= new ReadContext().run(async () => {
        const client = new Kanvil(c.kanvil);
        await client.connect(this.abort.signal);
        void client.subscribe(event => {
          if (this.stopped) return;
          if (!event || /^(project|workspace|workflow)\./.test(event.type)) this.store.set('sessionCatalog', 'null');
          // Refresh a collected row as soon as its native ticket changes.
          const rows = !event ? this.store.sessionTickets() : event.ticketId ? [this.store.sessionTicket(event.ticketId)].filter(row => !!row) : this.store.sessionTickets().filter(row => row.projectId === event.projectId);
          for (const row of rows) { row.refreshAfter = new Date(0).toISOString(); this.store.saveSessionTicket(row); }
          this.wake('kanvil');
        }, this.abort.signal, error => log('kanvil-stream-error', { message: safeError(error) }));
        return client;
      });
      const pending = this.kanvil;
      void pending.catch(() => { if (this.kanvil === pending) this.kanvil = undefined; });
      return waitFor(pending, signal);
    });
  }
  // Closing aborts the HTTP stream before settings are replaced.
  private async dropKanvil() {
    const dead = this.kanvil; this.kanvil = undefined;
    await dead?.then(k => k.close()).catch(() => {});
  }

  private configure(): Config {
    const c = loadConfig(this.configPath);
    this.pollSeconds = c.pollSeconds;
    if (c.stateDir !== this.stateDir) throw new Error('stateDir changed while running; restart the service for a deliberate state migration');
    if (JSON.stringify(c.t3) !== this.t3Settings) { log('t3-settings-changed'); this.connectT3(c); }
    if (JSON.stringify(c.kanvil) !== this.kanvilSettings) { if (this.kanvilSettings) log('kanvil-settings-changed'); this.dropKanvil(); this.kanvilSettings = JSON.stringify(c.kanvil); }
    return c;
  }

  private async pass(options: CycleOptions, reason: string, queueWaitMs: number, workKind?: Clients['workKind'], providerDriver?: string) {
    const started = performance.now();
    let c: Config | undefined;
    try {
      c = this.configure();
      const kanvil = await backgroundRead(() => this.ensureKanvil(c!));
      const result = await cycle(c, this.store, options, { t3: this.t3, kanvil, github: this.github, deferCleanup: true, deferReconcile: true, backgroundInventory: true, workKind, providerDriver, currentConfig: () => loadConfig(this.configPath) });
      const jobs = this.store.jobs();
      for (const id of this.uncertainRequests) {
        const job = jobs.find(j => j.requestId === id), operation = readOperation(c.stateDir, id);
        if (operation && (job?.thread || job?.reason === 'T3 accepted dispatch' || operation.progress?.planId)) { recoverOperation(c.stateDir, this.store, operation); this.uncertainRequests.delete(id); }
      }
      this.publishWork();
      log('pass', { reason, outcome: result.reason, ms: performance.now() - started, queueWaitMs });
      return result;
    } catch (error) {
      if (this.stopped && !options.manual) return { reason: 'stopped' };
      const message = safeError(error); log('error', { message, reason, ms: performance.now() - started, queueWaitMs });
      this.store.decide({ reason: 'error', message, at: new Date().toISOString() });
      try { this.publishWork(); } catch { /* Invalid config is already logged. */ }
      throw error;
    } finally {
      if ((options.manual || reason === 'once') && !options.dryRun && !options.doctor) { this.scheduleCleanup(true); this.scheduleCollection(); }
      }
  }
}
