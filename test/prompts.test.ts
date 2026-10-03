import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { promptFor } from '../src/prompts.ts';
import type { Job } from '../src/store.ts';

test('ticket dispatch supplies the current skill and leaves merge policy to that skill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-prompt-'));
  const c = loadConfig(fileURLToPath(new URL('../config.example.jsonc', import.meta.url)));
  c.factorySkill = join(dir, 'SKILL.md');
  c.discovery.promptFile = join(dir, 'discovery.md');
  const project = c.projects[0];
  const job: Job = { id: 'job', kind: 'ticket', projectId: project.kaneoId, taskId: 'task', ticketKey: 'APP-1', threadId: 'thread', messageId: 'message', createdAt: '2026-01-01T00:00:00Z', state: 'dispatching', reason: '', lastPersonalActivity: null, reportPath: join(dir, 'report.json'), command: null, prUrls: [], completedAt: null };
  const skill = '# Software factory\n\nMerge without asking after local review, Codex review, and green CI.\nPreserve human validation and Hold.\n';
  try {
    writeFileSync(c.factorySkill, skill);
    for (const instanceId of ['claudeAgent', 'codex']) {
      job.modelSelection = { instanceId, model: 'selected-model', options: [] };
      const prompt = promptFor(job, project, c);
      assert.ok(prompt.includes(skill.trim()), 'the dispatched prompt must contain the actual skill, not just its path');
      assert.match(prompt, /\$software-factory/);
      assert.doesNotMatch(prompt, /Only approved=true|normal structured user merge prompt|safe merged-work cleanup/);
      assert.match(prompt, /human-only gates still require user input/);
      assert.match(prompt, /reuse them; do not create another worktree/);
    }
    const updated = skill.replace('green CI', 'green CI on the exact current head');
    writeFileSync(c.factorySkill, updated);
    assert.ok(promptFor(job, project, c).includes(updated.trim()), 'skill edits apply on the next dispatch without restarting Factory');
    writeFileSync(c.factorySkill, ' \n');
    assert.throws(() => promptFor(job, project, c), /skill.*empty/i);
    rmSync(c.factorySkill);
    assert.throws(() => promptFor(job, project, c), /ENOENT/);
    writeFileSync(c.discovery.promptFile, 'Discovery instructions');
    assert.match(promptFor({ ...job, kind: 'discovery' }, project, c), /Discovery instructions/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
