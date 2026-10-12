import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { configSchema, loadConfig } from '../src/config.ts';
import { saveSettings } from '../src/settings.ts';
import { ticketLabelRank, selectTicket, selectAssignment, type Candidate } from '../src/policy.ts';

test('ordered label configuration defaults safely and survives settings edits', () => {
  const input = parse(readFileSync(new URL('../config.example.jsonc', import.meta.url), 'utf8'));
  delete input.projects[0].priorityLabels;
  const base = configSchema.parse(input);
  assert.deepEqual(base.projects[0].priorityLabels, []);
  input.projects[0].priorityLabels = [' security ', 'compatibility'];
  const next = configSchema.parse(input);
  assert.deepEqual(next.projects[0].priorityLabels, ['security', 'compatibility']);
  for (const invalid of [['security', ' security '], [' ']]) {
    assert.throws(() => configSchema.parse({ ...input, projects: [{ ...input.projects[0], priorityLabels: invalid }] }));
  }
  const dir = mkdtempSync(join(tmpdir(), 'factory-label-config-')), file = join(dir, 'config.jsonc');
  try {
    writeFileSync(file, JSON.stringify(base));
    saveSettings({ base, config: next }, file);
    assert.deepEqual(loadConfig(file).projects[0].priorityLabels, ['security', 'compatibility']);
    assert.deepEqual(loadConfig(file).models, base.models);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first matching label wins; unconfigured and absent labels have no rank', () => {
  assert.equal(ticketLabelRank([{ name: 'compatibility' }, { name: 'security' }], ['security', 'compatibility']), 0);
  assert.equal(ticketLabelRank([{ name: 'compatibility' }], ['security', 'compatibility']), 1);
  assert.equal(ticketLabelRank([{ name: 'Security' }], ['security']), undefined);
  assert.equal(ticketLabelRank([], ['security']), undefined);
  assert.equal(ticketLabelRank([{ name: 'security' }], []), undefined);
});

test('label rank precedes urgency across projects, retaining existing tie breakers', () => {
  const ticket = (id: string, projectId: string, priority: string, labelRank?: number, createdAt = '2026-01-01'): Candidate => ({ id, key: id, projectId, priority, labelRank, createdAt, difficulty: 'high' });
  const urgent = ticket('unmatched', 'B', 'urgent'), second = ticket('second', 'B', 'urgent', 1), first = ticket('first', 'A', 'low', 0);
  assert.equal(selectTicket([urgent, second, first], null, ['A', 'B'])?.id, 'first');
  assert.equal(selectTicket([urgent, second], null, ['A', 'B'])?.id, 'second');
  assert.equal(selectTicket([first, ticket('ranked-urgent', 'B', 'urgent', 0)], null, ['A', 'B'])?.id, 'ranked-urgent');
  const tied = [ticket('A-new', 'A', 'high', 0, '2026-01-02'), ticket('A-old', 'A', 'high', 0), ticket('B-old', 'B', 'high', 0)];
  assert.equal(selectTicket(tied, 'A', ['A', 'B'])?.id, 'A-old', 'largest ranked backlog wins');
  assert.equal(selectTicket(tied.slice(1), 'A', ['A', 'B'])?.id, 'B-old', 'equal backlogs rotate');
  assert.equal(selectTicket([urgent, ticket('ordinary', 'A', 'low')], null, ['A', 'B'])?.id, 'unmatched');
});

test('model selection respects label tiers without blocking other eligible work', () => {
  const preset = (id: string, maxDifficulty: 'low' | 'med' | 'high') => ({ id, name: id, model: { instanceId: id, model: id, options: [] }, automatic: true, maxDifficulty });
  const models = [{ preset: preset('small', 'med'), driver: 'codex' }, { preset: preset('large', 'high'), driver: 'claudeAgent' }];
  const ranked: Candidate = { id: 'ranked', key: 'ranked', projectId: 'p', priority: 'low', createdAt: '2026-01-01', difficulty: 'high', labelRank: 0 };
  const ordinary: Candidate = { ...ranked, id: 'ordinary', key: 'ordinary', priority: 'urgent', difficulty: 'med', labelRank: undefined };
  assert.equal(selectAssignment([ordinary, ranked], models, new Set(), null, ['p'])?.ticket.id, 'ranked');
  assert.equal(selectAssignment([ordinary, ranked], models, new Set(), null, ['p'])?.preset.id, 'large');
  assert.equal(selectAssignment([ordinary, ranked], models, new Set(['claudeAgent']), null, ['p'])?.ticket.id, 'ordinary');
  assert.equal(selectAssignment([{ ...ranked, difficulty: undefined }, ordinary], models, new Set(), null, ['p'])?.ticket.id, 'ordinary');
});
