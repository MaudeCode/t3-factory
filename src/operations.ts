// The existing request record is shared by web, CLI, native submissions and the scheduler.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Operation = {
  id: string; input: unknown; state: 'running' | 'done' | 'failed' | 'pending' | 'uncertain'; createdAt: string;
  result?: { code: number; data: any };
  command?: Record<string, unknown>;
  progress?: { phase: 'queued' | 'checking' | 'launching'; stage: string; acceptedAt: string; updatedAt: string; deadlineAt: string; jobId?: string; threadId?: string; planId?: string };
};
function operationPath(stateDir: string, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid request ID');
  return join(stateDir, 'web-requests', `${id}.json`);
}
export function readOperation(stateDir: string, id: string): Operation | undefined {
  const path = operationPath(stateDir, id);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}
export function saveOperation(stateDir: string, operation: Operation) {
  const path = operationPath(stateDir, operation.id);
  mkdirSync(join(stateDir, 'web-requests'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(operation), { mode: 0o600 });
  renameSync(temporary, path);
}
export function savedOperations(stateDir: string): Operation[] {
  const dir = join(stateDir, 'web-requests');
  return existsSync(dir) ? readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/i.test(n)).map(n => readOperation(stateDir, n.slice(0, -5))!) : [];
}
