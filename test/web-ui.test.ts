import test from 'node:test';
import assert from 'node:assert/strict';

// The browser store and helpers run unchanged in Node: no DOM is touched until a view renders.
const store = await import('../web/lib/store.js');
const { api } = await import('../web/lib/api.js');
const { coerce, isBackdropClick, selectPosition, moveItem, decisionSentence, until, ago } = await import('../web/lib/format.js');
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
  store.operation.value = { id: 'original', state: 'done', input: { ticket: 'APP-1', model: 'opus', overrideLimits: true }, result: { data: { reason: 'ready-label-confirmation-required', requiredLabel: 'sf' } } };
  store.showReadinessConfirmation();
  assert.equal(store.readiness.value?.label, 'sf');
  store.readiness.value = null; // Cancel
  await store.runWithoutReadyLabel();
  assert.equal(started.length, 0, 'Cancel cannot dispatch');
  store.showReadinessConfirmation();
  store.operation.value = { ...store.operation.value, id: 'different' };
  await store.runWithoutReadyLabel();
  assert.equal(started.length, 0, 'stale confirmation cannot dispatch');
  store.operation.value = { ...store.operation.value, id: 'original' };
  store.showReadinessConfirmation();
  await store.runWithoutReadyLabel();
  assert.deepEqual(started, [{ ticket: 'APP-1', model: 'opus', overrideLimits: true, allowMissingReadyLabel: true }]);
  assert.equal(store.readiness.value, null);
});

test('backdrop clicks close a dialog; clicks on its content do not', () => {
  const dialog = { getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 600 }) };
  assert.equal(isBackdropClick({ target: dialog, clientX: 150, clientY: 150 }, dialog), false);
  assert.equal(isBackdropClick({ target: {}, clientX: 50, clientY: 50 }, dialog), false);
  assert.equal(isBackdropClick({ target: dialog, clientX: 50, clientY: 50 }, dialog), true);
});

test('Select placement uses the available viewport below or above and clamps narrow or zoomed views', () => {
  const trigger = { left: 100, top: 100, bottom: 140, width: 240 };
  assert.deepEqual(selectPosition(trigger, { width: 1280, height: 800 }, 500), { left: 100, top: 144, width: 240, height: 280 });
  assert.deepEqual(selectPosition({ ...trigger, top: 740, bottom: 780 }, { width: 1280, height: 800 }, 500), { left: 100, top: 456, width: 240, height: 280 });
  assert.deepEqual(selectPosition({ left: 300, top: 150, bottom: 190, width: 400 }, { width: 390, height: 400 }, 500), { left: 8, top: 194, width: 374, height: 198 });
  assert.deepEqual(selectPosition(trigger, { width: 300, height: 200, offsetLeft: 50, offsetTop: 80 }, 40), { left: 100, top: 144, width: 240, height: 40 });
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
