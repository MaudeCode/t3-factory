// Real application views and saved operation queue; synthetic inventory and mutation boundaries only.
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import { applyState, operations } from '../../web/lib/store.js';
import { App } from '../../web/views/App.js';
import { route } from '../../web/lib/router.js';
const at = new Date().toISOString(), repo = '/workspace/example';
const state = { config: { enabled: false, projects: [{ name: 'Example', kanvilId: 'p', key: 'FIX', enabled: true }], models: [], kanvil: { url: 'https://tracker.example.test', workspaceId: 'fixture' } }, status: { jobs: [], streams: [] } };
const items = Array.from({ length: 24 }, (_, n) => ({ projectId: 'p', repository: repo, path: `/workspace/worktrees/${n ? `example-${n}` : 'fix-FIX-1'}`, branch: `fix/FIX-${n + 1}`, present: ![3, 4].includes(n), registered: ![3, 4].includes(n), ownership: n === 2 ? 'orphan' : 'factory', state: n === 0 ? 'blocked' : n === 1 ? 'active' : n === 3 ? 'missing' : n === 4 ? 'complete' : n === 5 ? 'primary' : 'pending', checkedAt: at, size: { bytes: n === 0 ? 2.5 * 1024 ** 3 : null, state: 'unknown' }, jobs: n === 2 ? [] : [{ id: `job-${n}`, projectId: 'p', ticketKey: `FIX-${n + 1}`, state: 'complete', threadId: `thread-${n}`, stage: 'verification / detach pending', prUrls: [], lastAttempt: at, error: n === 0 ? 'EnvironmentAuthorizationError: Missing terminal:read scope' : undefined }], bindings: [] }));
for (const [n, item] of items.entries()) item.next = n === 0 ? { group: 'attention', reason: 'Cleanup could not verify access or connectivity', action: 'inspect' } : n === 1 ? { group: 'protected', reason: 'Work is still using this folder', action: 'thread' } : n === 2 ? { group: 'attention', reason: 'No recorded owner for this folder', action: 'force' } : n === 3 ? { group: 'gone', reason: 'Directory gone; cleanup not verified', action: 'inspect' } : n === 4 ? { group: 'gone', reason: 'Directory and Git registration removed', action: 'none' } : n === 5 ? { group: 'protected', reason: 'Primary checkout', action: 'none' } : { group: 'ready', reason: 'Finished run; completion and files are rechecked before removal', action: 'remove' };
let calls = [], reads = [], release, inspectFailure = false;
window.fetch = async (url, init = {}) => {
  if (url === '/api/history') return Response.json([]);
  if (String(url).startsWith('/api/cleanup?')) {
    reads.push(String(url));
    const query = new URL(url, location.origin).searchParams;
    if (Number(query.get('limit')) > 100) return Response.json({ message: 'Invalid inventory request: limit must be at most 100' }, { status: 400 });
    const viewOf = i => i.next.group === 'protected' ? 'protected' : i.present ? 'retained' : i.state === 'complete' ? 'removed' : 'missing';
    const matched = items.filter(i => (!query.get('query') || JSON.stringify(i).includes(query.get('query'))) && (!query.get('repository') || i.repository === query.get('repository')));
    const counted = matched.filter(i => !(i.state === 'primary' && ['present', 'ready', 'blocked', 'inuse'].includes(query.get('view'))));
    const groups = Object.fromEntries(['ready', 'attention', 'retrying', 'protected', 'gone'].map(g => [g, counted.filter(i => i.next.group === g).length]));
    const list = matched.filter(i => !(i.state === 'primary' && ['present', 'ready', 'blocked', 'inuse'].includes(query.get('view'))) && (!query.get('view') || query.get('view') === 'overview' && ['ready', 'attention'].includes(i.next.group) || query.get('view') === 'present' && i.present || query.get('view') === 'blocked' && i.present && ['attention', 'retrying'].includes(i.next.group) || query.get('view') === 'inuse' && i.next.group === 'protected' || i.next.group === query.get('view') || viewOf(i) === query.get('view')));
    return Response.json({ policy: { ignoredFiles: 'disposable' }, counts: { primary: matched.filter(i => i.state === 'primary').length }, views: Object.fromEntries(['retained','protected','removed','missing'].map(v => [v, counted.filter(i => viewOf(i) === v).length])), filesystems: [{ id: 'fixture', freeBytes: 128 * 1024 ** 3, repositories: [repo] }], groups, items: query.get('view') === 'overview' ? ['ready','attention'].flatMap(g => list.filter(i => i.next.group === g).slice(0, Math.floor(Number(query.get('limit') || 50) / 2))) : list.slice(Number(query.get('offset') || 0), Number(query.get('offset') || 0) + Number(query.get('limit') || 50)), total: list.length, offset: 0, repositories: [{ path: repo, freeBytes: 128 * 1024 ** 3 }], errors: [], checkedAt: at, lastSuccessfulScan: at, nextRetry: null, stalled: false, automationEnabled: false, maintenance: { state: 'blocked', lastAttempt: at, lastSuccess: at, error: 'Missing terminal:read scope. Repair the credential scope, then retry.' }, actions: [] });
  }
  if (String(url).startsWith('/api/cleanup/inspect') || String(url).startsWith('/api/cleanup/review')) {
    calls.push(url); if (inspectFailure) return Response.json({ message: 'T3 connection unavailable; workspace preserved' }, { status: 503 });
    const input = JSON.parse(init.body), item = items.find(i => i.path === input.path), force = String(url).endsWith('review');
    return Response.json({ ...item, state: items.indexOf(item) >= 6 ? "eligible" : item.state, workspace: { present: true, registered: true, branch: item.branch, head: 'a'.repeat(40), tracked: 1, untracked: 2, ignored: 1 }, processCount: 0, terminals: [], reports: [], actions: [], checkedAt: at, size: { bytes: force || input.size ? 2.5 * 1024 ** 3 : null },
      checks: [{ name: 'Live ownership and activity', state: 'pass', detail: 'One idle binding verified', checkedAt: at }, { name: 'Contents', state: 'blocked', override: true, detail: '1 tracked change, 2 untracked files, 1 ignored entry will be lost', checkedAt: at }], overridden: ['Contents: 1 tracked change, 2 untracked files, 1 ignored entry will be lost', 'Verified completion and merged HEAD: Completion report is missing'], forceAllowed: true, reviewId: '00000000-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 600000).toISOString() });
  }
  if (url === '/api/cleanup/actions') {
    calls.push(url); const request = JSON.parse(init.body); await new Promise(resolve => { release = resolve; });
    return Response.json({ id: init.headers['Idempotency-Key'], state: 'done', result: { data: { state: 'failed', outcomes: [{ path: request.targets?.[0]?.path || items[0].path, state: 'failed', message: request.type === 'remove' ? 'Workspace HEAD is not verified merged into the remote release branch' : 'Reviewed identity changed; review again' }] } } });
  }
  return Response.json(state);
};
const pause = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw new Error("Fixture did not settle"); await pause(20); } };
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const click = text => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text); assert(el, 'button ' + text); el.click(); };
async function show() {
  render(null, document.querySelector('#root')); operations.value = []; calls = []; reads = []; inspectFailure = false;
  applyState(state, true); route.value = { page: '/cleanup', path: '/cleanup', param: null }; render(html`<${App} />`, document.querySelector('#root')); await until(() => document.querySelector('.cleanup-row')); await pause(30);
}
async function run() {
  await show();
  assert(document.querySelector('.cleanup-row').getBoundingClientRect().top < (innerWidth < 600 ? 430 : 300), 'worktrees appear before diagnostics');
  assert(document.querySelectorAll('.cleanup-row').length === 21, 'every present worktree except the primary checkout is listed on one page');
  assert(!document.body.textContent.includes('Needs you') && [...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Delete 18 unused worktrees'), 'one deletion action owns the workflow and names its candidate count');
  assert(document.body.textContent.includes('128.00 GiB free'), 'one filesystem free-space observation appears in the header');
  assert(!document.querySelector('.cleanup-row').textContent.includes('/workspace/'), 'rows use readable names');
  const segment = label => [...document.querySelectorAll('.segmented button')].find(b => b.textContent.startsWith(label)).click();
  segment('In use'); await until(() => document.querySelectorAll('.cleanup-row').length === 1);
  assert(document.querySelector('.cleanup-row').textContent.includes('In use'), 'protected work has its own view'); segment('All'); await until(() => document.querySelectorAll('.cleanup-row').length === 21);
  assert(!document.querySelector('.cleanup-row input[type=checkbox]'), 'checkboxes appear only while selecting'); click('Select worktrees'); await until(() => document.querySelector('.cleanup-row input[type=checkbox]'));
  const picks = [...document.querySelectorAll('.cleanup-row input[type=checkbox]')]; picks[0].click(); picks[1].click(); await until(() => document.body.textContent.includes('2 selected'));
  click('Delete selected worktrees'); await until(() => document.querySelector('dialog[open]'));
  assert(document.querySelector('dialog[open]')?.getAttribute('aria-label') === 'Delete 2 worktrees?', 'bulk removal has one bounded consequence confirmation');
  assert(document.querySelector('dialog[open]').textContent.includes('Ignored files are deleted'), 'bulk confirmation includes the approved ignored-file policy');
  click('Cancel'); click('Done selecting worktrees'); await pause();
  const search = document.querySelector('[aria-label="Find a branch or folder"]'); search.value = 'FIX-1'; search.dispatchEvent(new Event('input', { bubbles: true })); await until(() => !document.querySelector('[aria-label="Details /workspace/worktrees/example-6"]'));
  assert(!document.querySelector('[aria-label="Details /workspace/worktrees/example-6"]'), 'search narrows worktrees');
  document.querySelector('[aria-label="Details /workspace/worktrees/fix-FIX-1"]').click(); await until(() => document.querySelector('.cleanup-inspector'));
  assert(document.querySelector('.cleanup-inspector'), 'row details expand inline');
  assert(!document.querySelector('dialog[open]'), 'opening a row never opens a loading modal');
  assert(calls.length === 0, 'expansion reads existing inventory without starting an inspection');
  assert(document.querySelector('.cleanup-inspector').textContent.includes('Missing terminal:read scope'), 'last error is available immediately in its row');
  assert(document.querySelector('.cleanup-inspector').textContent.includes('Last result') && !document.querySelector('.cleanup-inspector').textContent.includes('Last attempt Not recorded'), 'an undated historical error is not presented as the current attempt');
  document.querySelector('[aria-label="Check fix-FIX-1"]').click(); await until(() => calls.length === 1 && document.body.textContent.includes('checks passed'));
  assert(calls.length === 1, 'only an explicit check starts inspection');
  click('Delete anyway…'); await until(() => document.querySelector('dialog[open]'));
  assert(document.querySelector('dialog[open]').getAttribute('aria-label') === 'Delete fix-FIX-1 anyway?', 'a reviewed force asks once, in the shared confirmation');
  assert(document.querySelector('dialog[open]').textContent.includes('will be lost') && !document.querySelector('input[aria-label="Worktree folder name"]'), 'the confirmation names what is lost and needs no typing');
  const confirm = [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Delete'); confirm.click(); confirm.click(); await until(() => calls.filter(c => c === '/api/cleanup/actions').length === 1 && document.querySelector('.cleanup-row-actions [aria-label^="Deleting…"]'));
  assert(calls.filter(c => c === '/api/cleanup/actions').length === 1, 'double click submits one saved action');
  const row = document.querySelector('[aria-label="Details /workspace/worktrees/fix-FIX-1"]').closest('.cleanup-row-group'), height = row.querySelector('.cleanup-row').getBoundingClientRect().height;
  assert(row.querySelector('.cleanup-row-actions [aria-label^="Deleting…"]'), 'progress shows in the row action');
  release(); await until(() => row.querySelector('.cleanup-note [data-tip*="Reviewed identity changed"]')); assert(row.querySelector('.cleanup-row').getBoundingClientRect().height === height, 'a result never changes the row height');
  inspectFailure = true; document.querySelector('[aria-label="Check fix-FIX-1"]').click(); await until(() => document.querySelector('.cleanup-inspector [role=alert]')?.textContent.includes('T3 connection unavailable'));
  assert(document.querySelector('.cleanup-inspector [role=alert]')?.textContent.includes('T3 connection unavailable'), 'failed checks show a recovery message inline');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page fits viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], requests: calls.length };
}
async function failedReady() {
  await show();
  const path = '/workspace/worktrees/example-6';
  document.querySelector(`[aria-label="Details ${path}"]`).closest('.cleanup-row-group').querySelector('.cleanup-row-actions button').click();
  await until(() => calls.includes('/api/cleanup/actions')); release();
  await until(() => document.querySelector('.cleanup-note [data-tip*="not verified merged"]'));
  assert(document.body.textContent.includes('0 deleted'), 'a completed request with failed outcomes must explicitly report zero removals');
  assert(!document.body.textContent.includes('Needs you'), 'a failed attempt does not create an operator triage queue');
  await pause(400);
  assert(document.querySelector(`[aria-label="Details ${path}"]`), 'failed worktrees remain visible with their result after refresh');
  document.querySelector(`[aria-label="Details ${path}"]`).closest('.cleanup-row-group').querySelector('.cleanup-row-actions button').click();
  await until(() => calls.length === 2 && document.querySelector('dialog[open]'));
  assert(document.querySelector('dialog[open]').getAttribute('aria-label') === 'Delete example-6 anyway?', 'a failed row offers a reviewed force without expanding'); click('Cancel');
  assert(!calls.includes('/api/cleanup/actions', 1), 'cancelling the confirmation sends nothing');
  return { passed: true, viewport: [innerWidth, innerHeight], requests: calls.length };
}
async function deleteUnused() {
  await show();
  assert([...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Delete 18 unused worktrees'), 'one action deletes unused worktrees without sorting old failures');
  assert(!document.body.textContent.includes('Needs you') && !document.body.textContent.includes('Ready to remove'), 'cleanup does not turn old failures into an operator triage queue');
  assert(document.querySelectorAll('.cleanup-row').length === 21, 'worktrees load in one list');
  click('Delete 18 unused worktrees'); await until(() => document.querySelector('dialog[open]'));
  assert(document.querySelector('dialog[open]').getAttribute('aria-label') === 'Delete 18 worktrees?', 'bulk deletion includes every unused candidate across pages');
  assert(document.querySelector('dialog[open]').textContent.includes('Ignored files are deleted'), 'ignored files are disposable under the approved policy');
  assert(!calls.length, 'preparing the confirmation never starts deletion'); click('Cancel');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page fits viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], requests: calls.length };
}
async function deckIsolation() {
  await show();
  const cleanup = { id: 'cleanup-fixture', kind: 'cleanup', input: { type: 'remove', targets: [{ projectId: 'p', path: items[6].path }] }, state: 'failed', result: { data: { state: 'failed', outcomes: [{ path: items[6].path, state: 'failed', message: 'Cleanup-only failure' }] } } };
  operations.value = [cleanup, { id: 'dispatch-fixture', input: { ticket: 'FIX-999', model: 'auto' }, state: 'failed', result: { data: { message: 'Dispatch-only failure' } } }];
  route.value = { page: '/', path: '/', param: null }; await until(() => document.querySelector('.deck')); await pause(30);
  assert(!document.querySelector('main').textContent.includes('Cleanup remove') && !document.querySelector('main').textContent.includes('Cleanup-only failure'), 'cleanup operations never render on the Deck');
  assert(document.querySelector('main').textContent.includes('Dispatch-only failure'), 'dispatch feedback remains on the Deck');
  operations.value = [cleanup]; await pause(30);
  assert(!document.querySelector('.deck .launch'), 'cleanup-only requests do not leave an empty launch section');
  route.value = { page: '/cleanup', path: '/cleanup', param: null }; await until(() => document.querySelector('.cleanup-row')); await pause(30);
  assert(document.body.textContent.includes('0 deleted') && document.body.textContent.includes('1 failed'), 'cleanup results remain visible on Cleanup');
  assert(operations.value.length === 1 && operations.value[0].id === cleanup.id, 'hiding cleanup feedback never deletes operation recovery state');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
async function previousFailure() {
  const item = items[6], original = item.next;
  item.lastOutcome = { state: 'failed', message: 'Normal maintenance requires one Factory-owned job; use a force review', updatedAt: '2026-01-01T00:00:00Z' };
  item.next = { group: 'ready', action: 'remove', reason: 'Rechecked with the current cleanup rules' };
  try {
    await show();
    const row = document.querySelector(`[aria-label="Details ${item.path}"]`).closest('.cleanup-row-group');
    assert(row.querySelector('.tag').textContent === 'Unused' && row.querySelector('.cleanup-row-actions button').getAttribute('aria-label') === 'Delete example-6', 'a refusal under an obsolete rule is offered for normal deletion');
    assert(!row.textContent.includes('requires one Factory-owned job'), 'an obsolete Factory-only rule does not appear as a current blocker');
    row.querySelector('.cleanup-open').click(); await until(() => row.querySelector('.cleanup-inspector'));
    assert(row.querySelector('.cleanup-inspector').textContent.includes('requires one Factory-owned job'), 'the exact historical failure remains available in row details');
    assert(calls.length === 0, 'reading failure history never starts inspection or deletion');
    return { passed: true, viewport: [innerWidth, innerHeight] };
  } finally { item.next = original; delete item.lastOutcome; }
}
async function maintainedInventory() {
  await show();
  assert(!new URL(reads.at(-1), location.origin).searchParams.has('inspectionId'), 'cached page reads do not create expensive inspection sessions');
  const count = document.querySelectorAll('.cleanup-row').length;
  click('Refresh cleanup inventory');
  await until(() => new URL(reads.at(-1), location.origin).searchParams.get('refresh') === 'true');
  assert(document.querySelectorAll('.cleanup-row').length === count, 'refresh keeps the previous inventory visible');
  const before = reads.length;
  applyState({ ...state, status: { ...state.status, at: new Date().toISOString() } }, true);
  await until(() => reads.length > before);
  assert(!new URL(reads.at(-1), location.origin).searchParams.has('refresh'), 'background publication reads the stored snapshot without requesting another scan');
  assert(calls.length === 0, 'background inventory updates do not inspect or remove worktrees');
  return { passed: true, viewport: [innerWidth, innerHeight], reads: reads.length };
}
async function liveRefresh() {
  // 140 more unused rows put three pages behind Show more, past the API's 100-row request limit.
  items.push(...Array.from({ length: 140 }, (_, n) => ({ ...items[6], path: `/workspace/worktrees/extra-${n}`, branch: `fix/EXTRA-${n}`, jobs: [] })));
  const original = items[7].next;
  try {
    await show();
    const push = async () => { const before = reads.length; applyState({ ...state, status: { ...state.status, at: new Date().toISOString() } }, true); await until(() => reads.length > before); await pause(); };
    const box = item => document.querySelector(`[aria-label="Select ${item.path}"]`);
    click('Select worktrees'); await until(() => box(items[6]));
    box(items[6]).click(); box(items[7]).click(); await until(() => document.body.textContent.includes('2 selected'));
    await push();
    assert(document.body.textContent.includes('2 selected') && box(items[6]).checked && box(items[7]).checked, 'a status push keeps the selection');
    items[7].next = { group: 'protected', reason: 'Work is still using this folder', action: 'thread' };
    await push();
    assert(document.body.textContent.includes('1 selected') && box(items[6]).checked && !box(items[7]), 'a selected row that comes into use leaves the selection');
    items[7].next = original;
    click('Show more'); await until(() => document.querySelectorAll('.cleanup-row').length === 100);
    click('Show more'); await until(() => document.querySelectorAll('.cleanup-row').length === 150);
    await push();
    assert(document.querySelectorAll('.cleanup-row').length === 150 && document.body.textContent.includes('1 selected') && !document.querySelector('[role=alert]'), 'rows loaded with Show more stay after a status push');
    click('Refresh cleanup inventory'); await until(() => document.body.textContent.includes('0 selected'));
    click('Done selecting worktrees'); await until(() => !box(items[6])); click('Select worktrees'); await until(() => box(items[6])); box(items[6]).click(); await until(() => document.body.textContent.includes('1 selected'));
    [...document.querySelectorAll('.segmented button')].find(b => b.textContent.startsWith('Unused')).click(); await until(() => document.body.textContent.includes('0 selected'));
    assert(document.documentElement.scrollWidth <= innerWidth, 'page fits viewport');
    return { passed: true, viewport: [innerWidth, innerHeight], reads: reads.length };
  } finally { items[7].next = original; items.splice(24); }
}
window.cleanupTests = { show, run, failedReady, deleteUnused, deckIsolation, previousFailure, maintainedInventory, liveRefresh }; await show();

if (new URLSearchParams(location.search).has('run')) (new URLSearchParams(location.search).has('live') ? liveRefresh() : new URLSearchParams(location.search).has('catalog') ? maintainedInventory() : new URLSearchParams(location.search).has('history') ? previousFailure() : new URLSearchParams(location.search).has('deck') ? deckIsolation() : new URLSearchParams(location.search).has('unused') ? deleteUnused() : new URLSearchParams(location.search).has('failed') ? failedReady() : run()).then(result => { document.body.dataset.result = JSON.stringify(result); }, error => { document.body.dataset.result = JSON.stringify({ failed: error.message }); });
