import test from 'node:test';
import assert from 'node:assert/strict';
import { codexReactionApproval, type PrReaction, type ReviewProof } from '../src/codex-approval.ts';

test('only a fresh Codex PR-body thumbs-up can approve the recorded head', () => {
  const proof: ReviewProof = { repository: 'fixture/repo', number: 1, head: 'a'.repeat(40), observedAt: '2026-09-12T02:00:00.000Z', existingReactionIds: [1] };
  const reaction: PrReaction = { id: 2, content: '+1', created_at: '2026-09-12T02:01:00Z', user: { id: 199175422, login: 'chatgpt-codex-connector[bot]' } };
  assert.equal(codexReactionApproval(proof, proof.head, [reaction]).approved, true);
  assert.equal(codexReactionApproval(proof, 'b'.repeat(40), [reaction]).approved, false);
  for (const invalid of [
    { ...reaction, id: 1 },
    { ...reaction, created_at: '2026-09-12T01:59:00Z' },
    { ...reaction, content: 'eyes' },
    { ...reaction, user: { id: 123, login: 'chatgpt-codex-connector[bot]' } },
    { ...reaction, user: { id: 199175422, login: 'someone-else' } },
  ]) assert.equal(codexReactionApproval(proof, proof.head, [invalid]).approved, false);
  assert.equal(codexReactionApproval(proof, proof.head, []).approved, false);
});
