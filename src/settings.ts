import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { configSchema, loadConfig, defaultConfigPath, type Config } from './config.ts';

const formattingOptions = { insertSpaces: true, tabSize: 2 };
const replace = (file: string, text: string) => { writeFileSync(`${file}.tmp`, text, { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
// Set values in the config file in place, keeping its comments and layout.
export function editConfig(file: string, edits: [path: (string | number)[], value: unknown][]) {
  let text = readFileSync(file, 'utf8');
  for (const [path, value] of edits) text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  replace(file, text);
}

// A weekly reset this much later than the one `offAt` was taken from is the next window: the reset came early.
const RESET_MOVED_MS = 3_600_000;
// Apply the schedule's due timers to the config file: each sets automation and the queue, they fire in time order, off wins
// a tie, and each clears itself. `resets` reads each provider's weekly reset as last seen. Returns the switches' new value
// and why, or nothing when no timer is due.
export function applySchedule(file: string, c: Pick<Config, 'schedule'>, resets: () => Partial<Record<'claude' | 'codex', string>>, now = Date.now()) {
  const { onAt, offAt, offAtReset } = c.schedule;
  const early = !!offAt && !!offAtReset && Date.parse(resets()[offAtReset] ?? '') > Date.parse(offAt) + RESET_MOVED_MS;
  const fired = [
    ...onAt && Date.parse(onAt) <= now ? [{ key: 'onAt', at: Date.parse(onAt), enabled: true }] : [],
    ...offAt && (Date.parse(offAt) <= now || early) ? [{ key: 'offAt', at: Math.min(Date.parse(offAt), now), enabled: false }] : [],
  ].sort((a, b) => a.at - b.at);
  const last = fired.at(-1);
  if (!last) return;
  editConfig(file, [[['enabled'], last.enabled], [['queue', 'enabled'], last.enabled], ...fired.map(f => [['schedule', f.key], null] as [string[], null]), ...fired.some(f => !f.enabled) ? [[['schedule', 'offAtReset'], null] as [string[], null]] : []]);
  const reset = offAtReset && { claude: 'Claude', codex: 'Codex' }[offAtReset];
  return { enabled: last.enabled, text: `Automation and queued runs turned ${last.enabled ? 'on by the schedule' : reset ? `off at the ${reset} weekly reset` : 'off by the schedule'}` };
}

export function saveSettings(input: unknown, file = process.env.T3_FACTORY_CONFIG ?? defaultConfigPath) {
  const { base, config } = input as { base?: unknown; config?: unknown };
  const next = configSchema.parse(config), previous = configSchema.parse(base);
  if (JSON.stringify(loadConfig(file)) !== JSON.stringify(previous)) throw new Error('Settings changed since this window opened. Reload before saving.');
  let text = readFileSync(file, 'utf8');
  // Edits descend into the parsed values only where the file holds the same shape: a value the schema normalized
  // (a bare priority label read as a rank of one) is replaced whole rather than indexed into.
  const update = (before: unknown, after: unknown, path: (string | number)[], stored: unknown) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (isObject(before) && isObject(after) && (stored === undefined || isObject(stored))) {
      const a = before as Record<string, unknown>, b = after as Record<string, unknown>, s = stored as Record<string, unknown> | undefined;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) update(a[key], b[key], [...path, key], s?.[key]);
    } else if (Array.isArray(before) && Array.isArray(after) && before.length === after.length && (stored === undefined || (Array.isArray(stored) && stored.length === before.length))) {
      after.forEach((value, i) => update(before[i], value, [...path, i], (stored as unknown[] | undefined)?.[i]));
    } else text = applyEdits(text, modify(text, path, after, { formattingOptions }));
  };
  update(previous, next, [], parse(text));
  // Reject stale UI snapshots and replace the file atomically.
  if (JSON.stringify(loadConfig(file)) !== JSON.stringify(previous)) throw new Error('Settings changed while saving. Reload before saving.');
  replace(file, text);
  return next;
}
