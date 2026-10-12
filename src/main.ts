import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { modify, applyEdits, parse } from 'jsonc-parser';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, defaultConfigPath } from './config.ts';
import { Store, jobLabel } from './store.ts';
import { cycle, log, safeError, writeStatus } from './scheduler.ts';
import { codexApprovalCommand } from './codex-approval.ts';
import { saveSettings } from './settings.ts';
import type { CycleOptions } from './scheduler.ts';
import { ZodError } from 'zod';
import { T3 } from './clients.ts';
import { createFactoryWeb, webSettings } from './web.ts';

import { loadEnvironment } from './env.ts';
import { createOidc } from './oidc.ts';

loadEnvironment();
process.umask(0o077);
const command = process.argv[2] ?? 'status';
const configPath = process.env.T3_FACTORY_CONFIG ?? defaultConfigPath;
// Config switches the CLI and web toggles flip.
const switches: Record<string, { path: string[]; value: boolean; message: string }> = {
  pause: { path: ['enabled'], value: false, message: 'New dispatches paused. Existing T3 jobs continue.' },
  resume: { path: ['enabled'], value: true, message: 'New dispatches enabled; quota and idle gates still apply.' },
  'upstream-pause': { path: ['upstream', 'enabled'], value: false, message: 'New upstream reviews paused. Running reviews continue.' },
  'upstream-resume': { path: ['upstream', 'enabled'], value: true, message: 'Upstream reviews enabled; quota and run limits still apply.' },
};
if (command === 'web') {
  const { config, secret, oidc } = webSettings();
  const c = loadConfig(configPath);
  const server = createFactoryWeb({ config, secret, oidc: oidc ? await createOidc(oidc, config.publicOrigin, undefined, Date.now, join(c.stateDir, "web-sessions.json")) : undefined, dataDir: c.stateDir, readState: () => {
    const config = loadConfig(configPath), file = join(config.stateDir, 'status.json');
    const status = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { jobs: [], streams: [] };
    const jobs = (status.jobs ?? []).filter((j: any) => j.state !== 'dismissed');
    status.jobs = [...jobs.filter((j: any) => j.state !== 'complete'), ...jobs.filter((j: any) => j.state === 'complete').slice(-30)].map((j: any) => ({ id: j.id, taskId: j.taskId, projectId: j.projectId, ticketKey: j.ticketKey, kind: j.kind, upstream: j.upstream, label: jobLabel(j), state: j.state, reason: j.reason, createdAt: j.createdAt, completedAt: j.completedAt, threadId: j.threadId, prUrls: j.prUrls, modelSelection: j.modelSelection, providerDriver: j.providerDriver, difficulty: j.difficulty }));
    return { config, status };
  } });
  server.listen(config.port, config.host, () => console.log(`Factory web controls listening on ${config.host}:${config.port}`));
  process.once('SIGTERM', () => server.close()); process.once('SIGINT', () => server.close());
} else if (command === 'web-pair') {
  try {
    const { config, secret, oidc } = webSettings();
    if (oidc) throw new Error('Pairing is disabled. Open the public address and sign in with SSO.');
    const result = await fetch(`http://${config.host}:${config.port}/api/pair`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
    if (!result.ok) throw new Error('Could not create a pairing link. Check that the web service is running.');
    console.log(JSON.stringify(await result.json()));
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'model-catalog') {
  try {
    const providers = await new T3(loadConfig(configPath).t3).providers();
    console.log(JSON.stringify({ providers: providers.filter(p => ['claudeAgent', 'codex'].includes(p.driver)).map(({ instanceId, driver, status, enabled, installed, models }) => ({ instanceId, driver, status, enabled, installed, models })) }));
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (command === 'config-get' || command === 'config-save') {
  try {
    const result = command === 'config-get' ? loadConfig(configPath) : saveSettings(JSON.parse(readFileSync(0, 'utf8')), configPath);
    console.log(JSON.stringify(result));
  } catch (e) { console.error(e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : safeError(e)); process.exitCode = 1; }
} else if (command === 'approval-record' || command === 'approval-check') {
  try {
    const [, , , repository, number, file] = process.argv;
    if (!repository || !number || !file) throw new Error('Usage: t3-factory approval-record|approval-check owner/repo PR_NUMBER PROOF_FILE');
    const result = await codexApprovalCommand(command, repository, number, file);
    console.log(JSON.stringify(result));
    if ('approved' in result && !result.approved) process.exitCode = 1;
  } catch (e) { console.error(safeError(e)); process.exitCode = 1; }
} else if (Object.hasOwn(switches, command)) {
  const { path, value, message } = switches[command];
  const text = readFileSync(configPath, 'utf8');
  if (path[0] === 'upstream' && !parse(text, [], { allowTrailingComma: true })?.upstream) {
    console.error('No upstream reviews are configured'); process.exitCode = 1;
  } else {
    const next = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    writeFileSync(`${configPath}.tmp`, next, { mode: 0o600 }); renameSync(`${configPath}.tmp`, configPath);
    console.log(message);
  }
} else if (command === 'status') {
  const c = loadConfig(configPath), store = new Store(c.stateDir);
  console.log(JSON.stringify(writeStatus(c, store), null, 2)); store.close();
} else if (['doctor', 'once', 'run', 'dispatch'].includes(command)) {
  const options: CycleOptions = { dryRun: process.argv.includes('--dry-run'), doctor: command === 'doctor', manual: command === 'dispatch', overrideLimits: process.argv.includes('--override-limits'), allowMissingReadyLabel: process.argv.includes('--allow-missing-ready-label') };
  if (command === 'dispatch') {
    const args = process.argv.slice(3);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ticket') options.ticket = args[++i];
      else if (args[i] === '--model') {
        const value = args[++i];
        if (!/^[a-z][a-z0-9-]*$/.test(value ?? '')) throw new Error('--model requires auto or a configured model ID');
        options.model = value as CycleOptions['model'];
      } else if (!['--override-limits', '--dry-run', '--allow-missing-ready-label'].includes(args[i])) throw new Error(`Unknown dispatch argument: ${args[i]}`);
    }
    if (args.includes('--ticket') && !options.ticket) throw new Error('--ticket requires a ticket key');
  }
  let stop = false;
  const signal = new AbortController();
  process.once('SIGTERM', () => { stop = true; signal.abort(); });
  process.once('SIGINT', () => { stop = true; signal.abort(); });
  let configuredStateDir: string | undefined;
  do {
    let store: Store | undefined;
    let seconds = 60;
    try {
      const c = loadConfig(configPath);
      if (configuredStateDir && configuredStateDir !== c.stateDir) throw new Error('stateDir changed while running; restart the service for a deliberate state migration');
      configuredStateDir = c.stateDir; seconds = c.pollSeconds;
      store = new Store(c.stateDir);
      let claimed = store.claim();
      for (let retry = 0; !claimed && options.manual && retry < 20 && !stop; retry++) {
        await delay(500); claimed = store.claim();
      }
      if (!claimed) { store.close(); store = undefined; throw new Error('Another scheduler cycle is checking the queue. Try again shortly.'); }
      const result = await cycle(c, store, options);
      if (options.manual && !['dispatched', 'would-dispatch'].includes(result.reason)) process.exitCode = 1;
      writeStatus(c, store);
    } catch (e) {
      const message = safeError(e); log('error', { message });
      if (store) {
        store.set('lastDecision', JSON.stringify({ reason: 'error', message, at: new Date().toISOString() }));
        try { writeStatus(loadConfig(configPath), store); } catch { /* Invalid config is already logged. */ }
      }
      if (command !== 'run') process.exitCode = 1;
    } finally { store?.close(); }
    if (command !== 'run' || stop) break;
    await delay(seconds * 1000, undefined, { signal: signal.signal }).catch(() => {});
  } while (!stop);
} else {
  console.error('Usage: t3-factory status | doctor | once [--dry-run] | run | pause | resume | upstream-pause | upstream-resume | config-get | config-save | model-catalog | web | web-pair | dispatch [--ticket KEY] [--model auto|MODEL_ID] [--override-limits] [--allow-missing-ready-label] [--dry-run]');
  process.exitCode = 2;
}
