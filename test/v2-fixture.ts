// Synthetic T3 orchestration protocol v2 shell data. No live thread or user data.
import { z } from 'zod';
import type { Thread } from '../src/policy.ts';

export function v2Thread(overrides: Record<string, unknown> = {}): Thread {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    createdBy: 'user', creationSource: 'web',
    id: 'thread-1', projectId: 'project-1', title: 'Fixture thread',
    providerInstanceId: 'claudeAgent', modelSelection: { instanceId: 'claudeAgent', model: 'claude-fixture' },
    runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
    lineage: { rootThreadId: 'thread-1', parentThreadId: null }, forkedFrom: null, activeProviderThreadId: null,
    latestRunId: 'run-1', latestRunRequestedAt: at, latestRunStartedAt: at, latestRunCompletedAt: at,
    activeRunId: null, activityRunStartedAt: null, activityRunStatus: null,
    status: 'completed', lastError: null, lastErrorClass: null,
    pendingRuntimeRequest: null, latestVisibleMessage: null, latestUserMessageAt: at, latestUserAuthoredMessageAt: at,
    hasActionableProposedPlan: false, pendingBackgroundTasks: [], providerInstanceHistory: ['claudeAgent'],
    itemCount: 2, visibleItemCount: 2, createdAt: at, updatedAt: at, archivedAt: null,
    settledOverride: null, settledAt: null, unsettledAt: null, deletedAt: null,
    ...overrides,
  } as Thread;
}

export function v2Shell(threads: Thread[] = [v2Thread()]) {
  return {
    schemaVersion: 2, snapshotSequence: 42, threads, archivedThreads: [],
    projects: [{ id: 'project-1', title: 'Fixture project', workspaceRoot: '/tmp/fixture-repo' }],
  };
}

// Public stop command subset, checked at the fake server boundary rather than by a dispatch spy.
export const publicStopCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.interrupt'), commandId: z.uuid(), threadId: z.string().min(1), runId: z.string().min(1), holdQueue: z.literal(true), reason: z.string().optional() }).strict(),
  z.object({ type: z.literal('thread.pull-request.watch'), commandId: z.uuid(), threadId: z.string().min(1), host: z.string().min(1), repository: z.string().min(1), number: z.number().int().positive(), watching: z.literal(false) }).strict(),
]);

// Minimal bounded control state for stop tests; callers supply run rows when work owns a run.
export function v2Projection(thread: Thread, extra: Record<string, unknown> = {}) {
  return {
    thread: { ...thread, pullRequests: thread.pendingBackgroundTasks.filter(t => t.kind === 'monitor').map((_, i) => ({ host: 'github.com', repository: 'fixture/repo', number: i + 1, source: 'explicit', watch: {} })) },
    runs: [], providerThreads: [], turnItems: [], subagents: [], messages: [], runtimeRequests: [], ...extra,
  };
}
