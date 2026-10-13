// The long-lived scheduler. One process holds the store claim, a T3 client, and a connected Kaneo
// client, and runs passes in series from one queue. Passes start from what changes: a T3 thread
// event, a config edit, a command over the control socket, or the fallback timer.
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { Store } from './store.ts';
import { T3, Kaneo } from './clients.ts';
import { cycle, log, safeError, stopJob, cancelPlan, writeStatus, refreshQuota, type CycleOptions } from './scheduler.ts';
import { listTasks } from './clients.ts';
import { serveControl, type ControlCommand, type ControlResult } from './control.ts';

const EVENT_SETTLE_MS = 750; // T3 coalesces bursts server-side; this folds the remainder into one pass.
const KINDS_WITHOUT_WORK = new Set(['snapshot', 'synchronized']);
export interface ServiceTiming { kaneoPollMs: number }
const DEFAULT_TIMING: ServiceTiming = { kaneoPollMs: 15_000 };

export class FactoryService {
  private store!: Store;
  private t3!: T3;
  private kaneo?: Kaneo;
  private control?: Server;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private settle?: NodeJS.Timeout;
  private quotaTimer?: NodeJS.Timeout;
  private kaneoTimer?: NodeJS.Timeout;
  private readyFingerprint?: string;
  private readonly timing: ServiceTiming;
  private queue: Promise<unknown> = Promise.resolve();
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
    this.t3 = new T3(c.t3);
    this.control = serveControl(c.stateDir, command => this.handle(command));
    this.watcher = watch(dirname(this.configPath), (_, name) => { if (name === basename(this.configPath)) this.wake('config'); });
    void this.t3.subscribe(item => this.onShellItem(item), this.abort.signal, error => log('t3-stream-error', { message: safeError(error) }));
    this.wake('start');
    this.scheduleQuota(c);
    this.kaneoTimer = setInterval(() => void this.checkKaneo(), this.timing.kaneoPollMs);
    log('service-started', { pid: process.pid, stateDir: c.stateDir });
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer); clearTimeout(this.settle); clearTimeout(this.quotaTimer); clearInterval(this.kaneoTimer);
    this.watcher?.close();
    await new Promise<void>(resolve => this.control ? this.control.close(() => resolve()) : resolve());
    await this.queue.catch(() => {});
    await this.kaneo?.close().catch(() => {});
    this.store.close();
  }

  // Anything but the opening snapshot and its completion marker means a project or thread changed.
  private onShellItem(item: unknown) {
    const kind = item && typeof item === 'object' && 'kind' in item ? String((item as { kind: unknown }).kind) : '';
    if (KINDS_WITHOUT_WORK.has(kind)) return;
    clearTimeout(this.settle);
    this.settle = setTimeout(() => this.wake('t3'), EVENT_SETTLE_MS);
  }

  // One queued full pass at a time; a request while one is queued joins it.
  wake(reason: string) {
    if (this.stopped || this.wanted) return;
    this.wanted = true;
    void this.enqueue(async () => { this.wanted = false; await this.pass({}, reason); });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async handle(command: ControlCommand): Promise<ControlResult> {
    if (command.type === 'health') return { code: 0, data: { ok: true, pid: process.pid } };
    if (command.type === 'wake') { this.wake(command.reason ?? 'command'); return { code: 0, data: { ok: true } }; }
    if (command.type === 'job-stop') {
      const result = await this.enqueue(() => stopJob(loadConfig(this.configPath), this.store, this.t3, command.jobId));
      this.wake('job-stop');
      return { code: 0, data: result };
    }
    if (command.type === 'plan-cancel') {
      const result = await this.enqueue(async () => { const r = cancelPlan(this.store, command.planId); writeStatus(loadConfig(this.configPath), this.store); return r; });
      return { code: 0, data: result };
    }
    const result = await this.enqueue(() => this.pass({ ...(command.options as CycleOptions), manual: true }, 'dispatch'));
    return { code: ['dispatched', 'would-dispatch', 'plan-started'].includes(result.reason) ? 0 : 1, data: result };
  }

  // Allowance readings stay within quota.maxAgeSeconds even when nothing else happens.
  private scheduleQuota(c: Config) {
    clearTimeout(this.quotaTimer);
    if (this.stopped) return;
    this.quotaTimer = setTimeout(() => void this.enqueue(async () => {
      const current = loadConfig(this.configPath);
      try { await refreshQuota(current, this.store, this.t3); writeStatus(current, this.store); }
      catch (error) { log('quota-refresh-failed', { message: safeError(error) }); }
      finally { this.scheduleQuota(current); }
    }), Math.max(15, c.quota.maxAgeSeconds / 2) * 1000);
  }

  // Kaneo has no push, so the ready columns are fingerprinted cheaply; any change starts a pass.
  private async checkKaneo() {
    if (this.stopped) return;
    try {
      const c = loadConfig(this.configPath), kaneo = await this.ensureKaneo(c);
      const tasks = await Promise.all(c.projects.filter(p => p.enabled).map(p => listTasks(kaneo, p.kaneoId, null, p.readyStatuses)));
      const fingerprint = JSON.stringify(tasks.flat().map(t => [t.id, t.status, t.priority, (t.labels ?? []).map(l => l.name).sort()]).sort());
      if (this.readyFingerprint !== undefined && fingerprint !== this.readyFingerprint) this.wake('kaneo');
      this.readyFingerprint = fingerprint;
    } catch (error) { log('kaneo-poll-failed', { message: safeError(error) }); }
  }

  private async ensureKaneo(c: Config) {
    if (!this.kaneo) { this.kaneo = new Kaneo(c.kaneo); await this.kaneo.connect(); }
    return this.kaneo;
  }

  private async pass(options: CycleOptions, reason: string) {
    clearTimeout(this.timer);
    const started = Date.now();
    let c: Config | undefined;
    try {
      c = loadConfig(this.configPath);
      if (c.stateDir !== this.stateDir) throw new Error('stateDir changed while running; restart the service for a deliberate state migration');
      const kaneo = await this.ensureKaneo(c);
      const result = await cycle(c, this.store, options, { t3: this.t3, kaneo });
      writeStatus(c, this.store);
      log('pass', { reason, outcome: result.reason, ms: Date.now() - started });
      return result;
    } catch (error) {
      const message = safeError(error); log('error', { message, reason });
      this.store.decide({ reason: 'error', message, at: new Date().toISOString() });
      try { writeStatus(c ?? loadConfig(this.configPath), this.store); } catch { /* Invalid config is already logged. */ }
      // A broken MCP transport cannot be reused; the next pass spawns a fresh Kaneo client.
      await this.kaneo?.close().catch(() => {}); this.kaneo = undefined;
      throw error;
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => this.wake('timer'), (c?.pollSeconds ?? 60) * 1000);
    }
  }
}
