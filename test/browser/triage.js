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
  config: { enabled: false, kanvil: { url: 'https://kanvil.example.test' }, triage: { enabled: true, promptFile: '/triage.md' }, models: [], projects: [{ enabled: true, kanvilId: 'p', name: 'Example', upstreams: [], scopes: ['app'], inbox: { kanvilId: 'pin', label: 'intake', maxPromotionsPerDay: 10 } }, { enabled: true, kanvilId: 'o', name: 'Other', upstreams: [], scopes: ['api'], inbox: { kanvilId: 'oin', label: 'report' } }] },
  status: { jobs: [], triageEnabled: true, triageStreams: [
    { project: 'Example', projectId: 'p', inboxId: 'pin', label: 'intake', synchronized: true, untriaged: 2, failed: 1, running: 'PIN-4', oldestUntriagedAt: ago(185), promoted: 3, queued: 1, blocked: 1, needsOwner: 1, limit: 10 },
    { project: 'Other', projectId: 'o', inboxId: 'oin', label: 'report', synchronized: true, untriaged: 0, failed: 0, running: null, oldestUntriagedAt: null, promoted: 0, queued: 0, blocked: 0, needsOwner: 0, limit: null },
  ], triageResults: [
    { id: 6, time: ago(1), kind: 'triage', text: 'PIN-7 promoted to EX-40', data: { ticket: 'PIN-7', ticketId: 't7', inboxId: 'pin', projectId: 'p', project: 'Example', outcome: 'promoted', promoted: 'EX-40', promotedId: 't40' } },
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
  state.config.projects[0].inbox.maxPromotionsPerDay = 10;
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
  const promoted = [...root.querySelectorAll('a.tag')];
  assert(promoted.length === 1 && promoted[0].textContent === 'promoted' && promoted[0].href === 'https://kanvil.example.test/projects/p/tickets/t40', 'the promoted tag links to the new ticket');
  const height = (row) => root.querySelectorAll('.release')[row].getBoundingClientRect().height;
  if (matchMedia('(pointer: coarse)').matches) { const r = promoted[0].getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top - 10); assert(hit === promoted[0], 'the promoted tag has a full touch target'); }
  assert(Math.abs(height(2) - height(3)) < 1, 'the promoted row is no taller than the others');
  const tagTop = (row) => root.querySelectorAll('.release')[row].querySelector('.tag').getBoundingClientRect().top - root.querySelectorAll('.release')[row].getBoundingClientRect().top;
  const tagRight = (row) => root.querySelectorAll('.release')[row].querySelector('.tag').getBoundingClientRect().right;
  assert(Math.abs(tagTop(2) - tagTop(3)) < 1 && Math.abs(tagRight(2) - tagRight(3)) < 1, 'the promoted tag lines up with the other tags');
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
  assert(rows()[0].querySelector('.release-state').textContent.includes('10 per day') && rows()[1].querySelector('.release-state').textContent.includes('Unlimited'), 'each row shows its limit next to its status');
  assert(text().includes('promoted to EX-40') && text().includes('needs owner') && text().includes('sensitive: workType sec') && text().includes('queued'), 'promotion outcomes are listed');
  // The shared limit picker: Paused, 5, 10, 20, 40, Other for any number, and Unlimited.
  const group = (row) => rows()[row].querySelector('[role="radiogroup"]');
  const choice = (row, name) => [...group(row).querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name);
  const checked = (row) => group(row).querySelector('[aria-checked="true"]')?.textContent;
  const state = (row) => rows()[row].querySelector('.release-state').textContent;
  assert(group(0).getAttribute('aria-label') === 'Example promotions per day' && checked(0) === '10' && group(1).querySelector('[aria-checked="true"]')?.getAttribute('aria-label') === 'Unlimited', 'each inbox shows its saved limit in the picker');
  assert([...group(1).querySelectorAll('button')].map((b) => b.textContent).join(' ') === 'Paused 5 10 20 40 Other ∞', 'the quick picks');
  assert(!rows()[0].querySelector('input'), 'no bare number box');
  choice(0, 'Paused').click(); await pause();
  assert(config.value.projects[0].inbox.maxPromotionsPerDay === 0 && state(0).includes('Paused') && checked(0) === 'Paused', 'Paused stores 0');
  choice(0, 'Unlimited').click(); await pause();
  assert(config.value.projects[0].inbox.maxPromotionsPerDay === null && state(0).includes('Unlimited'), 'Unlimited stores null');
  choice(0, 'Another number per day').click(); await pause();
  const box = group(0).querySelector('input.slot-custom'), enter = () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  box.value = '-1'; box.dispatchEvent(new Event('input', { bubbles: true })); enter(); await pause();
  assert(config.value.projects[0].inbox.maxPromotionsPerDay === null && group(0).querySelector('input.slot-custom') && box.validationMessage, 'a negative limit is refused with the field error and the box stays open');
  box.value = '1.5'; box.dispatchEvent(new Event('input', { bubbles: true })); enter(); await pause();
  assert(config.value.projects[0].inbox.maxPromotionsPerDay === null && box.validationMessage, 'a fractional limit is refused with the field error');
  box.value = '12'; box.dispatchEvent(new Event('input', { bubbles: true })); enter(); await pause();
  assert(config.value.projects[0].inbox.maxPromotionsPerDay === 12 && checked(0) === '12' && state(0).includes('12 per day'), 'a custom limit is stored');
  choice(0, '20 per day').click(); await pause();
  assert([...group(0).querySelectorAll('.slot.open')].map((b) => b.textContent).join(' ') === '5 10 20', 'picks up to the limit light up');
  await actions.save(); await pause();
  assert(saves.length === 1 && saves[0].config.projects[0].inbox.maxPromotionsPerDay === 20 && saves[0].config.projects[1].inbox.maxPromotionsPerDay === undefined, 'saving writes only that inbox limit');
  assert(checked(0) === '20' && state(0).includes('20 per day'), 'the saved limit shows');
  const one = (row) => new Set([...group(row).children].map((el) => Math.round(el.getBoundingClientRect().top))).size === 1;
  assert(one(0) && one(1), 'each picker stays on one line');
  // The server still answers an invalid config with its field error.
  config.value = { ...config.value, projects: [{ ...config.value.projects[0], inbox: { ...config.value.projects[0].inbox, maxPromotionsPerDay: -1 } }, config.value.projects[1]] };
  await actions.save(); await pause();
  assert(saves.length === 2 && notice.value?.error && notice.value.text.startsWith('projects.0.inbox.maxPromotionsPerDay:'), 'the save path rejects an invalid limit with its field error');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
  return { saves: saves.length };
}
window.triageTests = { show, run, promotion };
await show();
