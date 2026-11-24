import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
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
  if ('epics' in target) t.mock.method(target as any, 'epics', async () => []);
}

export const ticket = (extra: Record<string, unknown> = {}) => ({
  id: 'ticket', projectId: 'project', key: 'APP-1', number: 1, title: 'Fixture', description: 'Problem', acceptanceCriteria: 'Works',
  status: 'todo', priority: 'none', createdAt: '2026-01-01T00:00:00Z', version: 1,
  labels: ['sec', 'high', 'app', 'web', 'contracts', 'sf'], difficulty: 'high', automationReady: true,
  holdReason: null, archived: false, parentId: null, ...extra,
});
export const snapshot = (tickets = [ticket()], cursor = '5') => ({ project: { id: 'project', workspaceId: 'workspace', name: 'Fixture', key: 'APP' }, tickets, cursor });
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const turn = () => new Promise<void>(resolve => setImmediate(resolve));
export async function until(predicate: () => boolean) { for (let n = 0; n < 100; n++) { if (predicate()) return; await turn(); } assert.fail('fixture condition did not settle'); }
// A real Kanvil client over a fetch that records each request; project-scoped feeds connect at once unless `scoped`.
export function fixture(t: TestContext, read: (url: URL, init?: RequestInit) => Response | Promise<Response>, scoped = false) {
  const old = process.env.KANVIL_API_KEY; process.env.KANVIL_API_KEY = 'fixture-secret';
  t.after(() => { if (old === undefined) delete process.env.KANVIL_API_KEY; else process.env.KANVIL_API_KEY = old; });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input); calls.push(url.pathname + url.search);
    assert.equal(url.origin, 'https://tracker.example.test');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret');
    assert.equal(init?.redirect, 'error');
    if (url.pathname === '/api/v1/projects/project') return json({ id: 'project', workspaceId: 'workspace', key: 'APP', name: 'Fixture' });
    if (!scoped && url.pathname.endsWith('/events') && url.searchParams.has('projectId')) return new Response(new ReadableStream<Uint8Array>({ start(c) {
      const cursor = url.searchParams.get('cursor') ?? '0';
      c.enqueue(new TextEncoder().encode(`event: checkpoint\nid: ${cursor}\ndata: ${JSON.stringify({cursor})}\n\n`));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    return read(url, init);
  });
  const client = new Kanvil({ url: 'https://tracker.example.test', workspaceId: 'workspace' });
  t.after(() => client.close());
  return { client, calls };
}
