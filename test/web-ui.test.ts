import test from 'node:test';
import assert from 'node:assert/strict';

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
  removeItem: (key: string) => saved.delete(key),
}, configurable: true });

// The browser store and helpers run unchanged in Node: no DOM is touched until a view renders.
const store = await import('../web/lib/store.js');
const { api } = await import('../web/lib/api.js');
const { coerce, isBackdropClick, moveItem, decisionSentence, until, ago } = await import('../web/lib/format.js');
const { confirmation, confirmAction, finishConfirmation } = await import('../web/lib/confirmation.js');

const fixture = () => ({
  config: {
    enabled: true,
    concurrency: { claude: 1, codex: 1 },
    models: [{ id: 'm1', name: 'Original', automatic: true, maxDifficulty: 'high', model: { instanceId: 'codex', model: 'x', options: [] } }],
    projects: [{ name: 'Fixture', kaneoId: 'p', readyStatuses: ['todo'], doneStatuses: ['done'], priorityLabels: ['security', 'compatibility'] }],
  },
  status: { jobs: [] },
});

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function untilChecked(predicate: () => boolean) {
  for (let n = 0; n < 100 && !predicate(); n++) await turn();
  assert.ok(predicate(), 'dispatch state settled');
}

test('manual submissions queue behind a deferred check with captured inputs and keep draining after refusal', async () => {
  store.applyState(fixture(), true);
  const calls: any[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (url: any, init?: RequestInit) => {
    if (url !== '/api/dispatch') return Response.json(fixture());
    const input = JSON.parse(init!.body as string);
    const id = (init!.headers as any)['Idempotency-Key'];
    calls.push({ id, input });
    if (input.ticket === 'APP-1') await held;
    return Response.json({ id, input, state: 'done', result: { data: { reason: input.ticket === 'APP-1' ? 'quota-exhausted' : 'dispatched', ticket: input.ticket } } });
  };
  const first = store.startRun({ ticket: 'APP-1', model: 'sol', overrideLimits: false });
  const second = { ticket: 'APP-2', model: 'opus', overrideLimits: true };
  store.startRun(second);
  store.startRun({ ticket: 'APP-3', model: 'auto', overrideLimits: false });
  second.ticket = 'APP-99'; second.model = 'changed'; second.overrideLimits = false;
  try {
    const rows = store.operations?.value ?? [store.operation.value];
    assert.deepEqual(rows.map((op: any) => op.input.ticket), ['APP-1', 'APP-2', 'APP-3'], 'later submissions must be accepted while A is checking');
    assert.deepEqual(rows.map((op: any) => op.state), ['running', 'queued', 'queued']);
    assert.equal(calls.length, 1, 'only one check may be in flight');
  } finally { release(); await first; }
  await untilChecked(() => calls.length === 3 && store.operations.value.every((op: any) => op.state === 'done'));
  assert.deepEqual(calls.map(c => c.input), [
    { ticket: 'APP-1', model: 'sol', overrideLimits: false },
    { ticket: 'APP-2', model: 'opus', overrideLimits: true },
    { ticket: 'APP-3', model: 'auto', overrideLimits: false },
  ]);
  assert.equal(new Set(calls.map(c => c.id)).size, 3);
  store.operations.value = [];
});

test('config edits are immutable updates that mark the save bar dirty', () => {
  store.applyState(fixture(), true);
  assert.equal(store.dirty.value, false);
  store.set(['projects', '0', 'priorityLabels'], coerce('list', { value: 'compatibility, security' }));
  assert.deepEqual(store.config.value.projects[0].priorityLabels, ['compatibility', 'security']);
  assert.deepEqual(store.base.value.projects[0].priorityLabels, ['security', 'compatibility'], 'base copy is untouched');
  assert.equal(store.dirty.value, true);
  store.set(['projects', '0', 'priorityLabels'], coerce('list', { value: '' }));
  assert.deepEqual(store.config.value.projects[0].priorityLabels, []);
});

test('numeric inputs keep zero as a number', () => {
  store.applyState(fixture(), true);
  store.set(['concurrency', 'claude'], coerce('integer', { value: '0' }));
  assert.equal(store.config.value.concurrency.claude, 0);
  assert.equal(store.config.value.concurrency.codex, 1);
  assert.equal(coerce('boolean', { checked: true }), true);
  assert.equal(coerce('text', { value: ' a ' }), ' a ');
});

test('API recovers a transient empty proxy response on reads without resending writes', async () => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? new Response('', { status: 502 }) : Response.json({ state: 'done' }));
  assert.deepEqual(await api('/api/operations/saved-request'), { state: 'done' });
  assert.equal(calls, 2);

  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('<html>Unavailable</html>', { status: 503 }); };
  await assert.rejects(api('/api/dispatch', { method: 'POST', body: '{}' }), { status: 503, message: /HTTP 503/ });
  assert.equal(calls, 1, 'a lost dispatch response must be reconciled using its saved ID, never resent by the API helper');

  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 502 }); };
  await assert.rejects(api('/api/state'), { status: 502, message: /HTTP 502/ });
  assert.equal(calls, 2, 'persistent gateway failures do not cause an unbounded retry loop');

  globalThis.fetch = async () => new Response('', { status: 401 });
  store.authenticated.value = true;
  await assert.rejects(api('/api/state'), { status: 401 });
  assert.equal(store.authenticated.value, false, 'empty auth responses still open sign-in');

  globalThis.fetch = async () => new Response('');
  await assert.rejects(api('/api/state'), /empty or invalid response/);
});

