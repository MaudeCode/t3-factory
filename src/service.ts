import { manageCleanup, cleanupRequestSchema, readCleanupCatalog, refreshCleanupCatalog } from './cleanup.ts';
// The long-lived scheduler. One process holds the store claim, a T3 client, and a connected Kaneo
// client, and runs passes in series from one queue. Passes start from what changes: a T3 thread
// event, a config edit, a command over the control socket, or the fallback timer.
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { Store } from './store.ts';
import { T3, Kaneo, listTasks } from './clients.ts';
import { cycle, cleanupNextWorkspace, log, safeError, stopJob, cancelPlan, writeStatus, refreshQuota, readAll, type CycleOptions } from './scheduler.ts';
import { collectSessionTickets, dismissSessionTicket, recordSessionTicketsFailure } from './session-tickets.ts';
import { serveControl, type ControlCommand, type ControlResult } from './control.ts';
import { readOperation, savedOperations } from './operations.ts';
import { recoverOperation, runManualRequest } from './manual-request.ts';
import { ReadContext, readPhase, backgroundRead } from './read-context.ts';

const EVENT_SETTLE_MS = 750; // T3 coalesces bursts server-side; this folds the remainder into one pass.
const KINDS_WITHOUT_WORK = new Set(['snapshot', 'synchronized']);
export interface ServiceTiming { kaneoPollMs: number }
const DEFAULT_TIMING: ServiceTiming = { kaneoPollMs: 15_000 };

export class FactoryService {
  private store!: Store;
  private t3!: T3;
  private t3Settings = '';
  private kaneoSettings = '';
  private stream?: AbortController;
  private kaneo?: Promise<Kaneo>; // resolves once connected, so no caller sees a client mid-handshake
  private polling?: Promise<void>;
  private control?: Server;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private settle?: NodeJS.Timeout;
  private quotaTimer?: NodeJS.Timeout;
  private kaneoTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private cleanupQueued = false;
  private inventoryTimer?: NodeJS.Timeout;
  private inventoryQueued = false;
  private inventoryRequested = 0;
  private collectionTimer?: NodeJS.Timeout;
  private collectionQueued = false;
  private readonly inspections = new Map<string, AbortController>();
  private readonly cleanupVisited = new Set<string>();
  private readyFingerprint?: string;
  private readonly timing: ServiceTiming;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending: { foreground: boolean; run: () => Promise<void>; reason: string; context: ReadContext; id?: string; queuedAt: string }[] = [];
  private active?: { foreground: boolean; reason: string; context: ReadContext; id?: string; queuedAt: string; startedAt: string };
  private readonly requests = new Map<string, Promise<ControlResult>>();
  private readonly uncertainRequests = new Set<string>();
  private kaneoAbort?: AbortController;
  private running = false;
  private wanted = false;
  private stopped = false;
  private readonly abort = new AbortController();
  private stateDir = '';
  private readonly configPath: string;
  constructor(configPath: string, timing: Partial<ServiceTiming> = {}) { this.configPath = configPath; this.timing = { ...DEFAULT_TIMING, ...timing }; }

  async start() {
    const c = loadConfig(this.configPath);
    this.stateDir = c.stateDir;
    this.store = new Store(c.stateDir);
    if (!this.store.claim()) throw new Error('Another scheduler owns this state directory');
    for (const operation of savedOperations(c.stateDir)) if (operation.command) {
      if (['running', 'uncertain'].includes(operation.state)) recoverOperation(this.stateDir, this.store, operation);
      if (operation.state === 'uncertain') this.uncertainRequests.add(operation.id);
    }
    this.store.onCleanupChange = () => this.scheduleInventory();
    this.connectT3(c);
    this.control = serveControl(c.stateDir, command => this.handle(command));
    this.watcher = watch(dirname(this.configPath), (_, name) => { if (name === basename(this.configPath)) this.wake('config'); });
    this.wake('start');
    this.scheduleQuota(c);
    this.kaneoTimer = setInterval(() => void this.checkKaneo(), this.timing.kaneoPollMs);
    log('service-started', { pid: process.pid, stateDir: c.stateDir });
  }

