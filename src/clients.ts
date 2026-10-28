import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';
import { threadSchema, ticketStatuses, humanRequest, ORPHANED_RUN_GRACE_MINUTES, type Thread } from './policy.ts';
import type { Config } from './config.ts';
import { callT3Rpc, subscribeT3Shell, T3Rpc, type RpcAction } from './rpc.ts';
import { ReadContext, readContext, waitFor, readAll, readPhase, backgroundRead } from './read-context.ts';

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

const shellSchema = z.object({ threads: z.array(threadSchema), archivedThreads: z.array(threadSchema).default([]), projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }).passthrough()) });
const providerPayloadSchema = z.object({ providers: z.array(z.object({
      instanceId: z.string(), driver: z.string(), status: z.string(), installed: z.boolean(), enabled: z.boolean(),
      models: z.array(z.object({ slug: z.string(), aliases: z.array(z.string()).optional() }).passthrough()),
      usageLimits: z.object({ checkedAt: z.string(), unavailable: z.unknown().optional(), windows: z.array(z.object({
        id: z.string(), usedPercent: z.number(), resetsAt: z.string().optional(), windowDurationMins: z.number().optional(),
      }).passthrough()) }).passthrough().optional(),
    }).passthrough()) });
// Wire values are JSON. Freeze each new node once, retaining already-frozen entities
// across shell versions so readers can share them without copying the global state.
function immutableProjection<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutableProjection(child);
    Object.freeze(value);
  }
  return value;
}
export class T3 {
  readonly config: Config['t3'];
  private readonly orphanVerdicts = new Map<string, boolean>();
  private readonly providerSnapshots = new Map<string, { generation: number; at: number; pending: ReturnType<T3['readProviders']>; settled: boolean }>();
  private credential?: { stamp: string; token: string; expiresAt?: string };
  private readonly rpc: T3Rpc;
  private readonly persistent: boolean;
  private readonly readLifetime = new ReadContext();
  private shellEpoch = 0;
  private shellView?: { epoch: number; sequence: number; value: z.infer<typeof shellSchema> };
  private providerView?: { epoch: number; value: z.infer<typeof providerPayloadSchema>['providers'] };
  private streams?: Promise<void>;
  private connectionCredentialStamp?: string;
  private credentialGeneration = 0;
  private orphanProbe?: Promise<void>;
  private projectionChanged?: (item: unknown) => void;
  private shellRead?: { at: number; epoch: number; fresh: boolean; settled: boolean; pending: ReturnType<T3['readShell']> };
  constructor(config: Config['t3'], options: { persistent?: boolean } = {}) {
    this.config = config; this.persistent = !!options.persistent; this.rpc = new T3Rpc(() => this.socketUrl());
  }
  private readCredential() {
    const stat = statSync(this.config.credentialFile), stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (this.credential?.stamp !== stamp) this.credential = { ...z.object({ token: z.string().min(1), expiresAt: z.string().optional() }).passthrough().parse(JSON.parse(readFileSync(this.config.credentialFile, 'utf8'))), stamp };
    if (this.credential.expiresAt && Date.parse(this.credential.expiresAt) <= Date.now()) throw new Error('T3 scheduler credential expired');
    return this.credential;
  }
  private authenticateRpc() {
    const stamp = this.readCredential().stamp;
    if (this.connectionCredentialStamp && this.connectionCredentialStamp !== stamp) { this.credentialGeneration++; this.shellView = undefined; this.providerView = undefined; this.shellRead = undefined; this.shellEpoch++; this.providerSnapshots.clear(); this.orphanVerdicts.clear(); this.rpc.reset(); }
    this.connectionCredentialStamp = stamp;
  }
  private rpcCall(action: RpcAction) { if (this.persistent) this.authenticateRpc(); return this.persistent ? this.rpc.call(action) : this.socketUrl().then(url => callT3Rpc(url, action)); }
  async close() { this.readLifetime.controller.abort(new Error('T3 client closed')); await this.rpc.close(); await Promise.allSettled([this.streams, this.orphanProbe]); }
  get liveProviders() { if (!this.persistent) return false; this.authenticateRpc(); return !!this.providerView && this.rpc.isLive(this.providerView.epoch); }
  peekProvider(instanceId: string) { return this.liveProviders ? structuredClone(this.providerView!.value.find(provider => provider.instanceId === instanceId)) : undefined; }
  invalidateShell() { this.shellEpoch++; }
  async request(path: string, body?: unknown): Promise<unknown> {
    return readPhase(path === '/api/orchestration/shell' ? 't3.shell' : path === '/api/auth/websocket-ticket' ? 't3.socket-ticket' : 't3.thread', async signal => {
      const credential = this.readCredential();
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(new URL(path, this.config.url), {
            method: body === undefined ? 'GET' : 'POST', redirect: 'error',
            headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal,
          });
          if (r.status === 400) await this.assertProtocol();
          if (!r.ok) throw new Error(`T3 ${path} returned HTTP ${r.status}`);
          return await r.json();
        } catch (error) {
          const cause = error instanceof Error ? error.cause : undefined;
          const closed = cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'UND_ERR_SOCKET';
          // Retry only a cut-off read, once, within the original budget. Never replay a POST.
          if (attempt === 0 && body === undefined && closed && !requestSignal.aborted) continue;
          throw error;
        }
      }
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
  async shell(includeArchived = false, fresh = false): Promise<z.infer<typeof shellSchema>> {
    if (this.persistent) this.authenticateRpc();
    const generation = this.credentialGeneration;
    if (this.persistent && !includeArchived) {
      const view = this.shellView;
      if (view && this.rpc.isLive(view.epoch)) {
        this.probeOrphans(view.value.threads);
        const threads = view.value.threads.map(thread => this.orphanVerdicts.get(`${thread.id}:${thread.updatedAt}`) ? immutableProjection({ ...thread, orphanedRun: true }) : thread);
        return immutableProjection({ ...view.value, threads });
      }
    }
    let entry = this.shellRead;
    if (!entry || entry.epoch !== this.shellEpoch || (!this.persistent && entry.settled) || (fresh ? entry.settled || !entry.fresh || entry.at < (readContext()?.startedAt ?? Date.now()) : Date.now() - entry.at > 1000)) {
      const pending = this.readLifetime.run(() => this.readShell());
      entry = { at: Date.now(), epoch: this.shellEpoch, fresh, settled: false, pending }; this.shellRead = entry;
      const owned = entry;
      void pending.then(() => { owned.settled = true; }, () => { if (this.shellRead === owned) this.shellRead = undefined; });
    }
    const pending = entry.pending;
    const shell = structuredClone(await readPhase('t3.shell', signal => waitFor(pending, signal)));
    if (this.persistent) { this.authenticateRpc(); if (generation !== this.credentialGeneration) return this.shell(includeArchived, fresh); }
    if (includeArchived) for (const thread of shell.archivedThreads) if (!shell.threads.some(active => active.id === thread.id)) shell.threads.push(thread);
    return shell;
  }
  private async readShell() {
    const shell = shellSchema.parse(await this.request('/api/orchestration/shell'));
    const candidates = new Set<string>();
    // Probe concurrently so slow reads cost one request timeout, not one per stale thread.
    await readAll(shell.threads.map(async t => {
      if (t.activeRunId == null || (t.pendingRuntimeRequest != null && humanRequest(t.pendingRuntimeRequest.kind)) || Date.now() - Date.parse(t.updatedAt) < ORPHANED_RUN_GRACE_MINUTES * 60_000) return;
      const key = `${t.id}:${t.updatedAt}`;
      candidates.add(key);
      if (!this.orphanVerdicts.has(key)) {
        const verdict = await this.orphaned(t);
        if (verdict !== undefined) this.orphanVerdicts.set(key, verdict);
        else if (!this.persistent) this.shellRead = undefined;
      }
      if (this.orphanVerdicts.get(key)) t.orphanedRun = true;
    }));
    for (const key of this.orphanVerdicts.keys()) if (!candidates.has(key)) this.orphanVerdicts.delete(key);
    return shell;
  }
  private probeOrphans(threads: Thread[]) {
    if (this.orphanProbe) return;
    const candidates = threads.filter(thread => thread.activeRunId != null && !(thread.pendingRuntimeRequest && humanRequest(thread.pendingRuntimeRequest.kind)) && Date.now() - Date.parse(thread.updatedAt) >= ORPHANED_RUN_GRACE_MINUTES * 60_000 && !this.orphanVerdicts.has(`${thread.id}:${thread.updatedAt}`));
    if (!candidates.length) return;
    this.orphanProbe = this.readLifetime.run(async () => {
      let changed = false;
      for (let at = 0; at < candidates.length; at += 6) {
        this.readLifetime.check();
        await readAll(candidates.slice(at, at + 6).map(async thread => {
          const verdict = await this.orphaned(thread);
          if (verdict !== undefined && this.shellView?.value.threads.some(current => current.id === thread.id && current.updatedAt === thread.updatedAt)) {
            this.orphanVerdicts.set(`${thread.id}:${thread.updatedAt}`, verdict); changed ||= verdict;
          }
        }));
      }
      if (changed) this.projectionChanged?.({ kind: 'runtime.probed' });
    }).catch(() => {}).finally(() => { this.orphanProbe = undefined; });
  }
  private applyShell(item: unknown, epoch: number) {
    if (!this.rpc.isLive(epoch)) return;
    const event = z.object({ kind: z.string() }).passthrough().parse(item);
    if (event.kind === 'synchronized') return;
    if (event.kind === 'snapshot') {
      const value = shellSchema.extend({ snapshotSequence: z.number().int().nonnegative() }).parse(event.snapshot);
      if (event.resolvedRepositoryIdentityRoots !== undefined) {
        const roots = z.array(z.string()).parse(event.resolvedRepositoryIdentityRoots), view = this.shellView;
        // Native enrichment is a marked, partial project snapshot, not a new shell.
        // Its high-water mark cannot skip application events still arriving on the feed.
        if (view?.epoch === epoch && value.snapshotSequence >= view.sequence) {
          const enriched = new Map(value.projects.filter(project => roots.includes(project.workspaceRoot)).map(project => [project.id, project]));
          const projects = view.value.projects.map(current => {
            const project = enriched.get(current.id);
            return project?.workspaceRoot === current.workspaceRoot ? project : current;
          });
          view.value = immutableProjection({ ...view.value, projects });
        }
        return;
      }
      if (!this.shellView || this.shellView.epoch !== epoch || value.snapshotSequence >= this.shellView.sequence) this.shellView = { epoch, sequence: value.snapshotSequence, value: immutableProjection(value) };
      return;
    }
    const sequence = z.number().int().nonnegative().parse(event.sequence), view = this.shellView;
    if (!view || view.epoch !== epoch) return;
    if (sequence < view.sequence) return;
    const next = { ...view.value };
    if (event.kind === 'thread.updated') {
      const thread = threadSchema.parse(event.thread), location = z.enum(['active', 'archive']).parse(event.location);
      next.threads = next.threads.filter(current => current.id !== thread.id); next.archivedThreads = next.archivedThreads.filter(current => current.id !== thread.id);
      (location === 'active' ? next.threads : next.archivedThreads).push(thread);
    } else if (event.kind === 'thread.removed') {
      const id = z.string().parse(event.threadId); next.threads = next.threads.filter(thread => thread.id !== id); next.archivedThreads = next.archivedThreads.filter(thread => thread.id !== id);
    } else if (event.kind === 'project.updated') {
      const project = shellSchema.shape.projects.element.parse(event.project); next.projects = [...next.projects.filter(current => current.id !== project.id), project];
    } else if (event.kind === 'project.removed') {
      const id = z.string().parse(event.projectId); next.projects = next.projects.filter(project => project.id !== id); next.threads = next.threads.filter(thread => thread.projectId !== id); next.archivedThreads = next.archivedThreads.filter(thread => thread.projectId !== id);
    } else { this.shellView = undefined; throw new Error('Unsupported T3 shell stream event'); }
    view.sequence = sequence; view.value = immutableProjection(next);
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
    const shell = z.object({ threads: z.array(sessionSchema), archivedThreads: z.array(sessionSchema).default([]) }).passthrough().parse(this.persistent ? await this.shell() : await this.request('/api/orchestration/shell'));
    return [...shell.threads, ...shell.archivedThreads].filter(t => !t.deletedAt && t.lineage?.relationshipToParent !== 'subagent');
  }
  /** Message and tool-call turn items, oldest first: the recent bounded window without a cursor, else the older page behind `cursor`. */
  async conversation(id: string, cursor?: string): Promise<{ items: TurnItem[]; cursor: string | null; more: boolean }> {
    const base = `/api/orchestration/threads/${encodeURIComponent(id)}`;
    // Only message and tool-call items are parsed; other turn item kinds may carry any shape.
    const messages = (items: unknown[]) => z.array(z.object({ type: z.string() }).passthrough()).parse(items).filter(i => i.type === 'assistant_message' || i.type === 'user_message' || i.type === 'dynamic_tool').map(i => turnItemSchema.parse(i)).filter(i => i.threadId === id);
    if (cursor === undefined) {
      const page = z.object({ historyCursor: z.string().nullable(), hasMoreHistory: z.boolean(), projection: z.object({ turnItems: z.array(z.unknown()) }).passthrough() }).passthrough().parse(await this.request(`${base}/bounded`));
      return { items: messages(page.projection.turnItems), cursor: page.historyCursor, more: page.hasMoreHistory };
    }
    const page = z.object({ items: z.array(z.object({ sourceThreadId: z.string(), item: z.unknown() }).passthrough()), nextCursor: z.string().nullable(), hasMoreHistory: z.boolean() }).passthrough()
      .parse(await this.request(`${base}/history?cursor=${encodeURIComponent(cursor)}&view=activity`));
    // Entries inherited from another thread keep their source; a fork's copies are not this session's own reports.
    return { items: messages(page.items.filter(e => e.sourceThreadId === id).map(e => e.item)), cursor: page.nextCursor, more: page.hasMoreHistory };
  }
  /** One full turn item; snapshots and history pages omit tool output. */
  async turnItem(threadId: string, itemId: string) {
    return z.object({ item: z.unknown().nullable() }).passthrough().parse(await this.rpcCall({ type: 'turn-item', threadId, itemId })).item;
  }
  async socketUrl() {
    const stamp = this.readCredential().stamp;
    const ticket = z.object({ ticket: z.string() }).passthrough().parse(await this.request('/api/auth/websocket-ticket', {}));
    if (this.readCredential().stamp !== stamp) throw new Error('T3 credential changed during connection setup');
    const socket = new URL('/ws', this.config.url); socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    socket.searchParams.set('wsTicket', ticket.ticket);
    socket.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL));
    return socket.toString();
  }
  async dispatch(command: unknown) {
    return this.rpcCall({ type: 'dispatch', command });
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
  async prepareLaunch() {
    if (this.persistent) this.authenticateRpc();
    const credentialStamp = this.readCredential().stamp;
    const rpc = this.persistent ? this.rpc : new T3Rpc(() => this.socketUrl());
    let connection: Awaited<ReturnType<T3Rpc['connect']>>;
    try { connection = await rpc.connect(); } catch (error) { if (!this.persistent) await rpc.close(); throw error; }
    const prepared = { call: (action: RpcAction) => rpc.call(action, connection) };
    return { check: () => { this.authenticateRpc(); if (this.readCredential().stamp !== credentialStamp || !connection.open || connection.retired || this.persistent && !rpc.isLive(connection.epoch)) throw new Error('T3 launch connection closed before submission'); }, launch: (input: unknown) => this.launch(input, prepared), close: () => this.persistent ? Promise.resolve() : rpc.close() };
  }
  async launch(input: unknown, prepared?: Pick<T3Rpc, 'call'>) {
    // Thread launch prepares the worktree and runs the project setup script; plain dispatch does not.
    return prepared ? prepared.call({ type: 'launch', input }) : this.rpcCall({ type: 'launch', input });
  }
  async removeWorktree(cwd: string, path: string, force = false) {
    return this.rpcCall({ type: 'remove-worktree', cwd, path, force });
  }
  async terminals() {
    return z.object({ type: z.literal('snapshot'), terminals: z.array(z.object({
      threadId: z.string().min(1), terminalId: z.string().min(1), cwd: z.string(), worktreePath: z.string().nullable(),
      status: z.enum(['starting', 'running', 'exited', 'error']), pid: z.number().int().nullable(), hasRunningSubprocess: z.boolean(), label: z.string(), updatedAt: z.string(),
    }).passthrough()) }).passthrough().parse(await this.rpcCall({ type: 'terminals' })).terminals;
  }
  async closeTerminal(threadId: string, terminalId: string) {
    return this.rpcCall({ type: 'close-terminal', threadId, terminalId });
  }
  async providers(refreshInstance?: string): Promise<z.infer<typeof providerPayloadSchema>['providers']> {
    if (this.persistent) this.authenticateRpc();
    if (!refreshInstance && this.persistent && this.liveProviders) return structuredClone(this.providerView!.value);
    const key = refreshInstance ?? '*', after = readContext()?.startedAt ?? Date.now();
    let entry = this.providerSnapshots.get(key);
    if (!entry || entry.generation !== this.credentialGeneration || (refreshInstance ? entry.settled || entry.at < after : Date.now() - entry.at > 1000)) {
      const pending = this.readLifetime.run(() => this.readProviders(refreshInstance));
      entry = { generation: this.credentialGeneration, at: Date.now(), pending, settled: false }; this.providerSnapshots.set(key, entry);
      const owned = entry;
      void pending.then(() => {
        owned.settled = true;
        if (refreshInstance && owned.generation === this.credentialGeneration && this.providerSnapshots.get(key) === owned && (this.providerSnapshots.get('*')?.at ?? 0) <= owned.at) this.providerSnapshots.set('*', owned);
      }, () => { if (this.providerSnapshots.get(key) === owned) this.providerSnapshots.delete(key); });
    }
    const pending = entry.pending;
    const value = await readPhase('t3.providers', signal => waitFor(pending, signal));
    if (this.persistent) { this.authenticateRpc(); if (entry.generation !== this.credentialGeneration) return this.providers(refreshInstance); }
    return value;
  }
  // Follows every shell change until the signal aborts; onItem receives snapshots, markers, and change events.
  subscribe(onItem: (item: unknown) => void, signal: AbortSignal, onError?: (error: unknown) => void) {
    if (!this.persistent) return subscribeT3Shell(() => this.socketUrl(), onItem, signal, onError);
    if (this.streams) throw new Error('T3 streams already active');
    this.authenticateRpc(); this.projectionChanged = onItem;
    this.streams = Promise.all([
      this.rpc.follow('shell', (item, epoch) => { this.applyShell(item, epoch); onItem(item); }, epoch => { if (this.shellView?.epoch === epoch) this.shellView = undefined; }, signal, onError),
      this.rpc.follow('config', (item, epoch) => {
        if (!this.rpc.isLive(epoch)) return;
        const event = z.object({ type: z.string() }).passthrough().parse(item);
        const providers = event.type === 'snapshot' ? providerPayloadSchema.parse(event.config).providers : event.type === 'providerStatuses' ? providerPayloadSchema.parse(event.payload).providers : undefined;
        if (providers) {
          const changed = JSON.stringify(this.providerView?.value) !== JSON.stringify(providers);
          this.providerView = { epoch, value: providers };
          if (changed) onItem({ kind: 'providers.updated' });
        }
      }, epoch => { if (this.providerView?.epoch === epoch) this.providerView = undefined; }, signal, onError),
    ]).then(() => {});
    return this.streams;
  }
  private async readProviders(refreshInstance?: string) {
    const view = this.providerView;
    const data = providerPayloadSchema.parse(await this.rpcCall({ type: 'provider', ...(refreshInstance ? { refreshInstance } : {}) }));
    if (refreshInstance && view && this.providerView === view && this.rpc.isLive(view.epoch)) this.providerView = { epoch: view.epoch, value: data.providers };
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
  version: z.number().int().positive().optional(),
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
const eventSchema = z.object({ id: z.string().regex(/^\d+$/), projectId: z.string(), ticketId: z.string().nullable(), type: z.string(), data: z.record(z.string(), z.unknown()).optional() });
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
  private readonly relationCache = new Map<string, Map<boolean, Promise<TaskRelation[]>>>();
  private readonly snapshots = new Map<string, SnapshotRead>();
  private readonly eligibility = new Map<string, Promise<Task[]>>();
  private readonly projectVersions = new Map<string, number>();
  private readonly metadataVersions = new Map<string, number>();
  private readonly ticketVersions = new Map<string, number>();
  private readonly ownedProjects = new Map<string, Promise<void>>();
  private readonly dirty = new Map<string, Map<string, Change>>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly dependents = new Map<string, Set<string>>();
  private connectionEpoch = 0;
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
  generations() { return { epoch: this.connectionEpoch, projects: new Map(this.projectVersions), metadata: new Map(this.metadataVersions), tickets: new Map(this.ticketVersions) }; }
  unchanged(before: ReturnType<Kanvil['generations']>, projects: Iterable<string>, tickets?: Iterable<string>) {
    return before.epoch === this.connectionEpoch && [...projects].every(id => tickets
      ? (before.metadata.get(id) ?? 0) === (this.metadataVersions.get(id) ?? 0)
      : (before.projects.get(id) ?? 0) === (this.projectVersions.get(id) ?? 0))
      && (!tickets || [...tickets].every(id => (before.tickets.get(id) ?? 0) === (this.ticketVersions.get(id) ?? 0)));
  }
  private touchProject(projectId: string) { this.projectVersions.set(projectId, (this.projectVersions.get(projectId) ?? 0) + 1); }
  private dependent(ticketId: string, projectId: string) {
    if (!this.dependents.has(ticketId)) this.dependents.set(ticketId, new Set());
    this.dependents.get(ticketId)!.add(projectId);
  }
  private async project(projectId: string): Promise<void> {
    if (this.watching) await this.ensureProjectStream(projectId);
    if (!this.ownedProjects.has(projectId)) {
      const pending = new ReadContext().run(async () => {
        const project = projectSchema.parse(await this.request(`/projects/${encodeURIComponent(projectId)}`));
        if (project.id !== projectId || project.workspaceId !== this.config.workspaceId) throw new Error('Kanvil project workspace mismatch');
      });
      this.ownedProjects.set(projectId, pending);
      void pending.catch(() => { if (this.ownedProjects.get(projectId) === pending) this.ownedProjects.delete(projectId); });
    }
    const pending = this.ownedProjects.get(projectId)!;
    await readPhase('kanvil.project', signal => waitFor(pending, signal));
    if (this.ownedProjects.get(projectId) !== pending) return this.project(projectId);
  }
  private async eligibleTasks(projectId: string): Promise<Task[]> {
    await this.project(projectId);
    if (!this.eligibility.has(projectId)) {
      const generation = this.generations();
      const pending = new ReadContext().run(async () => {
        const tasks: Task[] = [], ids = new Set<string>();
        let total: number | undefined;
        do {
          const page = z.object({ items: z.array(z.object({ ticket: nativeTicket, readiness: readinessSchema })), total: z.number().int().nonnegative() }).parse(await this.request(`/projects/${encodeURIComponent(projectId)}/eligibility?limit=100&offset=${tasks.length}`));
          if ((total !== undefined && total !== page.total) || (!page.items.length && tasks.length < page.total)) throw new Error('Kanvil eligibility changed during pagination');
          total = page.total;
          for (const { ticket, readiness } of page.items) {
            if (ids.has(ticket.id) || ticket.projectId !== projectId || ticket.archived) throw new Error('Kanvil eligibility ownership mismatch');
            ids.add(ticket.id); tasks.push({ ...normalized(ticket), readiness });
            for (const reason of readiness.reasons) if (reason.ticketId) this.dependent(reason.ticketId, projectId);
          }
          if (tasks.length > total) throw new Error('Kanvil eligibility count mismatch');
        } while (tasks.length < total);
        if (!this.unchanged(generation, [projectId])) throw new Error('Kanvil eligibility changed during read');
        for (const task of tasks) this.tasksById.set(task.id, task);
        return tasks;
      });
      if (this.watching) this.eligibility.set(projectId, pending);
      else return readPhase('kanvil.eligibility', signal => waitFor(pending, signal));
      void pending.catch(() => { if (this.eligibility.get(projectId) === pending) this.eligibility.delete(projectId); });
    }
    const pending = this.eligibility.get(projectId)!;
    return readPhase('kanvil.eligibility', signal => waitFor(pending, signal));
  }
  async findTask(key: string, projectId: string) { await this.project(projectId); return this.task(key, projectId); }
  private async snapshot(projectId: string): Promise<Snapshot> {
    const read = async () => {
      const revision = this.generations();
      const snapshot = snapshotSchema.parse(await this.request(`/snapshot?projectId=${encodeURIComponent(projectId)}`));
      if (snapshot.project.id !== projectId || snapshot.project.workspaceId !== this.config.workspaceId || snapshot.tickets.some(t => t.projectId !== projectId)) throw new Error('Kanvil snapshot ownership mismatch');
      if (!this.unchanged(revision, [projectId])) throw new Error('Kanvil snapshot changed during read');
      for (const ticket of snapshot.tickets) this.tasksById.set(ticket.id, normalized(ticket));
      return snapshot;
    };
    if (!this.watching) return read();
    if (!this.connected) throw new Error('Kanvil event stream is not synchronized');
    await this.ensureProjectStream(projectId);
    if (!this.snapshots.has(projectId)) {
      const entry: SnapshotRead = { pending: new ReadContext().run(read) };
      entry.pending = entry.pending.then(value => { entry.value = value; return value; }).catch(error => { if (this.snapshots.get(projectId) === entry) this.snapshots.delete(projectId); throw error; });
      this.snapshots.set(projectId, entry);
    }
    if (this.dirty.get(projectId)?.size) await this.refreshChanges(projectId);
    const pending = this.snapshots.get(projectId)?.pending;
    if (!pending) return this.snapshot(projectId);
    return readPhase('kanvil.snapshot', signal => waitFor(pending, signal));
  }
  async tasks(projectId: string, statuses?: string[], includeArchived = false): Promise<Task[]> {
    if (!includeArchived && statuses?.length && statuses.every(status => ['backlog', 'todo', 'in_progress', 'in_review'].includes(status))) return (await this.eligibleTasks(projectId)).filter(task => statuses.includes(task.status));
    return (await this.snapshot(projectId)).tickets.filter(t => (includeArchived || !t.archived) && (!statuses || statuses.includes(t.status))).map(ticket => {
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
      if (found && !this.dirty.get(found.projectId)?.has(id)) { await this.ensureProjectStream(found.projectId); return normalized(found); }
    }
    const revision = this.generations();
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
    if (!this.watching || this.connected && this.unchanged(revision, [task.projectId])) this.tasksById.set(task.id, task);
    return task;
  }
  async eligibleTask(task: Task): Promise<Task> {
    if (this.watching) await this.ensureProjectStream(task.projectId);
    const cached = this.tasksById.get(task.id);
    if (this.watching && this.connected && cached?.readiness && cached.version === task.version) return cached;
    return this.task(task.id, task.projectId);
  }
  async relations(id: string, fresh = true, includeChildren = true, knownTask?: Task): Promise<TaskRelation[]> {
    if (fresh || !this.watching || !this.connected) return this.readRelations(id, fresh, includeChildren, knownTask);
    let variants = this.relationCache.get(id);
    if (!variants) { variants = new Map(); this.relationCache.set(id, variants); }
    if (!variants.has(includeChildren)) {
      const cache = variants;
      const pending = new ReadContext().run(() => this.readRelations(id, false, includeChildren, knownTask)).catch(error => { if (cache.get(includeChildren) === pending) cache.delete(includeChildren); throw error; });
      cache.set(includeChildren, pending);
    }
    return readPhase('kanvil.relations', signal => waitFor(variants!.get(includeChildren)!, signal));
  }
  private async readRelations(id: string, fresh: boolean, includeChildren: boolean, knownTask?: Task): Promise<TaskRelation[]> {
    const task = knownTask ?? await this.task(id, undefined, !fresh), projectId = task.projectId;
    if (task.id !== id && task.key !== id) throw new Error('Kanvil relation identity mismatch');
    const path = `/projects/${encodeURIComponent(projectId)}/tickets`;
    const rows = z.array(z.object({ sourceId: z.string(), targetId: z.string(), type: z.string() })).parse(await this.request(`${path}/${encodeURIComponent(id)}/relations`));
    const relations: TaskRelation[] = rows.filter(r => r.type === 'blocks').map(r => ({ sourceTaskId: r.sourceId, targetTaskId: r.targetId, relationType: 'blocks' }));
    for (const relation of relations) this.dependent(relation.sourceTaskId, projectId);
    if (task.parentId) this.dependent(task.parentId, projectId);
    if (task.parentId) relations.push({ sourceTaskId: task.parentId, targetTaskId: task.id, relationType: 'subtask' });
    if (!includeChildren) return relations;
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
  async ensureProjectStream(projectId: string) {
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
    this.eligibility.delete(projectId); this.ownedProjects.delete(projectId); this.dirty.delete(projectId);
    for (const [id, task] of this.tasksById) if (task.projectId === projectId) this.tasksById.delete(id);
    for (const id of this.relationCache.keys()) if (!this.tasksById.has(id) || this.tasksById.get(id)?.projectId === projectId) this.relationCache.delete(id);
  }
  private applyChange(change: Change) {
    const cached = change.ticketId ? this.tasksById.get(change.ticketId) : undefined;
    if (change.type === 'ticket.updated' && typeof change.data?.version === 'number' && cached?.version && cached.version >= change.data.version) return false;
    this.touchProject(change.projectId); this.eligibility.delete(change.projectId);
    if (change.ticketId) this.ticketVersions.set(change.ticketId, (this.ticketVersions.get(change.ticketId) ?? 0) + 1);
    else this.metadataVersions.set(change.projectId, (this.metadataVersions.get(change.projectId) ?? 0) + 1);
    for (const id of change.ticketId ? this.dependents.get(change.ticketId) ?? [] : []) { this.touchProject(id); this.eligibility.delete(id); }
    for (const id of this.relationCache.keys()) if (this.tasksById.get(id)?.projectId === change.projectId) this.relationCache.delete(id);
    if (change.ticketId) this.tasksById.delete(change.ticketId);
    const snapshot = this.snapshots.get(change.projectId)?.value;
    if (!change.ticketId || /^(project|workspace|workflow)\./.test(change.type)) {
      this.invalidateProject(change.projectId); return;
    }
    if (!snapshot) {
      this.snapshots.delete(change.projectId);
      for (const [id, task] of this.tasksById) if (task.projectId === change.projectId) this.tasksById.set(id, { ...task, readiness: undefined });
      return;
    }
    if (BigInt(change.id) <= BigInt(snapshot.cursor)) return;
    if (['ticket.deleted', 'ticket.moved_away'].includes(change.type)) {
      snapshot.tickets = snapshot.tickets.filter(t => t.id !== change.ticketId);
      this.dirty.get(change.projectId)?.delete(change.ticketId);
    } else {
      if (!this.dirty.has(change.projectId)) this.dirty.set(change.projectId, new Map());
      this.dirty.get(change.projectId)!.set(change.ticketId, change);
    }
    snapshot.cursor = change.id;
  }
  private async refreshChanges(projectId: string) {
    if (!this.refreshes.has(projectId)) {
      const changes = [...this.dirty.get(projectId)!.values()];
      const pending = new ReadContext().run(async () => {
        for (let start = 0; start < changes.length; start += 6) await readAll(changes.slice(start, start + 6).map(async change => {
          let task: Task | undefined;
          try { task = await this.task(change.ticketId!, projectId); } catch (error) { if (!(error instanceof KanvilTaskNotFound)) throw error; }
          if (this.dirty.get(projectId)?.get(change.ticketId!) !== change) return;
          const snapshot = this.snapshots.get(projectId)?.value;
          if (snapshot) {
            snapshot.tickets = snapshot.tickets.filter(ticket => ticket.id !== change.ticketId);
            if (task) snapshot.tickets.push(nativeTicket.parse({ ...task, labels: task.labels?.map(label => label.name) }));
          }
          this.dirty.get(projectId)?.delete(change.ticketId!);
        }));
      });
      this.refreshes.set(projectId, pending);
      void pending.finally(() => { if (this.refreshes.get(projectId) === pending) this.refreshes.delete(projectId); }).catch(() => {});
    }
    return readPhase('kanvil.changes', signal => waitFor(this.refreshes.get(projectId)!, signal));
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
                if (this.applyChange(change) !== false) this.revision++;
                onChange(change);
              } // Invalidation and notification precede cursor advancement.
            }
            if (projectId) {
              const entry = this.projectStreams.get(projectId)!;
              if (!entry.connected) { entry.connected = true; entry.ready.resolve(); this.revision++; this.touchProject(projectId); this.metadataVersions.set(projectId, (this.metadataVersions.get(projectId) ?? 0) + 1); onChange({ id, projectId, ticketId: null, type: 'stream.connected' }); }
            } else if (!this.connected) { this.connected = true; this.revision++; this.connectionEpoch++; onChange(); }
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
          this.revision++; this.touchProject(projectId); this.metadataVersions.set(projectId, (this.metadataVersions.get(projectId) ?? 0) + 1); this.invalidateProject(projectId);
          await reader?.cancel().catch(() => {});
          if (wasConnected && !signal.aborted) onChange({ id: cursor ?? '0', projectId, ticketId: null, type: 'stream.disconnected' });
        } else {
          const wasConnected = this.connected;
          this.connected = false; this.revision++; this.connectionEpoch++;
          this.eligibility.clear(); this.ownedProjects.clear(); this.dirty.clear();
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
