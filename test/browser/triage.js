// Real Triage view and switch, synthetic state and toggle endpoint only.
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import { applyState } from '../../web/lib/store.js';
import { Triage } from '../../web/views/Triage.js';
const root = document.querySelector('#root');
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const state = {
  config: { enabled: false, kanvil: { url: 'https://kanvil.example.test' }, triage: { enabled: true, promptFile: '/triage.md' }, models: [], projects: [{ enabled: true, kanvilId: 'p', name: 'Example', upstreams: [], scopes: ['app'], inbox: { kanvilId: 'pin', label: 'intake' } }] },
  status: { jobs: [], triageEnabled: true, triageStreams: [
    { project: 'Example', projectId: 'p', inboxId: 'pin', label: 'intake', synchronized: true, untriaged: 2, failed: 1, running: 'PIN-4', oldestUntriagedAt: ago(185) },
    { project: 'Other', projectId: 'o', inboxId: 'oin', label: 'report', synchronized: true, untriaged: 0, failed: 0, running: null, oldestUntriagedAt: null },
  ], triageResults: [
    { id: 3, time: ago(4), kind: 'triage', text: 'PIN-3 triaged: duplicate, duplicate of EX-12', data: { ticket: 'PIN-3', ticketId: 't3', inboxId: 'pin', project: 'Example', outcome: 'triaged', verdict: 'duplicate', duplicateOf: 'EX-12' } },
    { id: 2, time: ago(30), kind: 'triage', text: 'PIN-2 triage failed: Timed out twice', data: { ticket: 'PIN-2', ticketId: 't2', inboxId: 'pin', project: 'Example', outcome: 'triage-failed', reason: 'Timed out twice' } },
  ] },
};
let posts = [];
window.fetch = async (url, init) => {
  if (url === '/api/triage/enabled') {
    const body = JSON.parse(init.body); posts.push(body);
    state.config.triage.enabled = body.enabled; state.status.triageEnabled = body.enabled;
    return Response.json({ ok: true });
  }
  return Response.json(state);
};
async function show() {
  render(null, root); posts = [];
  state.config.triage.enabled = true; state.status.triageEnabled = true;
  applyState(state, true); render(html`<${Triage} />`, root); await pause();
}
async function run() {
  await show();
  const text = () => root.textContent;
  assert(text().includes('Triage on'), 'the switch shows triage on');
  assert(/2 waiting, 1 failed, oldest 3 h \d+ min ago, triaging PIN-4/.test(text()) && text().includes('report label') && text().includes('clear'), 'each inbox shows its queue');
  const ticket = [...root.querySelectorAll('a')].find(a => a.textContent === 'PIN-3');
  assert(ticket && ticket.href === 'https://kanvil.example.test/projects/pin/tickets/t3', 'a result links to its inbox ticket');
  assert(text().includes('duplicate of EX-12') && text().includes('Timed out twice'), 'results show the duplicate and the failure reason');
  const toggle = root.querySelector('input[role="switch"][aria-label="Inbox triage"]');
  assert(toggle && toggle.checked, 'the triage switch is on the Triage page');
  toggle.click(); await pause(); await pause();
  assert(posts.length === 1 && posts[0].enabled === false, 'the switch posts triage.enabled = false');
  assert(text().includes('Triage paused'), 'the page shows triage paused');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
  return { passed: true, viewport: [innerWidth, innerHeight], posts: posts.length };
}
window.triageTests = { show, run };
await show();
