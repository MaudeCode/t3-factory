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
const field = provider => root.querySelector(`[aria-label="${provider} runs at once custom limit"]`);
async function input(provider, text) { const el = field(provider); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); await pause(); return el; }
async function run() {
  await show();
  assert(field('Claude') && field('Codex'), 'each provider exposes a custom integer capacity field');
  await input('Claude', '12'); await input('Codex', '7');
  assert(store.config.value.concurrency.claude === 12 && store.config.value.concurrency.codex === 7, 'both providers accept values above six');
  assert(store.dirty.value && root.querySelector('[aria-label="Unsaved changes"]'), 'the existing save flow tracks custom edits');
  root.querySelector('[aria-label="Unsaved changes"] button:last-child').click();
  for (let n = 0; n < 100 && (store.busy.value || store.dirty.value); n++) await pause();
  assert(writes.length === 1 && saved.concurrency.claude === 12 && saved.concurrency.codex === 7 && !store.dirty.value, 'Save persists integer capacities');
  await mount(); assert(field('Claude').value === '12' && field('Codex').value === '7', 'saved custom limits survive reload');
  for (const text of ['', '-1', '1.5', '1e999', '9007199254740992']) {
    const before = store.config.value.concurrency.claude;
    const el = await input('Claude', text);
    assert(store.config.value.concurrency.claude === before, `invalid input ${text} never enters the config`);
    el.dispatchEvent(new FocusEvent('blur')); await pause();
    assert(field('Claude').value === String(before), 'leaving invalid input restores the accepted limit');
  }
  await input('Claude', '1000000');
  assert(store.config.value.concurrency.claude === 1000000, 'large integers are accepted');
  store.status.value = { ...store.status.value, jobs: Array.from({ length: 8 }, (_, i) => ({ id: String(i), state: 'running', providerDriver: 'codex' })) }; await pause();
  assert(root.textContent.includes('8 running'), 'the actual running count remains visible');
  assert(root.querySelectorAll('.slots button').length <= 14, 'custom limits and running counts never generate a button for each run');
  await input('Codex', '0');
  assert(store.config.value.concurrency.codex === 0 && root.querySelector('[role="radiogroup"][aria-label="Codex runs at once"] [aria-checked="true"]').textContent === 'Off', 'zero means Off');
  root.querySelector('[role="radiogroup"][aria-label="Claude runs at once"] [aria-label="3 at once"]').click(); await pause();
  assert(store.config.value.concurrency.claude === 3 && field('Claude').value === '3', 'quick picks synchronize the custom field');
  assert(document.documentElement.scrollWidth <= innerWidth, 'capacity controls stay within the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], writes: writes.length };
}
window.capacityTests = { run, show, mount };
await show();
