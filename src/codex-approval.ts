import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod';

const exec = promisify(execFile);
const proofSchema = z.object({ repository: z.string(), number: z.number().int().positive(), head: z.string(), observedAt: z.iso.datetime(), existingReactionIds: z.array(z.number()) });
const reactionSchema = z.object({ id: z.number(), content: z.string(), created_at: z.string(), user: z.object({ id: z.number(), login: z.string() }).passthrough() }).passthrough();
export type ReviewProof = z.infer<typeof proofSchema>;
export type PrReaction = z.infer<typeof reactionSchema>;

export function codexReactionApproval(proof: ReviewProof, head: string, reactions: PrReaction[]) {
  if (head !== proof.head) return { approved: false, head, reason: 'PR head changed; record the new review head' };
  const reaction = reactions.find(r => r.content === '+1'
    && r.user.id === 199175422 && r.user.login === 'chatgpt-codex-connector[bot]'
    && !proof.existingReactionIds.includes(r.id)
    && Date.parse(r.created_at) >= Date.parse(proof.observedAt));
  return reaction ? { approved: true, head, reactionId: reaction.id, reason: 'Codex added a new PR-body thumbs-up during this recorded head review' }
    : { approved: false, head, reason: 'No fresh Codex PR-body thumbs-up for the recorded head' };
}

async function github(path: string, paginate = false): Promise<unknown> {
  const { stdout } = await exec('gh', ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])], { timeout: 30_000, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}
async function headFor(repository: string, number: number) {
  return z.object({ state: z.literal('open'), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }).passthrough().parse(await github(`repos/${repository}/pulls/${number}`)).head.sha;
}
async function reactionsFor(repository: string, number: number) {
  return z.array(z.array(reactionSchema)).parse(await github(`repos/${repository}/issues/${number}/reactions?per_page=100`, true)).flat();
}

// Records/checks authorization evidence only. CI, review findings, human validation,
// and the final --match-head-commit guard remain the factory's responsibility.
export async function codexApprovalCommand(mode: 'approval-record' | 'approval-check', repository: string, numberText: string, file: string) {
  z.string().regex(/^[\w-][\w.-]*\/[\w-][\w.-]*$/).parse(repository);
  const number = z.coerce.number().int().positive().parse(numberText);
  const observedAt = new Date().toISOString();
  const head = await headFor(repository, number);
  const previous = existsSync(file) ? proofSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
  if (previous && (previous.repository !== repository || previous.number !== number)) throw new Error('Review proof belongs to another PR');
  if (mode === 'approval-record' && previous?.head === head) return { recorded: true, head, observedAt: previous.observedAt };
  if (mode === 'approval-check' && !previous) return { approved: false, head, reason: 'No recorded review head; explicit user approval is required' };
  const reactions = await reactionsFor(repository, number);
  if (await headFor(repository, number) !== head) throw new Error('PR head changed while collecting approval evidence');
  if (mode === 'approval-check') return codexReactionApproval(previous!, head, reactions);
  const proof: ReviewProof = { repository, number, head, observedAt, existingReactionIds: reactions.map(r => r.id) };
  writeFileSync(`${file}.tmp`, JSON.stringify(proof) + '\n', { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  return { recorded: true, head, observedAt };
}
