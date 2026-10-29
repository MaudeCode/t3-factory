// Real Triage view and switch, synthetic state and toggle endpoint only.
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import { applyState, actions, config, notice } from '../../web/lib/store.js';
import { Triage } from '../../web/views/Triage.js';
const root = document.querySelector('#root');
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const state = {
  config: { enabled: false, kanvil: { url: 'https://kanvil.example.test' }, triage: { enabled: true, promptFile: '/triage.md' }, models: [], projects: [{ enabled: true, kanvilId: 'p', name: 'Example', upstreams: [], scopes: ['app'], inbox: { kanvilId: 'pin', label: 'intake', maxPromotionsPerDay: 2 } }, { enabled: true, kanvilId: 'o', name: 'Other', upstreams: [], scopes: ['api'], inbox: { kanvilId: 'oin', label: 'report' } }] },
  status: { jobs: [], triageEnabled: true, triageStreams: [
    { project: 'Example', projectId: 'p', inboxId: 'pin', label: 'intake', synchronized: true, untriaged: 2, failed: 1, running: 'PIN-4', oldestUntriagedAt: ago(185), promoted: 3, queued: 1, blocked: 1, needsOwner: 1, limit: 2 },
    { project: 'Other', projectId: 'o', inboxId: 'oin', label: 'report', synchronized: true, untriaged: 0, failed: 0, running: null, oldestUntriagedAt: null, promoted: 0, queued: 0, blocked: 0, needsOwner: 0, limit: null },
  ], triageResults: [
    { id: 6, time: ago(1), kind: 'triage', text: 'PIN-7 promoted to EX-40', data: { ticket: 'PIN-7', ticketId: 't7', inboxId: 'pin', project: 'Example', outcome: 'promoted', promoted: 'EX-40' } },
    { id: 5, time: ago(2), kind: 'triage', text: 'PIN-6 needs the owner: sensitive: workType sec', data: { ticket: 'PIN-6', ticketId: 't6', inboxId: 'pin', project: 'Example', outcome: 'needs-owner', reason: 'sensitive: workType sec' } },
    { id: 4, time: ago(3), kind: 'triage', text: 'PIN-5 promotion queued: 2 promotions in the last 24 hours', data: { ticket: 'PIN-5', ticketId: 't5', inboxId: 'pin', project: 'Example', outcome: 'promotion-queued', reason: '2 promotions in the last 24 hours' } },
    { id: 3, time: ago(4), kind: 'triage', text: 'PIN-3 triaged: duplicate, duplicate of EX-12', data: { ticket: 'PIN-3', ticketId: 't3', inboxId: 'pin', project: 'Example', outcome: 'triaged', verdict: 'duplicate', duplicateOf: 'EX-12' } },
    { id: 2, time: ago(30), kind: 'triage', text: 'PIN-2 triage failed: Timed out twice', data: { ticket: 'PIN-2', ticketId: 't2', inboxId: 'pin', project: 'Example', outcome: 'triage-failed', reason: 'Timed out twice' } },
  ] },
};
let posts = [], saves = [];
window.fetch = async (url, init) => {
  // The real endpoint answers with the config-save field error for an invalid limit.
  if (url === '/api/config') {
    const body = JSON.parse(init.body); saves.push(body);
    const limit = body.config.projects[0].inbox.maxPromotionsPerDay;
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) return Response.json({ message: 'projects.0.inbox.maxPromotionsPerDay: Too small: expected number to be >=0' }, { status: 400 });
    state.config = body.config;
    return Response.json(body.config);
  }
  if (url === '/api/triage/enabled') {
    const body = JSON.parse(init.body); posts.push(body);
    state.config.triage.enabled = body.enabled; state.status.triageEnabled = body.enabled;
    return Response.json({ ok: true });
  }
  return Response.json(state);
};
async function show() {
  render(null, root); posts = []; saves = [];
  state.config.projects[0].inbox.maxPromotionsPerDay = 2;
  state.config.triage.enabled = true; state.status.triageEnabled = true;
  applyState(state, true); render(html`<${Triage} />`, root); await pause();
}
async function run() {
  await show();
  const text = () => root.textContent;
  assert(text().includes('Triage on'), 'the switch shows triage on');
  assert(/2 waiting, 1 failed, 3 promoted, 1 queued, 1 blocked, 1 need the owner, oldest 3 h \d+ min ago, triaging PIN-4/.test(text()) && text().includes('report label') && text().includes('clear'), 'each inbox shows its queue');
  const ticket = [...root.querySelectorAll('a')].find(a => a.textContent === 'PIN-3');
  assert(ticket && ticket.href === 'https://kanvil.example.test/projects/pin/tickets/t3', 'a result links to its inbox ticket');
  assert(text().includes('duplicate of EX-12') && text().includes('Timed out twice'), 'results show the duplicate and the failure reason');
  const toggle = root.querySelector('input[role="switch"][aria-label="Inbox triage"]');
  assert(toggle && toggle.checked, 'the triage switch is on the Triage page');
  toggle.click(); await pause(); await pause();
  assert(posts.length === 1 && posts[0].enabled === false, 'the switch posts triage.enabled = false');
  assert(text().includes('Triage paused'), 'the page shows triage paused');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
  const toggles = posts.length, limits = await promotion();
  return { passed: true, viewport: [innerWidth, innerHeight], posts: toggles, ...limits };
}
// Each inbox row shows its promotion counts and limit, and edits the limit through the settings save.
async function promotion() {
  await show();
  const text = () => root.textContent, rows = () => [...root.querySelectorAll('.release')].slice(0, 2);
  assert(/3 promoted, 1 queued, 1 blocked, 1 need the owner/.test(rows()[0].textContent), 'the first inbox shows its promotion counts');
  assert(rows()[0].querySelector('.release-state').textContent.includes('2 per day') && rows()[1].querySelector('.release-state').textContent.includes('Unlimited'), 'each row shows its limit next to its status');
  assert(text().includes('promoted to EX-40') && text().includes('needs owner') && text().includes('sensitive: workType sec') && text().includes('queued'), 'promotion outcomes are listed');
  const input = (row) => rows()[row].querySelector('input[type="number"]');
  const type = async (row, value) => { const el = input(row); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); await pause(); };
  assert(input(0).value === '2' && input(1).value === '' && input(1).placeholder === 'Unlimited', 'the inputs hold the saved limits');
  await type(0, '0');
  assert(config.value.projects[0].inbox.maxPromotionsPerDay === 0 && rows()[0].querySelector('.release-state').textContent.includes('Paused'), '0 pauses');
  await type(0, '');
  assert(config.value.projects[0].inbox.maxPromotionsPerDay === null && rows()[0].querySelector('.release-state').textContent.includes('Unlimited'), 'empty is unlimited');
  await type(0, '-1');
  await actions.save(); await pause();
  assert(saves.length === 1 && notice.value?.error && notice.value.text.startsWith('projects.0.inbox.maxPromotionsPerDay:'), 'an invalid limit is rejected with its field error');
  await type(0, '5');
  await actions.save(); await pause();
  assert(saves.length === 2 && saves[1].config.projects[0].inbox.maxPromotionsPerDay === 5 && saves[1].config.projects[1].inbox.maxPromotionsPerDay === undefined, 'saving writes only that inbox limit');
  assert(input(0).value === '5' && rows()[0].querySelector('.release-state').textContent.includes('5 per day'), 'the saved limit shows');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
  return { saves: saves.length };
}
window.triageTests = { show, run, promotion };
await show();
