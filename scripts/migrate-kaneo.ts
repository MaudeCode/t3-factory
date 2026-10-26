import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { Kanvil, T3 } from '../src/clients.ts';
import { migrateKaneoState } from '../src/migration.ts';
import { loadEnvironment } from '../src/env.ts';
import { canonicalPath } from '../src/workspace.ts';

loadEnvironment();
process.umask(0o077);
const args = process.argv.slice(2), sourcePath = args[0];
if (!sourcePath || args.slice(1).some(a => a !== '--apply')) throw new Error('Usage: node scripts/migrate-kaneo.ts SOURCE_CONFIG [--apply]');
const sourceConfig = z.object({ stateDir: z.string(), projects: z.array(z.object({ key: z.string(), kaneoId: z.string() })) }).parse(parse(readFileSync(sourcePath, 'utf8')));
const c = loadConfig();
if (canonicalPath(sourceConfig.stateDir) === canonicalPath(c.stateDir)) throw new Error('Source and destination must be different state directories');
const source = new DatabaseSync(join(sourceConfig.stateDir, 'state.sqlite'), { readOnly: true });
const client = new Kanvil(c.kanvil);
let target: Store | undefined;
try {
  // Migration reads the old ledger directly; it never replays historical creation reports.
  const catalog = await client.projects(), tickets = [];
  for (const project of catalog) tickets.push(...await client.tasks(project.id, undefined, true));
  const projects = Object.fromEntries(sourceConfig.projects.flatMap(p => { const native = catalog.find(n => n.key === p.key); return native ? [[p.kaneoId, native.id]] : []; }));
  const active = source.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.state') NOT IN ('complete','dismissed')").all().map(r => JSON.parse(r.data as string));
  if (active.length) {
    const shell = await new T3(c.t3).shell(true);
    for (const job of active) {
      const thread = shell.threads.find(t => t.id === job.threadId);
      if (!thread || thread.activeRunId || thread.pendingRuntimeRequest || thread.pendingBackgroundTasks.length || !['completed', 'idle', 'archived'].includes(thread.status)) throw new Error('A legacy run may still be active; migration refused');
    }
  }
  if (!args.includes('--apply')) {
    const dir = mkdtempSync(join(tmpdir(), 'factory-migration-preview-'));
    let preview: Store | undefined;
    try {
      const destination = join(c.stateDir, 'state.sqlite');
      if (existsSync(destination)) {
        const current = new DatabaseSync(destination, { readOnly: true });
        try { await backup(current, join(dir, 'state.sqlite')); } finally { current.close(); }
      }
      preview = new Store(dir);
      const result = migrateKaneoState(source, preview, tickets, projects);
      console.log(JSON.stringify({ apply: false, ...result, source: sourceConfig.stateDir, target: c.stateDir, snapshots: catalog.length }));
    } finally { preview?.close(); rmSync(dir, { recursive: true, force: true }); }
  } else {
    if (existsSync(join(c.stateDir, 'control.sock'))) throw new Error('Stop the scheduler and web service before applying migration');
    target = new Store(c.stateDir);
    if (!target.claim()) throw new Error('Another process owns the destination state');
    const backupPath = join(c.stateDir, `before-kaneo-migration-${Date.now()}.sqlite`);
    await backup(target.db, backupPath);
    const result = migrateKaneoState(source, target, tickets, projects);
    writeFileSync(join(c.stateDir, 'kaneo-migration.json'), JSON.stringify({ ...result, source: sourceConfig.stateDir, backupPath }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ...result, backupPath }));
  }
} finally { await client.close(); target?.close(); source.close(); }
