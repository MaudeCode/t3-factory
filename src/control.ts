import type { CleanupRequest } from './cleanup.ts';
// The running scheduler answers commands over a Unix socket in its state directory, so the CLI and
// the web server hand work to the process that already holds the clients and the store instead of
// racing it for the SQLite claim. Without a running scheduler, callers fall back to doing the work.
import { createServer, request, type Server } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type ControlCommand =
  | { type: 'dispatch'; options: Record<string, unknown> }
  | { type: 'wake'; reason?: string }
  | { type: 'once'; options: Record<string, unknown> }
  | { type: 'job-stop'; jobId: string }
  | { type: 'plan-cancel'; planId: string }
  | { type: 'session-dismiss'; taskId: string }
  | { type: 'cleanup'; input: CleanupRequest; operator?: string }
  | { type: 'cleanup-cancel'; inspectionId: string }
  | { type: 'health' };
export type ControlResult = { code: number; data: unknown };
export const controlPath = (stateDir: string) => join(stateDir, 'control.sock');

export function serveControl(stateDir: string, handle: (command: ControlCommand) => Promise<ControlResult>): Server {
  const path = controlPath(stateDir);
  if (existsSync(path)) unlinkSync(path); // A stale socket from a crashed run; the claim already proves we own the directory.
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let result: ControlResult;
      try {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{"type":"health"}') as ControlCommand;
        result = await handle(command);
      } catch (error) { result = { code: 1, data: { message: String(error instanceof Error ? error.message : error).slice(0, 800) } }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  server.listen(path);
  return server;
}

// null when no scheduler is listening, so the caller can do the work itself.
// A dispatch or a pass may take as long as the scheduler needs; the socket only gives up on it when the scheduler is gone.
export function callControl(stateDir: string, command: ControlCommand, timeoutMs = 0): Promise<ControlResult | null> {
  const socketPath = controlPath(stateDir);
  if (!existsSync(socketPath)) return Promise.resolve(null);
  // Only a failure before the request reached the scheduler means "no scheduler"; after that the outcome is unknown and
  // must not be retried locally, because the scheduler may already have started the work.
  const uncertain = { code: 1, data: { message: 'The scheduler stopped answering after taking the request. Check factory status before starting another run.', uncertain: true } };
  return new Promise(resolve => {
    let sent = false;
    const req = request({ socketPath, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(uncertain); } });
    });
    req.on('finish', () => { sent = true; }); // the request body reached the socket, so the scheduler may act on it
    req.on('error', () => resolve(sent ? uncertain : null));
    if (timeoutMs) req.on('timeout', () => { req.destroy(); resolve({ code: 1, data: { message: 'The scheduler did not answer in time' } }); });
    req.end(JSON.stringify(command));
  });
}

// Translate a CLI argument list into a control command, or undefined for commands the scheduler does not take.
export function commandFor(args: string[]): ControlCommand | undefined {
  if (args[0] === 'once' || args[0] === 'doctor') return { type: 'once', options: { dryRun: args.includes('--dry-run'), doctor: args[0] === 'doctor' } };
  if (args[0] === 'job-stop' && args[1]) return { type: 'job-stop', jobId: args[1] };
  if (args[0] === 'plan-cancel' && args[1]) return { type: 'plan-cancel', planId: args[1] };
  if (args[0] === 'cleanup-cancel' && args[1]) return { type: 'cleanup-cancel', inspectionId: args[1] };
  if (args[0] === 'session-dismiss' && args[1]) return { type: 'session-dismiss', taskId: args[1] };
  if (args[0] !== 'dispatch') return undefined;
  return { type: 'dispatch', options: dispatchOptions(args.slice(1)) };
}
// The one parser for dispatch arguments, shared by the CLI and the socket.
export function dispatchOptions(args: string[]): { manual: true; ticket?: string; upstream?: string; model?: string; overrideLimits?: boolean; allowMissingReadyLabel?: boolean; dryRun?: boolean; chain?: 'first' | 'all' } {
  const options: ReturnType<typeof dispatchOptions> = { manual: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ticket') { options.ticket = args[++i]; if (!options.ticket) throw new Error('--ticket requires a ticket key'); }
    else if (args[i] === '--upstream') {
      const value = args[++i];
      if (!/^[\w.-]+\/[\w.-]+$/.test(value ?? '')) throw new Error('--upstream requires owner/repo');
      options.upstream = value.toLowerCase();
    } else if (args[i] === '--model') {
      const value = args[++i];
      if (!/^[a-z][a-z0-9-]*$/.test(value ?? '')) throw new Error('--model requires auto or a configured model ID');
      options.model = value;
    } else if (args[i] === '--chain') {
      const value = args[++i];
      if (value !== 'first' && value !== 'all') throw new Error('--chain requires first or all');
      options.chain = value;
    } else if (args[i] === '--override-limits') options.overrideLimits = true;
    else if (args[i] === '--allow-missing-ready-label') options.allowMissingReadyLabel = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown dispatch argument: ${args[i]}`);
  }
  if (options.upstream && (options.ticket || options.chain || options.allowMissingReadyLabel)) throw new Error('--upstream cannot be combined with ticket options');
  return options;
}
