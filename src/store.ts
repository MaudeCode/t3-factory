import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSelection } from './config.ts';
import type { Difficulty } from './policy.ts';

export interface Job {
  id: string; kind: 'ticket' | 'discovery' | 'upstream'; projectId: string; taskId: string | null;
  // An upstream review covers base..candidate of one watched repository.
  upstream?: { name: string; repo: string; base: string; candidate: string };
  ticketKey: string | null; threadId: string; messageId: string; createdAt: string;
  state: 'dispatching' | 'running' | 'waiting' | 'complete' | 'dismissed'; reason: string;
  lastPersonalActivity: string | null; reportPath: string; command: unknown;
  lastExecutionAt?: string;
  // When reconciliation last saw the job resume from waiting; an awaiting-human report written earlier has been answered.
  resumedAt?: string;
  automationMessageIds?: string[];
  dismissedAt?: string;
  dismissedHead?: string;
  dismissedBranch?: string;
  dismissedWorktreePath?: string;
  modelSelection?: ModelSelection;
  providerDriver?: string;
  modelReason?: string;
  difficulty?: Difficulty;
  prUrls: string[]; completedAt: string | null;
  // Snapshot of the T3 thread from the last reconcile, for the web app.
  thread?: { title: string; status: string; branch: string | null; worktreePath: string | null; updatedAt: string; pending: string | null; background: string[] };
  // A persisted request is never retried until T3 confirms its command roster is empty.
  commandStop?: { status: 'requested' | 'uncertain' | 'confirmed'; requestedAt: string; confirmedAt?: string; error?: string };
  workspaceCleanup?: { path: string; branch: string; head: string };
  workspaceCleanedAt?: string;
  workspaceCleanupError?: string;
  workspaceCleanupBlockedAt?: string;
}
export function jobLabel(job: Pick<Job, 'ticketKey' | 'upstream'>): string {
  return job.ticketKey ?? (job.upstream ? `${job.upstream.name} ${job.upstream.candidate}` : 'Discovery');
}
// A chain: the unfinished tickets that must finish before a target ticket, run in priority order as they unblock.
export interface PlanTicket {
  id: string; key: string; title: string; projectId: string; status: string; priority: string; createdAt: string;
  difficulty?: Difficulty; labelRank?: number; readyLabel: boolean; runnable: boolean; blockedBy: string[]; done: boolean; note?: string;
}
export interface Plan { id: string; createdAt: string; target: PlanTicket; tickets: PlanTicket[]; model: string; overrideLimits: boolean; state: 'active' | 'done' | 'cancelled'; finishedAt?: string }
export interface FactoryEvent { id: number; time: string; kind: string; jobId: string | null; text: string; data: Record<string, unknown> }
const STATE_TEXT: Record<Job['state'], string> = { dispatching: 'is starting', running: 'is running', waiting: 'needs you', complete: 'finished', dismissed: 'was dismissed' };
const STREAM_TEXT: Record<string, string> = {
  'provider-running': 'working', 'provider-disabled': 'automatic starts off', 'waiting-for-idle': 'waiting for idle time', 'quota-exhausted': 'allowance exhausted',
  'quota-budget': 'waiting for budget', 'no-eligible-model': 'no automatic model', 'difficulty-limit': 'nothing within difficulty limits',
  'needs-classification': 'tickets need difficulty labels', 'no-eligible-ticket': 'watching the queue', dispatched: 'starting work', 'would-dispatch': 'ready to start',
};
export function decisionText(result: { reason: string } & Record<string, unknown>): string {
  if (result.reason === 'dispatched') return `Started ${result.ticket ?? (result.upstream ? `review of ${(result.upstream as any).name} ${(result.upstream as any).candidate}` : `discovery for ${result.project}`)} on ${result.model}`;
  if (result.reason === 'error') return `Check failed: ${result.message}`;
  if (result.reason === 'disabled') return 'Automation paused';
  const streams = result.streams as { provider: string; reason: string }[] | undefined;
  if (!streams?.length) return '';
  return streams.map(s => `${s.provider} ${STREAM_TEXT[s.reason] ?? s.reason.replaceAll('-', ' ')}`).join('; ');
}
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(join(dir, 'reports'), { recursive: true, mode: 0o700 });
    const path = join(dir, 'state.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, task_id TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, time TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT, text TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    // task_id is the live claim. Completed and dismissed history retain their ticket IDs in data.
    this.db.exec("UPDATE jobs SET task_id = NULL WHERE task_id IS NOT NULL AND json_extract(data, '$.state') IN ('complete', 'dismissed')");
  }
  jobs(): Job[] { return this.db.prepare('SELECT data FROM jobs ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
  job(id: string): Job | undefined { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.data as string) : undefined; }
  // Every job write passes through here, so the journal records each state change and delivered PR once.
  save(job: Job) {
    const before = this.job(job.id);
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, data=excluded.data').run(job.id, ['complete', 'dismissed'].includes(job.state) ? null : job.taskId, JSON.stringify(job));
    const label = jobLabel(job), detail = { ticketKey: job.ticketKey, projectId: job.projectId, kind: job.kind, state: job.state, model: job.modelSelection?.model, provider: job.providerDriver };
    if (!before) this.record('job.created', `${label} started on ${job.modelSelection?.model ?? 'the assigned model'}`, { ...detail, reason: job.modelReason }, job.id);
    else if (before.state !== job.state) this.record('job.state', `${label} ${STATE_TEXT[job.state]}`, { ...detail, reason: job.reason }, job.id);
    for (const url of job.prUrls ?? []) if (!before?.prUrls?.includes(url)) this.record('job.pr', `${label} opened ${url.replace(/^https:\/\/github\.com\//, '')}`, { ...detail, url }, job.id);
  }
  plans(): Plan[] { return this.db.prepare('SELECT data FROM plans ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
  plan(id: string): Plan | undefined { const row = this.db.prepare('SELECT data FROM plans WHERE id=?').get(id); return row ? JSON.parse(row.data as string) : undefined; }
  savePlan(plan: Plan) {
    const before = this.plan(plan.id);
    this.db.prepare('INSERT INTO plans VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(plan.id, JSON.stringify(plan));
    const detail = { planId: plan.id, ticketKey: plan.target.key, tickets: plan.tickets.map(t => t.key) };
    if (!before) this.record('plan.created', `Chain to ${plan.target.key} started with ${plan.tickets.length} ticket${plan.tickets.length === 1 ? '' : 's'} ahead of it`, detail);
    else if (before.state !== plan.state) this.record('plan.state', `Chain to ${plan.target.key} ${plan.state === 'done' ? 'finished' : 'cancelled'}`, { ...detail, state: plan.state });
  }
  record(kind: string, text: string, data: Record<string, unknown> = {}, jobId: string | null = null) {
    this.db.prepare('INSERT INTO events(time, kind, job_id, text, data) VALUES(?,?,?,?,?)').run(new Date().toISOString(), kind, jobId, text, JSON.stringify(data));
    this.db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) FROM events) - 5000').run();
  }
  events(limit = 100, jobId?: string): FactoryEvent[] {
    const rows = jobId
      ? this.db.prepare('SELECT * FROM events WHERE job_id=? ORDER BY id DESC LIMIT ?').all(jobId, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r => ({ id: r.id as number, time: r.time as string, kind: r.kind as string, jobId: r.job_id as string | null, text: r.text as string, data: JSON.parse(r.data as string) }));
  }
  // Store a decision and journal it only when the outcome changes, so a quiet factory does not flood the log.
  decide(result: { reason: string; at: string } & Record<string, unknown>) {
    const previous = this.get('lastDecision');
    this.set('lastDecision', JSON.stringify(result));
    const text = decisionText(result);
    // Dispatches have job events; routine paused checks are status, not activity.
    if (text && !['dispatched', 'disabled'].includes(result.reason) && (result.reason === 'error' || !previous || decisionText(JSON.parse(previous)) !== text)) this.record('decision', text, { reason: result.reason, streams: (result.streams as unknown[] | undefined)?.map((s: any) => ({ provider: s.provider, reason: s.reason })), message: result.message });
  }
  get(key: string): string | null { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value as string ?? null; }
  set(key: string, value: string) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  claim(): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = Number(this.get('ownerPid'));
      if (owner && owner !== process.pid) {
        try { process.kill(owner, 0); this.db.exec('ROLLBACK'); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      this.set('ownerPid', String(process.pid)); this.db.exec('COMMIT'); return true;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  close() {
    if (Number(this.get('ownerPid')) === process.pid) this.db.prepare("DELETE FROM metadata WHERE key='ownerPid'").run();
    this.db.close();
  }
}