test('missing-label confirmation cancels safely and binds Run anyway to the original ticket', async () => {
  const started: unknown[] = [];
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/dispatch') {
      started.push(JSON.parse(init!.body as string));
      return Response.json({ id: 'x', state: 'done', result: { data: { reason: 'dispatched' } } });
    }
    return Response.json(fixture());
  };
  store.applyState(fixture(), true);
  store.operations.value = [{ id: 'original', state: 'done', input: { ticket: 'APP-1', model: 'opus', overrideLimits: true }, result: { data: { reason: 'ready-label-confirmation-required', requiredLabel: 'sf' } } }];
  store.showReadinessConfirmation('original');
  assert.equal(store.readiness.value?.label, 'sf');
  store.readiness.value = null; // Cancel
  await store.runWithoutReadyLabel();
  assert.equal(started.length, 0, 'Cancel cannot dispatch');
  store.showReadinessConfirmation('original');
  store.operations.value = [{ ...store.operations.value[0], id: 'different' }];
  await store.runWithoutReadyLabel();
  assert.equal(started.length, 0, 'stale confirmation cannot dispatch');
  store.operations.value = [{ ...store.operations.value[0], id: 'original' }];
  store.showReadinessConfirmation('original');
  await store.runWithoutReadyLabel();
  await untilChecked(() => store.operations.value.at(-1).state === 'done');
  assert.deepEqual(started, [{ ticket: 'APP-1', model: 'opus', overrideLimits: true, allowMissingReadyLabel: true }]);
  assert.equal(store.readiness.value, null);
  store.operations.value = [];
});

test('backdrop clicks close a dialog; clicks on its content do not', () => {
  const dialog = { getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 600 }) };
  assert.equal(isBackdropClick({ target: dialog, clientX: 150, clientY: 150 }, dialog), false);
  assert.equal(isBackdropClick({ target: {}, clientX: 50, clientY: 50 }, dialog), false);
  assert.equal(isBackdropClick({ target: dialog, clientX: 50, clientY: 50 }, dialog), true);
});

test('confirmation defers the original action, cancels safely, and accepts only once', () => {
  const calls: string[] = [];
  const options = { title: 'Cancel the chain to APP-1?', message: 'Running tickets finish.', label: 'Cancel chain' };
  confirmAction(options, () => calls.push('original'));
  assert.equal(confirmation.value.title, options.title);
  assert.equal(calls.length, 0, 'opening a confirmation cannot perform the action');
  finishConfirmation();
  finishConfirmation(true);
  assert.equal(calls.length, 0, 'dismissal cannot leave a pending action');
  confirmAction(options, () => calls.push('original'));
  confirmAction(options, () => calls.push('replacement'));
  finishConfirmation(true);
  finishConfirmation(true);
  assert.deepEqual(calls, ['original'], 'repeated clicks cannot replace or repeat the action');
  assert.equal(confirmation.value, null);
});

