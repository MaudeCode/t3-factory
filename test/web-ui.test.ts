import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Execute the browser's actual event handlers without live API calls.
function ui() {
  const listeners = new Map<string, Function[]>();
  const nodes = new Map<string, any>();
  const document = {
    addEventListener(type: string, callback: Function) {
      listeners.set(type, [...(listeners.get(type) ?? []), callback]);
    },
    querySelector(selector: string) {
      if (!nodes.has(selector)) nodes.set(selector, {
        hidden: true, open: true,
        addEventListener(type: string, callback: Function) {
          listeners.set(`${selector}:${type}`, [...(listeners.get(`${selector}:${type}`) ?? []), callback]);
        },
        getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 600 }),
        close() { this.open = false; },
        showModal() { this.open = true; },
      });
      return nodes.get(selector);
    },
  };
  const context = createContext({ document, structuredClone,
    fetch: () => new Promise(() => {}), setInterval: () => {},
  });
  runInContext(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), context);
  runInContext('state.config = { models: [{ name: "Original" }] }; state.base = clone(state.config);', context);
  async function fire(type: string, target: any, properties = {}) {
    const event = new Event(type.split(':').at(-1)!, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.defineProperty(event, 'currentTarget', { value: type.startsWith('#model-dialog:') ? document.querySelector('#model-dialog') : document });
    Object.assign(event, properties);
    for (const callback of listeners.get(type) ?? []) await callback(event);
    return event;
  }
  return { context, document, fire };
}

test('Done keeps native dialog submission available before and after model edits', async () => {
  const { context, document, fire } = ui();
  assert.equal((await fire('submit', { id: '', method: 'dialog' })).defaultPrevented, false);
  await fire('input', { dataset: { path: '["models","0","name"]', kind: 'text' }, value: 'Edited' });
  assert.equal(document.querySelector('#save-bar').hidden, false);
  assert.equal((await fire('submit', { id: '', method: 'dialog' })).defaultPrevented, false);
  assert.equal(runInContext('state.config.models[0].name', context), 'Edited');
  // The run form must still be handled by JavaScript, even while busy.
  runInContext('state.busy = true;', context);
  assert.equal((await fire('submit', { id: 'run-form', method: 'post' })).defaultPrevented, true);
});

test('clicking the model backdrop closes the dialog; clicking its content does not', async () => {
  const { document, fire } = ui();
  const dialog = document.querySelector('#model-dialog');
  await fire('#model-dialog:click', dialog, { clientX: 150, clientY: 150 });
  assert.equal(dialog.open, true);
  await fire('#model-dialog:click', { closest: () => null }, { clientX: 50, clientY: 50 });
  assert.equal(dialog.open, true);
  await fire('#model-dialog:click', dialog, { clientX: 50, clientY: 50 });
  assert.equal(dialog.open, false);
});


test('provider limit inputs retain zero as a numeric setting', async () => {
  const { context, document, fire } = ui();
  runInContext('state.config.concurrency = { claude: 1, codex: 1 }; state.base = clone(state.config);', context);
  await fire('input', { dataset: { path: '["concurrency","claude"]', kind: 'number' }, value: '0' });
  assert.equal(runInContext('state.config.concurrency.claude', context), 0);
  assert.equal(runInContext('state.config.concurrency.codex', context), 1);
  assert.equal(document.querySelector('#save-bar').hidden, false);
  const html = runInContext('field("Claude run limit", ["concurrency", "claude"], "integer")', context);
  assert.match(html, /min="0" step="1"/);
  assert.match(html, /value="0"/);
});


test('missing-label confirmation cancels safely and binds Run anyway to the original ticket', async () => {
  const { context, document, fire } = ui();
  runInContext(`
    state.operation = { id: 'original', state: 'done', input: { ticket: 'APP-1', model: 'opus', overrideLimits: true }, result: { data: { reason: 'ready-label-confirmation-required', requiredLabel: 'sf' } } };
    startRun = async input => { globalThis.started = input; };
    showReadinessConfirmation();
  `, context);
  assert.equal(document.querySelector('#readiness-dialog').open, true);
  assert.match(document.querySelector('#readiness-description').textContent, /skips only/);
  await fire('#readiness-dialog:close', document.querySelector('#readiness-dialog'));
  await runInContext('action("run-without-ready-label")', context);
  assert.equal(runInContext('globalThis.started', context), undefined, 'Cancel cannot dispatch');
  runInContext('showReadinessConfirmation(); state.operation.id = "different";', context);
  await runInContext('action("run-without-ready-label")', context);
  assert.equal(runInContext('globalThis.started', context), undefined, 'stale confirmation cannot dispatch');
  runInContext('state.operation.id = "original"; showReadinessConfirmation();', context);
  await runInContext('action("run-without-ready-label")', context);
  assert.equal(runInContext('globalThis.started.ticket', context), 'APP-1');
  assert.equal(runInContext('globalThis.started.model', context), 'opus');
  assert.equal(runInContext('globalThis.started.allowMissingReadyLabel', context), true);
  assert.equal(document.querySelector('#readiness-dialog').open, false);
});
