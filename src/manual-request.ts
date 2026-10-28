import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { CycleOptions } from './scheduler.ts';
import { log, safeError } from './scheduler.ts';
import type { ControlResult } from './control.ts';
import { readOperation, saveOperation, type Operation } from './operations.ts';
import { ReadContext, ManualDeadline, readFailure } from './read-context.ts';

type Enqueue = (work: (queueWaitMs: number) => Promise<void>, foreground: boolean, metadata: { reason: string; context: ReadContext; id: string }) => Promise<void>;

export function recoverOperation(stateDir: string, store: Store, operation: Operation) {
  const job = store.jobs().find(j => j.requestId === operation.id);
  const confirmed = job && (job.reason === 'T3 accepted dispatch' || job.thread);
  const plan = store.plans().find(p => p.requestId === operation.id || p.id === operation.progress?.planId);
  if (plan) {
    operation.state = 'done'; operation.result = { code: 0, data: { reason: 'plan-started', planId: plan.id } }; saveOperation(stateDir, operation); return operation.result;
  }
  operation.state = job || operation.progress?.phase === 'launching' ? confirmed ? 'done' : 'uncertain' : 'done';
  operation.result = confirmed ? { code: 0, data: { reason: 'dispatched', jobId: job.id, threadId: job.threadId, ticket: job.ticketKey } }
    : { code: 1, data: { reason: job || operation.progress?.phase === 'launching' ? 'launch-uncertain' : 'scheduler-restarted',
      message: job || operation.progress?.phase === 'launching' ? 'Launch outcome is uncertain. Check the existing run before retrying.' : 'Not launched: scheduler restarted before launch ownership.',
      ...job ? { jobId: job.id, threadId: job.threadId } : {}, ...operation.state === 'uncertain' ? { uncertain: true } : { notLaunched: true } } };
  saveOperation(stateDir, operation);
  return operation.result;
}

export function runManualRequest(c: Config, store: Store, options: CycleOptions, enqueue: Enqueue, pass: (options: CycleOptions, queueWaitMs: number) => Promise<{ reason: string } & Record<string, unknown>>, requests = new Map<string, Promise<ControlResult>>(), finished: (operation: Operation) => void = () => {}, controlReceivedAt?: string): Promise<ControlResult> {
  const id = options.requestId ?? randomUUID(), command = { ...options, requestId: id, manual: true };
  const prior = readOperation(c.stateDir, id);
  if (prior?.command && !isDeepStrictEqual(prior.command, command)) return Promise.resolve({ code: 1, data: { message: 'Request ID already belongs to another command' } });
  const running = requests.get(id);
  if (running) return running;
  if (prior && !prior.command && ['done', 'failed', 'uncertain'].includes(prior.state)) return Promise.resolve(prior.result ?? { code: 1, data: { reason: 'launch-uncertain', uncertain: true, message: 'This legacy request has no confirmed outcome. Inspect its existing run before starting another request.' } });
  if (prior?.command) {
    if (prior.state === 'uncertain') return Promise.resolve(recoverOperation(c.stateDir, store, prior));
    return Promise.resolve(prior.result ?? recoverOperation(c.stateDir, store, prior));
  }
  const now = Date.now(), received = Date.parse(prior?.createdAt ?? '');
  const accepted = Number.isFinite(received) ? Math.min(received, now) : now;
  const operation: Operation = { ...prior, id, input: prior?.input ?? command, command, state: 'running', createdAt: prior?.createdAt ?? new Date(accepted).toISOString(),
    progress: { phase: 'queued', stage: 'queued', acceptedAt: new Date(accepted).toISOString(), updatedAt: new Date(now).toISOString(), deadlineAt: new Date(accepted + c.manualPrelaunchSeconds * 1000).toISOString(), controlReceivedAt, schedulerAcceptedAt: new Date(now).toISOString() } };
  log('manual-accepted', { requestId: id, receivedAt: prior?.createdAt ?? new Date(accepted).toISOString(), controlReceivedAt, acceptedAt: new Date(now).toISOString(), admissionMs: now - accepted });
  const publish = () => { saveOperation(c.stateDir, operation); };
  const context = new ReadContext(Date.parse(operation.progress!.deadlineAt), stage => {
    const previous = operation.progress!;
    log('manual-phase', { requestId: id, stage: previous.stage, ms: Date.now() - Date.parse(previous.updatedAt) });
    operation.progress = { ...previous, ...context.ownership, stage, phase: context.launched ? 'launching' : previous.phase, updatedAt: new Date().toISOString() }; publish();
  });
  publish();
  let finish!: (result: ControlResult) => void;
  const result = new Promise<ControlResult>(resolve => { finish = resolve; });
  requests.set(id, result);
  const settle = (result: ControlResult) => {
    if (operation.state !== 'running') return;
    log('manual-phase', { requestId: id, stage: context.stage, ms: Date.now() - Date.parse(operation.progress!.updatedAt), outcome: (result.data as any)?.reason });
    operation.state = (result.data as any)?.uncertain ? 'uncertain' : 'done'; operation.result = result;
    try { publish(); finished(operation); }
    catch (error) { result = { code: 1, data: { uncertain: true, message: `Could not persist the request outcome: ${safeError(error)}. Check factory status before retrying.` } }; }
    context.finish(); context.onStage?.(); finish(result); requests.delete(id);
  };
  const failure = (error: unknown) => {
    if (operation.state !== 'running') return;
    const deadline = context.controller.signal.reason instanceof ManualDeadline ? context.controller.signal.reason : error;
    const stage = deadline instanceof ManualDeadline ? deadline.stage : readFailure(error)?.stage ?? context.stage;
    log('manual-request-failed', { requestId: id, stage, message: safeError(deadline), launched: context.launched });
    settle({ code: 1, data: { reason: context.launched ? 'launch-uncertain' : deadline instanceof ManualDeadline ? 'manual-deadline-exceeded' : 'error', message: safeError(deadline), stage,
      ...context.launched ? { uncertain: true, ...context.ownership } : { notLaunched: true } } });
  };
  context.start(() => { if (operation.progress?.phase === 'queued') failure(context.controller.signal.reason); });
  void enqueue(async queueWaitMs => {
    context.check();
    operation.progress!.phase = 'checking'; context.setStage('checking'); publish();
    const decision = await pass(command, queueWaitMs);
    context.check();
    settle({ code: ['dispatched', 'would-dispatch', 'plan-started'].includes(decision.reason) ? 0 : 1, data: decision });
  }, true, { reason: 'dispatch', context, id }).catch(failure);
  return result;
}

