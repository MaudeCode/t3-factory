// Actual Projects page with its priority ranks and config save flow; only the server is synthetic.
import { html, render } from '../../web/lib/h.js';
import '../../web/lib/theme.js';
import * as store from '../../web/lib/store.js';
import { navigate } from '../../web/lib/router.js';
import { App } from '../../web/views/App.js';
const project = (over) => ({ name: 'Example app', key: 'APP', kanvilId: 'app-project', t3Id: 'app-project', enabled: true, repoPath: '/example/app', githubRepo: 'example/app', baseBranch: 'main', readyStatuses: ['todo'], doneStatuses: ['done'], priorityLabels: [], labelLimits: {}, upstreams: [], ...over });
const initial = {
  enabled: false, concurrency: { claude: 2, codex: 6 }, models: [], pollSeconds: 60, idleMinutes: 30, monitoringTimeoutMinutes: 30, maxWaitingPRs: null,
  kanvil: { url: 'https://tracker.example.test', workspaceId: 'workspace' }, discovery: { emptyCooldownHours: 24, promptFile: '/example/discovery.md' },
  projects: [
    project({ priorityLabels: [['user-report', 'sec'], ['agent-compat']], labelLimits: { app: 2 }, upstreams: [{ name: 'Framework', repo: 'example/framework', prereleases: false, firstBase: 'v1' }] }),
    project({ name: 'Library', key: 'LIB', kanvilId: 'lib-project', t3Id: 'lib-project', repoPath: '/example/lib', githubRepo: 'example/lib', enabled: false }),
  ],
};
const ticket = (n, labels, priority = 'low') => ({ id: `t${n}`, key: `APP-${n}`, title: `Ticket ${n}`, projectId: 'app-project', difficulty: 'med', priority, labels, after: [], model: null, modelId: null });
const upNext = { at: '2026-11-05T10:00:00Z', tickets: [ticket(1, ['user-report']), ticket(2, ['sec', 'agent-compat']), ticket(3, ['agent-compat'], 'high'), ticket(4, ['perf'], 'urgent')], held: [] };
let saved = structuredClone(initial), writes = [];
const state = () => ({ config: saved, status: { jobs: [], journal: [], upNext } });
window.fetch = async (url, init) => {
  if (url === '/api/config' && init?.method === 'POST') { const input = JSON.parse(init.body); writes.push(input); saved = structuredClone(input.config); return Response.json({ ok: true }); }
  if (url === '/api/sources') return Response.json({ t3: [{ id: 'app-project', title: 'Example app', workspaceRoot: '/example/app' }, { id: 'lib-project', title: 'Library', workspaceRoot: '/example/lib' }, { id: 'second-t3', title: 'Second app', workspaceRoot: '/example/second' }], kanvil: {
    workspaces: [{ id: 'workspace', name: 'First workspace' }, { id: 'other', name: 'Other workspace' }, { id: 'empty', name: 'Empty workspace' }],
    projects: [{ id: 'app-project', workspaceId: 'workspace', name: 'Example app', slug: 'APP' }, { id: 'lib-project', workspaceId: 'workspace', name: 'Library', slug: 'LIB' }, { id: 'second-project', workspaceId: 'other', name: 'Second app', slug: 'SEC' }],
    columns: { 'second-project': [{ slug: 'todo', name: 'To do', isFinal: false }, { slug: 'done', name: 'Done', isFinal: true }] }, labels: ['agent-compat', 'app', 'perf', 'sec', 'software-factory-ready', 'user-report', 'web'] } });
  return Response.json(state());
};
const root = document.querySelector('#root');
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
async function mount() {
  render(null, root); store.history.value = null; store.selectedProject.value = 0; store.applyState(state(), true); navigate('/projects', true); render(html`<${App} />`, root); await pause();
}
const views = () => root.querySelector('[role="radiogroup"][aria-label="Project settings"]');
async function view(name) { [...views().querySelectorAll('[role="radio"]')].find(b => b.textContent.startsWith(name)).click(); await pause(); }
async function show(name = 'Scheduling') { saved = structuredClone(initial); writes = []; await mount(); await view(name); }
const tiers = () => store.config.value.projects[0].priorityLabels;
const ranks = () => [...root.querySelectorAll('.ladder .sortable .tier')];
const labelsOf = (rank) => [...rank.querySelectorAll('.tier-labels [aria-pressed]')].map(b => b.textContent.trim());
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
// Opens a label picker and chooses an option by its text.
async function pick(label, text, scope = root) {
  const button = scope.querySelector(`[role="combobox"][aria-label^="${label}:"]`);
  assert(button, `${label} picker is present`); button.scrollIntoView({ block: 'nearest' }); button.click(); await pause();
  const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === text);
  assert(option, `${label} offers ${text}`); option.click(); await pause();
}
async function run() {
  await show();
  assert(views().querySelector('[aria-checked="true"]').textContent.startsWith('Scheduling'), 'the settings switch marks the open view');
  assert(ranks().length === 2 && labelsOf(ranks()[0]).join() === 'user-report,sec' && labelsOf(ranks()[1]).join() === 'agent-compat', 'ranks render highest first with their labels');
  const counts = () => [...root.querySelectorAll('.tier-count')].map(el => el.textContent.trim());
  assert(counts().join('|') === '2 up next|1 up next|1 up next', `queued tickets count toward their first matching rank: ${counts().join('|')}`);
  await pick('Add a label to rank 2', 'perf');
  assert(JSON.stringify(tiers()) === JSON.stringify([['user-report', 'sec'], ['agent-compat', 'perf']]), 'a catalog label joins an existing rank');
  assert(counts().join('|') === '2 up next|2 up next|0 up next', 'counts follow the edit before saving');
  const picker = root.querySelector('[role="combobox"][aria-label^="Add a label to rank 2:"]'); picker.click(); await pause();
  const menu = document.querySelector('.select ul:popover-open'), box = menu.getBoundingClientRect();
  assert(menu.scrollWidth <= menu.clientWidth && box.width >= picker.getBoundingClientRect().width && box.right <= innerWidth, `the menu grows to its widest option without sideways scroll: ${menu.scrollWidth} in ${menu.clientWidth}`);
  const offered = [...document.querySelectorAll('[role="option"]')].map(el => el.textContent.trim());
  assert(!offered.includes('perf') && !offered.includes('sec') && offered.includes('app') && offered.at(-1) === 'Other label…', `pickers offer only unranked labels: ${offered.join()}`);
  key(picker, 'Escape'); await pause();
  root.querySelector('[aria-label="Remove sec from rank 1"]').click(); await pause();
  assert(JSON.stringify(tiers()) === JSON.stringify([['user-report'], ['agent-compat', 'perf']]), 'a label leaves its rank');
  const grip = ranks()[1].querySelector('.grip'); grip.focus(); key(grip, 'ArrowUp'); await pause();
  assert(JSON.stringify(tiers()) === JSON.stringify([['agent-compat', 'perf'], ['user-report']]), 'the arrow keys move a rank');
  assert(labelsOf(ranks()[0]).join() === 'agent-compat,perf' && ranks()[0].querySelector('.rank').textContent === '1', 'the ladder renumbers after a move');
  await pick('Start a new rank', 'Other label…');
  const typed = root.querySelector('[aria-label="Start a new rank, typed"]');
  assert(typed && document.activeElement === typed, 'Other label opens a focused box');
  typed.value = ' infra '; key(typed, 'Enter'); await pause();
  assert(JSON.stringify(tiers()) === JSON.stringify([['agent-compat', 'perf'], ['user-report'], ['infra']]), 'a typed label starts the next rank');
  assert(ranks().length === 3 && root.querySelector('.tier-new .rank').textContent === '4', 'the new-rank row names the rank it would create');
  root.querySelector('[aria-label="Remove infra from rank 3"]').click(); await pause();
  assert(tiers().length === 2, 'removing the last label of a rank removes the rank');
  await store.actions.save(); await mount(); await view('Scheduling');
  assert(JSON.stringify(writes.at(-1).config.projects[0].priorityLabels) === JSON.stringify([['agent-compat', 'perf'], ['user-report']]), 'Save posts ranks as lists of labels');
  assert(labelsOf(ranks()[0]).join() === 'agent-compat,perf' && !store.dirty.value, 'ranks survive Save/reload');
  await pick('Limit a label', 'web');
  assert(store.config.value.projects[0].labelLimits.web === 1 && root.querySelector('[aria-label="web runs at once"]'), 'a limited label appears with its slots');
  await view('Setup');
  assert(root.querySelector('[aria-label="T3 project: Example app"]') && !root.querySelector('.ladder'), 'Setup shows the links and hides the ladder');
  await view('Releases');
  assert(root.textContent.includes('example/framework'), 'Releases lists watched repositories');
  store.selectedProject.value = 1; await pause();
  assert(root.querySelector('.detail-head h2').textContent === 'Library' && views().querySelector('[aria-checked="true"]').textContent.startsWith('Releases'), 'switching projects keeps the open view');
  await view('Scheduling');
  assert(ranks().length === 0 && root.querySelector('.tier-new .rank').textContent === '1' && root.querySelector('.tier-rest'), 'a project without ranks shows only the first rank to fill and the rest');
  for (const el of root.querySelectorAll('.tier, .label-limit, .segmented')) assert(el.getBoundingClientRect().right <= innerWidth, 'project controls stay within the viewport');
  assert(document.documentElement.scrollWidth <= innerWidth, 'Projects has no horizontal overflow');
  return { passed: true, viewport: [innerWidth, innerHeight], writes: writes.length };
}
async function workspaces() {
  await show('Setup');
  assert(root.querySelector('[aria-label="Kanvil workspace: First workspace"]'), 'legacy mappings use the configured default workspace');
  await pick('Kanvil workspace', 'Other workspace');
  const projectPicker = root.querySelector('[role="combobox"][aria-label^="Kanvil project:"]');
  projectPicker.click(); await pause();
  const choices = [...root.querySelectorAll('.select [role="option"]')].map(el => el.textContent.trim());
  assert(choices.includes('Second app (SEC)') && !choices.includes('Example app (APP)') && !choices.includes('Library (LIB)'), 'project choices belong to the selected workspace');
  key(projectPicker, 'Escape'); await pause();
  await pick('Kanvil project', 'Second app (SEC)');
  await store.actions.save(); await mount();
  assert(store.config.value.projects[0].kanvilWorkspaceId === 'other' && root.querySelector('[aria-label="Kanvil workspace: Other workspace"]') && root.querySelector('[aria-label="Kanvil project: Second app (SEC)"]'), 'relinked project and workspace survive Save/reload');
  await show('Setup');
  root.querySelector('[aria-label="Add project"]').click(); await pause();
  const dialog = root.querySelector('dialog[open]');
  const bounds = dialog.getBoundingClientRect(), footer = dialog.querySelector('.dialog-actions').getBoundingClientRect();
  assert(footer.top >= bounds.top && footer.bottom <= bounds.bottom && footer.bottom <= innerHeight, 'Add project actions remain fully visible at the short viewport');
  const dialogProject = dialog.querySelector('[role="combobox"][aria-label^="Kanvil project:"]');
  dialogProject.scrollIntoView({ block: 'nearest' }); await pause();
  const projectBounds = dialogProject.getBoundingClientRect(), visibleFooter = dialog.querySelector('.dialog-actions').getBoundingClientRect();
  assert(projectBounds.top >= bounds.top && projectBounds.bottom <= visibleFooter.top && visibleFooter.bottom <= bounds.bottom, 'scrolling reveals the project control without hiding the dialog actions');
  await pick('T3 project', 'Second app', dialog);
  await pick('Kanvil workspace', 'Other workspace', dialog);
  await pick('Kanvil project', 'Second app (SEC)', dialog);
  await pick('Kanvil workspace', 'Empty workspace', dialog);
  assert(dialog.querySelector('[aria-label="Kanvil project: No projects available"]'), 'switching to an empty workspace clears the previous project selection');
  await pick('Kanvil workspace', 'Other workspace', dialog);
  await pick('Kanvil project', 'Second app (SEC)', dialog);
  [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Add project').click(); await pause();
  const added = store.config.value.projects.at(-1);
  assert(added.kanvilId === 'second-project' && added.kanvilWorkspaceId === 'other' && added.key === 'SEC' && added.doneStatuses.includes('done'), 'Add project stores workspace, identity, prefix and statuses together');
  await store.actions.save(); await mount(); store.selectedProject.value = 2; await pause();
  assert(root.querySelector('[aria-label="Kanvil workspace: Other workspace"]') && root.querySelector('[aria-label="Kanvil project: Second app (SEC)"]'), 'added mapping survives Save/reload');
  assert(document.documentElement.scrollWidth <= innerWidth, 'workspace and project controls stay within the viewport');
  return { passed: true, viewport: [innerWidth, innerHeight] };
}
window.projectsTests = { run, show, workspaces };
// Opening the page shows the Scheduling view with synthetic data; ?view=Setup or ?view=Releases open the others.
const params = new URLSearchParams(location.search);
show(params.get('view') ?? 'Scheduling').then(async () => {
  if (params.has('add')) {
    root.querySelector('[aria-label="Add project"]').click(); await pause();
    await pick('Kanvil workspace', 'Other workspace', root.querySelector('dialog[open]'));
  }
});
