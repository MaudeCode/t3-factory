// Real application views and store, synthetic authentication and dispatch only.
import { html, render } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import * as store from "../../web/lib/store.js";
import { navigate } from "../../web/lib/router.js";
import { App } from "../../web/views/App.js";

const state = {
  config: { enabled: false, concurrency: { claude: 1, codex: 1 }, models: [], projects: [{ kanvilId: "p", key: "APP", name: "Example", enabled: true }, { kanvilId: "f", key: "T3F", name: "Factory", enabled: true }, { kanvilId: "off", key: "OFF", name: "Disabled", enabled: false }], kanvil: { url: "https://tracker.example", workspaceId: "w" } },
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
// Away from a launch link the start bar is in the Start a run panel.
async function openStart() {
  if (root.querySelector('.composer')) return;
  root.querySelector('.start-btn').click();
  await pause();
}
const contentWidth = () => root.querySelector('.content').clientWidth;
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
  assert([...document.getElementById(picker.getAttribute('aria-controls')).children].map(li => li.textContent).join() === 'APP,T3F', 'disabled projects are not offered as ticket keys');
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
  assert(root.querySelector('.now-section.attention')?.textContent.includes('quota-exhausted'), 'a refused request is listed under Needs you with its reason');
  await whitespace();
  await paste();
  await statusLayout();
  await show();
  assert(document.documentElement.scrollWidth <= innerWidth, 'launch form fits viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], dispatches: calls.length };
}
async function whitespace() {
  for (const path of ['/', '/start?ticket=APP-123']) {
    calls = []; release = null;
    await show(path);
    await openStart();
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
// A pasted key keeps only its own number and selects its enabled project, even when the key contains digits.
async function paste() {
  for (const [text, expected] of [["T3F-48", "T3F-48"], ["app-7", "APP-7"], ["APP-481", "APP-481"], ["XYZ-12", "APP-12"], [" 42 ", "APP-42"], ["See T3F-9: details", "T3F-9"], ["12T3F-48", "T3F-48"]]) {
    await show('/');
    await openStart();
    const input = root.querySelector('[aria-label="Ticket number"]');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await pause();
    assert(named() === expected, `pasting "${text}" names ${expected}, got ${named()}`);
    assert(root.querySelector('button[type="submit"]').getAttribute('aria-label') === `Start ${expected}`, `start action names ${expected}`);
  }
  // Pasting the ticket already named changes no state, yet leaves no key text in the field.
  const input = root.querySelector('[aria-label="Ticket number"]');
  input.value = "T3F-48";
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await pause();
  assert(named() === 'T3F-48', `re-pasting the named ticket keeps T3F-48, got ${named()}`);
  calls = []; release = null;
  root.querySelector('button[type="submit"]').click();
  await pause();
  try { assert(calls.length === 1 && calls[0].input.ticket === 'T3F-48', 'the pasted project and number dispatch together'); } finally { release?.(); }
  await pause();
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function showDecision(decision = { reason: 'dispatched', ticket: 'APP-123', model: 'Example model' }) {
  await show('/start?ticket=APP-123');
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
    const after = input(), form = root.querySelector('.now > .composer').getBoundingClientRect();
    const message = root.querySelector('.now-decision'), bounds = message.getBoundingClientRect();
    assert(Math.abs(before.x - after.x) < 1 && Math.abs(before.width - after.width) < 1 && Math.abs(before.y - after.y) < 1, 'decision feedback does not shift or resize the ticket input');
    assert(message.textContent.includes(decision.reason === 'error' ? decision.message : 'Started'), 'complete decision feedback remains visible');
    assert(bounds.top >= form.bottom, 'decision feedback follows the start form');
    assert(bounds.left >= 0 && bounds.right <= innerWidth && message.scrollWidth <= message.clientWidth + 1, 'long decision feedback wraps within the viewport');
    assert(document.documentElement.scrollWidth <= innerWidth, 'decision feedback does not overflow the viewport');
  }
  await showDecision();
  return { passed: true, viewport: [innerWidth, innerHeight], decisions: 3 };
}
async function duoLayout() {
  calls = [];
  await show('/');
  const visible = el => el.getClientRects().length > 0;
  const bounds = el => el.getBoundingClientRect();
  const coarse = matchMedia('(pointer: coarse)').matches;
  const noOverflow = () => assert(document.documentElement.scrollWidth <= innerWidth, 'Factory fits the viewport');
  noOverflow();
  const phone = innerWidth <= 600;
  const shell = root.querySelector('.shell'), bar = root.querySelector(phone ? '.top' : '.side');
  assert(!!root.querySelector('.tabbar') === phone && !!root.querySelector('.side') === !phone, 'the sidebar gives way to the top bar and tab bar at phone width');
  assert(shell.querySelectorAll('[aria-current="page"]').length === 1, 'only the Now link marks the current page');
  const priorConnection = store.connection.value, priorStatus = store.status.value;
  for (const withIssue of [false, true]) {
    store.status.value = withIssue ? { ...priorStatus, sessionTickets: { error: { message: 'Fixture connection problem' } } } : priorStatus;
    for (const state of ['retrying', 'live']) {
      store.connection.value = state; await pause();
      const live = bar.querySelector('[role="status"]'), label = bar.querySelector('.conn-label'), style = getComputedStyle(label);
      assert(live.textContent === (state === 'live' ? 'Live' : 'Retrying') && !live.hasAttribute('aria-label'), 'connection changes remain readable live-region text with and without issues');
      assert(style.display !== 'none' && style.visibility !== 'hidden', 'connection text stays in the accessibility tree');
      if (phone) assert(bounds(label).width === 1 && bounds(label).height === 1 && style.clipPath !== 'none', 'the compact connection label is visually clipped instead of hidden');
    }
  }
  store.status.value = priorStatus;
  store.connection.value = priorConnection; await pause();
  const b0 = bounds(bar);
  for (const el of bar.querySelectorAll('a, button')) {
    if (!visible(el)) continue;
    const b = bounds(el);
    assert(b.left >= b0.left && b.right <= b0.right + 1, 'shell controls stay inside their bar');
    if (coarse) assert(b.width >= 44 && b.height >= 44, `shell links and buttons have touch targets: ${el.getAttribute('aria-label') ?? el.textContent.trim()}`);
  }
  const meters = [...root.querySelectorAll('.machine')].map(bounds);
  assert(contentWidth() > 600 ? meters[0].top === meters[1].top : meters[1].top >= meters[0].bottom, 'provider meters use two columns only when there is room');
  const hrefs = () => [...document.querySelectorAll('.side nav a, .tabbar a, .more-list a')].filter(visible).map(a => a.getAttribute('href'));
  if (phone) {
    const tabs = [...root.querySelectorAll('.tabbar a, .tabbar button')];
    assert(tabs.length === 5 && tabs.every(el => bounds(el).width >= 44 && bounds(el).height >= 44), 'five tab-bar destinations with touch targets');
    tabs.at(-1).click(); await pause();
    const more = root.querySelector('dialog[open][aria-label="More"]');
    assert(more && new Set(hrefs()).size === 10, 'More holds every page the tab bar leaves out');
    assert([...more.querySelectorAll('.more-list button')].map(el => el.textContent.trim()).join() === 'Appearance,Sign out', 'More offers Appearance and Sign out');
    more.querySelector('a[href="/activity"]').click(); await pause();
    assert(!root.querySelector('dialog[open]') && tabs.at(-1).getAttribute('aria-current') === 'page', 'a page from More closes it and marks More current');
  } else {
    assert(hrefs().length === 10, 'every page is a direct sidebar link');
    assert([...root.querySelectorAll('.side nav')].map(n => n.getAttribute('aria-label')).join() === 'Operate,Maintain,Configure', 'pages are grouped');
    navigate('/activity'); await pause();
    assert(root.querySelector('.side a[aria-current="page"]').getAttribute('href') === '/activity', 'navigation marks the active page');
    // Collapse to icons and back; the choice is stored.
    const toggle = () => root.querySelector('.side-head button');
    const was = shell.classList.contains('rail');
    assert(was === innerWidth < 900, 'with no stored choice the sidebar starts expanded from 900px and collapsed below');
    toggle().click(); await pause();
    assert(shell.classList.contains('rail') === !was && toggle().getAttribute('aria-expanded') === String(was), 'the collapse button toggles the icon rail');
    assert(localStorage.getItem('factoryRail') === (was ? 'expanded' : 'collapsed'), 'the sidebar choice is stored');
    assert([...root.querySelectorAll('.side nav a')].every(a => a.textContent.trim()), 'collapsed links keep their names for assistive technology');
    noOverflow();
    toggle().click(); await pause();
    assert(shell.classList.contains('rail') === was, 'the sidebar toggles back');
    localStorage.removeItem('factoryRail');
  }
  assert(root.querySelector('h1').textContent.includes('Activity'), 'a secondary destination uses the ordinary page route');
  if (phone) { root.querySelector('.tabbar button').click(); await pause(); [...root.querySelectorAll('.more-list button')][0].click(); await pause(); }
  else root.querySelector('button[aria-label="Appearance"]').click();
  await pause();
  assert(root.querySelector('dialog[open][aria-label="Appearance"]'), 'Appearance is accessible');
  root.querySelector('dialog[open] .dialog-head button').click(); await pause();
  store.set(['pollSeconds'], 90); await pause();
  const save = root.querySelector('.save-bar');
  save.firstElementChild.textContent = '1200 unsaved changes';
  await pause();
  store.message('Could not save. Try again.', true); await pause();
  const s = bounds(save), toast = bounds(root.querySelector('.toast'));
  assert(s.left >= 16 && s.right <= innerWidth - 16, 'unsaved changes and both actions fit the screen');
  assert(toast.bottom < s.top, 'notifications clear the actual save bar height');
  if (phone) assert(s.bottom <= bounds(root.querySelector('.tabbar')).top, 'the save bar clears the tab bar');
  noOverflow();
  root.querySelector('.save-bar button').click(); await pause();
  assert(!root.querySelector('.save-bar') && !document.documentElement.style.getPropertyValue('--save-bar-height'), 'discard removes the save bar and its measured space');
  store.message('');
  assert(calls.length === 0, 'layout checks never submit a run');
  return { passed: true, viewport: [innerWidth, innerHeight], phone, coarse };
}
window.startTests = { show, run, whitespace, paste, showDecision, statusLayout, duoLayout, openStart };
await show();
