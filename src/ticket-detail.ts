// One ticket as the web app shows it: an allowlisted read from the tracker, never a write.
import { KanvilTaskNotFound, type Kanvil, type Task } from './clients.ts';
import type { Config } from './config.ts';

type Reader = Pick<Kanvil, 'task' | 'relations' | 'epics'>;
const closed = (status: string) => status === 'done' || status === 'cancelled';
const brief = (task: Task) => ({ key: task.key ?? task.id, title: task.title, done: closed(task.status) });

// Null when the key is malformed, names a project Factory is not configured for, or the tracker has no such ticket.
// An inbox has no key in the config, so a key outside the delivery projects is resolved by the tracker and kept
// only when it lands in a configured inbox.
// Only the fields below leave the scheduler; tracker rows carry more than a browser needs.
export async function ticketDetail(c: Pick<Config, 'projects' | 'kanvil'>, kanvil: Reader, key: string) {
  const match = /^([A-Z0-9]+)-\d{1,9}$/.exec(key.toUpperCase());
  if (!match) return null;
  const project = c.projects.find(p => p.key === match[1]), inboxes = c.projects.flatMap(p => p.inbox ? [p.inbox.kanvilId] : []);
  if (!project && !inboxes.length) return null;
  let task: Task;
  try { task = await kanvil.task(match[0], project?.kanvilId); }
  catch (error) { if (error instanceof KanvilTaskNotFound) return null; throw error; }
  const inbox = !project && inboxes.includes(task.projectId);
  if (!project && !inbox) return null;
  // A related ticket Factory cannot read, or one in a project it is not configured for, is left out rather than
  // failing the whole read or naming work outside its projects.
  const configured = (t: Task) => c.projects.some(p => p.kanvilId === t.projectId);
  const related = async (id: string) => { try { const t = await kanvil.task(id, undefined, true); return configured(t) ? brief(t) : null; } catch { return null; } };
  const edges = (await kanvil.relations(task.id, true, false, task)).filter(r => r.relationType === 'blocks');
  const [blockedBy, blocks, epics] = await Promise.all([
    Promise.all(edges.filter(r => r.targetTaskId === task.id).map(r => related(r.sourceTaskId))),
    Promise.all(edges.filter(r => r.sourceTaskId === task.id).map(r => related(r.targetTaskId))),
    task.epicId ? kanvil.epics().catch(() => []) : [],
  ]);
  return {
    id: task.id, projectId: task.projectId, inbox, key: task.key ?? match[0], title: task.title, status: task.status, priority: task.priority,
    difficulty: task.difficulty ?? null, kind: task.kind ?? null, labels: (task.labels ?? []).map(l => l.name), scopes: task.scopes ?? [],
    description: task.description ?? '', acceptanceCriteria: typeof task.acceptanceCriteria === 'string' ? task.acceptanceCriteria : '',
    automationReady: task.automationReady ?? false, holdReason: task.holdReason ?? null, readiness: (task.readiness?.reasons ?? []).map(r => r.message),
    blockedBy: blockedBy.filter(t => t !== null), blocks: blocks.filter(t => t !== null),
    epic: epics.find(e => e.id === task.epicId)?.title ?? null, createdAt: task.createdAt,
    url: `${c.kanvil.url.replace(/\/$/, '')}/projects/${encodeURIComponent(task.projectId)}/tickets/${encodeURIComponent(task.id)}`,
  };
}
