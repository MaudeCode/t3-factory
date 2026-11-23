// A fake T3 WebSocket: each request is recorded and answered by `reply`; `respond` pushes later stream chunks or results.
import type { TestContext } from 'node:test';

export type RpcRequest = { id: string; tag: string; payload: unknown };
export function fixtureSocket(t: TestContext, reply: (request: RpcRequest) => unknown[]) {
  const requests: RpcRequest[] = [];
  const sockets: FixtureSocket[] = [];
  let connections = 0;
  class FixtureSocket extends EventTarget {
    readyState = 1;
    constructor() { super(); connections++; sockets.push(this); }
    send(data: string) {
      const message = JSON.parse(data);
      if (message._tag !== 'Request') return;
      requests.push(message);
      queueMicrotask(() => { for (const response of reply(message)) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(response) })); });
    }
    close() { this.readyState = 3; }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  return { disconnect: (notify = true) => { const socket = sockets.at(-1)!; socket.readyState = 3; if (notify) socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: 'Fixture disconnect' })); }, connections: () => connections, requests: () => requests.map(r => ({ tag: r.tag, payload: r.payload })), respond: (requestId: string, value: unknown, stream = false) => {
    for (const socket of sockets) if (socket.readyState === 1) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(stream ? { _tag: 'Chunk', requestId, values: [value] } : { _tag: 'Exit', requestId, exit: { _tag: 'Success', value } }) }));
  } };
}
