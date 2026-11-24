import { canonicalPath } from './workspace.ts';
import { startedWork } from '../web/lib/format.js';
import type { CleanupAction } from './cleanup.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSelection, OverrideLimits, DispatchProvider } from './config.ts';
import type { Difficulty } from './policy.ts';

// A batch's uncertainty protects only targets that have no confirmed or definitively failed outcome.
export function cleanupActionPending(action: CleanupAction, path: string, canonical = canonicalPath): boolean {
  if (!['requested', 'uncertain'].includes(action.state)) return false;
  const target = canonical(path);
  return action.targets.some(t => canonical(t.path) === target) &&
    !action.outcomes.some(o => canonical(o.path) === target && ['confirmed', 'failed'].includes(o.state));
}

export interface Job {
  historyOnly?: boolean;
  sourceIdentity?: { backend: 'kaneo'; projectId: string; taskId: string | null; ticketKey: string | null };
  requestId?: string;
  id: string; kind: 'ticket' | 'discovery' | 'upstream' | 'repair' | 'reconcile'; projectId: string; taskId: string | null;
  // An upstream review covers base..candidate of one watched repository; the commits are those the scheduler verified forward.
  upstream?: { name: string; repo: string; base: string; candidate: string; baseCommit?: string; candidateCommit?: string };
  // A repair covers one failed run of a watched workflow; its report fills in the failed jobs it repaired and those it did not.
  repair?: { workflow: string; runId: number; runUrl: string; sha: string; failedJobs: string[]; repaired?: string[]; unrepaired?: string[] };
  // A reconcile settles the earlier work that holds its ticket back; it records what the scheduler found at the start.
  reconcile?: ReconcileEvidence & { title: string; reason: string };
  ticketKey: string | null; threadId: string; messageId: string; createdAt: string;
  state: 'dispatching' | 'running' | 'waiting' | 'complete' | 'dismissed'; reason: string;
  lastPersonalActivity: string | null; reportPath: string; command?: unknown;
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
  labels?: string[];
  priority?: string;
  prUrls: string[]; completedAt: string | null;
  // Snapshot of the T3 thread from the last reconcile, for the web app.
  thread?: { title: string; status: string; branch: string | null; worktreePath: string | null; updatedAt: string; pending: string | null; background: string[] };
  // A persisted request is never retried until T3 confirms its command roster is empty.
  commandStop?: { status: 'requested' | 'uncertain' | 'confirmed'; requestedAt: string; confirmedAt?: string; error?: string };
  workspaceCleanup?: { path: string; branch: string; head: string };
  workspaceCleanedAt?: string;
  workspaceCleanupError?: string;
  workspaceCleanupBlockedAt?: string;
  workspaceCleanupAttemptedAt?: string;
}
// The earlier work that holds a ticket back: T3 threads that reference it, Git refs that name it, and whether an open PR mentions it.
export interface ReconcileEvidence { threads: string[]; refs: string[]; openPR: boolean }
export function jobLabel(job: Pick<Job, 'ticketKey' | 'upstream' | 'repair'>): string {
  return job.ticketKey ?? (job.upstream ? `${job.upstream.name} ${job.upstream.candidate}` : job.repair ? `${job.repair.workflow} run ${job.repair.runId}` : 'Discovery');
}
// A chain: the unfinished tickets that must finish before a target ticket, run in priority order as they unblock.
// An Epic plan has no target: its tickets are the Epic's unfinished members and their blockers, re-read on every pass.
export interface PlanTicket {
  id: string; key: string; title: string; projectId: string; status: string; priority: string; createdAt: string;
  difficulty?: Difficulty; automationReady?: boolean; labels?: string[]; labelRank?: number; runnable: boolean; blockedBy: string[]; done: boolean; note?: string;
  outside?: boolean; hold?: string; umbrella?: boolean; readiness?: { ready: boolean; reasons: { code: string; message: string }[] };
}
export interface Plan { queued?: boolean; agent?: true; requestId?: string; id: string; createdAt: string; target?: PlanTicket; epic?: { id: string; title: string; restrictedCount?: number; error?: string }; tickets: PlanTicket[]; model: string; provider?: DispatchProvider; overrideLimits: OverrideLimits; state: 'active' | 'done' | 'cancelled'; finishedAt?: string }
// Every ticket of a plan, with any target last.
export const planTickets = (plan: Pick<Plan, 'target' | 'tickets'>) => plan.target ? [...plan.tickets, plan.target] : plan.tickets;
export interface FactoryEvent { id: number; time: string; kind: string; jobId: string | null; text: string; data: Record<string, unknown> }
// A ticket that a T3 session reported creating, with every session and message that reported it.
export interface SessionSource { threadId: string; messageId: string; projectId: string; title: string; at: string }
export interface SessionTicket {
  archived?: boolean;
  // Hidden while Kanvil cannot resolve the identity; retain history and retry in case access returns.
  missing?: boolean;
  taskId: string; projectId: string; key: string; number: number; title: string; priority: string; status: string; labels: string[]; createdAt: string;
  difficulty?: 'low' | 'med' | 'high' | null; automationReady?: boolean; holdReason?: string | null;
  // `refreshedAt` is the last successful tracker read; `refreshAfter` is when the next read is due, later after a failure.
  firstSeenAt: string; refreshedAt: string; refreshAfter?: string; refreshError?: string; sources: SessionSource[];
  // Tombstones: a dismissed or consumed entry never returns to the list, whatever a rescan or refresh finds.
  dismissedAt?: string; consumed?: { jobId: string; at: string };
}
// A ticket reference from a session message or Kanvil tool call, waiting for the tracker to confirm it.
export interface SessionRef { kind: 'key' | 'task' | 'legacy-task' | 'tool'; value: string; messageId: string; at: string; attempts: number; error?: string; retryAfter?: string }
// Scan progress through one session's conversation. `lastOrdinal` is the newest turn item fully processed;
// `backfill` is an unfinished walk back through older history pages toward that mark.
export interface SessionThread {
  id: string; projectId: string; title: string; createdAt: string; updatedAt?: string; lastOrdinal?: number;
  reportVersion?: number;
  backfill?: { cursor: string; updatedAt: string; top: number }; pending: SessionRef[];
  // Undefined until the session's own history has established whether it launches a release review.
  upstreamReview?: boolean;
  // A failed read leaves progress untouched and waits for this deadline before the session is read again.
  retryAfter?: string; error?: string;
}
const STATE_TEXT: Record<Job['state'], string> = { dispatching: 'is starting', running: 'is running', waiting: 'needs you', complete: 'finished', dismissed: 'was dismissed' };
// Every job state but complete and dismissed, as an SQL list; STATE_TEXT's record type keeps it exhaustive.
const LIVE_STATES = Object.keys(STATE_TEXT).filter(state => !['complete', 'dismissed'].includes(state)).map(state => `'${state}'`).join(', ');
const STREAM_TEXT: Record<string, string> = {
  'provider-running': 'working', 'provider-disabled': 'automatic starts off', 'waiting-for-idle': 'waiting for idle time', 'quota-exhausted': 'allowance exhausted',
  'quota-budget': 'waiting for budget', 'no-eligible-model': 'no automatic model', 'difficulty-limit': 'nothing within difficulty limits', 'label-limit': 'label limits are full',
  'needs-classification': 'tickets need difficulty labels', 'no-eligible-ticket': 'watching the queue', dispatched: 'starting work', 'would-dispatch': 'ready to start',
};
export function decisionText(result: { reason: string } & Record<string, unknown>): string {
  if (result.reason === 'dispatched') return `Started ${startedWork(result)} on ${result.model}`;
  if (result.reason === 'error') return `Check failed: ${result.message}`;
  if (result.reason === 'disabled') return 'Automation paused';
  const streams = result.streams as { provider: string; reason: string }[] | undefined;
  if (!streams?.length) return '';
  return streams.map(s => `${s.provider} ${STREAM_TEXT[s.reason] ?? s.reason.replaceAll('-', ' ')}`).join('; ');
}
export type Decision = { reason: string; at: string } & Record<string, unknown>;
export type DecisionOrigin = { workKind: 'tickets' | 'upstream' | 'chains'; providerDriver?: string; manual?: boolean };
type CheckDecision = Decision & { origin?: DecisionOrigin & { sequence: number; startedAt: string }; checks?: Record<string, CheckDecision> };
const decisionKeys = ['lastDecision', 'upstreamDecision', 'chainDecision'] as const;
// Metadata that automatic admission reads, beside jobs and plans: the prepared Up next list, plan order, project rotation, discovery cooldowns and upstream/repair source state.
// Match the status readers' metadata dependencies. A trailing colon denotes a prefix.
const STATUS_METADATA = {
  ticketKeyRevision: ['ticketKeyRevision'], work: ['serviceWork'], streams: ['streams'],
  decision: decisionKeys, upNext: ['upNext'], plans: ['planOrder'],
  epics: ['epics', 'planOrder'], epicDetailsRevision: ['epicDetailsRevision'], epicsError: ['epicsError'],
  triageStreams: ['triageStreams'], triageDecision: ['triageDecision'], triageReports: ['triageReports'],
  triageResults: ['triagePromoted'], sessionTickets: ['sessionCatalog', 'sessionTickets:'],
  upstreams: ['upstreamReviewed:', 'upstreamLatest:', 'upstreamCandidate:', 'upstreamCheckedAt:', 'upstreamCheckError:'],
  repairs: ['repairWatch:'], discovery: ['discoveryLast:', 'discoveryAfter:'],
  cleanupRevision: ['cleanupCatalog', 'cleanupCatalogRefresh'],
};
const STATUS_TABLES = {
  jobs: ['jobs', 'recent', 'upstreams', 'repairs', 'sessionTickets', 'triageResults'],
  job_history: ['recent', 'sessionTickets'], plans: ['plans', 'epics', 'sessionTickets', 'triageResults'],
  session_tickets: ['sessionTickets'], session_threads: ['sessionTickets'],
  cleanup_actions: ['cleanupRevision'], events: ['journal', 'triageResults'],
};
const planState = "json_extract(data, '$.state')";
const planFinished = "julianday(coalesce(json_extract(data, '$.finishedAt'), json_extract(data, '$.createdAt')))";
const listedSessionTicket = ["archived", "missing", "dismissedAt", "consumed"].map(key =>
  `coalesce(json_extract(data, '$.${key}'), 0) IN (0, '')`).join(' AND ');