  // A new T3 client and shell stream whenever the connection settings change, so an edit applies without a restart.
  private connectT3(c: Config) {
    this.stream?.abort();
    this.t3 = new T3(c.t3); this.t3Settings = JSON.stringify(c.t3);
    if (this.stopped) return;
    const stream = new AbortController(); this.stream = stream;
    this.abort.signal.addEventListener('abort', () => stream.abort(), { once: true });
    void this.t3.subscribe(item => this.onShellItem(item), stream.signal, error => log('t3-stream-error', { message: safeError(error) }));
  }
  async stop() {
    this.stopped = true;
    for (const controller of this.inspections.values()) controller.abort();
    this.abort.abort();
    for (const item of [this.active, ...this.pending]) if (item && !item.foreground) item.context.stopBackground();
    clearTimeout(this.timer); clearTimeout(this.settle); clearTimeout(this.quotaTimer); clearInterval(this.kaneoTimer); clearTimeout(this.cleanupTimer); clearTimeout(this.collectionTimer); clearTimeout(this.inventoryTimer);
    this.watcher?.close();
    await new Promise<void>(resolve => this.control ? this.control.close(() => resolve()) : resolve());
    await this.queue.catch(() => {});
    await this.polling;
    await this.kaneo?.then(k => k.close()).catch(() => {});
    this.store.close();
  }

  // Anything but the opening snapshot and its completion marker means a project or thread changed.
  private onShellItem(item: unknown) {
    if (this.stopped) return;
    const kind = item && typeof item === 'object' && 'kind' in item ? String((item as { kind: unknown }).kind) : '';
    if (KINDS_WITHOUT_WORK.has(kind)) return;
    clearTimeout(this.settle);
    this.settle = setTimeout(() => this.wake('t3'), EVENT_SETTLE_MS);
  }

  // One queued full pass at a time; a request while one is queued joins it.
  wake(reason: string) {
    if (this.stopped || this.wanted) return;
    this.wanted = true;
    void this.enqueue(async queueWaitMs => {
      this.wanted = false;
      if (!this.stopped) await this.pass({}, reason, queueWaitMs);
    }, false, { reason }).catch(error => log('background-pass-failed', { reason, message: safeError(error) }));
  }

  private enqueue<T>(work: (queueWaitMs: number) => Promise<T>, foreground = true, metadata: { reason?: string; context?: ReadContext; id?: string } = {}): Promise<T> {
    const queued = performance.now();
    const context = metadata.context ?? new ReadContext();
    context.onStage = () => this.publishWork();
    const result = new Promise<T>((resolve, reject) => {
      let segment = Promise.withResolvers<void>(), resume: (() => void) | undefined, started = false;
      const item = { foreground, reason: metadata.reason ?? (foreground ? 'command' : 'maintenance'), context, id: metadata.id, queuedAt: new Date().toISOString(), run: async () => {
        segment = Promise.withResolvers<void>();
        if (started) { resume!(); }
        else {
          started = true;
          void context.run(() => work(performance.now() - queued)).then(resolve, reject).finally(() => segment.resolve());
        }
        await segment.promise;
      } };
      if (!foreground) context.cooperate = async () => {
        if (this.stopped || !this.pending.some(p => p.foreground && !p.context.controller.signal.aborted)) return;
        const gate = Promise.withResolvers<void>(); resume = gate.resolve;
        context.suspended = true;
        context.revision++;
        this.pending.push(item); // The continuation retains its state, but rejoins the same fair queue.
        segment.resolve();
        await gate.promise;
      };
      this.pending.push(item);
    });
    if (foreground && this.active && !this.active.foreground) this.active.context.requestYield();
    this.publishWork();
    if (!this.running) this.queue = this.drain();
    return result;
  }

  private async drain() {
    this.running = true;
    let foregroundCount = 0;
    while (this.pending.length) {
      const background = this.pending.findIndex(item => !item.foreground);
      const foreground = this.pending.findIndex(item => item.foreground);
      const index = background !== -1 && foregroundCount >= 3 ? background : foreground !== -1 ? foreground : 0;
      const [item] = this.pending.splice(index, 1);
      if (item.context.controller.signal.aborted) { await item.run(); continue; }
      // Only count commands competing with background work toward the fairness bound.
      foregroundCount = item.foreground && background !== -1 ? foregroundCount + 1 : 0;
      this.active = { ...item, startedAt: new Date().toISOString() };
      this.publishWork();
      await item.run();
      this.active = undefined;
      this.publishWork();
    }
    this.running = false;
  }

  private workStatus() {
    return { queueDepth: this.pending.filter(p => !p.context.controller.signal.aborted).length,
      active: this.active ? { reason: this.active.reason, requestId: this.active.id, queuedAt: this.active.queuedAt, startedAt: this.active.startedAt, ageMs: Date.now() - Date.parse(this.active.startedAt), stage: this.active.context.stage } : null };
  }
  private publishWork() {
    if (!this.store) return;
    try { this.store.set('serviceWork', JSON.stringify(this.workStatus())); writeStatus(loadConfig(this.configPath), this.store); }
    catch (error) { log('work-status-failed', { message: safeError(error) }); }
  }

