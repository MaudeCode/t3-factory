import { z } from 'zod';
import { taskSchema, type Task } from './clients.ts';

const sourceSchema = z.object({ key: z.string().regex(/^[A-Z0-9]+-\d+$/), taskId: z.string().regex(/^[\w-]+$/), createdAt: z.iso.datetime() });

// Shared importer evidence: migration and historical collection must agree on identity and creation time.
export function importedTicketSource(ticket: Task) {
  const matches = [...(ticket.description ?? '').matchAll(/\n---\nKaneo source: ([A-Z0-9]+-\d+)\nSource task ID: ([^\n]+)\nSource created: ([^\n]+)/g)];
  if (!matches.length) {
    if (/\n---\nKaneo source:/.test(ticket.description ?? '')) throw new Error('Malformed Kaneo import identity');
    return null;
  }
  if (matches.length !== 1) throw new Error('Ambiguous Kaneo import identity');
  const source = sourceSchema.safeParse({ key: matches[0]![1], taskId: matches[0]![2], createdAt: matches[0]![3] });
  if (!source.success) throw new Error('Malformed Kaneo import identity');
  return source.data;
}

export function importedTickets(tickets: Task[]) {
  const ids = new Map<string, Task>();
  for (const ticket of tickets) {
    const source = importedTicketSource(ticket);
    if (!source) continue;
    if (ids.has(source.taskId)) throw new Error('Ambiguous Kaneo import identity');
    ids.set(source.taskId, taskSchema.parse(ticket));
  }
  return ids;
}
