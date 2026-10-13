import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { threadSchema, humanRequest, ORPHANED_RUN_GRACE_MINUTES, type Thread } from './policy.ts';
import type { Config } from './config.ts';
import { callT3Rpc, subscribeT3Shell } from './rpc.ts';

/** T3 orchestration protocol this client speaks; T3 rejects other versions. */
export const ORCHESTRATION_PROTOCOL = 2;
const ORCHESTRATION_PROTOCOL_HEADER = 'x-t3-orchestration-protocol', ORCHESTRATION_PROTOCOL_QUERY_PARAM = 'orchestrationProtocol';

export class T3 {
  readonly config: Config['t3'];
  private readonly orphanVerdicts = new Map<string, boolean>();
  // One provider read serves a whole scheduler pass; a refresh replaces it. reset() starts the next pass.
  private providerSnapshot?: Promise<Awaited<ReturnType<T3['readProviders']>>>;
  reset() { this.providerSnapshot = undefined; }
  constructor(config: Config['t3']) { this.config = config; }
  async request(path: string, body?: unknown): Promise<unknown> {
    const credential = z.object({ token: z.string().min(1), expiresAt: z.string().optional() }).passthrough().parse(JSON.parse(readFileSync(this.config.credentialFile, 'utf8')));
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) throw new Error('T3 scheduler credential expired');
    const r = await fetch(new URL(path, this.config.url), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 400) await this.assertProtocol();
    if (!r.ok) throw new Error(`T3 ${path} returned HTTP ${r.status}`);
    return r.json();
  }
  /** T3 rejects an unsupported protocol header with a bare 400; name the mismatch when its descriptor shows one. */
  private async assertProtocol() {
    let server: number;
    try {
      const r = await fetch(new URL('/.well-known/t3/environment', this.config.url), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      // Hosts from before protocol negotiation omit the version and speak v1.
      server = z.object({ orchestrationProtocolVersion: z.number().int().optional() }).passthrough().parse(await r.json()).orchestrationProtocolVersion ?? 1;
    } catch { return; }
    if (server !== ORCHESTRATION_PROTOCOL) throw new Error(`T3 orchestration protocol mismatch (scheduler speaks v${ORCHESTRATION_PROTOCOL}, server requires v${server})`);
  }
  async shell() {
    const shell = z.object({ threads: z.array(threadSchema), projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }).passthrough()) }).parse(await this.request('/api/orchestration/shell'));
    const candidates = new Set<string>();
    // Probe concurrently so slow reads cost one request timeout, not one per stale thread.
    await Promise.all(shell.threads.map(async t => {
      if (t.activeRunId == null || (t.pendingRuntimeRequest != null && humanRequest(t.pendingRuntimeRequest.kind)) || Date.now() - Date.parse(t.updatedAt) < ORPHANED_RUN_GRACE_MINUTES * 60_000) return;
      const key = `${t.id}:${t.updatedAt}`;
      candidates.add(key);
      if (!this.orphanVerdicts.has(key)) {
        const verdict = await this.orphaned(t);
        if (verdict !== undefined) this.orphanVerdicts.set(key, verdict); // Retry failed reads next cycle.
      }
      if (this.orphanVerdicts.get(key)) t.orphanedRun = true;
    }));
    for (const key of this.orphanVerdicts.keys()) if (!candidates.has(key)) this.orphanVerdicts.delete(key);
    return shell;
  }
  /** T3 can leave a run active after its provider session stopped. Any doubt keeps the run executing. */
  private async orphaned(t: Thread): Promise<boolean | undefined> {
    try {
      const { projection } = z.object({ projection: z.object({
        runs: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
        providerSessions: z.array(z.object({ status: z.string() }).passthrough()),
      }).passthrough() }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(t.id)}/bounded`));
      const run = projection.runs.find(r => r.id === t.activeRunId);
      return !!run && ['preparing', 'starting', 'running', 'waiting'].includes(run.status) &&
        projection.providerSessions.length > 0 && projection.providerSessions.every(s => ['stopped', 'error'].includes(s.status));
    } catch { return undefined; }
  }
  async detail(id: string) {
    // The bounded snapshot keeps every runtime request and the recent conversation window.
    const { projection } = z.object({ projection: z.object({
      messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string(), createdAt: z.string() }).passthrough()),
      runtimeRequests: z.array(z.object({ kind: z.string(), status: z.string(), resolvedAt: z.string().nullable() }).passthrough()),
    }).passthrough() }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(id)}/bounded`));
    // Tool calls and auth refreshes resolve without a person; approvals and questions need one.
    const responses = projection.runtimeRequests.filter(r => r.status === 'resolved' && r.resolvedAt && humanRequest(r.kind)).map(r => ({ createdAt: r.resolvedAt! }));
    return { messages: projection.messages, responses };
  }
  async socketUrl() {
    const ticket = z.object({ ticket: z.string() }).passthrough().parse(await this.request('/api/auth/websocket-ticket', {}));
    const socket = new URL('/ws', this.config.url); socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    socket.searchParams.set('wsTicket', ticket.ticket);
    socket.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL));
    return socket.toString();
  }
  async dispatch(command: unknown) {
    return callT3Rpc(await this.socketUrl(), { type: 'dispatch', command });
  }
  async launch(input: unknown) {
    // Thread launch prepares the worktree and runs the project setup script; plain dispatch does not.
    return callT3Rpc(await this.socketUrl(), { type: 'launch', input });
  }
  async removeWorktree(cwd: string, path: string) {
    return callT3Rpc(await this.socketUrl(), { type: 'remove-worktree', cwd, path });
  }
  async terminals() {
    return z.object({ type: z.literal('snapshot'), terminals: z.array(z.object({
      threadId: z.string().min(1), terminalId: z.string().min(1), cwd: z.string(), worktreePath: z.string().nullable(),
      status: z.enum(['starting', 'running', 'exited', 'error']), pid: z.number().int().nullable(), hasRunningSubprocess: z.boolean(), label: z.string(), updatedAt: z.string(),
    }).passthrough()) }).passthrough().parse(await callT3Rpc(await this.socketUrl(), { type: 'terminals' })).terminals;
  }
  async closeTerminal(threadId: string, terminalId: string) {
    return callT3Rpc(await this.socketUrl(), { type: 'close-terminal', threadId, terminalId });
  }
  async providers(refreshInstance?: string) {
    if (refreshInstance || !this.providerSnapshot) {
      const read = this.readProviders(refreshInstance);
      this.providerSnapshot = read;
      read.catch(() => { if (this.providerSnapshot === read) this.providerSnapshot = undefined; });
    }
    return this.providerSnapshot;
  }
  // Follows every shell change until the signal aborts; onItem receives snapshots, markers, and change events.
  subscribe(onItem: (item: unknown) => void, signal: AbortSignal, onError?: (error: unknown) => void) {
    return subscribeT3Shell(() => this.socketUrl(), onItem, signal, onError);
  }
  private async readProviders(refreshInstance?: string) {
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
type TaskLabels = Map<string, { name: string }[]>;
export async function listTaskLabels(kaneo: Kaneo): Promise<TaskLabels> {
  const rows = z.array(z.object({ name: z.string().min(1), taskId: z.string().nullable(), workspaceId: z.string(), deletionStartedAt: z.string().nullish() }).passthrough())
    .parse(await kaneo.call('list_workspace_labels', { workspaceId: kaneo.config.workspaceId }));
  const labels: TaskLabels = new Map();
  for (const row of rows) {
    if (row.workspaceId !== kaneo.config.workspaceId) throw new Error('Kaneo label workspace mismatch');
    if (!row.taskId || row.deletionStartedAt) continue;
    if (!labels.has(row.taskId)) labels.set(row.taskId, []);
    labels.get(row.taskId)!.push({ name: row.name });
  }
  return labels;
}
// `statuses` limits the read to those columns; the scheduler only needs ready tickets, not a project's whole history.
// `labels: null` keeps the list's own label preview, enough to notice a change but not to decide on one.
export async function listTasks(kaneo: Kaneo, projectId: string, labels?: TaskLabels | null, statuses?: string[]): Promise<Task[]> {
  // Task-list labels are only a capped display preview. Use complete task associations.
  const taskLabels = labels === null ? null : labels ?? await listTaskLabels(kaneo);
  const tasks = new Map<string, Task>();
  for (const status of statuses ?? [undefined]) for (let page = 1; ; page++) {
    const r = z.object({ data: z.object({ workspaceId: z.string(), columns: z.array(z.object({ tasks: z.array(taskSchema) })) }), pagination: z.object({ totalPages: z.number(), total: z.number() }) }).parse(await kaneo.call('list_tasks', { projectId, page, limit: 100, ...(status ? { status } : {}) }));
    if (r.data.workspaceId !== kaneo.config.workspaceId) throw new Error('Kaneo workspace mismatch');
    for (const col of r.data.columns) for (const task of col.tasks) {
      if (task.projectId !== projectId) throw new Error('Kaneo project mismatch');
      tasks.set(task.id, { ...task, labels: taskLabels ? taskLabels.get(task.id) ?? [] : task.labels ?? [] });
    }
    if (page >= r.pagination.totalPages) break;
    if (page > 100) throw new Error('Kaneo pagination exceeded 100 pages');
  }
  return [...tasks.values()];
}