test('reordering models keeps the list intact and selects the moved model', () => {
  assert.deepEqual(moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4]);
  assert.deepEqual(moveItem([1, 2, 3, 4], 3, 1), [1, 4, 2, 3]);
  assert.deepEqual(moveItem([1, 2], 1, 5), [1, 2], 'out-of-range moves are ignored');
  store.applyState({ ...fixture(), config: { ...fixture().config, models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } }, true);
  store.actions.moveModel(2, 0);
  assert.deepEqual(store.config.value.models.map((m: any) => m.id), ['c', 'a', 'b']);
  assert.equal(store.selectedModel.value, 0);
  assert.equal(store.dirty.value, true);
});

test('relative times accept ISO strings and millisecond numbers alike', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(until(now + 28 * 60_000, now), 'in 28 min');
  assert.equal(until(new Date(now + 3600_000).toISOString(), now), 'in 1 h');
  assert.equal(until(now - 1, now), 'now');
  assert.equal(ago(now - 90_000, now), '1 min ago');
});

test('the deck explains the last check in one sentence', () => {
  assert.equal(decisionSentence(null), 'No check has run yet.');
  assert.equal(decisionSentence({ reason: 'disabled' }), 'Automation is paused. Running work continues.');
  assert.equal(decisionSentence({ reason: 'dispatched', ticket: 'APP-1', model: 'claude-opus-5-5' }), 'Started APP-1 on claude-opus-5-5.');
  assert.equal(
    decisionSentence({ reason: 'no-eligible-ticket', eligible: 0, streams: [{ provider: 'Claude', reason: 'waiting-for-idle' }, { provider: 'Codex', reason: 'provider-disabled' }] }),
    'Claude is waiting for idle time; Codex is automatic starts off. Nothing eligible to start.',
  );
});

test('server pushes replace status but keep local config edits until saved', () => {
  store.applyState(fixture(), true);
  store.set(['concurrency', 'claude'], 3);
  store.applyState({ ...fixture(), status: { jobs: [{ id: 'j1', state: 'running' }], journal: [{ id: 1 }] } });
  assert.equal(store.config.value.concurrency.claude, 3, 'local edit survives a push');
  assert.equal(store.jobs.value.length, 1);
  assert.equal(store.journal.value.length, 1);
  assert.equal(store.dirty.value, true);
  store.applyState(fixture(), true);
  assert.equal(store.dirty.value, false);
});

test('a project added from the catalogs starts with its path, prefix, and columns filled in', () => {
  store.applyState(fixture(), true);
  store.sources.value = {
    t3: [{ id: 't3-1', title: 'widgets', workspaceRoot: '/Users/me/git/example/widgets' }],
    kaneo: { projects: [{ id: 'k1', name: 'Widgets', slug: 'WID', githubRepo: null }], columns: { k1: [{ slug: 'backlog', name: 'Backlog', isFinal: false }, { slug: 'done', name: 'Done', isFinal: true }, { slug: 'wont-do', name: "Won't do", isFinal: true }] }, labels: [] },
  };
  store.actions.addProject(store.sources.value.t3[0], store.sources.value.kaneo.projects[0]);
  const added = store.config.value.projects.at(-1);
  assert.deepEqual(
    { ...added, upstreams: undefined },
    { name: 'widgets', enabled: false, key: 'WID', kaneoId: 'k1', t3Id: 't3-1', repoPath: '/Users/me/git/example/widgets', githubRepo: 'example/widgets', baseBranch: 'main', readyStatuses: ['backlog'], doneStatuses: ['done', 'wont-do'], priorityLabels: [], upstreams: undefined },
  );
  assert.equal(store.selectedProject.value, 1);
  store.actions.linkKaneo(0, 'k1');
  assert.deepEqual(store.config.value.projects[0].readyStatuses, ['backlog'], 'relinking resets the columns to the new project');
  store.actions.addUpstream(0, { name: 'T3', repo: 'pingdotgg/t3code', firstBase: 'v1', prereleases: false });
  store.actions.setUpstream(0, 0, { name: 'T3 Code', repo: 'pingdotgg/t3code', firstBase: 'v1', prereleases: true });
  assert.equal(store.config.value.projects[0].upstreams[0].name, 'T3 Code');
  store.actions.removeUpstream(0, 0);
  assert.deepEqual(store.config.value.projects[0].upstreams, []);
});

