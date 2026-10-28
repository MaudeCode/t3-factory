import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Scope from 'effect/Scope';
import * as Rpc from 'effect/unstable/rpc/Rpc';
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup';
import * as RpcClient from 'effect/unstable/rpc/RpcClient';
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization';
import * as Socket from 'effect/unstable/socket/Socket';
import { ReadContext, readContext, readPhase, waitFor } from './read-context.ts';

// Same transport and method contracts as T3. Validate the fields we consume at the caller.
const group = RpcGroup.make(
  Rpc.make('server.getConfig', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('server.refreshProviders', { payload: Schema.Struct({ instanceId: Schema.String, refreshModels: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.dispatchCommand', { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.launchThread', { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('vcs.removeWorktree', { payload: Schema.Struct({ cwd: Schema.String, path: Schema.String, force: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('subscribeTerminalMetadata', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown, stream: true }),
  Rpc.make('terminal.close', { payload: Schema.Struct({ threadId: Schema.String, terminalId: Schema.String, deleteHistory: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.getTurnItem', { payload: Schema.Struct({ threadId: Schema.String, itemId: Schema.String }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.subscribeShell', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown, stream: true }),
);
const transport = (socketUrl: string, disconnected?: () => void) => RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
  Layer.provide(Socket.layerWebSocket(socketUrl).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
    const socket = new WebSocket(url, protocols);
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
export type RpcAction = { type: 'provider'; refreshInstance?: string } | { type: 'dispatch'; command: unknown } | { type: 'launch'; input: unknown } | { type: 'remove-worktree'; cwd: string; path: string; force?: boolean } | { type: 'turn-item'; threadId: string; itemId: string } | { type: 'terminals' } | { type: 'close-terminal'; threadId: string; terminalId: string };
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
    if (action.refreshInstance) yield* client['server.refreshProviders']({ instanceId: action.refreshInstance, refreshModels: true });
    return yield* client['server.getConfig']({});
  });
}
async function openConnection(socketUrl: string, signal: AbortSignal, disconnected: () => void) {
  let open = true;
  const runtime = ManagedRuntime.make(transport(socketUrl, () => { open = false; disconnected(); }));
  try {
    const client = await runtime.runPromise(Scope.provide(makeClient(), runtime.scope), { signal });
    // A read-only handshake proves the socket is open before a launch can acquire ownership.
    const configuration: unknown = await runtime.runPromise(request(client, { type: 'provider' }).pipe(Effect.timeout('60 seconds')), { signal });
    return { runtime, client, configuration, get open() { return open; } };
  } catch (error) { await runtime.dispose(); throw error; }
}
export class T3Rpc {
  private connection?: ReturnType<typeof openConnection>;
  private readonly lifetime = new ReadContext();
  private readonly socketUrl: () => Promise<string>;
  constructor(socketUrl: () => Promise<string>) { this.socketUrl = socketUrl; }
  connect() {
    if (!this.connection) {
      const pending = this.lifetime.run(async () => openConnection(await this.socketUrl(), this.lifetime.controller.signal, () => {
        if (this.connection !== pending) return;
        this.connection = undefined;
        void pending.then(value => value.runtime.dispose()).catch(() => {});
      }));
      this.connection = pending;
      void pending.catch(() => { if (this.connection === pending) this.connection = undefined; });
    }
    const pending = this.connection;
    return readPhase('t3.rpc.connect', signal => waitFor(pending, signal));
  }
  async call(action: RpcAction, prepared?: Awaited<ReturnType<typeof openConnection>>): Promise<unknown> {
    const connected = prepared ?? await this.connect();
    if (action.type === 'provider') {
      const configuration = connected.configuration; connected.configuration = undefined;
      if (!action.refreshInstance && configuration !== undefined) return configuration;
    }
    return rpcPhase(action, signal => connected.runtime.runPromise(request(connected.client, action).pipe(Effect.timeout('60 seconds')), { signal }));
  }
  async close() {
    this.lifetime.controller.abort(new Error('T3 client closed'));
    const connection = this.connection; this.connection = undefined;
    await connection?.then(value => value.runtime.dispose()).catch(() => {});
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
