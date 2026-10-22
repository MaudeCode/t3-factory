// Real application views and saved operation queue; synthetic inventory and mutation boundaries only.
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import { applyState, operations } from '../../web/lib/store.js';
import { App } from '../../web/views/App.js';
import { route } from '../../web/lib/router.js';
const at = new Date().toISOString(), repo = '/workspace/example';
const state = { config: { enabled: false, projects: [{ name: 'Example', kaneoId: 'p', key: 'FIX', enabled: true }], models: [], kaneo: { url: 'https://tracker.example.test', workspaceId: 'fixture' } }, status: { jobs: [], streams: [] } };
const items = Array.from({ length: 24 }, (_, n) => ({ projectId: 'p', repository: repo, path: `/workspace/worktrees/${n ? `example-${n}` : 'fix-FIX-1'}`, branch: `fix/FIX-${n + 1}`, present: n !== 3, registered: n !== 3, ownership: n === 2 ? 'orphan' : 'factory', state: n === 0 ? 'blocked' : n === 1 ? 'active' : n === 3 ? 'missing' : 'pending', checkedAt: at, size: { bytes: n === 0 ? 2.5 * 1024 ** 3 : null, state: 'unknown' }, jobs: n === 2 ? [] : [{ id: `job-${n}`, projectId: 'p', ticketKey: `FIX-${n + 1}`, state: 'complete', threadId: `thread-${n}`, stage: 'verification / detach pending', prUrls: [], lastAttempt: at, error: n === 0 ? 'EnvironmentAuthorizationError: Missing terminal:read scope' : undefined }], bindings: [] }));
let calls = [], release, inspectFailure = false;
window.fetch = async (url, init = {}) => {
  if (String(url).startsWith('/api/cleanup?')) {
    const query = new URL(url, location.origin).searchParams;
    const list = items.filter(i => (!query.get('query') || JSON.stringify(i).includes(query.get('query'))) && (!query.get('state') || i.state === query.get('state')));
    return Response.json({ items: list, total: list.length, offset: 0, counts: { blocked: 1, active: 1, pending: 21, missing: 1 }, present: 23, repositories: [{ path: repo, freeBytes: 128 * 1024 ** 3 }], errors: [], checkedAt: at, lastSuccessfulScan: at, nextRetry: null, stalled: false, automationEnabled: false, maintenance: { state: 'blocked', lastAttempt: at, lastSuccess: at, error: 'Missing terminal:read scope. Repair the credential scope, then retry.' }, actions: [] });
  }
  if (String(url).startsWith('/api/cleanup/inspect') || String(url).startsWith('/api/cleanup/review')) {
    calls.push(url); if (inspectFailure) return Response.json({ message: 'T3 connection unavailable; workspace preserved' }, { status: 503 });
    const input = JSON.parse(init.body), item = items.find(i => i.path === input.path), force = String(url).endsWith('review');
    return Response.json({ ...item, workspace: { present: true, registered: true, branch: item.branch, head: 'a'.repeat(40), tracked: 1, untracked: 2, ignored: 1 }, processCount: 0, terminals: [], reports: [], actions: [], checkedAt: at, size: { bytes: force || input.size ? 2.5 * 1024 ** 3 : null },
      checks: [{ name: 'Live ownership and activity', state: 'pass', detail: 'One idle binding verified', checkedAt: at }, { name: 'Contents', state: 'blocked', override: true, detail: '1 tracked change, 2 untracked files, 1 ignored entry will be lost', checkedAt: at }], overridden: ['Contents: 1 tracked change, 2 untracked files, 1 ignored entry will be lost', 'Verified completion and merged HEAD: Completion report is missing'], forceAllowed: true, reviewId: '00000000-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 600000).toISOString() });
  }
  if (url === '/api/cleanup/actions') {
    calls.push(url); await new Promise(resolve => { release = resolve; });
    return Response.json({ id: init.headers['Idempotency-Key'], state: 'done', result: { data: { state: 'failed', outcomes: [{ path: items[0].path, state: 'failed', message: 'Reviewed identity changed; review again' }] } } });
  }
  return Response.json(state);
};
const pause = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const click = text => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); assert(el, 'button ' + text); el.click(); };
async function show() {
  render(null, document.querySelector('#root')); operations.value = []; calls = []; inspectFailure = false;
  applyState(state, true); route.value = { page: '/cleanup', path: '/cleanup', param: null }; render(html`<${App} />`, document.querySelector('#root')); await pause();
}
async function run() {
  await show();
  assert(document.querySelectorAll('.cleanup-row').length === 24, 'all synthetic rows render');
  const search = document.querySelector('[aria-label="Find a worktree"]'); search.value = 'FIX-1'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(document.querySelectorAll('.cleanup-row').length < 24, 'search filters inventory');
  const review = document.querySelector('[aria-label="Review /workspace/worktrees/fix-FIX-1"]'); review.click(); await pause();
  assert(document.querySelector('dialog[open]')?.getAttribute('aria-label') === 'Worktree review', 'accessible review dialog opens');
  assert(calls.every(c => c !== '/api/cleanup/actions'), 'read-only review never mutates');
  click('Review force removal'); await pause();
  assert(document.querySelector('dialog[open]').getAttribute('aria-label') === 'Force remove review', 'force review is separate');
  const force = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Force remove');
  assert(force.disabled, 'exact path and reason required');
  for (const [label, value] of [['Exact worktree path', '/workspace/worktrees/fix-FIX-1'], ['Reason for force removal', 'Discard fixture files']]) { const input = document.querySelector(`[aria-label="${label}"]`); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
  await pause(); assert(!force.disabled, 'confirmation enabled for exact path and reason'); force.click(); force.click(); await pause();
  assert(calls.filter(c => c === '/api/cleanup/actions').length === 1, 'double click submits one saved operation');
  assert(document.body.textContent.includes('Verifying cleanup'), 'pending feedback visible');
  release(); await pause(); assert(document.body.textContent.includes('Reviewed identity changed'), 'per-item failure remains visible');
  document.querySelector('[aria-label="Review /workspace/worktrees/fix-FIX-1"]').click(); await pause();
  inspectFailure = true; document.querySelector('[aria-label="Refresh inspection"]').click(); await pause();
  assert(document.querySelector('[role="alert"]')?.textContent.includes('T3 connection unavailable'), 'inspection errors preserve readable recovery state');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page fits viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], requests: calls.length };
}
window.cleanupTests = { show, run }; await show();

if (new URLSearchParams(location.search).has('run')) run().then(result => { document.body.dataset.result = JSON.stringify(result); }, error => { document.body.dataset.result = JSON.stringify({ failed: error.message }); });
