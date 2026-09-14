import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { threadSchema } from './policy.ts';
import type { Config } from './config.ts';
import { callT3Rpc } from './rpc.ts';

export class T3 {
  readonly config: Config['t3'];
  constructor(config: Config['t3']) { this.config = config; }
  async request(path: string, body?: unknown): Promise<unknown> {
    const credential = z.object({ token: z.string().min(1), expiresAt: z.string().optional() }).passthrough().parse(JSON.parse(readFileSync(this.config.credentialFile, 'utf8')));
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) throw new Error('T3 scheduler credential expired');
    const r = await fetch(new URL(path, this.config.url), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`T3 ${path} returned HTTP ${r.status}`);
    return r.json();
  }
  async shell() {
    return z.object({ threads: z.array(threadSchema), projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }).passthrough()) }).parse(await this.request('/api/orchestration/shell'));
  }
  async detail(id: string) {
    return z.object({ thread: z.object({
      messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string(), createdAt: z.string() }).passthrough()),
      activities: z.array(z.object({ kind: z.string(), createdAt: z.string() }).passthrough()),
    }).passthrough() }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(id)}?turnLimit=1`)).thread;
  }
  async socketUrl() {
    const ticket = z.object({ ticket: z.string() }).passthrough().parse(await this.request('/api/auth/websocket-ticket', {}));
    const socket = new URL('/ws', this.config.url); socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    socket.searchParams.set('wsTicket', ticket.ticket);
    return socket.toString();
  }
  async dispatch(command: unknown) {
    // Worktree bootstrap is implemented by the RPC handler, not the plain HTTP dispatcher.
    return callT3Rpc(await this.socketUrl(), { type: 'dispatch', command });
  }
  async providers(refreshInstance?: string) {
    const data = z.object({ providers: z.array(z.object({
      instanceId: z.string(), driver: z.string(), status: z.string(), installed: z.boolean(), enabled: z.boolean(),
      models: z.array(z.object({ slug: z.string(), aliases: z.array(z.string()).optional() }).passthrough()),
      usageLimits: z.object({ checkedAt: z.string(), unavailable: z.unknown().optional(), windows: z.array(z.object({
        id: z.string(), usedPercent: z.number(), resetsAt: z.string().optional(), windowDurationMins: z.number().optional(),
      }).passthrough()) }).passthrough().optional(),
    }).passthrough()) }).parse(await callT3Rpc(await this.socketUrl(), { type: 'provider', ...(refreshInstance ? { refreshInstance } : {}) }));
    return data.providers;
  }
  async provider(instanceId: string, refresh = false) {
    const provider = (await this.providers(refresh ? instanceId : undefined)).find(p => p.instanceId === instanceId);
    if (!provider) throw new Error(`T3 provider ${instanceId} not found`);
    return provider;
  }
}

export class Kaneo {
  client = new Client({ name: 't3-factory', version: '0.1.0' });
  readonly config: Config['kaneo'];
  constructor(config: Config['kaneo']) { this.config = config; }
  async connect() {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const entry = fileURLToPath(new URL('../node_modules/@kaneo/mcp/dist/index.js', import.meta.url));
    await this.client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, 'serve'], env: { ...env, KANEO_API_URL: this.config.url }, stderr: 'pipe' }));
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const r = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
    if (r.isError) throw new Error(`Kaneo ${name} failed; check its authenticated connection`);
    const text = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).parse(r).content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    return JSON.parse(text);
  }
  async close() { await this.client.close(); }
}

export const taskSchema = z.object({
  id: z.string(), projectId: z.string(), title: z.string(), number: z.number(),
  description: z.string().nullable().optional(), priority: z.enum(['urgent', 'high', 'medium', 'low', 'no-priority']),
  status: z.string(), createdAt: z.string(), labels: z.array(z.object({ name: z.string() }).passthrough()).optional(),
}).passthrough();
export type Task = z.infer<typeof taskSchema>;
export async function listTasks(kaneo: Kaneo, projectId: string): Promise<Task[]> {
  const tasks = new Map<string, Task>();
  for (let page = 1; ; page++) {
    const listedTask = taskSchema.extend({ labels: z.array(z.object({ name: z.string() }).passthrough()) });
    const r = z.object({ data: z.object({ workspaceId: z.string(), columns: z.array(z.object({ tasks: z.array(listedTask) })) }), pagination: z.object({ totalPages: z.number(), total: z.number() }) }).parse(await kaneo.call('list_tasks', { projectId, page, limit: 100 }));
    if (r.data.workspaceId !== kaneo.config.workspaceId) throw new Error('Kaneo workspace mismatch');
    for (const col of r.data.columns) for (const task of col.tasks) {
      if (task.projectId !== projectId) throw new Error('Kaneo project mismatch');
      tasks.set(task.id, task);
    }
    if (page >= r.pagination.totalPages) break;
    if (page > 100) throw new Error('Kaneo pagination exceeded 100 pages');
  }
  return [...tasks.values()];
}
