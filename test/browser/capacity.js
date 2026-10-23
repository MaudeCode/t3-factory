// Actual Capacity controls and config save flow; only the server is synthetic.
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import * as store from '../../web/lib/store.js';
import { navigate } from '../../web/lib/router.js';
import { App } from '../../web/views/App.js';
const budget = { reservePercent: 10, minRemainingPercent: 5 };
const initial = {
  enabled: false, concurrency: { claude: 2, codex: 6 }, models: [], projects: [], pollSeconds: 60, idleMinutes: 30, monitoringTimeoutMinutes: 30, maxWaitingPRs: null,
  quota: { maxAgeSeconds: 300, claude: { fiveHour: budget, weekly: budget, fable: budget }, codex: { weekly: budget } },
};
let saved = structuredClone(initial), writes = [];
const state = () => ({ config: saved, status: { jobs: [], journal: [] } });
window.fetch = async (url, init) => {
  if (url === '/api/config' && init?.method === 'POST') { const input = JSON.parse(init.body); writes.push(input); saved = structuredClone(input.config); return Response.json({ ok: true }); }
  return Response.json(state());
};
const root = document.querySelector('#root');
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
async function mount() {
  render(null, root); store.history.value = null; store.applyState(state(), true); navigate('/capacity', true); render(html`<${App} />`, root); await pause();
}
async function show() { saved = structuredClone(initial); writes = []; await mount(); }
const group = provider => root.querySelector(`[role="radiogroup"][aria-label="${provider} runs at once"]`);
const field = provider => root.querySelector(`[aria-label="${provider} runs at once, custom limit"]`);
const more = provider => group(provider).lastElementChild;
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
// Opens the last slot's box, types, and presses Enter.
async function enter(provider, text) {
  more(provider).click(); await pause();
  const el = field(provider); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); key(el, 'Enter'); await pause();
  return el;
}
async function liveEdit() {
  await show();
  for (const provider of ['Claude', 'Codex']) {
    more(provider).click(); await pause();
    const el = field(provider);
    for (const text of ['', '1', '12']) {
      el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); await pause();
      store.clock.value += 1000; await pause();
      store.applyState(state()); await pause();
      assert(field(provider) === el && document.activeElement === el, `${provider} keeps the same focused custom input during live refresh`);
      assert(el.value === text, `${provider} custom draft survives live refresh: expected ${JSON.stringify(text)}, got ${JSON.stringify(el.value)}`);
      assert(!store.dirty.value, 'typing alone does not commit the custom limit');
    }
    key(el, 'Enter'); await pause();
    assert(more(provider).textContent === '12', `${provider} commits the retained draft`);
    await store.actions.save(); await mount();
    assert(more(provider).textContent === '12', `${provider} retained draft survives Save and reload`);
    more(provider).click(); await pause();
    const reopened = field(provider);
    assert(reopened.value === '12', 'reopening starts with the saved limit');
    reopened.value = '30'; reopened.dispatchEvent(new Event('input', { bubbles: true })); await pause();
    key(reopened, 'Escape'); await pause();
    assert(more(provider).textContent === '12', 'Escape discards the retained draft');
    more(provider).click(); await pause();
    const blurred = field(provider);
    assert(blurred.value === '12', 'reopening discards the cancelled draft');
    blurred.value = '14'; blurred.dispatchEvent(new Event('input', { bubbles: true })); await pause();
    store.clock.value += 1000; await pause(); blurred.blur(); await pause();
    assert(more(provider).textContent === '14', 'leaving a valid draft commits it after a refresh');
    await store.actions.save(); await mount();
  }
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function run() {
  await liveEdit();
  await show();
  assert(!field('Claude') && more('Claude').textContent === '7+', 'the custom box stays closed until the last slot is chosen');
  await enter('Claude', '12'); await enter('Codex', '7');
  assert(store.config.value.concurrency.claude === 12 && store.config.value.concurrency.codex === 7, 'both providers accept values above six');
  assert(!field('Claude') && more('Claude').textContent === '12' && more('Claude').getAttribute('aria-checked') === 'true', 'a custom limit shows as the checked last slot');
  assert(store.dirty.value && root.querySelector('[aria-label="Unsaved changes"]'), 'the existing save flow tracks custom edits');
  root.querySelector('[aria-label="Unsaved changes"] button:last-child').click();
  for (let n = 0; n < 100 && (store.busy.value || store.dirty.value); n++) await pause();
  assert(writes.length === 1 && saved.concurrency.claude === 12 && saved.concurrency.codex === 7 && !store.dirty.value, 'Save persists integer capacities');
  await mount(); assert(more('Claude').textContent === '12' && more('Codex').textContent === '7', 'saved custom limits survive reload');
  for (const text of ['', '-1', '1.5', '1e999', '9007199254740992']) {
    const el = await enter('Claude', text);
    assert(store.config.value.concurrency.claude === 12, `invalid input ${text} never enters the config`);
    assert(field('Claude'), 'Enter on invalid input keeps the box open');
    el.dispatchEvent(new FocusEvent('blur')); await pause();
    assert(!field('Claude') && more('Claude').textContent === '12', 'leaving invalid input restores the accepted limit');
  }
  more('Claude').click(); await pause();
  const box = field('Claude'); assert(box.value === '12' && document.activeElement === box, 'the box opens focused on the current limit');
  box.value = '40'; key(box, 'Escape'); await pause();
  assert(!field('Claude') && store.config.value.concurrency.claude === 12, 'Escape discards the edit');
  await enter('Claude', '1000000');
  assert(store.config.value.concurrency.claude === 1000000, 'large integers are accepted');
  store.status.value = { ...store.status.value, jobs: Array.from({ length: 8 }, (_, i) => ({ id: String(i), state: 'running', providerDriver: 'codex' })) }; await pause();
  assert(root.textContent.includes('8 running'), 'the actual running count remains visible');
  assert(root.querySelectorAll('.slots button').length === 16, 'custom limits and running counts never generate a button for each run');
  await enter('Codex', '0');
  assert(store.config.value.concurrency.codex === 0 && group('Codex').querySelector('[aria-checked="true"]').textContent === 'Off', 'zero means Off');
  group('Claude').querySelector('[aria-label="3 at once"]').click(); await pause();
  assert(store.config.value.concurrency.claude === 3 && more('Claude').textContent === '7+', 'quick picks clear the custom slot');
  assert(document.documentElement.scrollWidth <= innerWidth, 'capacity controls stay within the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], writes: writes.length };
}
window.capacityTests = { run, liveEdit, show, mount };
await show();
