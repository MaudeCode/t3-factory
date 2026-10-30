import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Scope from 'effect/Scope';
import * as Schedule from 'effect/Schedule';
import * as Rpc from 'effect/unstable/rpc/Rpc';
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup';
import * as RpcClient from 'effect/unstable/rpc/RpcClient';
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization';
import * as Socket from 'effect/unstable/socket/Socket';
import { ReadContext, readContext, readPhase, waitFor } from './read-context.ts';

// Same transport and method contracts as T3. Validate the fields we consume at the caller.
const group = RpcGroup.make(
  Rpc.make('subscribeServerConfig', { payload: Schema.Struct({ workspaceSnapshotsOnDemand: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown, stream: true }),
  Rpc.make('server.probe', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('server.getConfig', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('server.refreshProviders', { payload: Schema.Struct({ instanceId: Schema.String, workspaceSnapshotsOnDemand: Schema.Boolean, refreshModels: Schema.optional(Schema.Boolean) }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.dispatchCommand', { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.launchThread', { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('vcs.removeWorktree', { payload: Schema.Struct({ cwd: Schema.String, path: Schema.String, force: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('subscribeTerminalMetadata', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown, stream: true }),
  Rpc.make('terminal.close', { payload: Schema.Struct({ threadId: Schema.String, terminalId: Schema.String, deleteHistory: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.getTurnItem', { payload: Schema.Struct({ threadId: Schema.String, itemId: Schema.String }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.subscribeShell', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown, stream: true }),
);
const transport = (socketUrl: string, disconnected?: () => void, created?: (socket: WebSocket) => void) => Layer.effect(RpcClient.Protocol)(RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) })).pipe(
  Layer.provide(Socket.layerWebSocket(socketUrl).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
    const socket = new WebSocket(url, protocols); created?.(socket);
    if (disconnected) { socket.addEventListener('close', disconnected, { once: true }); socket.addEventListener('error', disconnected, { once: true }); }
    return socket;
  })))),
  Layer.provide(RpcSerialization.layerJson),
);
// T3 pushes one item per coalesced change to any project or thread. The stream stays open until
// the signal aborts; a dropped socket reconnects with a fresh ticket and growing backoff.
export async function subscribeT3Shell(socketUrl: () => Promise<string>, onItem: (item: unknown) => void, signal: AbortSignal, onError: (error: unknown) => void = () => {}) {
  for (let backoff = 1000; !signal.aborted; ) {
    const started = Date.now();
    try {
      const protocol = transport(await socketUrl());
      await Effect.runPromise(Effect.gen(function* () {
        const client = yield* RpcClient.make(group);
        yield* Stream.runForEach(client['orchestration.subscribeShell']({}), item => Effect.sync(() => onItem(item)));
      }).pipe(Effect.provide(protocol), Effect.scoped), { signal });
    } catch (error) { if (signal.aborted) return; onError(error); }
    backoff = Date.now() - started > 60_000 ? 1000 : Math.min(backoff * 2, 30_000);
    await new Promise<void>(resolve => {
      const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve(); };
      const timer = setTimeout(stop, backoff);
      signal.addEventListener('abort', stop);
    });
  }
}
export type RpcAction = { type: 'provider'; refreshInstance?: string; invalidate?: boolean } | { type: 'dispatch'; command: unknown } | { type: 'launch'; input: unknown } | { type: 'remove-worktree'; cwd: string; path: string; force?: boolean } | { type: 'turn-item'; threadId: string; itemId: string } | { type: 'terminals' } | { type: 'close-terminal'; threadId: string; terminalId: string };
const makeClient = () => RpcClient.make(group);
type Client = Effect.Success<ReturnType<typeof makeClient>>;
function rpcPhase<T>(action: RpcAction, work: (signal?: AbortSignal) => Promise<T>) {
  const mutating = ['dispatch', 'launch', 'remove-worktree', 'close-terminal'].includes(action.type);
  if (mutating) readContext()?.check();
  return readPhase(`t3.rpc.${action.type}`, work, mutating);
}
function request(client: Client, action: RpcAction) {
  return Effect.gen(function* () {
    if (action.type === 'dispatch') return yield* client['orchestration.dispatchCommand'](action.command);
    if (action.type === 'launch') return yield* client['orchestration.launchThread'](action.input);
    if (action.type === 'turn-item') return yield* client['orchestration.getTurnItem']({ threadId: action.threadId, itemId: action.itemId });
    if (action.type === 'remove-worktree') return yield* client['vcs.removeWorktree']({ cwd: action.cwd, path: action.path, force: action.force ?? false });
    if (action.type === 'terminals') return Option.getOrNull(yield* Stream.runHead(client['subscribeTerminalMetadata']({})));
    if (action.type === 'close-terminal') return yield* client['terminal.close']({ threadId: action.threadId, terminalId: action.terminalId, deleteHistory: false });
    // T3 invalidates the selected instance's cached capability and usage probe only for refreshModels.
    if (action.refreshInstance) return yield* client['server.refreshProviders']({ instanceId: action.refreshInstance, workspaceSnapshotsOnDemand: true, ...(action.invalidate ? { refreshModels: true } : {}) });
    return yield* client['server.getConfig']({});
  });
}
async function openConnection(socketUrl: string, signal: AbortSignal, disconnected: () => void) {
  let open = true, socket: WebSocket | undefined;
  const runtime = ManagedRuntime.make(transport(socketUrl, () => { open = false; disconnected(); }, value => { socket = value; }));
  try {
    const client = await runtime.runPromise(Scope.provide(makeClient(), runtime.scope), { signal });
    // A read-only handshake proves the socket is open before a launch can acquire ownership.
    await runtime.runPromise(client['server.probe']({}).pipe(Effect.timeout('60 seconds')), { signal });
    return { runtime, client, get open() { return open && socket?.readyState === 1; } };
  } catch (error) { await runtime.dispose(); throw error; }
}
type Connection = Awaited<ReturnType<typeof openConnection>> & { epoch: number; active: number; retired: boolean; dispose: () => Promise<void> };
export class T3Rpc {
  private connection?: Promise<Connection>;
  private ready?: Connection;
  private epoch = 0;
  private closed = false;
  private readonly scopes = new Set<Promise<Connection>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly lifetime = new ReadContext();
  private readonly socketUrl: () => Promise<string>;
  constructor(socketUrl: () => Promise<string>) { this.socketUrl = socketUrl; }
  isLive(epoch: number) { return this.ready?.epoch === epoch && this.ready.open && !this.ready.retired; }
  reset() {
    const pending = this.connection; this.connection = undefined; this.ready = undefined;
    void pending?.then(value => { value.retired = true; if (!value.active) return value.dispose(); }).catch(() => {});
  }
  connect() {
    if (this.ready && !this.ready.open) this.reset();
    if (!this.connection) {
      const epoch = ++this.epoch;
      const pending = this.lifetime.run(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const value = await openConnection(await this.socketUrl(), this.lifetime.controller.signal, () => {
              if (this.connection === pending && this.ready?.epoch === epoch) this.reset();
            });
            const connected = Object.assign(value, { epoch, active: 0, retired: false, dispose: () => value.runtime.dispose().finally(() => { this.scopes.delete(pending); }) });
            if (this.connection === pending) this.ready = connected;
            else { connected.retired = true; void connected.dispose(); }
            return connected;
          } catch (error) {
            const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
            const retryable = reason && typeof reason === 'object' && '_tag' in reason && ['SocketOpenError', 'SocketCloseError', 'SocketReadError'].includes(String(reason._tag));
            if (attempt || !retryable || this.lifetime.controller.signal.aborted) throw error;
            // No command was submitted: a second preflight gets a new ticket and scope.
          }
        }
      });
      this.connection = pending; this.scopes.add(pending);
      void pending.catch(() => { this.scopes.delete(pending); if (this.connection === pending) { this.connection = undefined; this.ready = undefined; } });
    }
    const pending = this.connection;
    return readPhase('t3.rpc.connect', signal => waitFor(pending, signal));
  }
  async call(action: RpcAction, prepared?: Connection): Promise<unknown> {
    if (this.closed) throw new Error('T3 RPC client closed');
    const connected = prepared ?? await this.connect();
    if (!connected.open || connected.retired) throw new Error('T3 RPC connection closed before submission');
    connected.active++;
    let pending: Promise<unknown> | undefined;
    try {
      pending = rpcPhase(action, signal => connected.runtime.runPromise(request(connected.client, action).pipe(Effect.timeout('60 seconds')), { signal }));
      this.inFlight.add(pending); return await pending;
    } finally {
      if (pending) this.inFlight.delete(pending);
      if (!--connected.active && connected.retired) await connected.dispose();
    }
  }
  async follow(feed: 'shell' | 'config', onItem: (value: unknown, epoch: number) => void, onReset: (epoch: number) => void, signal: AbortSignal, onError: (error: unknown) => void = () => {}) {
    const stop = AbortSignal.any([signal, this.lifetime.controller.signal]);
    if (stop.aborted) return;
    await this.lifetime.run(async () => {
      for (let backoff = 1000; !stop.aborted; ) {
        let connected: Connection | undefined;
        const started = Date.now();
        try {
          connected = await this.connect();
          const channel = feed === 'shell' ? connected.client['orchestration.subscribeShell']({}) : connected.client.subscribeServerConfig({ workspaceSnapshotsOnDemand: true });
          const epoch = connected.epoch;
          await connected.runtime.runPromise(Stream.runForEach(channel, value => Effect.sync(() => {
            try { onItem(value, epoch); }
            catch (error) { onReset(epoch); throw error; } // Invalidate before error observers can start another read.
          })), { signal: stop });
        } catch (error) { if (!stop.aborted) onError(error); }
        finally { if (connected) onReset(connected.epoch); }
        if (stop.aborted) return;
        backoff = Date.now() - started > 60_000 ? 1000 : Math.min(backoff * 2, 30_000);
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); stop.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, backoff); stop.addEventListener('abort', done, { once: true }); if (stop.aborted) done();
        });
      }
    });
  }
  async close() {
    this.closed = true; this.lifetime.controller.abort(new Error('T3 client closed'));
    this.connection = undefined; this.ready = undefined;
    await Promise.allSettled([...this.inFlight]);
    await Promise.allSettled([...this.scopes].map(pending => pending.then(value => { value.retired = true; return value.dispose(); })));
  }
}
export async function callT3Rpc(socketUrl: string, action: RpcAction): Promise<unknown> {
  return rpcPhase(action, async signal => {
    const protocol = transport(socketUrl);
    return Effect.runPromise(Effect.gen(function* () {
      return yield* request(yield* makeClient(), action);
    }).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout('60 seconds')), { signal });
  });
}
