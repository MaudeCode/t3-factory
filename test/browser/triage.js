// Real Triage view, its settings and start path; synthetic state, toggle, config and dispatch endpoints only.
import { openSearch, checkPageHead } from "./search.js";
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import { applyState, actions, config, notice, operations, issues, sessionOverrides } from '../../web/lib/store.js';
import { confirmation, finishConfirmation } from '../../web/lib/confirmation.js';
import { Triage, ReadyReports, TriageSettings } from '../../web/views/Triage.js';
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
    { id: 6, time: ago(1), kind: 'triage', text: 'PIN-7 promoted to EX-40', data: { ticket: 'PIN-7', ticketId: 't7', inboxId: 'pin', projectId: 'p', project: 'Example', outcome: 'promoted', promoted: 'EX-40', promotedId: 't40' },
      promotedTicket: { taskId: 't40', projectId: 'p', key: 'EX-40', title: 'Launch crash with empty saved state', status: 'todo', priority: 'high', difficulty: 'med', labels: ['bug', 'med', 'app', 'from-user-report'], automationReady: true, unavailable: null, listed: true } },
    { id: 8, time: ago(12), kind: 'triage', text: 'PIN-8 promoted to EX-41', data: { ticket: 'PIN-8', ticketId: 't8', inboxId: 'pin', projectId: 'p', project: 'Example', outcome: 'promoted', promoted: 'EX-41', promotedId: 't41' },
      promotedTicket: { taskId: 't41', projectId: 'p', key: 'EX-41', title: 'Settings sheet forgets the chosen theme after relaunch', status: 'todo', priority: 'medium', difficulty: 'low', labels: ['ux', 'low', 'web', 'from-user-report'], automationReady: true, unavailable: null, listed: true } },
    { id: 5, time: ago(2), kind: 'triage', text: 'PIN-6 needs the owner: sensitive: workType sec', data: { ticket: 'PIN-6', ticketId: 't6', inboxId: 'pin', project: 'Example', outcome: 'needs-owner', reason: 'sensitive: workType sec' } },
    { id: 4, time: ago(3), kind: 'triage', text: 'PIN-5 promotion queued: 2 promotions in the last 24 hours', data: { ticket: 'PIN-5', ticketId: 't5', inboxId: 'pin', project: 'Example', outcome: 'promotion-queued', reason: '2 promotions in the last 24 hours' } },
    { id: 3, time: ago(4), kind: 'triage', text: 'PIN-3 triaged: duplicate, duplicate of EX-12', data: { ticket: 'PIN-3', ticketId: 't3', inboxId: 'pin', project: 'Example', outcome: 'triaged', verdict: 'duplicate', duplicateOf: 'EX-12' } },
    { id: 10, time: ago(40), kind: 'triage', text: 'PIN-10 promoted to EX-42', data: { ticket: 'PIN-10', ticketId: 't10', inboxId: 'pin', projectId: 'p', project: 'Example', outcome: 'promoted', promoted: 'EX-42', promotedId: 't42' },
      promotedTicket: { taskId: 't42', projectId: 'p', key: 'EX-42', title: 'Already running', status: 'in_progress', priority: 'low', difficulty: 'low', labels: [], automationReady: true, unavailable: 'Ticket is in_progress; it must be in todo', listed: false } },
    { id: 9, time: ago(200), kind: 'triage', text: 'GONE-1 promoted to EX-38', data: { ticket: 'GONE-1', ticketId: 'g1', inboxId: 'gone', projectId: 'p', project: 'Example', outcome: 'promoted', promoted: 'EX-38', promotedId: 't38' } },
    { id: 1, time: ago(90), kind: 'triage', text: 'PIN-1 promoted to EX-39', data: { ticket: 'PIN-1', ticketId: 't1', inboxId: 'pin', project: 'Example', outcome: 'promoted', promoted: 'EX-39' } },
    { id: 11, time: ago(20), kind: 'triage', text: 'PIN-9 closed during triage', data: { ticket: 'PIN-9', ticketId: 't9', inboxId: 'pin', project: 'Example', outcome: 'closed', reason: 'closed during triage' } },
    { id: 2, time: ago(30), kind: 'triage', text: 'PIN-2 triage failed: Timed out twice', data: { ticket: 'PIN-2', ticketId: 't2', inboxId: 'pin', project: 'Example', outcome: 'triage-failed', reason: 'Timed out twice' } },
  ],
  // Every open report with its stage. PIN-12 was triaged long before the 30 results above.
  triageReports: [
    { id: 5, time: ago(2), kind: 'triage', text: 'PIN-6 needs the owner: sensitive: workType sec', data: { ticket: 'PIN-6', ticketId: 't6', inboxId: 'pin', projectId: 'p', project: 'Example', stage: 'owner', outcome: 'needs-owner', reason: 'sensitive: workType sec' } },
    { id: 0, time: ago(4400), kind: 'triage', text: 'PIN-12 triaged: needs-info', data: { ticket: 'PIN-12', ticketId: 't12', inboxId: 'pin', projectId: 'p', project: 'Example', stage: 'owner', outcome: 'triaged', verdict: 'needs-info' } },
    { id: 2, time: ago(30), kind: 'triage', text: 'PIN-2 triage failed: Timed out twice', data: { ticket: 'PIN-2', ticketId: 't2', inboxId: 'pin', projectId: 'p', project: 'Example', stage: 'owner', outcome: 'triage-failed', reason: 'Timed out twice' } },
    { id: 0, time: ago(185), kind: 'triage', text: 'PIN-13 waiting for triage', data: { ticket: 'PIN-13', ticketId: 't13', inboxId: 'pin', projectId: 'p', project: 'Example', stage: 'working', outcome: 'waiting' } },
    { id: 0, time: ago(5), kind: 'triage', text: 'PIN-4 triaging', data: { ticket: 'PIN-4', ticketId: 't4', inboxId: 'pin', projectId: 'p', project: 'Example', stage: 'working', outcome: 'triaging' } },
    { id: 4, time: ago(3), kind: 'triage', text: 'PIN-5 promotion queued: 2 promotions in the last 24 hours', data: { ticket: 'PIN-5', ticketId: 't5', inboxId: 'pin', projectId: 'p', project: 'Example', stage: 'working', outcome: 'promotion-queued', reason: '2 promotions in the last 24 hours' } },
  ] },
};
let posts = [], saves = [], dispatches = [], decisions = [], runs = 0;
window.fetch = async (url, init) => {
  // A start is refused, as a quota refusal answers, so it lands in the notification area.
  if (url === '/api/dispatch') {
    const input = JSON.parse(init.body), id = init.headers['Idempotency-Key']; dispatches.push(input);
    return Response.json({ id, input, state: 'done', result: { data: { reason: 'quota-exhausted' } } });
  }
  // The real endpoint answers with the config-save field error for an invalid limit.
  if (url === '/api/config') {
    const body = JSON.parse(init.body); saves.push(body);
    const limit = body.config.projects[0].inbox.maxPromotionsPerDay;
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) return Response.json({ message: 'projects.0.inbox.maxPromotionsPerDay: Too small: expected number to be >=0' }, { status: 400 });
    state.config = body.config;
    return Response.json(body.config);
  }
  if (url.startsWith('/api/triage/reports/')) { decisions.push(url.slice(20)); return Response.json({ state: 'written' }); }
  if (url === '/api/triage/run') { runs++; return Response.json({ queued: true }); }
  if (url === '/api/triage/enabled') {
    const body = JSON.parse(init.body); posts.push(body);
    state.config.triage.enabled = body.enabled; state.status.triageEnabled = body.enabled;
    return Response.json({ ok: true });
  }
  return Response.json(state);
};
async function show() {
  render(null, root); posts = []; saves = []; dispatches = []; decisions = []; operations.value = [];
  state.config.projects[0].inbox.maxPromotionsPerDay = 10;
  state.config.triage.enabled = true; state.status.triageEnabled = true;
  applyState(state, true); render(html`<${Triage} />`, root); await pause();
}
// Promoted tickets waiting to start are the Queue page's Reports view.
async function showReady() { await show(); render(null, root); render(html`<${ReadyReports} />`, root); await pause(); }
// Section 0 is Inboxes; Needs you, In progress and History follow.
const section = (title) => [...root.querySelectorAll('section.section')].find((s) => s.querySelector('h2')?.textContent.startsWith(title));
const rows = (title) => [...((title ? section(title) : root)?.querySelectorAll('.next') ?? [])];
const keys = (title) => rows(title).map((r) => r.querySelector('.key').textContent).join();
const row = (key, title = key.startsWith('EX-') ? undefined : 'History') => rows(title).find((r) => r.querySelector('.key')?.textContent === key);
const button = (label) => [...root.querySelectorAll(`[aria-label="${label}"]`)].find((el) => el.getClientRects().length);
const visibleTag = (r) => [...r.querySelectorAll('.tag')].find((el) => el.getClientRects().length && /promoted|needs owner|needs-info|queued|duplicate|failed|closed|waiting|triaging/.test(el.textContent));
// Triage's settings live in the Settings area; the fixture mounts them under the view, in a settings page's section.
async function settings() {
  render(null, root);
  render(html`<${Triage} /><div class="page settings-page"><section class="section"><${TriageSettings} /></section></div>`, root);
  await pause();
  return root.querySelector('.settings-page');
}
async function run() {
  await show();
  const text = () => root.textContent;
  assert(/3 need you.*2 waiting, oldest 3 h \d+ min ago, triaging PIN-4, 1 queued, 3 promoted/.test(root.querySelector('.triage-inbox').textContent) && root.querySelectorAll('.triage-inbox')[1].textContent.includes('clear') && !root.querySelectorAll('.triage-inbox')[1].textContent.includes('need'), 'each inbox shows its queue in pipeline order and how many reports need the owner');
  assert(keys('Needs you') === 'PIN-6,PIN-2,PIN-12' && !keys('History').includes('PIN-12'), 'Needs you lists every open report waiting on the owner, including one older than the recent results');
  const info = row('PIN-12', 'Needs you');
  assert(visibleTag(info)?.textContent === 'needs-info' && info.textContent.includes('Needs more information') && info.textContent.includes('3 d') && info.querySelector('a.next-ticket').href === 'https://kanvil.example.test/projects/pin/tickets/t12' && !info.querySelector('[aria-label^="Run "]'), 'a needs-info report says what it needs and how long it has waited, and opens its inbox ticket');
  assert(keys('In progress') === 'PIN-4,PIN-5,PIN-13' && visibleTag(row('PIN-13', 'In progress')).textContent === 'waiting' && !section('In progress').querySelector('.next-actions'), 'In progress lists the running report first, then the ones waiting on triage or promotion, with no actions');
  assert(['Needs you', 'In progress', 'History'].every((title, i, all) => !i || section(all[i - 1]).getBoundingClientRect().top < section(title).getBoundingClientRect().top), 'the lists follow a report from needing the owner to history');
  // The owner's decisions: triage again where a second pass can change the result, and close after a confirmation.
  assert(button('Triage PIN-2 again') && button('Triage PIN-12 again') && !button('Triage PIN-6 again') && button('Close PIN-6'), 'a failed or needs-info report can be triaged again; a needs-owner report can only be closed');
  button('Triage PIN-2 again').click(); await pause(); await pause();
  assert(decisions.join() === 't2/retry' && notice.value?.text === 'PIN-2 will be triaged again.', 'Triage again asks the scheduler to clear the result');
  button('Close PIN-6').click(); await pause();
  assert(decisions.length === 1 && confirmation.value?.title === 'Close PIN-6?', 'closing a report asks first');
  finishConfirmation(true); await pause(); await pause();
  assert(decisions.join() === 't2/retry,t6/close' && notice.value?.text === 'PIN-6 closed.', 'confirming closes the report');
  assert(keys('History') === 'PIN-7,PIN-6,PIN-5,PIN-3,PIN-8,PIN-9,PIN-2,PIN-10,PIN-1,GONE-1', 'History lists every recent result as its report, newest first');
  assert(!root.textContent.includes('Ready to start') && !root.querySelector('[aria-label^="Run "]') && row('PIN-10').textContent.includes('Promoted to EX-42'), 'promoted tickets are started from the Queue; Triage keeps their results in History');
  assert(row('PIN-7').querySelector('a.tag')?.href === 'https://kanvil.example.test/projects/p/tickets/t40' && !row('PIN-7').querySelector('[aria-label^="Run "]'), 'a promoted result in History links its ticket and has no Start');
  assert(row('PIN-6').textContent.includes('Needs the owner: sensitive: workType sec') && !button('Run PIN-6 now'), 'other results show their outcome and cannot start');
  assert(visibleTag(row('PIN-9'))?.textContent === 'closed' && visibleTag(row('PIN-9')).classList.contains('tag-label') && row('PIN-9').textContent.includes('Closed during triage'), 'a report closed during triage shows a neutral closed tag, not an error');
  assert(row('PIN-3').querySelector('a.next-ticket').href === 'https://kanvil.example.test/projects/pin/tickets/t3', 'a report row links to its inbox ticket');
  assert(row('PIN-1').querySelector('a.tag')?.href === 'https://kanvil.example.test/projects/p/tickets/EX-39', 'a promoted result without its ticket links the tag by key');
  assert(row('GONE-1').querySelector('a.tag')?.href === 'https://kanvil.example.test/projects/p/tickets/t38', 'a result from an inbox no longer configured keeps its recorded project');
  // Search and order.
  const search = await openSearch();
  search.value = 'ex-41'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(keys('Needs you') === '' && keys('History') === 'PIN-8', 'search narrows every list');
  search.value = 'sensitive'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(keys('Needs you') === 'PIN-6' && keys('History') === 'PIN-6', 'search matches a report row by its outcome');
  root.querySelector('[role="radiogroup"][aria-label="Result order"] [aria-label="Oldest first"]').click(); await pause();
  search.value = 'pin-'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(keys('History') === 'PIN-1,PIN-10,PIN-2,PIN-9,PIN-8,PIN-3,PIN-5,PIN-6,PIN-7', 'oldest first reverses the results');
  root.querySelector('[role="radiogroup"][aria-label="Result order"] [aria-label="Newest first"]').click(); await pause();
  search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  // The cog holds the triage switch.
  assert(button('Triage settings').getAttribute('href') === '/settings/sources', 'the cog leads to the Settings area');
  const toggle = root.querySelector('.page-head input[role="switch"][aria-label="Inbox triage"]');
  assert(toggle && toggle.checked, 'the triage switch sits with the view\'s controls');
  toggle.click(); await pause(); await pause();
  assert(posts.length === 1 && posts[0].enabled === false, 'the switch posts triage.enabled = false');
  assert(text().includes('Triage is paused'), 'the page warns that triage is paused');
  // Layout: promoted rows are no taller than two lines plus Start, and nothing overflows.
  assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
  for (const r of rows()) assert(r.getBoundingClientRect().right <= innerWidth, `row ${r.querySelector('.key').textContent} stays within the viewport`);
  const height = (key) => row(key).getBoundingClientRect().height, left = (key) => visibleTag(row(key)).getBoundingClientRect().left;
  assert(['PIN-3', 'PIN-9', 'PIN-2', 'PIN-1'].every((key) => Math.abs(left(key) - left('PIN-6')) < 1), 'outcome tags line up at the start of the facet line');
  const reportHeight = height('PIN-6'), tagLeft = left('PIN-6');
  const queue = await ready(reportHeight, tagLeft);
  const toggles = posts.length, limits = await promotion();
  return { passed: true, viewport: [innerWidth, innerHeight], posts: toggles, ...queue, ...limits };
}
// The Queue page's Reports view: promoted tickets, their start path, search, filters and selection.
async function ready(reportHeight, tagLeft) {
  await showReady();
  assert(keys() === 'EX-40,EX-41', 'the Reports view lists the promoted tickets that have not started, newest first');
  const ex40 = row('EX-40');
  assert(ex40.textContent.includes('Launch crash with empty saved state') && ex40.textContent.includes('from PIN-7') && ex40.querySelector('.meta-project').textContent === 'Example', 'a promoted row shows the new ticket and its report');
  assert(ex40.querySelector('a.next-ticket').href === 'https://kanvil.example.test/projects/p/tickets/t40', 'the row links to the promoted ticket');
  assert(visibleTag(ex40)?.textContent === 'promoted' && button('Run EX-40 now'), 'the promoted tag and Start show');
  assert(!root.querySelector('.next .tag-label') && ex40.textContent.includes('high') && ex40.textContent.includes('med'), 'promoted rows list priority and difficulty but not every label');
  assert(visibleTag(ex40).closest('.meta') && !visibleTag(ex40).closest('.next-actions'), 'the outcome tag leads the facet line, beside Start rather than above it');
  // Start goes through the shared start path with the page's overrides; a refusal lands in the notification area.
  button('Run EX-40 now').click(); await pause();
  for (let n = 0; n < 100 && operations.value.some((op) => op.state !== 'done'); n++) await pause();
  assert(JSON.stringify(dispatches[0]) === JSON.stringify({ ticket: 'EX-40', model: 'auto', overrideLimits: sessionOverrides.value }), 'Start dispatches the promoted key with the start options');
  assert(issues.value.some((i) => i.source === 'Triage starts' && i.error.problems[0].title === "Couldn't start EX-40"), 'a refused start is reported as a Triage start');
  operations.value = []; await pause();
  const search = await openSearch();
  search.value = 'ex-41'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(keys() === 'EX-41', 'search narrows the tickets');
  search.value = 'sensitive'; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  assert(keys() === '' && root.textContent.includes('No tickets match.'), 'an empty ticket list says the search matched nothing');
  search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  root.querySelector('[aria-label^="Filter runs"]').click(); await pause();
  [...document.querySelectorAll('.popover[aria-label="Filters"] [role="group"][aria-label="Priority"] button')].find((b) => b.getAttribute('aria-label') === 'High').click(); await pause();
  assert(keys() === 'EX-40', 'filters narrow the tickets');
  [...document.querySelectorAll('.popover[aria-label="Filters"] button')].find((b) => b.textContent.trim() === 'Clear all').click(); await pause();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause();
  button('Select tickets').click(); await pause();
  assert(root.querySelectorAll('.next > .check').length === 2, 'only promoted tickets can be selected');
  button('Select visible promoted tickets').click(); await pause();
  button('Run selected tickets').click(); await pause();
  for (let n = 0; n < 100 && operations.value.some((op) => op.state !== 'done'); n++) await pause();
  assert(dispatches.slice(1).map((d) => d.ticket).sort().join() === 'EX-40,EX-41', 'Run selected starts each selected ticket');
  operations.value = []; button('Done selecting tickets').click(); await pause();
  assert(document.documentElement.scrollWidth <= innerWidth, 'the Reports view stays within the viewport');
  assert(Math.abs(visibleTag(row('EX-41')).getBoundingClientRect().left - visibleTag(row('EX-40')).getBoundingClientRect().left) < 1 && (innerWidth <= 900 || Math.abs(visibleTag(row('EX-40')).getBoundingClientRect().left - tagLeft) < 1), 'outcome tags line up at the start of the facet line');
  if (innerWidth > 900) assert(Math.abs(row('EX-40').getBoundingClientRect().height - reportHeight) < 1, 'a promoted row with Start is as tall as a report row');
  const result = { dispatches: dispatches.length };
  await show();
  return result;
}
// Each inbox row shows its promotion counts and limit, and edits the limit through the settings save.
async function promotion() {
  await show();
  const text = () => root.textContent, lines = () => [...root.querySelectorAll('.triage-inbox')];
  assert(/1 queued, 3 promoted/.test(lines()[0].textContent), 'the first inbox shows its promotion counts');
  assert(lines()[0].textContent.includes('10 per day') && lines()[1].textContent.includes('Unlimited'), 'each inbox shows its limit next to its status');
  await settings();
  const rows = () => [...root.querySelectorAll('.settings-page .triage-inbox-settings')];
  assert(text().includes('Promoted to EX-39') && text().includes('needs owner') && text().includes('sensitive: workType sec') && text().includes('queued'), 'promotion outcomes are listed');
  // The shared limit picker: Paused, 5, 10, 20, 40, Other for any number, and Unlimited.
  const group = (row) => rows()[row].querySelector('[role="radiogroup"]');
  const one = (row) => new Set([...group(row).children].map((el) => Math.round(el.getBoundingClientRect().top))).size === 1;
  assert(one(0) && one(1), 'both promotion pickers initially fit one line, including at 382px');
  const choice = (row, name) => [...group(row).querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name);
  const checked = (row) => group(row).querySelector('[aria-checked="true"]')?.textContent;
  const state = (row) => lines()[row].textContent;
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
  assert(one(0) && one(1), 'each picker stays on one line');
  // The server still answers an invalid config with its field error.
  config.value = { ...config.value, projects: [{ ...config.value.projects[0], inbox: { ...config.value.projects[0].inbox, maxPromotionsPerDay: -1 } }, config.value.projects[1]] };
  await actions.save(); await pause();
  assert(saves.length === 2 && notice.value?.error && notice.value.text.startsWith('projects.0.inbox.maxPromotionsPerDay:'), 'the save path rejects an invalid limit with its field error');
  assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
  return { saves: saves.length, promotionPickersOnOneLine: true, viewport: [innerWidth, innerHeight] };
}
// Triage now: enabled only with waiting reports and no run in progress, beside the cog in the Inboxes header.
async function triageNow() {
  await show(); runs = 0;
  const now = () => button('Triage waiting reports now'), streams = state.status.triageStreams, saved = streams.map((s) => ({ ...s }));
  try {
    assert(now()?.disabled && now().title === 'Triage is running', 'a running triage disables Triage now');
    streams[0].running = null; applyState(state, true); await pause();
    assert(!now().disabled, 'waiting reports enable Triage now');
    const head = section('Inboxes').querySelector('h2').getBoundingClientRect(), play = now().getBoundingClientRect(), cog = button('Triage settings').getBoundingClientRect();
    assert(Math.abs(play.top - cog.top) < 1 && play.right <= cog.left && cog.left - play.right < 16 && play.bottom > head.top && play.top < head.bottom && cog.right <= innerWidth, 'Triage now sits beside the cog on the Inboxes title line');
    now().click(); await pause(); await pause();
    assert(runs === 1 && notice.value?.text === 'Triage started for waiting reports.', 'Triage now asks for one pass and confirms it');
    state.status.triageEnabled = false; state.config.triage.enabled = false; applyState(state, true); await pause();
    assert(!now().disabled, 'Triage now works while triage is paused');
    streams[0].untriaged = 0; applyState(state, true); await pause();
    assert(now().disabled && now().title === 'No reports are waiting', 'no waiting reports disables Triage now');
    assert(document.documentElement.scrollWidth <= innerWidth, 'page stays within viewport');
    return { runs, viewport: [innerWidth, innerHeight] };
  } finally { streams.splice(0, streams.length, ...saved); }
}
async function phoneHeader() { await showReady(); return checkPageHead(); }
window.triageTests = { phoneHeader, show, showReady, run, ready, promotion, triageNow };
await show();
