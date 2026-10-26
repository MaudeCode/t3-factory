import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';
import { threadSchema, ticketStatuses, humanRequest, ORPHANED_RUN_GRACE_MINUTES, type Thread } from './policy.ts';
import type { Config } from './config.ts';
import { callT3Rpc, subscribeT3Shell } from './rpc.ts';
import { ReadContext, readAll, readPhase, backgroundRead } from './read-context.ts';

/** T3 orchestration protocol this client speaks; T3 rejects other versions. */
export const ORCHESTRATION_PROTOCOL = 2;
const ORCHESTRATION_PROTOCOL_HEADER = 'x-t3-orchestration-protocol', ORCHESTRATION_PROTOCOL_QUERY_PARAM = 'orchestrationProtocol';

const sessionSchema = z.object({
  id: z.string(), projectId: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullish(),
  lineage: z.object({ relationshipToParent: z.string().nullish() }).passthrough().nullish(),
}).passthrough();
export type Session = z.infer<typeof sessionSchema>;
const turnItemSchema = z.object({
  id: z.string(), threadId: z.string(), type: z.string(), ordinal: z.number(), startedAt: z.string(), updatedAt: z.string().nullish(),
  messageId: z.string().nullish(), text: z.string().nullish(),
}).passthrough();
export type TurnItem = z.infer<typeof turnItemSchema>;

