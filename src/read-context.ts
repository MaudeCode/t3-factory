import { AsyncLocalStorage } from 'node:async_hooks';

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
    try { const result = await work(draining ? undefined : this.signal); if (!draining) this.check(); return result; }
    finally { this.reads.delete(key); if (!this.controller.signal.aborted && this.reads.size) this.setStage([...new Set(this.reads.values())].join(', ')); }
  }
}
export function readPhase<T>(stage: string, work: (signal?: AbortSignal) => Promise<T>, draining = false): Promise<T> {
  return current.getStore()?.read(stage, work, draining) ?? work();
}

// Keep a failed phase open until every read it started has settled.
export async function readAll<T extends unknown[]>(reads: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  try { return await Promise.all(reads); }
  catch (error) { await Promise.allSettled(reads); throw error; }
}
