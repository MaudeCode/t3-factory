import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

// Like cleanup's signal, but scoped here so every existing integration caller shares the deadline.
const current = new AsyncLocalStorage<ReadContext>();
export const readContext = () => current.getStore();
export class ManualDeadline extends Error {
  readonly stage: string;
  constructor(stage: string) { super(`Not launched: manual request deadline exceeded during ${stage}`); this.stage = stage; }
}
export class ReadContext {
  readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private reads = new Map<symbol, string>();
  private owned = false;
  private batch?: ReadContext;
  private readonly pendingReads = new Set<Promise<unknown>>();
  cooperate?: () => Promise<void>;
  suspended = false;
  revision = 0;
  needsRefresh = false;
  private stopping = false;
  requestYield() { this.batch?.controller.abort(BACKGROUND_YIELD); }
  stopBackground() { this.stopping = true; this.batch?.controller.abort(new Error('Scheduler stopping')); }
  async checkpoint() {
    if (this.stopping) throw new Error('Scheduler stopping');
    if (this.cooperate) await yieldToEventLoop();
    this.check(); await this.cooperate?.(); this.check();
    if (this.stopping) throw new Error('Scheduler stopping');
  }
  async backgroundRead<T>(work: () => Promise<T>): Promise<T> {
    if (!this.cooperate) return work();
    // After one cancellation, finish a batch before yielding again so commands cannot starve a scan.
    for (let attempt = 0; ; attempt++) {
      const child = new ReadContext();
      child.onStage = () => this.setStage(child.stage);
      const abort = () => child.controller.abort(this.controller.signal.reason);
      this.controller.signal.addEventListener('abort', abort, { once: true });
      if (!attempt) this.batch = child;
      try {
        const result = await child.run(work);
        await child.drain(); child.check();
        this.batch = undefined;
        if (!attempt) {
          const revision = this.revision;
          await this.checkpoint();
          if (revision !== this.revision) continue; // A command may have changed even a successfully read snapshot.
        }
        return result;
      } catch (error) {
        await child.drain();
        if (child.controller.signal.reason !== BACKGROUND_YIELD) throw error;
      } finally {
        this.batch = undefined;
        this.controller.signal.removeEventListener('abort', abort);
      }
      await this.checkpoint();
    }
  }
  private async drain() { while (this.pendingReads.size) await Promise.allSettled([...this.pendingReads]); }
  stage = 'queued';
  onStage?: () => void;
  ownership?: { jobId?: string; threadId?: string; planId?: string };
  readonly deadlineAt?: number;
  private readonly changed: (stage: string) => void;
  constructor(deadlineAt?: number, changed: (stage: string) => void = () => {}) { this.deadlineAt = deadlineAt; this.changed = changed; }
  start(expired: () => void) {
    if (this.deadlineAt !== undefined) this.timer = setTimeout(() => { this.expire(); expired(); }, Math.max(0, this.deadlineAt - Date.now()));
  }
  private expire() { if (!this.owned && !this.controller.signal.aborted) this.controller.abort(new ManualDeadline(this.stage)); }
  check() {
    if (!this.owned && this.deadlineAt !== undefined && Date.now() >= this.deadlineAt) this.expire();
    this.controller.signal.throwIfAborted();
  }
  get signal() { return this.owned ? undefined : this.controller.signal; }
  get launched() { return this.owned; }
  own(ownership: NonNullable<ReadContext['ownership']>, save: () => void) {
    this.check(); save(); // No asynchronous gap between the final check and durable ownership.
    this.ownership = ownership; this.owned = true; clearTimeout(this.timer); this.setStage(ownership.planId ? 'chain.start' : 't3.launch');
  }
  finish() { clearTimeout(this.timer); }
  setStage(stage: string) { if (stage !== this.stage) { this.stage = stage; this.changed(stage); this.onStage?.(); } }
  run<T>(work: () => Promise<T>) { return current.run(this, work); }
  async read<T>(stage: string, work: (signal?: AbortSignal) => Promise<T>, draining = false): Promise<T> {
    if (!draining) this.check();
    const key = Symbol(); this.reads.set(key, stage); this.setStage([...new Set(this.reads.values())].join(', '));
    const pending = Promise.resolve().then(() => work(draining ? undefined : this.signal));
    this.pendingReads.add(pending);
    try { const result = await pending; if (!draining) this.check(); return result; }
    finally { this.pendingReads.delete(pending); this.reads.delete(key); if (!this.controller.signal.aborted && this.reads.size) this.setStage([...new Set(this.reads.values())].join(', ')); }
  }
}
const BACKGROUND_YIELD = new Error('Background read yielding to a command');
export async function backgroundCheckpoint() {
  const context = readContext(), revision = context?.revision;
  await context?.checkpoint();
  return revision !== context?.revision;
}
// Only wrap disposable reads: publication and external mutations belong after the batch.
export function backgroundRead<T>(work: () => Promise<T>): Promise<T> { return readContext()?.backgroundRead(work) ?? work(); }
export function readPhase<T>(stage: string, work: (signal?: AbortSignal) => Promise<T>, draining = false): Promise<T> {
  return current.getStore()?.read(stage, work, draining) ?? work();
}

// Keep a failed phase open until every read it started has settled.
export async function readAll<T extends unknown[]>(reads: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  try { return await Promise.all(reads); }
  catch (error) { await Promise.allSettled(reads); throw error; }
}
