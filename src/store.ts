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
  workspaceCleanup?: { path: string; branch: string; head: string };
  workspaceCleanedAt?: string;
  workspaceCleanupError?: string;
  workspaceCleanupBlockedAt?: string;
}
export function jobLabel(job: Pick<Job, 'ticketKey' | 'upstream'>): string {
  return job.ticketKey ?? (job.upstream ? `${job.upstream.name} ${job.upstream.candidate}` : 'Discovery');
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
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // task_id is the live claim. Completed and dismissed history retain their ticket IDs in data.
    this.db.exec("UPDATE jobs SET task_id = NULL WHERE task_id IS NOT NULL AND json_extract(data, '$.state') IN ('complete', 'dismissed')");
  }
  jobs(): Job[] { return this.db.prepare('SELECT data FROM jobs ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
  save(job: Job) { this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, data=excluded.data').run(job.id, ['complete', 'dismissed'].includes(job.state) ? null : job.taskId, JSON.stringify(job)); }
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
