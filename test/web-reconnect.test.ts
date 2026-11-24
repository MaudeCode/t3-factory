import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/lib/store.js';

const state = () => ({ config: { enabled: false, concurrency: {}, projects: [], models: [] }, status: { jobs: [] } });
function setup(t: any) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  const streams: Stream[] = [];
  class Stream extends EventTarget {
    static CLOSED = 2;
    readyState = 0;
    onerror: null | (() => void) = null;
    closed = false;
    url: string;
    constructor(url: string) { super(); this.url = url; streams.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    fail(closed = true) { this.readyState = closed ? 2 : 0; this.onerror?.(); }
    state() { this.readyState = 1; this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(state()) })); }
  }
  const restore: (() => void)[] = [];
  for (const [key, value] of Object.entries({ document, window, EventSource: Stream })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    restore.push(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  store.applyState(state(), true);
  store.connection.value = 'connecting';
  store.message(null);
  const stop = store.subscribe();
  t.after(() => { stop(); restore.forEach(fn => fn()); });
  const advance = async (ms = 1000) => { t.mock.timers.tick(ms); for (let n = 0; n < 20; n++) await Promise.resolve(); };
  return { streams, document, window, stop, advance };
}

test('deployment recovery retries quietly and resumes live state without losing edits or action errors', async t => {
  const h = setup(t);
  let failing = true, reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { reads++; return failing ? new Response('', { status: 502 }) : Response.json(state()); });
  await h.advance();
  h.streams[0].state();
  store.set(['enabled'], true);
  h.streams[0].fail();
  await h.advance();
  assert.equal(store.notice.value, null, 'deployment HTTP 502 must not become a persistent notification');
  assert.equal(store.connection.value, 'retrying');
  for (let n = 0; n < 40; n++) { h.streams.at(-1)?.fail(); await h.advance(); }
  assert.ok(reads < 30, 'repeated outages back off instead of retrying every tick');
  assert.ok(h.streams.length < 10, 'stream recreation also backs off');
  store.message('Save rejected: configuration changed', true);
  failing = false;
  h.window.dispatchEvent(new Event('online'));
  await h.advance();
  h.streams.at(-1)!.state();
  assert.equal(store.connection.value, 'live');
  assert.equal(store.config.value.enabled, true, 'unsaved edits survive reconnect');
  assert.match(store.notice.value.text, /Save rejected/, 'recovery preserves an unrelated action error');
  assert.equal(h.streams.filter(s => !s.closed).length, 1);
});

test('recovery serializes reads, aborts on unsubscribe and ignores late stream events', async t => {
  const h = setup(t);
  let reads = 0, signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', (_url: any, options: any) => {
    reads++; signal = options?.signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  await h.advance();
  h.streams[0].fail(false);
  await h.advance();
  h.window.dispatchEvent(new Event('online'));
  h.document.dispatchEvent(new Event('visibilitychange'));
  await h.advance(60000);
  assert.equal(reads, 1);
  h.stop();
  assert.equal(signal?.aborted, true);
  const before = store.connection.value;
  h.streams[0].state();
  assert.equal(store.connection.value, before, 'disposed stream cannot restore live state');
  await h.advance(60000);
  assert.equal(reads, 1);
});

test('an expired session stops recovery and opens sign-in without a retry storm', async t => {
  const h = setup(t);
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { reads++; return new Response('', { status: 401 }); });
  await h.advance();
  h.streams[0].fail();
  await h.advance();
  assert.equal(store.authenticated.value, false);
  await h.advance(60000);
  assert.equal(reads, 1);
  assert.equal(h.streams.filter(s => !s.closed).length, 0);
  assert.equal(store.notice.value, null);
});


test('returning to a visible page restarts the clock, reconnects a stale live stream and cancels stale recovery failures', async t => {
  const h = setup(t);
  let rejectRead!: (error: Error) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise((_resolve, reject) => { rejectRead = reject; }));
  await h.advance();
  h.streams[0].state();
  h.document.hidden = true;
  h.document.dispatchEvent(new Event('visibilitychange'));
  const still = store.clock.value;
  await h.advance(60000);
  assert.equal(h.streams.length, 1, 'hidden tabs do not create connections');
  assert.equal(store.clock.value, still, 'a hidden tab keeps its clock still, so nothing re-renders in the background');
  h.document.hidden = false;
  h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(store.clock.value, Date.now(), 'the clock catches up as soon as the tab is visible');
  assert.equal(h.streams.length, 2, 'visibility recovery replaces even a stale live stream');
  assert.equal(h.streams[0].closed, true);
  h.streams[1].state();
  rejectRead(new TypeError('Network lost'));
  await h.advance();
  assert.equal(store.connection.value, 'live', 'late background failure cannot undo a fresh stream state');
  assert.equal(store.notice.value, null);
});

test('browser offline closes a stale live stream immediately and online resumes it', async t => {
  const h = setup(t);
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { reads++; return Response.json(state()); });
  await h.advance();
  h.streams[0].state();
  h.window.dispatchEvent(new Event('offline'));
  assert.equal(store.connection.value, 'retrying', 'offline browser must stop reporting a stale stream as Live');
  assert.equal(h.streams[0].closed, true);
  await h.advance(60000);
  assert.equal(h.streams.length, 1, 'offline browsers do not recreate streams');
  assert.equal(reads, 0, 'offline browsers do not send fallback reads');
  h.window.dispatchEvent(new Event('online'));
  assert.equal(h.streams.length, 2);
  h.streams[1].state();
  assert.equal(store.connection.value, 'live');
  assert.equal(store.notice.value, null);
});

test('a view that needs an on-demand section reads it once and widens the stream, and reconnects keep it', async t => {
  const h = setup(t);
  const reads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    reads.push(url);
    return Response.json(url.includes('fields=') ? { status: { upNext: { tickets: [{ id: 't1' }], held: [] } } } : state());
  });
  await h.advance();
  assert.equal(h.streams[0].url, '/api/events?with=', 'a page starts with the base sections only');
  h.streams[0].state();
  const before = store.statusSection('jobs').value;
  // The Queue and its ticket panel both read Up next in the same render.
  store.needSection('upNext'); store.needSection('upNext');
  await h.advance(0);
  assert.deepEqual(reads, ['/api/state?fields=upNext']);
  assert.deepEqual(store.statusSection('upNext').value.tickets, [{ id: 't1' }]);
  assert.equal(store.statusSection('jobs').value, before, 'the section read leaves the other sections in place');
  assert.equal(h.streams.length, 2); assert.equal(h.streams[0].closed, true);
  assert.equal(h.streams[1].url, '/api/events?with=upNext');
  store.needSection('upNext');
  await h.advance(0);
  assert.equal(reads.length, 1); assert.equal(h.streams.length, 2, 'a held section needs no read and no reopen');
  h.streams[1].fail();
  await h.advance(2000);
  assert.equal(h.streams.at(-1)!.url, '/api/events?with=upNext', 'a reconnect keeps the widened set');
  assert.equal(reads.at(-1), '/api/state?with=upNext', 'the fallback read asks for the held set too');
});
