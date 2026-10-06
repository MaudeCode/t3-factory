// Synthetic T3 orchestration protocol v2 shell data. No live thread or user data.
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
