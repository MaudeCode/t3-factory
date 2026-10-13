// The running scheduler answers commands over a Unix socket in its state directory, so the CLI and
// the web server hand work to the process that already holds the clients and the store instead of
// racing it for the SQLite claim. Without a running scheduler, callers fall back to doing the work.
import { createServer, request, type Server } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type ControlCommand =
  | { type: 'dispatch'; options: Record<string, unknown> }
  | { type: 'wake'; reason?: string }
  | { type: 'job-stop'; jobId: string }
  | { type: 'plan-cancel'; planId: string }
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
export function callControl(stateDir: string, command: ControlCommand, timeoutMs = 180_000): Promise<ControlResult | null> {
  const socketPath = controlPath(stateDir);
  if (!existsSync(socketPath)) return Promise.resolve(null);
  return new Promise(resolve => {
    const req = request({ socketPath, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve({ code: 1, data: { message: 'The scheduler did not answer in time' } }); });
    req.end(JSON.stringify(command));
  });
}

// Translate a CLI argument list into a control command, or undefined for commands the scheduler does not take.
export function commandFor(args: string[]): ControlCommand | undefined {
  if (args[0] === 'once' && !args.includes('--dry-run')) return { type: 'wake', reason: 'once' };
  if (args[0] === 'job-stop' && args[1]) return { type: 'job-stop', jobId: args[1] };
  if (args[0] === 'plan-cancel' && args[1]) return { type: 'plan-cancel', planId: args[1] };
  if (args[0] !== 'dispatch') return undefined;
  const options: Record<string, unknown> = { manual: true };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--ticket') options.ticket = args[++i];
    else if (args[i] === '--model') options.model = args[++i];
    else if (args[i] === '--override-limits') options.overrideLimits = true;
    else if (args[i] === '--allow-missing-ready-label') options.allowMissingReadyLabel = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--chain') options.chain = args[++i];
    else throw new Error(`Unknown dispatch argument: ${args[i]}`);
  }
  return { type: 'dispatch', options };
}