  // Yield to the command response and enqueue only one step. Continuations join the tail,
  // so housekeeping shares the single writer without occupying the dispatch call itself.
  private scheduleCleanup(newSweep = false) {
    if (this.stopped) return;
    if (newSweep) this.cleanupVisited.clear();
    if (this.cleanupQueued) return;
    this.cleanupQueued = true;
    this.cleanupTimer = setTimeout(() => void this.enqueue(async () => {
      let more = false;
      try {
        if (this.stopped) return;
        const c = this.configure(), kaneo = await this.ensureKaneo(c);
        more = await cleanupNextWorkspace(c, this.store, this.t3, kaneo, this.cleanupVisited);
        writeStatus(c, this.store);
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
        writeStatus(c, this.store);
      } catch (error) {
        if (!this.stopped) {
          this.store.set('cleanupCatalogRefresh', JSON.stringify({ refreshing: false, errors: [{ repository: 'Inventory', message: safeError(error) }] }));
          writeStatus(loadConfig(this.configPath), this.store);
        }
      } finally {
        this.inventoryQueued = false;
        if (!this.stopped && requested !== this.inventoryRequested) this.scheduleInventory();
      }
    }, false, { reason: 'cleanup-inventory' }), 0);
  }

  // Session-ticket collection runs the same way: one bounded batch per queued item, behind any command, until nothing remains.
  private scheduleCollection() {
    if (this.stopped || this.collectionQueued) return;
    this.collectionQueued = true;
    this.collectionTimer = setTimeout(() => void this.enqueue(async () => {
      let more = false;
      try {
        if (this.stopped) return;
        const c = this.configure(), kaneo = await this.ensureKaneo(c);
        more = await collectSessionTickets(c, this.store, this.t3, kaneo);
        writeStatus(c, this.store);
      } catch (error) {
        // A batch that could not even start (bad config, no tracker client) is a failure the page must show too.
        recordSessionTicketsFailure(this.store, safeError(error));
        try { writeStatus(loadConfig(this.configPath), this.store); } catch { /* Invalid config is already logged. */ }
      }
      finally {
        this.collectionQueued = false;
        if (more) this.scheduleCollection();
      }
    }, false, { reason: 'session-tickets' }), 0);
  }

