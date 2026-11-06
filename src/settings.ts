import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { configSchema, loadConfig, defaultConfigPath } from './config.ts';

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
    } else text = applyEdits(text, modify(text, path, after, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  };
  update(previous, next, [], parse(text));
  // Reject stale UI snapshots and replace the file atomically.
  if (JSON.stringify(loadConfig(file)) !== JSON.stringify(previous)) throw new Error('Settings changed while saving. Reload before saving.');
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  return next;
}
