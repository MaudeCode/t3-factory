// A stdio MCP server that lets agents read and steer the running factory. Every write goes through the scheduler's
// control socket, so agents get the same limits and locks as the CLI and web app. Triage decisions (they are recorded as the owner's) and settings are not exposed.
// `dispatch` takes limit overrides, a model and a provider only from the owner's sessions: it sends this server's working directory,
// and the scheduler refuses them when that is inside an unfinished run's worktree (`refuseRunCaller`), so runs cannot lift limits for work they queue.
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { z } from 'zod';
import { callControl, dispatchOptions, type ControlCommand } from './control.ts';
import { dispatchProviderSchema, overridableLimits } from './config.ts';

const id = z.string().regex(/^[\w-]{1,64}$/);
type Tool = { description: string; input: z.ZodObject; command?: (input: any) => ControlCommand; read?: (stateDir: string) => unknown };
// Status fields an agent needs to pick a run, plan or report; the rest of status.json feeds the web page.
const statusFields = ['enabled', 'concurrency', 'work', 'decision', 'upNext', 'plans', 'jobs', 'recent'] as const;

export const tools: Record<string, Tool> = {
  factory_status: {
    description: 'Factory state: whether dispatch is enabled, concurrency, the current decision, up next, Epic plans, and runs (jobs) and recent runs.',
    input: z.object({}).strict(),
    read: stateDir => {
      const file = join(stateDir, 'status.json');
      if (!existsSync(file)) throw new Error('The factory has not written its status yet');
      const status = JSON.parse(readFileSync(file, 'utf8'));
      return Object.fromEntries(statusFields.map(key => [key, status[key]]));
    },
  },
  get_ticket: {
    description: 'Read a ticket in a configured project as the factory sees it, including readiness and its runs. Inbox reports are not readable here.',
    input: z.object({ key: z.string().regex(/^[A-Za-z0-9]{1,32}-\d{1,9}$/) }).strict(),
    command: ({ key }) => ({ type: 'ticket', key: key.toUpperCase(), agent: true }),
  },
  dispatch: {
    description: 'Queue factory work now: one ticket (optionally with its dependency chain), an Epic plan, or an upstream review. Without overrideLimits, model or provider, normal limits apply, including the quota reserve and idle time, and the model is chosen automatically from presets marked automatic; the result says why work did not start. overrideLimits, model and provider start it as the owner would from the CLI; they are refused when the call comes from a factory run (its worktree). Omit all targets to let the factory pick the next ticket.',
    input: z.object({
      ticket: z.string().regex(/^[A-Za-z0-9]{1,32}-\d{1,9}$/).optional(),
      epic: id.optional(),
      upstream: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe('owner/repo'),
      chain: z.enum(['first', 'all']).optional().describe('With ticket: start its first blocker, or run the whole chain'),
      overrideLimits: z.union([z.literal(true), z.array(z.enum(overridableLimits)).min(1)]).optional().describe('true for every limit, or the limits to lift for this dispatch and its chain or plan. Not available to factory runs'),
      model: z.string().max(64).optional().describe('auto or a model preset ID. Not available to factory runs'),
      provider: dispatchProviderSchema.optional().describe('With automatic model selection: the provider to use. Not available to factory runs'),
      dryRun: z.boolean().optional(),
    }).strict(),
    command: input => {
      const owner = input.overrideLimits !== undefined || input.model !== undefined || input.provider !== undefined;
      const limits = input.overrideLimits === true ? ['--override-limits'] : input.overrideLimits ? ['--override', input.overrideLimits.join(',')] : [];
      return { type: 'dispatch', ...owner ? { callerCwd: process.cwd() } : {}, options: dispatchOptions([...owner ? [] : ['--agent'],
        ...input.ticket ? ['--ticket', input.ticket.toUpperCase()] : [], ...input.epic ? ['--epic', input.epic] : [],
        ...input.upstream ? ['--upstream', input.upstream] : [], ...input.chain ? ['--chain', input.chain] : [], ...limits,
        ...input.model ? ['--model', input.model] : [], ...input.provider ? ['--provider', input.provider] : [],
        ...input.dryRun ? ['--dry-run'] : [],
      ]) };
    },
  },
  stop_run: {
    description: 'Stop a running factory run by its job ID.',
    input: z.object({ jobId: id }).strict(),
    command: ({ jobId }) => ({ type: 'job-stop', jobId }),
  },
  dismiss_run: {
    description: 'Dismiss a run whose T3 thread was deleted. resetTicket returns its ticket to the ready queue.',
    input: z.object({ jobId: id, resetTicket: z.boolean().default(false) }).strict(),
    command: ({ jobId, resetTicket }) => ({ type: 'job-dismiss', jobId, resetTicket }),
  },
  cancel_plan: {
    description: 'Cancel an active Epic plan. Runs already started continue.',
    input: z.object({ planId: id }).strict(),
    command: ({ planId }) => ({ type: 'plan-cancel', planId }),
  },
  order_plans: {
    description: 'Set the order active Epic plans are worked in.',
    input: z.object({ planIds: z.array(id).min(1).max(200) }).strict(),
    command: ({ planIds }) => ({ type: 'plan-order', planIds }),
  },
};

const text = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...isError ? { isError } : {} });

async function callTool(stateDir: string, name: string, args: unknown) {
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
  if (!tool) return text({ message: `Unknown tool: ${name}` }, true);
  try {
    const input = tool.input.parse(args ?? {});
    if (tool.read) return text(tool.read(stateDir));
    const result = await callControl(stateDir, tool.command!(input));
    if (!result) return text({ message: 'The factory scheduler is not running' }, true);
    return text(result.data, result.code !== 0);
  } catch (error) {
    return text({ message: error instanceof z.ZodError ? z.prettifyError(error) : String(error instanceof Error ? error.message : error) }, true);
  }
}

// One JSON-RPC message in, its response out (undefined for notifications).
export async function handleMcp(stateDir: string, message: { id?: string | number; method?: string; params?: any }) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.id === undefined) return undefined;
  if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't3-factory', version: '0.1.0' } });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: z.toJSONSchema(tool.input, { io: 'input' }) })) });
  if (message.method === 'tools/call') return reply(await callTool(stateDir, message.params?.name, message.params?.arguments));
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
}

export function serveMcp(stateDir: string) {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async line => {
    if (!line.trim()) return;
    let response;
    try { response = await handleMcp(stateDir, JSON.parse(line)); }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });
}