const statusJobs = {
  upstream: "json_extract(data, '$.upstream') IS NOT NULL",
  repair: "json_extract(data, '$.kind') = 'repair'",
  tickets: "json_extract(data, '$.taskId') IS NOT NULL",
};
const jobValue = (row: string, key: string) => `json_extract(${row}.data, '$.${key}')`;
function statusCondition(table: string, action: string, section: string) {
  const rows = action === 'UPDATE' ? ['old', 'new'] : [action === 'DELETE' ? 'old' : 'new'];
  const either = (condition: (row: string) => string) => rows.map(condition).join(' OR ');
  if (table === 'events' && section === 'triageResults') return either(row => `${row}.kind = 'triage'`);
  if (table !== 'jobs') return '1';
  if (section === 'recent') return either(row => `${jobValue(row, 'state')} IN ('complete', 'dismissed')`);
  if (section === 'upstreams') return either(row => `${jobValue(row, 'upstream')} IS NOT NULL`);
  if (section === 'repairs') return either(row => `${jobValue(row, 'kind')} = 'repair'`);
  if (section === 'sessionTickets' || section === 'triageResults') {
    const started = (row: string) => `CASE WHEN ${jobValue(row, 'state')} <> 'dispatching' OR ${jobValue(row, 'reason')} = 'T3 accepted dispatch' THEN ${jobValue(row, 'taskId')} END`;
    const sources = ['kind', 'threadId'].map(key => `${jobValue('old', key)} IS NOT ${jobValue('new', key)}`);
    if (action !== 'UPDATE') return either(row => `${started(row)} IS NOT NULL OR ${jobValue(row, 'kind')} IN ('upstream', 'discovery')`);
    return [`${started('old')} IS NOT ${started('new')}`, ...(section === 'sessionTickets' ? sources : [])].join(' OR ');
  }
  return '1';
}
const bumpStatus = (section: string, where = '1') =>
  `INSERT INTO revisions SELECT '${section}', 1 WHERE ${where} ON CONFLICT(section) DO UPDATE SET n=n+1;`;

