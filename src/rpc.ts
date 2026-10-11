import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import * as Rpc from 'effect/unstable/rpc/Rpc';
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup';
import * as RpcClient from 'effect/unstable/rpc/RpcClient';
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization';
import * as Socket from 'effect/unstable/socket/Socket';

// Same transport and method contracts as T3. Validate the fields we consume at the caller.
const group = RpcGroup.make(
  Rpc.make('server.getConfig', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('server.refreshProviders', { payload: Schema.Struct({ instanceId: Schema.String, refreshModels: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.dispatchCommand', { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.launchThread', { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('vcs.removeWorktree', { payload: Schema.Struct({ cwd: Schema.String, path: Schema.String, force: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('subscribeTerminalMetadata', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown, stream: true }),
  Rpc.make('terminal.close', { payload: Schema.Struct({ threadId: Schema.String, terminalId: Schema.String, deleteHistory: Schema.Boolean }), success: Schema.Unknown, error: Schema.Unknown }),
);
export async function callT3Rpc(socketUrl: string, action: { type: 'provider'; refreshInstance?: string } | { type: 'dispatch'; command: unknown } | { type: 'launch'; input: unknown } | { type: 'remove-worktree'; cwd: string; path: string } | { type: 'terminals' } | { type: 'close-terminal'; threadId: string; terminalId: string }): Promise<unknown> {
  const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Socket.layerWebSocket(socketUrl).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => new WebSocket(url, protocols))))),
    Layer.provide(RpcSerialization.layerJson),
  );
  return Effect.runPromise(Effect.gen(function* () {
    const client = yield* RpcClient.make(group);
    if (action.type === 'dispatch') return yield* client['orchestration.dispatchCommand'](action.command);
    if (action.type === 'launch') return yield* client['orchestration.launchThread'](action.input);
    if (action.type === 'remove-worktree') return yield* client['vcs.removeWorktree']({ cwd: action.cwd, path: action.path, force: false });
    // The metadata stream opens with a snapshot of every terminal.
    if (action.type === 'terminals') return Option.getOrNull(yield* Stream.runHead(client['subscribeTerminalMetadata']({})));
    // Without terminalId, T3 closes every terminal of the thread, including busy ones.
    if (action.type === 'close-terminal') return yield* client['terminal.close']({ threadId: action.threadId, terminalId: action.terminalId, deleteHistory: false });
    // T3 only invalidates its cached capability/usage probe when refreshModels is set.
    if (action.refreshInstance) yield* client['server.refreshProviders']({ instanceId: action.refreshInstance, refreshModels: true });
    return yield* client['server.getConfig']({});
  }).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout('60 seconds')));
}
