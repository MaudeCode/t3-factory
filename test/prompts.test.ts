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
  const skill = '# Software factory\n\nMerge without asking after local review, Codex review, and green CI.\nInvoke $ios-phone-validation and wait for the user device verdict.\nPreserve human validation and Hold.\n';
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
      assert.match(prompt, /no change is needed.*record the evidence on the ticket.*move it out of the ready queue.*detach the sf readiness label.*clean with no commits.*"no-work" with "prUrls":\[\]/);
      assert.match(prompt, /Never report complete based merely on finishing a turn or opening a PR/);
      assert.match(prompt, /Yielding to background work that notifies you on completion.*ordinary progress: it needs no awaiting-human report or user question.*resumes this same job/);
      assert.match(prompt, /Automatic run visual validation/);
      assert.match(prompt, /capture and inspect screenshots of the actual changed build/i);
      assert.match(prompt, /record and inspect a video/i);
      assert.match(prompt, /declined the physical-phone checkpoint/i);
      assert.ok(prompt.indexOf('Automatic run visual validation') > prompt.indexOf('</software-factory-skill>'), 'the automatic-run exception follows the supplied skill so its phone gate cannot override it');
      const manualPrompt = promptFor(job, project, c, true);
      assert.match(manualPrompt, /Manual run validation/);
      assert.doesNotMatch(manualPrompt, /declined the physical-phone checkpoint/);
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