  private async handle(command: ControlCommand): Promise<ControlResult> {
    if (command.type === 'health') return { code: 0, data: { ok: true, pid: process.pid, ...this.workStatus() } };
    if (this.stopped) return { code: 1, data: { message: 'The scheduler is stopping' } };
    if (command.type === 'wake') { this.wake(command.reason ?? 'command'); return { code: 0, data: { ok: true } }; }
    if (command.type === 'job-stop') {
      const result = await this.enqueue(() => stopJob(this.configure(), this.store, this.t3, command.jobId));
      this.wake('job-stop');
      return { code: 0, data: result };
    }
    if (command.type === 'session-dismiss') {
      const result = await this.enqueue(async () => { const r = dismissSessionTicket(this.store, command.taskId); writeStatus(loadConfig(this.configPath), this.store); return r; });
      return { code: 0, data: result };
    }
    if (command.type === 'plan-cancel') {
      const result = await this.enqueue(async () => { const r = cancelPlan(this.store, command.planId); writeStatus(loadConfig(this.configPath), this.store); return r; });
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
          const lazy = { call: async (tool: string, args: any) => (await this.ensureKaneo(c)).call(tool, args) } as Kaneo;
          const r = await manageCleanup(c, this.store, this.t3, lazy, input, command.operator ?? 'local operator', { signal: controller.signal });
          if (!['inventory', 'inspect', 'review'].includes(input.type)) writeStatus(c, this.store);
          return r;
        });
        return { code: 0, data: result };
      } finally { if (inspectionId) this.inspections.delete(inspectionId); }
    }
    if (command.type === 'once') {
      const result = await this.enqueue(queueWaitMs => this.pass(command.options as CycleOptions, 'once', queueWaitMs));
      return { code: result.reason === 'error' ? 1 : 0, data: result };
    }
    return runManualRequest(loadConfig(this.configPath), this.store, command.options as CycleOptions, this.enqueue.bind(this), (options, wait) => this.pass(options, 'dispatch', wait), this.requests, operation => { if (operation.state === 'uncertain') this.uncertainRequests.add(operation.id); });
  }


  // Allowance readings stay within quota.maxAgeSeconds even when nothing else happens.
  private scheduleQuota(c: Config) {
    clearTimeout(this.quotaTimer);
    if (this.stopped) return;
    this.quotaTimer = setTimeout(() => void this.enqueue(async () => {
      if (this.stopped) return;
      let current: Config | undefined;
      try { current = loadConfig(this.configPath); await refreshQuota(current, this.store, this.t3); writeStatus(current, this.store); }
      catch (error) { log('quota-refresh-failed', { message: safeError(error) }); }
      finally { this.scheduleQuota(current ?? c); } // an unreadable config keeps the last cadence rather than stopping the refreshes
    }, false, { reason: 'quota-refresh' }), Math.max(15, c.quota.maxAgeSeconds / 2) * 1000);
  }

  // Kaneo has no push, so the ready columns are fingerprinted cheaply; any change starts a pass.
  private checkKaneo() {
    if (this.stopped || this.polling) return this.polling;
    this.polling = (async () => {
      try {
        const c = loadConfig(this.configPath), kaneo = await this.ensureKaneo(c);
        const tasks = await readAll(c.projects.filter(p => p.enabled).map(p => listTasks(kaneo, p.kaneoId, null, p.readyStatuses)));
        const fingerprint = JSON.stringify(tasks.flat().map(t => [t.id, t.status, t.priority, (t.labels ?? []).map(l => l.name).sort()]).sort());
        if (this.readyFingerprint !== undefined && fingerprint !== this.readyFingerprint) this.wake('kaneo');
        this.readyFingerprint = fingerprint;
      } catch (error) { log('kaneo-poll-failed', { message: safeError(error) }); }
      finally { this.polling = undefined; }
    })();
    return this.polling;
  }

  private ensureKaneo(c: Config): Promise<Kaneo> {
    return readPhase('kaneo.connect', async signal => {
      this.kaneo ??= (async () => { const client = new Kaneo(c.kaneo); this.kaneoAbort = new AbortController(); await client.connect(this.kaneoAbort.signal); return client; })();
      const pending = this.kaneo, controller = this.kaneoAbort;
      const abort = () => controller?.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      try { return await pending; }
      catch (error) { if (this.kaneo === pending) this.kaneo = undefined; throw error; }
      finally { signal?.removeEventListener('abort', abort); }
    });
  }
  // A broken MCP transport cannot be reused; the next pass spawns a fresh client.
  private async dropKaneo() {
    const dead = this.kaneo; this.kaneo = undefined;
    await dead?.then(k => k.close()).catch(() => {});
  }

  private configure(): Config {
    const c = loadConfig(this.configPath);
    if (c.stateDir !== this.stateDir) throw new Error('stateDir changed while running; restart the service for a deliberate state migration');
    if (JSON.stringify(c.t3) !== this.t3Settings) { log('t3-settings-changed'); this.connectT3(c); }
    if (JSON.stringify(c.kaneo) !== this.kaneoSettings) { if (this.kaneoSettings) log('kaneo-settings-changed'); this.dropKaneo(); this.kaneoSettings = JSON.stringify(c.kaneo); }
    return c;
  }

  private async pass(options: CycleOptions, reason: string, queueWaitMs: number) {
    clearTimeout(this.timer);
    const started = performance.now();
    let c: Config | undefined;
    try {
      c = this.configure();
      const kaneo = await backgroundRead(() => this.ensureKaneo(c!));
      const result = await cycle(c, this.store, options, { t3: this.t3, kaneo, deferCleanup: true });
      if (this.active?.context.needsRefresh && !this.active.foreground) this.wake('resume');
      const jobs = this.store.jobs();
      for (const id of this.uncertainRequests) {
        const job = jobs.find(j => j.requestId === id), operation = readOperation(c.stateDir, id);
        if (operation && (job?.thread || job?.reason === 'T3 accepted dispatch' || operation.progress?.planId)) { recoverOperation(c.stateDir, this.store, operation); this.uncertainRequests.delete(id); }
      }
      writeStatus(c, this.store);
      log('pass', { reason, outcome: result.reason, ms: performance.now() - started, queueWaitMs });
      return result;
    } catch (error) {
      if (this.stopped && !this.active?.foreground) return { reason: 'stopped' };
      const message = safeError(error); log('error', { message, reason, ms: performance.now() - started, queueWaitMs });
      this.store.decide({ reason: 'error', message, at: new Date().toISOString() });
      try { writeStatus(c ?? loadConfig(this.configPath), this.store); } catch { /* Invalid config is already logged. */ }
      await this.dropKaneo();
      throw error;
    } finally {
      if (!options.dryRun && !options.doctor) { this.scheduleCleanup(true); this.scheduleCollection(); }
      if (!this.stopped && (reason === 'start' || reason === 'config' || !this.store.get('cleanupCatalog') || Date.now() - (Date.parse(this.store.get('cleanupCatalogAttempt') ?? '') || 0) >= (c?.pollSeconds ?? 60) * 1000)) this.scheduleInventory();
      clearTimeout(this.timer);
      if (!this.stopped) this.timer = setTimeout(() => this.wake('timer'), (c?.pollSeconds ?? 60) * 1000);
    }
  }
}
