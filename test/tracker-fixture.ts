import type { TestContext } from 'node:test';
import { Kanvil, KanvilTaskNotFound, taskSchema, type Task } from '../src/clients.ts';

// Scheduler scenarios share an in-memory tracker boundary. HTTP/SSE contracts are tested separately.
export function mockTracker(t: TestContext, target: Kanvil, read: (name: string, args: any) => Promise<any>) {
  const task = (row: any, labels = row?.labels ?? []): Task => taskSchema.parse({
    readiness: { ready: true, reasons: [] }, difficulty: labels.find((l: any) => ['low', 'med', 'high'].includes(l.name))?.name ?? null,
    automationReady: true, holdReason: null, archived: false, parentId: null, ...row, labels,
  });
  const labels = async () => {
    const rows = await read('labels', {});
    return new Map<string, { name: string }[]>(rows.filter((r: any) => r.taskId && !r.deletionStartedAt).map((r: any) => [r.taskId, rows.filter((l: any) => l.taskId === r.taskId && !l.deletionStartedAt).map((l: any) => ({ name: l.name }))]));
  };
  t.mock.method(target, 'subscribe', async (_onChange: unknown, signal: AbortSignal) => { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
  t.mock.method(target, 'task', async (id: string, projectId?: string) => {
    const row = await read(/^[A-Z0-9]+-\d+$/.test(id) ? 'ticketByKey' : 'ticket', /^[A-Z0-9]+-\d+$/.test(id) ? { ticketId: id, projectId: projectId ?? id.split('-')[0] } : { taskId: id });
    let associated: Map<string, {name: string}[]> | undefined;
    try { associated = await labels(); } catch (error) { if (!row?.labels) throw error; }
    return task(row, associated?.get(row.id) ?? row.labels ?? []);
  });
  t.mock.method(target, 'tasks', async (projectId: string, statuses?: string[]) => {
    const associated = await labels(), rows: Task[] = [];
    for (const status of statuses?.length ? statuses : [undefined]) {
      let page = 1, totalPages = 1;
      do {
        const result = await read('tickets', { projectId, status, page, limit: 100 });
        for (const row of result.data.columns.flatMap((c: any) => c.tasks)) rows.push(task(row, associated.get(row.id) ?? row.labels ?? []));
        totalPages = result.pagination.totalPages;
        page++;
      } while (page <= totalPages);
    }
    return [...new Map(rows.map(row => [row.id, row])).values()];
  });
  if ('findTask' in target) t.mock.method(target, 'findTask', async (key: string, projectId: string) => {
    const row = (await target.tasks(projectId)).find(row => row.number === Number(key.split('-').at(-1)));
    if (!row) throw new KanvilTaskNotFound('Fixture ticket not found');
    return row;
  });
  t.mock.method(target, 'eligibleTask', async (row: Task) => row);
  t.mock.method(target, 'relations', (id: string) => read('relations', { taskId: id }));
  t.mock.method(target, 'columns', (projectId: string) => read('columns', { projectId }));
  t.mock.method(target, 'projects', () => read('projects', {}));
}