export class T3 {
  readonly config: Config['t3'];
  private readonly orphanVerdicts = new Map<string, boolean>();
  // One provider read serves a whole scheduler pass; a refresh replaces it. reset() starts the next pass.
  private providerSnapshot?: Promise<Awaited<ReturnType<T3['readProviders']>>>;
  reset() { this.providerSnapshot = undefined; }
  constructor(config: Config['t3']) { this.config = config; }
  async request(path: string, body?: unknown): Promise<unknown> {
    return readPhase(path === '/api/orchestration/shell' ? 't3.shell' : path === '/api/auth/websocket-ticket' ? 't3.socket-ticket' : 't3.thread', async signal => {
      const credential = z.object({ token: z.string().min(1), expiresAt: z.string().optional() }).passthrough().parse(JSON.parse(readFileSync(this.config.credentialFile, 'utf8')));
      if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) throw new Error('T3 scheduler credential expired');
      const r = await fetch(new URL(path, this.config.url), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (r.status === 400) await this.assertProtocol();
      if (!r.ok) throw new Error(`T3 ${path} returned HTTP ${r.status}`);
      return r.json();
    });
  }
  /** T3 rejects an unsupported protocol header with a bare 400; name the mismatch when its descriptor shows one. */
  private async assertProtocol() {
    let server: number;
    try {
      // Hosts from before protocol negotiation omit the version and speak v1.
      server = (await this.environment()).orchestrationProtocolVersion ?? 1;
    } catch { return; }
    if (server !== ORCHESTRATION_PROTOCOL) throw new Error(`T3 orchestration protocol mismatch (scheduler speaks v${ORCHESTRATION_PROTOCOL}, server requires v${server})`);
  }
  async environment() {
    return readPhase('t3.environment', async signal => {
      const r = await fetch(new URL('/.well-known/t3/environment', this.config.url), { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`T3 environment descriptor returned HTTP ${r.status}`);
      return z.object({ environmentId: z.string().min(1).optional(), orchestrationProtocolVersion: z.number().int().optional() }).parse(await r.json());
    });
  }
  async threadLink(id: string) {
    const { environmentId } = await this.environment();
    if (!environmentId) throw new Error('T3 did not report its environment ID');
    return `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(id)}`;
  }
  async shell(includeArchived = false) {
    const shell = z.object({ threads: z.array(threadSchema), archivedThreads: z.array(threadSchema).default([]), projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }).passthrough()) }).parse(await this.request('/api/orchestration/shell'));
    if (includeArchived) for (const thread of shell.archivedThreads) if (!shell.threads.some(t => t.id === thread.id)) shell.threads.push(thread);
    const candidates = new Set<string>();
    // Probe concurrently so slow reads cost one request timeout, not one per stale thread.
    await readAll(shell.threads.map(async t => {
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
  /** Every top-level session T3 still exposes, including settled and archived ones; subagent and deleted threads are not sessions. */
  async sessions() {
    const shell = z.object({ threads: z.array(sessionSchema), archivedThreads: z.array(sessionSchema).default([]) }).passthrough().parse(await this.request('/api/orchestration/shell'));
    return [...shell.threads, ...shell.archivedThreads].filter(t => !t.deletedAt && t.lineage?.relationshipToParent !== 'subagent');
  }
  /** Conversation turn items, oldest first: the recent bounded window without a cursor, else the older page behind `cursor`. */
  async conversation(id: string, cursor?: string): Promise<{ items: TurnItem[]; cursor: string | null; more: boolean }> {
    const base = `/api/orchestration/threads/${encodeURIComponent(id)}`;
    // Only message items are parsed in full; other turn item kinds may carry any shape.
    const messages = (items: unknown[]) => z.array(z.object({ type: z.string() }).passthrough()).parse(items).filter(i => i.type === 'assistant_message' || i.type === 'user_message').map(i => turnItemSchema.parse(i)).filter(i => i.threadId === id);
    if (cursor === undefined) {
      const page = z.object({ historyCursor: z.string().nullable(), hasMoreHistory: z.boolean(), projection: z.object({ turnItems: z.array(z.unknown()) }).passthrough() }).passthrough().parse(await this.request(`${base}/bounded`));
      return { items: messages(page.projection.turnItems), cursor: page.historyCursor, more: page.hasMoreHistory };
    }
    const page = z.object({ items: z.array(z.object({ sourceThreadId: z.string(), item: z.unknown() }).passthrough()), nextCursor: z.string().nullable(), hasMoreHistory: z.boolean() }).passthrough()
      .parse(await this.request(`${base}/history?cursor=${encodeURIComponent(cursor)}&view=conversation`));
    // Entries inherited from another thread keep their source; a fork's copies are not this session's own reports.
    return { items: messages(page.items.filter(e => e.sourceThreadId === id).map(e => e.item)), cursor: page.nextCursor, more: page.hasMoreHistory };
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
  /** Match T3's public interruptThreadTurn: resolve fresh work, hold the queue, or end runless watches. */
  async stop(id: string, beforeStop?: (projection: unknown) => Promise<void>) {
    const { projection } = z.object({ projection: z.object({
      thread: z.object({ id: z.literal(id), activeProviderThreadId: z.string().nullable(), pullRequests: z.array(z.object({
        host: z.string().min(1), repository: z.string().min(1), number: z.number().int().positive(), source: z.string(), watch: z.unknown().optional(),
      }).passthrough()).default([]) }).passthrough(),
      runs: z.array(z.object({ id: z.string().min(1), status: z.enum(['preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']) }).passthrough()),
      providerThreads: z.array(z.object({ id: z.string(), pendingBackgroundTasks: z.array(z.object({ taskId: z.string() }).passthrough()).nullish() }).passthrough()),
      turnItems: z.array(z.object({ type: z.string(), status: z.string(), runId: z.string().nullish(), input: z.unknown().optional() }).passthrough()),
    }).passthrough() }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(id)}/bounded`));
    const { thread, runs, providerThreads, turnItems } = projection;
    let run = runs.findLast(r => ['preparing', 'starting', 'running', 'waiting'].includes(r.status));
    if (!run) {
      const latest = runs.at(-1);
      const rolledBack = new Set(runs.filter(r => r.status === 'rolled_back').map(r => r.id));
      // The public client excludes persistent tools, abandoned items, and inactive provider rosters.
      const pending = providerThreads.some(p => (thread.activeProviderThreadId == null || p.id === thread.activeProviderThreadId) && p.pendingBackgroundTasks?.some(t => t.taskId.length > 0)) ||
        turnItems.some(item => ['command_execution', 'dynamic_tool', 'subagent'].includes(item.type) && ['pending', 'running', 'waiting'].includes(item.status) &&
          !(item.type === 'dynamic_tool' && item.input != null && typeof item.input === 'object' && !Array.isArray(item.input) && Reflect.get(item.input, 'persistent') === true) &&
          (item.runId == null || !rolledBack.has(item.runId)));
      if (latest && ['cancelled', 'completed', 'failed', 'interrupted', 'waiting'].includes(latest.status) && pending) run = latest;
    }
    if (beforeStop) {
      if (!run) throw new Error('No interruptible run owns the remaining background work');
      await beforeStop(projection);
    }
    if (run) {
      await this.dispatch({ type: 'run.interrupt', commandId: randomUUID(), threadId: id, runId: run.id, holdQueue: true });
      return;
    }
    for (const link of thread.pullRequests) {
      if (link.source === 'stack-dismissed' || link.watch === undefined) continue;
      await this.dispatch({ type: 'thread.pull-request.watch', commandId: randomUUID(), threadId: id, host: link.host, repository: link.repository, number: link.number, watching: false });
    }
  }
  async launch(input: unknown) {
    // Thread launch prepares the worktree and runs the project setup script; plain dispatch does not.
    return callT3Rpc(await this.socketUrl(), { type: 'launch', input });
  }
  async removeWorktree(cwd: string, path: string, force = false) {
    return callT3Rpc(await this.socketUrl(), { type: 'remove-worktree', cwd, path, force });
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

export class KanvilTaskNotFound extends Error {}
class KanvilError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(`Kanvil request failed (HTTP ${status}, ${code})`); this.status = status; this.code = code; }
}
const readinessSchema = z.object({ ready: z.boolean(), reasons: z.array(z.object({ code: z.string(), message: z.string(), ticketId: z.string().optional() })) });
export const taskSchema = z.object({
  id: z.string(), projectId: z.string(), title: z.string(), number: z.number(), key: z.string().optional(),
  description: z.string().nullable().optional(), priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']),
  status: z.string(), createdAt: z.string(), labels: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  difficulty: z.enum(['low', 'med', 'high']).nullable().optional(), automationReady: z.boolean().optional(),
  holdReason: z.string().nullable().optional(), archived: z.boolean().optional(), parentId: z.string().nullable().optional(),
  readiness: readinessSchema.optional(),
}).passthrough();
export type Task = z.infer<typeof taskSchema>;
const nativeTicket = taskSchema.omit({ labels: true, readiness: true }).extend({
  status: z.enum(ticketStatuses), key: z.string(), labels: z.array(z.string()), difficulty: z.enum(['low', 'med', 'high']).nullable(),
  automationReady: z.boolean(), holdReason: z.string().nullable(), archived: z.boolean(), parentId: z.string().nullable(),
  acceptanceCriteria: z.string(), version: z.number().int().positive(),
});
const projectSchema = z.object({ id: z.string(), workspaceId: z.string(), name: z.string(), key: z.string(), description: z.string().optional(), archivedAt: z.string().nullish() }).passthrough();
const snapshotSchema = z.object({ project: projectSchema, tickets: z.array(nativeTicket), cursor: z.string().regex(/^\d+$/) });
type Snapshot = z.infer<typeof snapshotSchema>;
type SnapshotRead = { pending: Promise<Snapshot>; value?: Snapshot };
const eventSchema = z.object({ id: z.string().regex(/^\d+$/), projectId: z.string(), ticketId: z.string().nullable(), type: z.string() });
type Change = z.infer<typeof eventSchema>;
type ProjectStream = { connected: boolean; ready: PromiseWithResolvers<void>; done?: Promise<void> };
const normalized = (ticket: z.infer<typeof nativeTicket>): Task => ({ ...ticket, labels: ticket.labels.map(name => ({ name })) });
export const relationsSchema = z.array(z.object({ sourceTaskId: z.string(), targetTaskId: z.string(), relationType: z.enum(['blocks', 'subtask', 'related']) }).passthrough());
export type TaskRelation = z.infer<typeof relationsSchema>[number];

// HTTP and the durable SSE feed share the same project-scoped bearer credential. No subprocess or device login.
export class Kanvil {
  readonly config: Config['kanvil'];
  private readonly abort = new AbortController();
  private watching = false;
  revision = 0;
  get realtime() { return this.watching; }
  private connected = false;
  private subscription?: Promise<void>;
  private streamSignal?: AbortSignal;
  private changed?: (event?: Change) => void;
  private streamError?: (error: unknown) => void;
  private position?: string;
  private readonly projectStreams = new Map<string, ProjectStream>();
  private readonly tasksById = new Map<string, Task>();
  private readonly relationCache = new Map<string, Promise<TaskRelation[]>>();
  private readonly snapshots = new Map<string, SnapshotRead>();
  constructor(config: Config['kanvil']) { this.config = config; }
  async connect(signal?: AbortSignal) { signal?.throwIfAborted(); this.headers(); }
  private headers() {
    const token = process.env.KANVIL_API_KEY?.trim();
    if (!token) throw new Error('Set KANVIL_API_KEY for the scheduler account');
    return { Authorization: `Bearer ${token}` };
  }
  private async response(path: string, signal?: AbortSignal, streaming = false) {
    try {
      return await fetch(new URL(`/api/v1${path}`, this.config.url), { headers: this.headers(), redirect: 'error',
        signal: AbortSignal.any([this.abort.signal, ...signal ? [signal] : [], ...streaming ? [] : [AbortSignal.timeout(30_000)]]) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // fetch errors can contain URLs or proxy credentials.
      throw new Error(this.abort.signal.aborted ? 'Kanvil client closed' : 'Kanvil connection failed');
    }
  }
  async request(path: string): Promise<unknown> {
    return readPhase('kanvil.read', async signal => {
      const response = await this.response(path, signal);
      if (!response.ok) await this.failure(response);
      try { return await response.json(); } catch { throw new Error('Kanvil returned invalid JSON'); }
    });
  }
  private async failure(response: Response): Promise<never> {
    const error = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]+$/) }) }).safeParse(await response.json().catch(() => null));
    const code = error.success ? error.data.error.code : 'unclassified';
    if (response.status === 404 && code === 'not_found') throw new KanvilTaskNotFound('Kanvil ticket not found or inaccessible');
    throw new KanvilError(response.status, code);
  }
  async projects() {
    const projects = z.array(projectSchema).parse(await this.request(`/projects?workspaceId=${encodeURIComponent(this.config.workspaceId)}`));
    if (projects.some(p => p.workspaceId !== this.config.workspaceId)) throw new Error('Kanvil project workspace mismatch');
    return projects.filter(p => !p.archivedAt).map(p => ({ ...p, slug: p.key }));
  }
  async columns(projectId: string) {
    const states = z.array(z.object({ category: z.enum(ticketStatuses), name: z.string(), position: z.number() })).parse(await this.request(`/projects/${encodeURIComponent(projectId)}/workflow`));
    // Factory selects native categories, including every custom state in the category.
    return [...new Map(states.map(s => [s.category, { slug: s.category, name: s.category.replaceAll('_', ' '), isFinal: ['done', 'cancelled'].includes(s.category), position: s.position }])).values()];
  }
  async labels() {
    const rows = await readAll((await this.projects()).map(p => this.request(`/projects/${encodeURIComponent(p.id)}/labels/catalog`)));
    return [...new Set(rows.flatMap(r => z.array(z.object({ name: z.string() })).parse(r).map(l => l.name)))].sort();
  }
  private async snapshot(projectId: string) {
    const read = async () => {
      const revision = this.revision;
      const snapshot = snapshotSchema.parse(await this.request(`/snapshot?projectId=${encodeURIComponent(projectId)}`));
      if (snapshot.project.id !== projectId || snapshot.project.workspaceId !== this.config.workspaceId || snapshot.tickets.some(t => t.projectId !== projectId)) throw new Error('Kanvil snapshot ownership mismatch');
      if (revision === this.revision) for (const ticket of snapshot.tickets) this.tasksById.set(ticket.id, normalized(ticket));
      return snapshot;
    };
    if (!this.watching) return read();
    if (!this.connected) throw new Error('Kanvil event stream is not synchronized');
    await this.ensureProjectStream(projectId);
    if (!this.snapshots.has(projectId)) {
      const entry: SnapshotRead = { pending: read() };
      entry.pending = entry.pending.then(value => { entry.value = value; return value; }).catch(error => { if (this.snapshots.get(projectId) === entry) this.snapshots.delete(projectId); throw error; });
      this.snapshots.set(projectId, entry);
    }
    return this.snapshots.get(projectId)!.pending;
  }
  async tasks(projectId: string, statuses?: string[]): Promise<Task[]> {
    return (await this.snapshot(projectId)).tickets.filter(t => !t.archived && (!statuses || statuses.includes(t.status))).map(ticket => {
      const cached = this.tasksById.get(ticket.id);
      return cached?.version === ticket.version && cached.readiness ? { ...normalized(ticket), readiness: cached.readiness } : normalized(ticket);
    });
  }
  async task(id: string, projectId?: string, cached = false): Promise<Task> {
    if (cached && this.watching && this.tasksById.has(id)) {
      const task = this.tasksById.get(id)!; await this.ensureProjectStream(task.projectId); return task;
    }
    if (cached && this.watching && this.connected) for (const entry of this.snapshots.values()) {
      const found = entry.value?.tickets.find(t => t.id === id);
      if (found) { await this.ensureProjectStream(found.projectId); return normalized(found); }
    }
    const revision = this.revision;
    projectId ??= this.tasksById.get(id)?.projectId;
    if (!projectId || /^[A-Z0-9]+-\d+$/.test(id)) {
      const resolved = z.object({ ticket: nativeTicket }).parse(await this.request(`/tickets/resolve?ticketId=${encodeURIComponent(id)}`));
      if (projectId && resolved.ticket.projectId !== projectId) throw new Error('Kanvil ticket moved to another project');
      projectId = resolved.ticket.projectId; id = resolved.ticket.id;
    }
    const result = z.object({ ticket: nativeTicket, readiness: readinessSchema }).parse(await this.request(`/projects/${encodeURIComponent(projectId)}/tickets/${encodeURIComponent(id)}`));
    if (result.ticket.projectId !== projectId || (result.ticket.id !== id && result.ticket.key !== id)) throw new Error('Kanvil ticket identity mismatch');
    const task = { ...normalized(result.ticket), readiness: result.readiness };
    if (this.watching) await this.ensureProjectStream(task.projectId);
    if (this.watching && this.connected && revision === this.revision) this.tasksById.set(task.id, task);
    return task;
  }
  async eligibleTask(task: Task): Promise<Task> {
    if (this.watching) await this.ensureProjectStream(task.projectId);
    const cached = this.tasksById.get(task.id);
    if (this.watching && this.connected && cached?.readiness && cached.version === task.version) return cached;
    return this.task(task.id, task.projectId);
  }
  async relations(id: string, fresh = true): Promise<TaskRelation[]> {
    if (fresh || !this.watching || !this.connected) return this.readRelations(id, fresh);
    if (!this.relationCache.has(id)) {
      const pending = this.readRelations(id, false).catch(error => { if (this.relationCache.get(id) === pending) this.relationCache.delete(id); throw error; });
      this.relationCache.set(id, pending);
    }
    return this.relationCache.get(id)!;
  }
  private async readRelations(id: string, fresh: boolean): Promise<TaskRelation[]> {
    const task = await this.task(id, undefined, !fresh), projectId = task.projectId;
    const path = `/projects/${encodeURIComponent(projectId)}/tickets`;
    const rows = z.array(z.object({ sourceId: z.string(), targetId: z.string(), type: z.string() })).parse(await this.request(`${path}/${encodeURIComponent(id)}/relations`));
    const relations: TaskRelation[] = rows.filter(r => r.type === 'blocks').map(r => ({ sourceTaskId: r.sourceId, targetTaskId: r.targetId, relationType: 'blocks' }));
    if (task.parentId) relations.push({ sourceTaskId: task.parentId, targetTaskId: task.id, relationType: 'subtask' });
    let offset = 0, total: number | undefined;
    const children = new Set<string>();
    do {
      const page = z.object({ items: z.array(nativeTicket), total: z.number().int().nonnegative() }).parse(await this.request(`${path}?parentId=${encodeURIComponent(id)}&archived=include&sort=number&order=asc&limit=100&offset=${offset}`));
      if ((total !== undefined && total !== page.total) || (!page.items.length && offset < page.total)) throw new Error('Kanvil children changed during pagination');
      total = page.total;
      for (const child of page.items) {
        if (children.has(child.id) || child.parentId !== task.id || child.projectId !== projectId) throw new Error('Kanvil child ownership mismatch');
        children.add(child.id);
        relations.push({ sourceTaskId: id, targetTaskId: child.id, relationType: 'subtask' });
      }
      offset += page.items.length;
      if (offset > total) throw new Error('Kanvil child count mismatch');
    } while (offset < total);
    return relations;
  }
  projectSynchronized(projectId: string) { return this.connected && this.projectStreams.get(projectId)?.connected === true; }
  // Unscoped feeds cannot report membership revocation after the caller loses visibility.
  // A scoped stream revalidates that project's access, without polling its inventory.
  private async ensureProjectStream(projectId: string) {
    if (!this.watching) return;
    if (!this.connected) throw new Error('Kanvil event stream is not synchronized');
    let entry = this.projectStreams.get(projectId);
    if (!entry) {
      entry = { connected: false, ready: Promise.withResolvers<void>() };
      this.projectStreams.set(projectId, entry);
      const pending = entry;
      const timer = setTimeout(() => pending.ready.reject(new Error('Kanvil project stream unavailable')), 30_000);
      void entry.ready.promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
      entry.done = new ReadContext().run(() => this.follow(this.changed!, this.streamSignal!, this.streamError, projectId));
    }
    const pending = entry;
    if (!pending.connected) await readPhase('kanvil.project-stream', signal => new Promise<void>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      void pending.ready.promise.then(() => { signal?.removeEventListener('abort', abort); resolve(); }, error => { signal?.removeEventListener('abort', abort); reject(error); });
      if (signal?.aborted) abort();
    }));
    if (!this.projectSynchronized(projectId)) throw new Error('Kanvil project stream is not synchronized');
  }
  private invalidateProject(projectId: string) {
    this.snapshots.delete(projectId);
    for (const [id, task] of this.tasksById) if (task.projectId === projectId) this.tasksById.delete(id);
    this.relationCache.clear();
  }
  private async applyChange(change: Change) {
    this.tasksById.clear(); this.relationCache.clear();
    const snapshot = this.snapshots.get(change.projectId)?.value;
    if (!snapshot || !change.ticketId || /^(project|workspace|workflow)\./.test(change.type)) {
      this.snapshots.delete(change.projectId); return;
    }
    if (BigInt(change.id) <= BigInt(snapshot.cursor)) return;
    if (change.ticketId) {
      let ticket: z.infer<typeof nativeTicket> | undefined;
      if (!['ticket.deleted', 'ticket.moved_away'].includes(change.type)) {
        try {
          const task = await this.task(change.ticketId, change.projectId);
          ticket = nativeTicket.parse({ ...task, labels: task.labels?.map(l => l.name) });
        } catch (error) {
          if (!(error instanceof KanvilTaskNotFound)) { this.snapshots.delete(change.projectId); throw error; }
          // A later delete or move may already have committed. Its event will replay after this one.
        }
      }
      snapshot.tickets = snapshot.tickets.filter(t => t.id !== change.ticketId);
      if (ticket) snapshot.tickets.push(ticket);
    }
    snapshot.cursor = change.id;
  }
  // In-memory projection and cursor share a lifetime. Restart always starts with fresh snapshots, never a cursor alone.
  subscribe(onChange: (event?: Change) => void, signal: AbortSignal, onError?: (error: unknown) => void) {
    if (this.subscription) throw new Error('Kanvil subscription already active');
    this.watching = true;
    const abort = AbortSignal.any([signal, this.abort.signal]);
    this.streamSignal = abort; this.changed = onChange; this.streamError = onError;
    return this.subscription = new ReadContext().run(() => this.follow(onChange, abort, onError));
  }
  private async follow(onChange: (event?: Change) => void, signal: AbortSignal, onError?: (error: unknown) => void, projectId?: string) {
    let cursor: string | undefined = projectId ? this.position : undefined, backoff = 1000;
    while (!signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (!cursor) cursor = z.object({ cursor: z.string().regex(/^\d+$/) }).parse(await this.request('/checkpoint')).cursor;
        const response = await this.response(`/events?cursor=${cursor}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`, signal, true);
        if (response.status === 410) { await response.body?.cancel(); cursor = undefined; if (projectId) this.invalidateProject(projectId); else this.snapshots.clear(); continue; }
        if (!response.ok) await this.failure(response);
        if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Kanvil returned an invalid event stream');
        reader = response.body.getReader();
        const messages: EventSourceMessage[] = [];
        const parser = createParser({ maxBufferSize: 1_000_000, onEvent: event => messages.push(event), onError: () => { throw new Error('Kanvil returned invalid SSE'); } });
        const decoder = new TextDecoder();
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Kanvil event stream ended');
          parser.feed(decoder.decode(chunk.value, { stream: true }));
          for (const message of messages.splice(0)) {
            if (message.event === 'error') {
              const error = z.object({ status: z.number(), code: z.string().regex(/^[a-z_]+$/) }).parse(JSON.parse(message.data));
              throw new KanvilError(error.status, error.code);
            }
            if (message.event !== 'change' && message.event !== 'checkpoint') continue;
            const id = z.string().regex(/^\d+$/).parse(message.id);
            if (message.event === 'checkpoint' && z.object({ cursor: z.string() }).parse(JSON.parse(message.data)).cursor !== id) throw new Error('Kanvil checkpoint cursor mismatch');
            if (!projectId && message.event === 'change' && BigInt(id) > BigInt(cursor)) {
              const change = eventSchema.parse(JSON.parse(message.data));
              if (change.id !== id) throw new Error('Kanvil event cursor mismatch');
              if (!/^(comment|evidence)\./.test(change.type)) {
                this.revision++;
                await this.applyChange(change);
                onChange(change);
              } // Invalidation and notification precede cursor advancement.
            }
            if (projectId) {
              const entry = this.projectStreams.get(projectId)!;
              if (!entry.connected) { entry.connected = true; entry.ready.resolve(); this.revision++; onChange({ id, projectId, ticketId: null, type: 'stream.connected' }); }
            } else if (!this.connected) { this.connected = true; this.revision++; onChange(); }
            if (BigInt(id) > BigInt(cursor)) cursor = id;
            if (!projectId) this.position = cursor;
            backoff = 1000;
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof KanvilError && error.status === 410) cursor = undefined;
        if (projectId) this.projectStreams.get(projectId)?.ready.reject(new Error('Kanvil project stream is not synchronized'));
        onError?.(error);
      } finally {
        signal.removeEventListener('abort', cancel);
        if (projectId) {
          const entry = this.projectStreams.get(projectId)!;
          const wasConnected = entry.connected;
          entry.connected = false; entry.ready.reject(new Error('Kanvil project stream is not synchronized'));
          this.revision++; this.invalidateProject(projectId);
          await reader?.cancel().catch(() => {});
          if (wasConnected && !signal.aborted) onChange({ id: cursor ?? '0', projectId, ticketId: null, type: 'stream.disconnected' });
        } else {
          const wasConnected = this.connected;
          this.connected = false; this.revision++;
          this.tasksById.clear(); this.relationCache.clear();
          this.snapshots.clear(); // Revoked access and disconnected streams cannot keep a trusted inventory.
          await reader?.cancel().catch(() => {});
          if (wasConnected && !signal.aborted) onChange();
        }
      }
      if (signal.aborted) break;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, backoff); signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  async close() { this.abort.abort(); await this.subscription; await Promise.allSettled([...this.projectStreams.values()].map(p => p.done)); this.projectStreams.clear(); this.snapshots.clear(); this.tasksById.clear(); this.relationCache.clear(); }
}

export const listTasks = (kanvil: Kanvil, projectId: string, statuses?: string[]) => backgroundRead(() => kanvil.tasks(projectId, statuses));