test('readiness and chain answers remain bound to older rows after later checks finish', async () => {
  store.operations.value = []; store.readiness.value = null; store.blocked.value = null;
  store.applyState(fixture(), true);
  const calls: any[] = [];
  globalThis.fetch = async (url: any, init?: RequestInit) => {
    if (url !== '/api/dispatch') return Response.json(fixture());
    const input = JSON.parse(init!.body as string), id = (init!.headers as any)['Idempotency-Key'];
    calls.push(input);
    const reason = input.allowMissingReadyLabel || input.chain ? 'dispatched' : input.ticket === 'APP-1' ? 'ready-label-confirmation-required' : input.ticket === 'APP-2' ? 'blocked-ticket-plan-required' : 'quota-exhausted';
    return Response.json({ id, input, state: 'done', result: { data: { reason, ticket: input.ticket, requiredLabel: 'sf', tree: { tickets: [] } } } });
  };
  const a = store.startRun({ ticket: 'APP-1', model: 'sol', overrideLimits: false });
  const b = store.startRun({ ticket: 'APP-2', model: 'opus', overrideLimits: true });
  store.startRun({ ticket: 'APP-3', model: 'auto', overrideLimits: true });
  await untilChecked(() => calls.length === 3 && store.operations.value.at(-1).state === 'done');
  assert.equal(store.readiness.value.id, a);
  store.readiness.value = null; // Cancel leaves the row available to review later.
  store.showBlockedChoice(b);
  assert.equal(store.blocked.value.id, b);
  store.runChain('all'); store.runChain('first');
  store.showReadinessConfirmation(a);
  store.runWithoutReadyLabel(); store.runWithoutReadyLabel();
  await untilChecked(() => calls.length === 5 && store.operations.value.at(-1).state === 'done');
  assert.deepEqual(calls.slice(3), [
    { ticket: 'APP-2', model: 'opus', overrideLimits: true, chain: 'all' },
    { ticket: 'APP-1', model: 'sol', overrideLimits: false, allowMissingReadyLabel: true },
  ]);
  store.showReadinessConfirmation(a);
  assert.equal(store.readiness.value, null, 'an answered row cannot be submitted twice');
  store.operations.value = [];
});

test('recovery migrates one saved operation and restores queued order without resending accepted or uncertain writes', async () => {
  store.operations.value = []; saved.clear();
  const input = { ticket: 'APP-1', model: 'sol', overrideLimits: false };
  saved.set('factoryOperation', JSON.stringify({ id: 'legacy', input, state: 'running' }));
  const writes: any[] = [], reads: string[] = [];
  globalThis.fetch = async (url: any, init?: RequestInit) => {
    if (url === '/api/state') return Response.json(fixture());
    if (url === '/api/dispatch') {
      const id = (init!.headers as any)['Idempotency-Key'], input = JSON.parse(init!.body as string);
      writes.push({ id, input });
      return Response.json({ id, input, state: 'done', result: { data: { reason: 'dispatched' } } });
    }
    reads.push(url);
    return Response.json({ id: url.split('/').at(-1), input, state: 'done', result: { data: { reason: 'dispatched' } } });
  };
  store.applyState(fixture(), true);
  await store.restoreOperation();
  assert.deepEqual(reads, ['/api/operations/legacy']);
  assert.equal(writes.length, 0);
  assert.equal(saved.has('factoryOperation'), false);
  assert.equal(JSON.parse(saved.get('factoryOperations')!)[0].id, 'legacy');

  saved.set('factoryOperations', JSON.stringify([
    { id: 'uncertain', input, state: 'uncertain' },
    { id: 'accepted', input, state: 'running' },
    { id: 'b', input: { ...input, ticket: 'APP-2' }, state: 'queued' },
    { id: 'c', input: { ...input, ticket: 'APP-3', model: 'auto' }, state: 'queued' },
  ]));
  saved.set('factoryOperation', '{corrupt legacy value');
  // A fresh module is a fresh page. It must use only the persisted identities and captured inputs.
  const path = '../web/lib/store.js?reloaded-queue';
  const restored = await import(path);
  restored.applyState(fixture(), true);
  await restored.restoreOperation();
  assert.deepEqual(reads, ['/api/operations/legacy', '/api/operations/accepted']);
  assert.deepEqual(writes.map(w => [w.id, w.input.ticket]), [['b', 'APP-2'], ['c', 'APP-3']]);
  assert.deepEqual(restored.operations.value.map((op: any) => [op.id, op.state]), [['uncertain', 'uncertain'], ['accepted', 'done'], ['b', 'done'], ['c', 'done']]);
  store.operations.value = []; saved.clear();
});