const ADMISSION_KEYS = /^(upNext|planOrder|lastProject)$|^(discoveryAfter|discoveryLast|repairWatch|repairExpect|upstreamReviewed|upstreamLatest|upstreamCandidate|upstreamCheckedAt|upstreamCheckError):/;
// The parts of a job and a plan admission reads. A running job's progress timestamps and a plan's hold notes are display only:
// rows still persist them, but they leave the revision alone. Time policies that read them run on the quiet-pass deadline.
const jobInputs = (job: Job) => JSON.stringify({ ...job, lastExecutionAt: undefined, thread: job.thread && { ...job.thread, updatedAt: undefined } });
const planInputs = (plan: Plan) => JSON.stringify({ ...plan, target: plan.target && { ...plan.target, note: undefined }, tickets: plan.tickets.map(ticket => ({ ...ticket, note: undefined })) });
const newestDecision = (a: CheckDecision, b: CheckDecision) => (b.origin?.sequence ?? 0) - (a.origin?.sequence ?? 0) || b.at.localeCompare(a.at);
function selectDecision(checks: CheckDecision[]): CheckDecision | undefined {
  return checks.filter(check => check.reason === 'error').sort(newestDecision)[0]
    ?? checks.filter(check => check.origin?.manual || !check.origin).sort(newestDecision)[0]
    ?? checks.sort(newestDecision)[0];
}
export class Store {
  db: DatabaseSync;
  /** Changes with every write admission decides from: a job, a plan, an admission key, or a ticket preparation ending. Status, caches and other lanes' state leave it alone. */
  revision = 0;
  private closed = false;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private statement(sql: string) { if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql)); return this.statements.get(sql)!; }
  private readonly locks = new Map<string, Promise<void>>();
  // Ticket locks an admission read found held. Only those move the revision when they go away.
  private readonly observedLocks = new Set<string>();
  onCleanupChange?: (projectIds: string[]) => void;
  onClose?: () => void;
  constructor(dir: string) {
    mkdirSync(join(dir, 'reports'), { recursive: true, mode: 0o700 });
    const path = join(dir, 'state.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, task_id TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_history(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_actions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, time TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT, text TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
      CREATE TRIGGER IF NOT EXISTS events_retention AFTER INSERT ON events BEGIN DELETE FROM events WHERE id <= new.id - 5000; END;
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_threads(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_tickets(task_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_sources(id TEXT PRIMARY KEY, kind TEXT, thread_id TEXT);
      CREATE TRIGGER IF NOT EXISTS jobs_source_insert AFTER INSERT ON jobs BEGIN
        INSERT OR REPLACE INTO job_sources VALUES(new.id, json_extract(new.data, '$.kind'), json_extract(new.data, '$.threadId')); END;
      CREATE TRIGGER IF NOT EXISTS jobs_source_update AFTER UPDATE ON jobs WHEN json_extract(new.data, '$.kind') IS NOT json_extract(old.data, '$.kind') OR json_extract(new.data, '$.threadId') IS NOT json_extract(old.data, '$.threadId') BEGIN
        INSERT OR REPLACE INTO job_sources VALUES(new.id, json_extract(new.data, '$.kind'), json_extract(new.data, '$.threadId')); END;
      CREATE TRIGGER IF NOT EXISTS history_source_insert AFTER INSERT ON job_history BEGIN
        INSERT OR REPLACE INTO job_sources VALUES(new.id, json_extract(new.data, '$.kind'), json_extract(new.data, '$.threadId')); END;
      CREATE INDEX IF NOT EXISTS jobs_recent ON jobs(coalesce(json_extract(data, '$.completedAt'), json_extract(data, '$.dismissedAt'), json_extract(data, '$.createdAt')) DESC) WHERE json_extract(data, '$.state') IN ('complete', 'dismissed');
      CREATE INDEX IF NOT EXISTS history_recent ON job_history(coalesce(json_extract(data, '$.completedAt'), json_extract(data, '$.dismissedAt'), json_extract(data, '$.createdAt')) DESC) WHERE json_extract(data, '$.state') IN ('complete', 'dismissed');`);
    this.db.exec('CREATE TABLE IF NOT EXISTS revisions(section TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      for (const [table, sections] of Object.entries(STATUS_TABLES)) {
        const body = sections.map(section => bumpStatus(section, statusCondition(table, action, section))).join(' ');
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS status_${table}_${action} AFTER ${action} ON ${table} BEGIN ${body} END`);
      }
      // Runs within Store.set's write, including when an older scheduler still owns the database.
      const row = action === 'DELETE' ? 'old' : 'new';
      const body = Object.entries(STATUS_METADATA).map(([section, keys]) => bumpStatus(section, keys.map(key =>
        key.endsWith(':') ? `substr(${row}.key, 1, ${key.length}) = '${key}'` : `${row}.key = '${key}'`).join(' OR '))).join(' ');
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS status_metadata_${action} AFTER ${action} ON metadata BEGIN ${body} END`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS plans_state_finish ON plans(${planState}, ${planFinished});
      CREATE INDEX IF NOT EXISTS session_tickets_visible ON session_tickets((${listedSessionTicket}));
      ${Object.entries(statusJobs).map(([kind, where]) => `CREATE INDEX IF NOT EXISTS jobs_status_${kind} ON jobs((${where}));`).join(' ')}`);
    if (this.get('jobSourcesVersion') !== '1') {
      this.db.exec(`      INSERT OR IGNORE INTO job_sources SELECT id, json_extract(data, '$.kind'), json_extract(data, '$.threadId') FROM job_history;
      INSERT OR REPLACE INTO job_sources SELECT id, json_extract(data, '$.kind'), json_extract(data, '$.threadId') FROM jobs;
`);
      this.set('jobSourcesVersion', '1');
    }
    // Live-job reads search this index instead of parsing every row. SQLite cannot add a STORED column to an existing
    // table without rebuilding it; the index holds the extracted value either way.
    // The web, MCP and scheduler processes can open an old database together; the first to take the write lock adds the column.
    const hasState = () => this.db.prepare('PRAGMA table_xinfo(jobs)').all().some(column => column.name === 'state');
    if (!hasState()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!hasState()) this.db.exec("ALTER TABLE jobs ADD COLUMN state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) VIRTUAL");
        this.db.exec('CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state); COMMIT');
      } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    }
    // task_id is the live claim. Completed and dismissed history retain their ticket IDs in data.
    this.db.exec("UPDATE jobs SET task_id = NULL WHERE task_id IS NOT NULL AND state IN ('complete', 'dismissed')");
  }
  jobs(): Job[] { return this.statement('SELECT data FROM jobs ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
  // Hot inventory reads need lifecycle metadata, not historical dispatch prompts and commands.
  jobSummaries(filter?: keyof typeof statusJobs): Omit<Job, 'command'>[] {
    const source = filter ? `jobs WHERE (${statusJobs[filter]}) = 1` : 'jobs';
    return this.statement(`SELECT json_remove(data, '$.command') AS data FROM ${source} ORDER BY rowid`).all().map(row => JSON.parse(row.data as string));
  }
  // Jobs that are not complete or dismissed, from the state index. `IN` searches the index; `NOT IN` would scan the table.
  activeJobs(): Omit<Job, 'command'>[] { return this.statement(`SELECT json_remove(data, '$.command') AS data FROM jobs WHERE state IN (${LIVE_STATES}) ORDER BY rowid`).all().map(row => JSON.parse(row.data as string)); }
  // The newest completed (not dismissed) jobs, oldest first.
  finishedJobs(limit = 30): Omit<Job, 'command'>[] { return this.statement("SELECT json_remove(data, '$.command') AS data FROM jobs WHERE state = 'complete' ORDER BY rowid DESC LIMIT ?").all(limit).map(row => JSON.parse(row.data as string)).toReversed(); }
  statusRevisions(): Record<string, number> {
    return Object.fromEntries(this.statement('SELECT section, n FROM revisions').all().map(row => [row.section, row.n]));
  }
  // Changes when another connection commits. A reader polls it to learn the scheduler wrote, without reading any rows.
  dataVersion(): number { return this.statement('PRAGMA data_version').get()!.data_version as number; }
  // Calls notify after another connection writes, checking at most once per interval; returns the stop function.
  watch(notify: () => void, intervalMs = 1000, needsRefresh?: () => boolean) {
    let seen = this.dataVersion();
    const timer = setInterval(() => {
      if (this.closed) return clearInterval(timer);
      const now = this.dataVersion(); if (now !== seen || needsRefresh?.()) { seen = now; notify(); }
    }, intervalMs);
    return () => clearInterval(timer);
  }
  // Historical source classification needs identity and kind, never dispatch prompts.
  jobSources(): Pick<Job, 'kind' | 'threadId'>[] {
    return this.statement("SELECT kind, thread_id AS threadId FROM job_sources WHERE EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_sources.id) OR EXISTS (SELECT 1 FROM job_history WHERE job_history.id = job_sources.id)").all() as Pick<Job, 'kind' | 'threadId'>[];
  }
  recentJobs(limit = 15): Omit<Job, 'command'>[] {
    const at = "coalesce(json_extract(data, '$.completedAt'), json_extract(data, '$.dismissedAt'), json_extract(data, '$.createdAt'))";
    return (['jobs', 'job_history'] as const).flatMap(table => this.statement(`SELECT json_remove(data, '$.command') AS data, ${at} AS at FROM ${table} WHERE json_extract(data, '$.state') IN ('complete', 'dismissed') AND ${at} > '' ${table === 'job_history' ? 'AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_history.id)' : ''} ORDER BY ${at} DESC LIMIT ?`).all(limit))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit).map(row => JSON.parse(row.data as string));
  }
  private lock(key: string) {
    const previous = this.locks.get(key), gate = Promise.withResolvers<void>();
    this.locks.set(key, gate.promise);
    // A ticket a lane left out because it was locked can be selected again once its lock is gone, even if no job was written.
    // A release nobody observed changes nothing any decision read, so it leaves the revision alone.
    return { previous, release: () => {
      gate.resolve();
      if (this.locks.get(key) !== gate.promise) return;
      this.locks.delete(key);
      if (this.observedLocks.delete(key)) this.revision++;
    } };
  }
  tryLock(key: string) { if (!this.locks.has(key)) return this.lock(key).release; }
  async exclusive<T>(keys: string[], work: () => Promise<T>): Promise<T> {
    const releases: (() => void)[] = [];
    try {
      for (const key of [...new Set(keys)].sort()) {
        const lease = this.lock(key); releases.push(lease.release); await lease.previous;
      }
      return await work();
    } finally { for (const release of releases.reverse()) release(); }
  }
  isLocked(key: string) {
    const locked = this.locks.has(key);
    if (locked && key.startsWith('ticket:')) this.observedLocks.add(key);
    return locked;
  }
  history(): Omit<Job, 'command'>[] {
    return this.statement("SELECT json_remove(data, '$.command') AS data FROM job_history WHERE id NOT IN (SELECT id FROM jobs) UNION ALL SELECT json_remove(data, '$.command') AS data FROM jobs").all()
      .map(r => JSON.parse(r.data as string)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  archiveJob(job: Job) {
    this.statement('INSERT INTO job_history VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(job.id, JSON.stringify({ ...job, historyOnly: true }));
  }
  job(id: string): Job | undefined { const row = this.statement('SELECT data FROM jobs WHERE id=? UNION ALL SELECT data FROM job_history WHERE id=? LIMIT 1').get(id, id); return row ? JSON.parse(row.data as string) : undefined; }
  // Every job write passes through here, so the journal records each state change and delivered PR once.
  save(job: Job) {
    if (job.historyOnly || this.statement('SELECT id FROM job_history WHERE id=?').get(job.id)) throw new Error('Historical runs are read-only');
    const before = this.job(job.id);
    if (this.statement('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, data=excluded.data WHERE jobs.data != excluded.data OR jobs.task_id IS NOT excluded.task_id').run(job.id, ['complete', 'dismissed'].includes(job.state) ? null : job.taskId, JSON.stringify(job)).changes && (!before || jobInputs(before) !== jobInputs(job))) this.revision++;
    const label = jobLabel(job), detail = { ticketKey: job.ticketKey, projectId: job.projectId, kind: job.kind, state: job.state, model: job.modelSelection?.model, provider: job.providerDriver };
    if (!before) this.record('job.created', `${label} started on ${job.modelSelection?.model ?? 'the assigned model'}`, { ...detail, reason: job.modelReason }, job.id);
    else if (before.state !== job.state) this.record('job.state', `${label} ${STATE_TEXT[job.state]}`, { ...detail, reason: job.reason }, job.id);
    for (const url of job.prUrls ?? []) if (!before?.prUrls?.includes(url)) this.record('job.pr', `${label} opened ${url.replace(/^https:\/\/github\.com\//, '')}`, { ...detail, url }, job.id);
    const lifecycle = (j: Job) => JSON.stringify([j.state, j.thread?.worktreePath, j.thread?.branch, j.thread?.status, j.resumedAt, j.workspaceCleanup?.path, j.dismissedWorktreePath, j.workspaceCleanedAt]);
    if (!before || lifecycle(before) !== lifecycle(job)) this.onCleanupChange?.([...new Set([job.projectId, ...before ? [before.projectId] : []])]);
  }
  cleanupActions(): CleanupAction[] { return this.statement('SELECT data FROM cleanup_actions ORDER BY rowid DESC').all().map(r => JSON.parse(r.data as string)); }
  cleanupAction(id: string): CleanupAction | undefined { const row = this.statement('SELECT data FROM cleanup_actions WHERE id=?').get(id); return row ? JSON.parse(row.data as string) : undefined; }
  saveCleanupAction(action: CleanupAction) {
    const before = this.cleanupAction(action.id);
    this.statement('INSERT INTO cleanup_actions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(action.id, JSON.stringify(action));
    if (!before || action.outcomes.some(outcome => outcome.state === 'confirmed' && outcome.physicalRemoval === true && !before.outcomes.some(old => old.path === outcome.path && old.physicalRemoval === true))) this.onCleanupChange?.([...new Set(action.targets.map(target => target.projectId))]);
  }
  // Plans in the order the scheduler serves them: the owner's saved order first, then the rest as created.
  plans(filter?: 'active' | string): Plan[] {
    const rows = filter === undefined ? this.statement('SELECT data FROM plans ORDER BY rowid').all()
      : filter === 'active' ? this.statement(`SELECT data FROM plans WHERE ${planState} = 'active' ORDER BY rowid`).all()
      : this.statement(`SELECT data FROM plans WHERE ${planState} = 'active' OR (${planState} IN ('done', 'cancelled') AND ${planFinished} > julianday(?)) ORDER BY rowid`).all(filter);
    const plans = rows.map(r => JSON.parse(r.data as string) as Plan);
    const rank = new Map((JSON.parse(this.get('planOrder') || '[]') as string[]).map((id, i) => [id, i]));
    return rank.size ? plans.map((plan, i) => ({ plan, at: rank.get(plan.id) ?? rank.size + i })).sort((a, b) => a.at - b.at).map(row => row.plan) : plans;
  }
  plan(id: string): Plan | undefined { const row = this.statement('SELECT data FROM plans WHERE id=?').get(id); return row ? JSON.parse(row.data as string) : undefined; }
  savePlan(plan: Plan) {
    const before = this.plan(plan.id);
    if (before && before.state !== 'active' && plan.state === 'active') return;
    if (this.statement('INSERT INTO plans VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE plans.data != excluded.data').run(plan.id, JSON.stringify(plan)).changes && (!before || planInputs(before) !== planInputs(plan))) this.revision++;
    const detail = { planId: plan.id, ticketKey: plan.target?.key, epicId: plan.epic?.id, tickets: plan.tickets.map(t => t.key) };
    const name = plan.queued ? `Run ${plan.target!.key}` : plan.epic ? `Epic ${plan.epic.title}` : `Chain to ${plan.target!.key}`, count = `${plan.tickets.length} ticket${plan.tickets.length === 1 ? '' : 's'}`;
    if (!before) this.record('plan.created', plan.queued ? `${name} queued` : `${name} started with ${count}${plan.epic ? '' : ' ahead of it'}`, detail);
    else if (before.state !== plan.state) this.record('plan.state', `${name} ${plan.state === 'done' ? plan.queued && !plan.target?.done ? 'dispatched' : 'finished' : 'cancelled'}`, { ...detail, state: plan.state });
  }
  sessionThreads(): SessionThread[] { return this.statement('SELECT data FROM session_threads ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
  sessionThread(id: string): SessionThread | undefined { const row = this.statement('SELECT data FROM session_threads WHERE id=?').get(id); return row ? JSON.parse(row.data as string) : undefined; }
  saveSessionThread(thread: SessionThread) { this.statement('INSERT INTO session_threads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE data != excluded.data').run(thread.id, JSON.stringify(thread)); }
  sessionTickets(visible = false): SessionTicket[] { return this.statement(visible
    ? `SELECT data FROM session_tickets WHERE (${listedSessionTicket}) = 1 ORDER BY rowid`
    : 'SELECT data FROM session_tickets ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
  sessionTicket(taskId: string): SessionTicket | undefined { const row = this.statement('SELECT data FROM session_tickets WHERE task_id=?').get(taskId); return row ? JSON.parse(row.data as string) : undefined; }
  // Returns the row as stored: a dismissal or consumption already recorded is kept.
  saveSessionTicket(ticket: SessionTicket): SessionTicket {
    const current = this.sessionTicket(ticket.taskId);
    ticket = { ...ticket, ...current?.dismissedAt && !Object.hasOwn(ticket, 'dismissedAt') ? { dismissedAt: current.dismissedAt } : {}, ...current?.consumed && !Object.hasOwn(ticket, 'consumed') ? { consumed: current.consumed } : {} };
    this.statement('INSERT INTO session_tickets VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data WHERE data != excluded.data').run(ticket.taskId, JSON.stringify(ticket));
    return ticket;
  }
  record(kind: string, text: string, data: Record<string, unknown> = {}, jobId: string | null = null) {
    this.statement('INSERT INTO events(time, kind, job_id, text, data) VALUES(?,?,?,?,?)').run(new Date().toISOString(), kind, jobId, text, JSON.stringify(data));
  }
  events(limit = 100, jobId?: string, kind?: string): FactoryEvent[] {
    const rows = jobId
      ? this.statement('SELECT * FROM events WHERE job_id=? ORDER BY id DESC LIMIT ?').all(jobId, limit)
      : kind ? this.statement('SELECT * FROM events WHERE kind=? ORDER BY id DESC LIMIT ?').all(kind, limit)
      // Start at the minimum signed rowid so migrated events with negative IDs stay visible.
      : this.statement('SELECT * FROM events WHERE id >= -9223372036854775808 ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r => ({ id: r.id as number, time: r.time as string, kind: r.kind as string, jobId: r.job_id as string | null, text: r.text as string, data: JSON.parse(r.data as string) }));
  }
  // Capture order before any reads, and share this recorder with nested dispatches and the error path.
  decisionRecorder(origin: DecisionOrigin = { workKind: 'tickets' }) {
    const sequence = Number(this.get('decisionSequence') ?? 0) + 1;
    this.set('decisionSequence', String(sequence));
    const check = { ...origin, sequence, startedAt: new Date().toISOString() };
    return (result: Decision): Decision => { this.decide({ ...result, origin: check }); return result; };
  }
  currentDecision(): Decision | null {
    const decisions = decisionKeys.map(key => JSON.parse(this.get(key) ?? 'null') as CheckDecision | null);
    const selected = decisions.filter((check): check is CheckDecision => !!check);
    const result = selected.filter(check => check.reason === 'error').sort(newestDecision)[0] ?? decisions[0] ?? selected.sort(newestDecision)[0];
    if (!result) return null;
    const { checks, ...decision } = result;
    return decision;
  }
  // Store a decision and journal it only when the outcome changes, so a quiet factory does not flood the log.
  decide(result: CheckDecision) {
    const key = result.origin?.workKind === 'upstream' ? 'upstreamDecision' : result.origin?.workKind === 'chains' ? 'chainDecision' : 'lastDecision';
    let before: CheckDecision | null = JSON.parse(this.get(key) ?? 'null');
    if (result.origin) {
      // Old runtimes misplaced background preflight errors globally. A fresh successful preflight
      // proves that shared read recovered; arbitrary legacy errors retain their warning.
      if (result.reason !== 'error') {
        const global: CheckDecision | null = JSON.parse(this.get('lastDecision') ?? 'null');
        if (global && !global.origin && !global.checks && global.reason === 'error' && /^t3\.(shell|providers) failed\b/.test(String(global.message)) && result.origin.startedAt >= global.at) this.set('lastDecision', 'null');
      }
      const current: CheckDecision | null = JSON.parse(this.get(key) ?? 'null');
      const checks = { ...current?.checks ?? (current && key === 'lastDecision' && current.reason !== 'error' ? { legacy: current } : {}) };
      const lane = result.origin.manual ? 'manual' : result.origin.providerDriver ?? 'all';
      before = checks[lane] ?? null;
      if ((checks[lane]?.origin?.sequence ?? 0) <= result.origin.sequence) {
        checks[lane] = result;
        const selected = selectDecision(Object.values(checks))!;
        this.set(key, JSON.stringify({ ...selected, checks }));
      }
    } else this.set(key, JSON.stringify(result));
    const text = decisionText(result);
    // Dispatches have job events; routine paused checks are status, not activity.
    if (text && !['dispatched', 'disabled'].includes(result.reason) && (result.reason === 'error' || !before || decisionText(before) !== text)) this.record('decision', text, { reason: result.reason, origin: result.origin, streams: (result.streams as unknown[] | undefined)?.map((s: any) => ({ provider: s.provider, reason: s.reason })), message: result.message });
  }
  get(key: string): string | null { return this.statement('SELECT value FROM metadata WHERE key=?').get(key)?.value as string ?? null; }
  set(key: string, value: string) { if (this.statement('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE metadata.value != excluded.value').run(key, value).changes && ADMISSION_KEYS.test(key)) this.revision++; }
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
    if (this.closed) return;
    this.onClose?.();
    if (Number(this.get('ownerPid')) === process.pid) this.statement("DELETE FROM metadata WHERE key='ownerPid'").run();
    this.db.close();
    this.closed = true;
  }
}
