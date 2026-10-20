// Real application views and store, synthetic authentication and dispatch only.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { App } from "../../web/views/App.js";

const state = {
  config: { enabled: false, concurrency: { claude: 1, codex: 1 }, models: [], projects: [{ kaneoId: "p", key: "APP", name: "Example", enabled: true }, { kaneoId: "off", key: "OFF", name: "Disabled", enabled: false }], kaneo: { url: "https://tracker.example", workspaceId: "w" } },
  status: { jobs: [], journal: [] },
};
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const root = document.querySelector('#root');
let calls = [], release;
window.fetch = async (url, init) => {
  if (url === '/api/history') return Response.json([]);
  if (url !== '/api/dispatch') return Response.json(state);
  const input = JSON.parse(init.body), id = init.headers['Idempotency-Key'];
  calls.push({ input, id });
  await new Promise(resolve => { release = resolve; });
  return Response.json({ id, input, state: 'done', result: { data: { reason: 'quota-exhausted' } } });
};
async function show(path = '/start?ticket=app-123', signedIn = true) {
  render(null, root);
  store.operations.value = [];
  store.history.value = [];
  store.applyState(state, true);
  store.auth.value = { mode: 'oidc', loginUrl: '/auth/login' };
  store.authenticated.value = signedIn;
  navigate(path, true);
  render(html`<${App} />`, root);
  await pause();
}
const named = () => `${root.querySelector('[aria-label^="Ticket project"] span')?.textContent}-${root.querySelector('[aria-label="Ticket number"]').value}`;
async function run() {
  calls = [];
  await show('/start?ticket=app-123', false);
  const login = root.querySelector('button');
  assert(login?.textContent.includes('Sign in'), 'launch link requires authentication');
  assert(calls.length === 0, 'signed-out navigation does not dispatch');
  await show();
  assert(named() === 'APP-123', 'launch link prefills the named ticket');
  assert(root.querySelector('button[type="submit"]').getAttribute('aria-label') === 'Start APP-123', 'explicit named start action');
  assert(calls.length === 0, 'opening and authenticating does not dispatch');
  navigate('/runs'); await pause();
  const back = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
  window.history.back(); await back; await pause();
  assert(named() === 'APP-123', 'back restores the named ticket without dispatch');
  const forward = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
  window.history.forward(); await forward; await pause();
  navigate('/start?ticket=APP-124'); await pause();
  assert(named() === 'APP-124', 'history navigation updates the ticket');
  assert(calls.length === 0, 'leaving and reopening cannot dispatch');
  for (const query of ['', '?ticket=bad', '?ticket=APP-1&ticket=APP-2']) {
    await show('/start' + query);
    assert(root.querySelector('[role="alert"]'), 'invalid link has an error');
    root.querySelector('.composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await pause();
    assert(calls.length === 0, 'invalid launch cannot fall back to the next eligible ticket');
  }
  // A bad link is repaired by typing a number; only enabled projects are offered.
  await show('/start?ticket=bad');
  const picker = root.querySelector('[aria-label^="Ticket project"]');
  picker.click(); await pause();
  assert([...document.getElementById(picker.getAttribute('aria-controls')).children].map(li => li.textContent).join() === 'APP', 'disabled projects are not offered as ticket keys');
  picker.click(); await pause();
  const number = root.querySelector('[aria-label="Ticket number"]');
  number.value = '7'; number.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(!root.querySelector('[role="alert"]') && !root.querySelector('button[type="submit"]').disabled, 'a typed ticket repairs an invalid link');
  root.querySelector('button[type="submit"]').click(); await pause();
  try { assert(calls.length === 1 && calls[0].input.ticket === 'APP-7', 'the repaired link dispatches the typed ticket'); } finally { release?.(); }
  await pause();
  calls = []; release = null;
  await show('/start?ticket=APP-123&chain=all&allowMissingReadyLabel=true&model=evil');
  const button = root.querySelector('button[type="submit"]');
  button.click(); button.click();
  await pause();
  try {
    assert(calls.length === 1, 'repeated clicks submit once');
    assert(JSON.stringify(calls[0].input) === JSON.stringify({ ticket: 'APP-123', model: 'auto', overrideLimits: true }), 'URL cannot add hidden dispatch options');
    assert(calls[0].id, 'dispatch retains an idempotency key');
  } finally { release?.(); }
  await pause();
  assert(root.querySelector('.operation')?.textContent.includes('quota-exhausted'), 'existing request row shows refusals');
  await whitespace();
  await statusLayout();
  await show();
  assert(document.documentElement.scrollWidth <= innerWidth, 'launch form fits viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], dispatches: calls.length };
}
async function whitespace() {
  for (const path of ['/', '/start?ticket=APP-123']) {
    calls = []; release = null;
    await show(path);
    const input = root.querySelector('[aria-label="Ticket number"]');
    input.value = ' 123 ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await pause();
    root.querySelector('button[type="submit"]').click();
    await pause();
    try {
      assert(calls.length === 1, `pasted whitespace submits once on ${path}`);
      assert(calls[0].input.ticket === 'APP-123', 'the number is cleaned and joined to the project key');
    } finally { release?.(); }
    await pause();
  }
  return { passed: true, contexts: ['manual', 'linked'] };
}
async function showDecision(decision = { reason: 'dispatched', ticket: 'APP-123', model: 'Example model' }) {
  await show('/');
  store.status.value = { ...store.status.value, decision: { ...decision, at: new Date().toISOString() } };
  await pause();
}
async function statusLayout() {
  await showDecision({ reason: 'disabled' });
  const input = () => root.querySelector('[aria-label="Ticket number"]').getBoundingClientRect();
  const before = input();
  for (const decision of [
    { reason: 'dispatched', ticket: 'APP-123', model: 'Example model' },
    { reason: 'dispatched', upstream: { name: 'Example upstream', candidate: 'release-'.repeat(30) }, model: 'Example model' },
    { reason: 'error', message: 'diagnostic'.repeat(100) },
  ]) {
    store.status.value = { ...store.status.value, decision: { ...decision, at: new Date().toISOString() } };
    await pause();
    const after = input(), form = root.querySelector('.status .composer').getBoundingClientRect();
    const message = root.querySelector('.status p'), bounds = message.getBoundingClientRect();
    assert(Math.abs(before.x - after.x) < 1 && Math.abs(before.width - after.width) < 1 && Math.abs(before.y - after.y) < 1, 'decision feedback does not shift or resize the ticket input');
    assert(message.textContent.includes(decision.reason === 'error' ? decision.message : 'Started'), 'complete decision feedback remains visible');
    assert(innerWidth <= 900 ? bounds.top >= form.bottom : bounds.left >= form.right, 'decision feedback follows the form on desktop and stacks below it on mobile');
    assert(bounds.left >= 0 && bounds.right <= innerWidth && message.scrollWidth <= message.clientWidth + 1, 'long decision feedback wraps within the viewport');
    assert(document.documentElement.scrollWidth <= innerWidth, 'status header does not overflow the viewport');
  }
  await showDecision();
  return { passed: true, viewport: [innerWidth, innerHeight], decisions: 3 };
}
window.startTests = { show, run, whitespace, showDecision, statusLayout };
await show();
