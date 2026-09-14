import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as Rpc from 'effect/unstable/rpc/Rpc';
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup';
import * as RpcClient from 'effect/unstable/rpc/RpcClient';
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization';
import * as Socket from 'effect/unstable/socket/Socket';

// Same transport and method contracts as T3. Validate the fields we consume at the caller.
const group = RpcGroup.make(
  Rpc.make('server.getConfig', { payload: Schema.Struct({}), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('server.refreshProviders', { payload: Schema.Struct({ instanceId: Schema.String }), success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make('orchestration.dispatchCommand', { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
);
export async function callT3Rpc(socketUrl: string, action: { type: 'provider'; refreshInstance?: string } | { type: 'dispatch'; command: unknown }): Promise<unknown> {
  const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Socket.layerWebSocket(socketUrl).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => new WebSocket(url, protocols))))),
    Layer.provide(RpcSerialization.layerJson),
  );
  return Effect.runPromise(Effect.gen(function* () {
    const client = yield* RpcClient.make(group);
    if (action.type === 'dispatch') return yield* client['orchestration.dispatchCommand'](action.command);
    if (action.refreshInstance) yield* client['server.refreshProviders']({ instanceId: action.refreshInstance });
    return yield* client['server.getConfig']({});
  }).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout('60 seconds')));
}
