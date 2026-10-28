// Real Upstream view and request queue, synthetic dispatch only.
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import { applyState, operations } from '../../web/lib/store.js';
import { Upstream } from '../../web/views/Upstream.js';
const root = document.querySelector('#root');
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const state = {
  config: { enabled: false, upstream: { enabled: false, checkMinutes: 360, promptFile: '/reviews.md' }, models: [], projects: [{ enabled: true, kanvilId: 'p', name: 'Example', upstreams: [{ name: 'Example upstream', repo: 'example/project', firstBase: 'v1.0' }, { name: 'Current upstream', repo: 'example/current', firstBase: 'v3.0' }] }] },
  status: { jobs: [], triageEnabled: true, triageStreams: [
    { project: 'Example', projectId: 'p', inboxId: 'pin', label: 'intake', synchronized: true, untriaged: 2, failed: 1, running: 'PIN-4', oldestUntriagedAt: new Date(Date.now() - 3 * 3600_000 - 5 * 60_000).toISOString() },
    { project: 'Other', projectId: 'o', inboxId: 'oin', label: 'report', synchronized: true, untriaged: 0, failed: 0, running: null, oldestUntriagedAt: null },
  ], upstreams: [{ repo: 'example/project', pending: true, reviewed: 'v1.0', latest: 'v2.0', checkedAt: new Date().toISOString() }, { repo: 'example/current', pending: false, reviewed: 'v3.0', latest: 'v3.0', checkedAt: new Date().toISOString() }] },
};
let calls = [], release;
window.fetch = async (url, init) => {
  if (url !== '/api/dispatch') return Response.json(state);
  const input = JSON.parse(init.body), id = init.headers['Idempotency-Key'];
  calls.push({ input, id });
  await new Promise(resolve => { release = resolve; });
  return Response.json({ id, input, state: 'done', result: { data: { reason: 'upstream-not-due', message: 'This repository has no review due.' } } });
};
async function show() {
  render(null, root); operations.value = []; calls = [];
  applyState(state, true); render(html`<${Upstream} />`, root); await pause();
}
async function run() {
  await show();
  const inbox = root.textContent;
  assert(inbox.includes('Inbox triage') && /2 waiting, 1 failed, oldest 3 h [45] min ago, triaging PIN-4/.test(inbox) && inbox.includes('report label') && inbox.includes('clear'), 'each inbox queue shows its counts, oldest age and running report');
  const button = root.querySelector('[aria-label="Review Example upstream now"]');
  assert(button && button.textContent.trim() === '' && button.querySelector('.icon-play'), 'a due release has an icon-only review action');
  assert(!root.querySelector('[aria-label="Review Current upstream now"]'), 'current releases have no launch action');
  button.click(); await pause();
  assert(calls.length === 1 && calls[0].id, 'one durable request is submitted');
  assert(JSON.stringify(calls[0].input) === JSON.stringify({ upstream: 'example/project', model: 'auto', overrideLimits: true }), 'the repository target uses automatic models');
  assert(button.disabled, 'the same repository is disabled while pending');
  button.click(); await pause(); assert(calls.length === 1, 'repeated clicks cannot send another review');
  assert(!document.querySelector('dialog[open]'), 'Review now does not open watch settings');
  assert(root.textContent.includes('example/project') && root.textContent.includes('Checking the release'), 'pending feedback identifies the review');
  release(); await pause();
  assert(root.textContent.includes('This repository has no review due.'), 'refusal remains visible');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
  root.querySelector('[aria-label="Edit Example upstream watch"]').click(); await pause();
  assert(document.querySelector('dialog[open]'), 'watch settings remain accessible');
  return { passed: true, viewport: [innerWidth, innerHeight], requests: calls.length };
}
window.upstreamTests = { show, run };
await show();
