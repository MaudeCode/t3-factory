import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { T3 } from '../src/clients.ts';

// The EventTarget fixture cannot exercise HTTP upgrades or native WebSocket state.
async function nativeRpc(t: TestContext, first: 'reject' | 'timeout') {
  const dir = mkdtempSync(join(tmpdir(), 'factory-native-rpc-'));
  const credentialFile = join(dir, 'credential.json'); writeFileSync(credentialFile, JSON.stringify({ token: 'fixture' }));
  let tickets = 0, commands = 0;
  const upgrades: string[] = [], sockets = new Set<Socket>();
  const provider = { instanceId: 'codex', driver: 'codex', status: 'ready', installed: true, enabled: true, models: [{ slug: 'fixture' }] };
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/auth/websocket-ticket');
    assert.equal(req.headers.authorization, 'Bearer fixture');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ticket: `ticket-${++tickets}` }));
  });
  const frame = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(payload.length < 126 ? 2 : 4); header[0] = 0x81;
    if (payload.length < 126) header[1] = payload.length; else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    return Buffer.concat([header, payload]);
  };
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url!, 'http://localhost'); upgrades.push(url.searchParams.get('wsTicket')!);
    if (upgrades.length === 1) { if (first === 'reject') socket.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key']! + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        let length = pending[1]! & 127, offset = 2;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (pending.length < 10) return; const wide = pending.readBigUInt64BE(2); assert.ok(wide < 1_000_000n); length = Number(wide); offset = 10; }
        const masked = !!(pending[1]! & 128), maskAt = offset; if (masked) offset += 4;
        if (pending.length < offset + length) return;
        const opcode = pending[0]! & 15, payload = Buffer.from(pending.subarray(offset, offset + length));
        if (masked) for (let n = 0; n < length; n++) payload[n] = payload[n]! ^ pending[maskAt + n % 4]!;
        pending = pending.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1 && opcode !== 2) continue;
        const message = JSON.parse(payload.toString());
        if (message._tag === 'Ping') { socket.write(frame({ _tag: 'Pong' })); continue; }
        if (message._tag !== 'Request') continue;
        if (message.tag === 'orchestration.dispatchCommand') { commands++; socket.destroy(); return; }
        socket.write(frame({ _tag: 'Exit', requestId: message.id, exit: { _tag: 'Success', value: message.tag === 'server.probe' ? {} : { providers: [provider] } } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new T3({ url: `http://127.0.0.1:${address.port}`, credentialFile }, { persistent: true });
  t.after(async () => { await client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  return { client, tickets: () => tickets, upgrades, commands: () => commands };
}

for (const failure of ['reject', 'timeout'] as const) test(`native RPC recovers a ${failure} before open with a fresh ticket and never replays a mutation`, { timeout: 20000 }, async t => {
  const f = await nativeRpc(t, failure);
  await assert.doesNotReject(() => f.client.providers(), 'a pre-open failure must recover before any mutating command');
  assert.equal(f.tickets(), 2); assert.deepEqual(f.upgrades, ['ticket-1', 'ticket-2']);
  await assert.rejects(f.client.dispatch({ commandId: 'one-submission' }));
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(f.commands(), 1, 'a possibly submitted mutation must never be replayed');
  assert.equal(f.upgrades.length, 2, 'the transport must not reconnect itself with the consumed or expired URL');
});