test('lost POST responses are reconciled by ID and a missing request retries only explicitly with that ID', async () => {
  store.operations.value = []; store.readiness.value = null; store.blocked.value = null;
  store.applyState(fixture(), true);
  const posts: any[] = [];
  let first = true;
  globalThis.fetch = async (url: any, init?: RequestInit) => {
    if (url === '/api/state') return Response.json(fixture());
    if (url === '/api/dispatch') {
      const id = (init!.headers as any)['Idempotency-Key'], input = JSON.parse(init!.body as string);
      posts.push({ id, input });
      if (first) { first = false; throw new Error('lost response'); }
      return Response.json({ id, input, state: 'done', result: { data: { reason: 'dispatched' } } });
    }
    return Response.json({ message: 'Not found' }, { status: 404 });
  };
  const a = store.startRun({ ticket: 'APP-1', model: 'sol', overrideLimits: true });
  store.startRun({ ticket: 'APP-2', model: 'auto', overrideLimits: false });
  await untilChecked(() => posts.length === 2 && store.operations.value.at(-1).state === 'done');
  assert.equal(store.operations.value[0].state, 'uncertain');
  assert.equal(posts.filter(p => p.id === a).length, 1, 'no automatic resend');
  store.retryRequest(a); store.retryRequest(a);
  await untilChecked(() => store.operations.value.at(-1).state === 'done');
  assert.deepEqual(posts.map(p => p.input.ticket), ['APP-1', 'APP-2', 'APP-1']);
  assert.equal(posts[2].id, a);
  store.operations.value = []; saved.clear();
});

test('an accepted request keeps the next check queued until polling settles its own ID', async () => {
  store.operations.value = []; store.applyState(fixture(), true);
  const posts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let polling = false;
  globalThis.fetch = async (url: any, init?: RequestInit) => {
    if (url === '/api/state') return Response.json(fixture());
    if (url === '/api/dispatch') {
      const input = JSON.parse(init!.body as string), id = (init!.headers as any)['Idempotency-Key'];
      posts.push(input.ticket);
      return Response.json({ id, input, state: input.ticket === 'APP-1' ? 'running' : 'done', result: { data: { reason: 'dispatched' } } });
    }
    polling = true; await held;
    return Response.json({ id: url.split('/').at(-1), state: 'done', result: { data: { reason: 'dispatched' } } });
  };
  store.startRun({ ticket: 'APP-1', model: 'sol', overrideLimits: true });
  store.startRun({ ticket: 'APP-2', model: 'auto', overrideLimits: false });
  try {
    await untilChecked(() => polling);
    assert.deepEqual(posts, ['APP-1'], 'HTTP acceptance alone cannot advance the queue');
    assert.deepEqual(store.operations.value.map((op: any) => op.state), ['running', 'queued']);
  } finally { release(); }
  await untilChecked(() => posts.length === 2 && store.operations.value.at(-1).state === 'done');
  store.operations.value = []; saved.clear();
});
