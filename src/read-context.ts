import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

// Like cleanup's signal, but scoped here so every existing integration caller shares the deadline.
const current = new AsyncLocalStorage<ReadContext>();
export const readContext = () => current.getStore();
// Consumers can stop waiting for a shared read without cancelling its owner or its siblings.
export function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
// Keep the original thrown value: cancellation and SDK callers rely on its identity.
const failures = new WeakMap<object, { stage: string; elapsedMs: number }>();
export const readFailure = (error: unknown) => error !== null && typeof error === 'object' ? failures.get(error) : undefined;
export class ManualDeadline extends Error {
  readonly stage: string;
  constructor(stage: string) { super(`Not launched: manual request deadline exceeded during ${stage}`); this.stage = stage; }
}
export class ReadContext {
  readonly startedAt = Date.now();
  readonly startedAtMonotonic = performance.now();
  readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private reads = new Map<symbol, string>();
  private owned = false;
  private readonly pendingReads = new Set<Promise<unknown>>();
  private stopping = false;
  stopBackground() { this.stopping = true; this.controller.abort(new Error('Scheduler stopping')); }
  async checkpoint() {
    if (this.stopping) throw new Error('Scheduler stopping');
    this.check(); await yieldToEventLoop(); this.check();
  }
  async backgroundRead<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    try { const value = await work(); await this.drain(); this.check(); return value; }
    catch (error) { await this.drain(); throw error; }
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
    if (!this.owned) this.controller.signal.throwIfAborted();
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
// Each automatic/chain admission owns its mutation boundary, even within one provider batch.
export async function independentOperation<T>(work: () => Promise<T>): Promise<T> {
  const parent = readContext(), context = new ReadContext();
  const abort = () => context.stopBackground();
  parent?.controller.signal.addEventListener('abort', abort, { once: true });
  if (parent?.controller.signal.aborted) abort();
  context.onStage = () => parent?.setStage(context.stage);
  try { return await context.run(work); }
  finally { parent?.controller.signal.removeEventListener('abort', abort); }
}
export async function backgroundCheckpoint() {
  await readContext()?.checkpoint();
}
// Only wrap disposable reads: publication and external mutations belong after the batch.
export function backgroundRead<T>(work: () => Promise<T>): Promise<T> { return readContext()?.backgroundRead(work) ?? work(); }
export async function readPhase<T>(stage: string, work: (signal?: AbortSignal) => Promise<T>, draining = false): Promise<T> {
  const started = performance.now();
  try { return await (current.getStore()?.read(stage, work, draining) ?? work()); }
  catch (error) {
    if (error !== null && typeof error === 'object' && !failures.has(error)) failures.set(error, { stage, elapsedMs: Math.round(performance.now() - started) });
    throw error;
  }
}

// Keep a failed phase open until every read it started has settled.
export async function readAll<T extends unknown[]>(reads: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  try { return await Promise.all(reads); }
  catch (error) { await Promise.allSettled(reads); throw error; }
}
