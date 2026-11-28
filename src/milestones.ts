// T3's outside-client MCP Events contract. The web process owns the callback and its leases.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { jobLabel, type Store } from './store.ts';
import { milestoneGrant } from './milestone-login.ts';
import type { Config } from './config.ts';

export const hookPath = '/api/t3/milestones';
const names = ['thread.needs_input', 'thread.input_resolved', 'thread.run_settled', 'pr.watch_wake'] as const;
const id = z.string().min(1).max(2048);
const input = z.object({ requestId: id, kind: z.enum(['user_input', 'approval']) });
const data = z.discriminatedUnion('type', [
  input.extend({ type: z.literal('thread.needs_input') }),
  input.extend({ type: z.literal('thread.input_resolved'), resolution: z.enum(['resolved', 'expired', 'cancelled']) }),
  z.object({ type: z.literal('thread.run_settled'), outcome: z.enum(['completed', 'failed', 'interrupted', 'cancelled']), runId: id }),
  z.object({ type: z.literal('pr.watch_wake'), summary: z.string(), outcome: z.enum(['completed', 'failed', 'cancelled', 'updated', 'unknown']), watchEnded: z.boolean(), pullRequests: z.array(z.object({ repository: id, host: id, number: z.number().int().positive() })) }),
]).and(z.object({ id, threadId: id, projectId: id, occurredAt: z.iso.datetime({ offset: true }) }));
const envelope = z.object({ name: z.enum(names), cursor: id, data });
const cursorKey = (name: string) => 'milestoneCursor:' + name;

export function milestoneHooks(store: Store, config: () => Config, publicOrigin: string) {
  let saved;
  try { saved = milestoneGrant(config()); }
  catch {
    console.warn('Factory milestone grant is invalid for this T3 environment; run milestone-login and restart the web service');
    return;
  }
  if (!saved) return;
  const { token, secret, origin } = saved;
  const key = Buffer.from(secret.slice(6), 'base64');
  const delivery = { mode: 'webhook', url: new URL(hookPath, publicOrigin).href, secret };

  function receive(headers: IncomingHttpHeaders, raw: Buffer) {
    const msg = headers['webhook-id'], stamp = headers['webhook-timestamp'], signatures = headers['webhook-signature'];
    if (typeof msg !== 'string' || !msg || typeof stamp !== 'string' || typeof signatures !== 'string' ||
        !/^\d+$/.test(stamp) || Math.abs(Date.now() / 1000 - Number(stamp)) > 300) return { status: 401 };
    const expected = createHmac('sha256', key).update(msg + '.' + stamp + '.').update(raw).digest();
    if (!signatures.split(' ').some(s => {
      if (!s.startsWith('v1,')) return false;
      const supplied = Buffer.from(s.slice(3), 'base64');
      return supplied.length === expected.length && timingSafeEqual(expected, supplied);
    })) return { status: 401 };
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return { status: 400 }; }
    if (body?.type === 'verification' && typeof body.challenge === 'string') return { status: 200, body: { challenge: body.challenge } };
    if (body?.type === 'gap' || body?.type === 'terminated') {
      console.warn('T3 milestone subscription reported', body.type);
      return { status: 204 };
    }
    const parsed = envelope.safeParse(body);
    if (!parsed.success || parsed.data.name !== parsed.data.data.type) return { status: 400 };
    const { data: event, cursor } = parsed.data;
    const current = config();
    if (new URL(current.t3.url).origin !== origin) return { status: 410 };
    const job = store.jobForThread(event.threadId);
    if (job && current.projects.some(p => p.kanvilId === job.projectId && p.t3Id === event.projectId)) {
      if (event.type === 'thread.needs_input') {
        store.recordInput(job, event.requestId, event.kind, event.occurredAt, event.id);
      } else {
        let text: string;
        switch (event.type) {
          case 'thread.input_resolved': text = (event.kind === 'approval' ? 'approval ' : 'question ') + event.resolution; break;
          case 'thread.run_settled': text = 'turn ' + event.outcome; break;
          case 'pr.watch_wake': text = 'woke for ' + event.pullRequests.map(p => p.repository + '#' + p.number).join(', ') + ' — ' + event.summary; break;
        }
        store.record(event.type, jobLabel(job) + ' ' + text, { ...event, projectId: job.projectId, ticketKey: job.ticketKey, milestoneId: event.id }, job.id, event.occurredAt);
      }
    }
    store.set(cursorKey(event.type), cursor);
    return { status: 204 };
  }

  async function follow(signal: AbortSignal) {
    // Each event type has its own lease and cursor. A failed renewal cannot starve another type.
    await Promise.all(names.map(async name => {
      while (!signal.aborted) {
        let next = 30_000;
        try {
          const c = config(), endpoint = new URL('/mcp', c.t3.url);
          if (endpoint.origin !== origin) throw new Error('T3 origin changed; run milestone-login');
          const params = {
            name, arguments: { projectIds: [...new Set(c.projects.map(p => p.t3Id))].sort() },
            cursor: store.get(cursorKey(name)) ?? null, ttlMs: 900_000, delivery,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } },
              'io.modelcontextprotocol/clientInfo': { name: 't3-factory', version: '1' },
            },
          };
          const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-name': name, 'mcp-method': 'events/subscribe', 'mcp-protocol-version': '2026-07-28' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params }) });
          if (!response.ok) throw new Error('MCP returned HTTP ' + response.status);
          const { result } = await response.json();
          if (!result?.id || !Number.isFinite(Date.parse(result.refreshBefore))) throw new Error('MCP declined the milestone subscription');
          if (!store.get(cursorKey(name)) && typeof result.cursor === 'string') store.set(cursorKey(name), result.cursor);
          if (result.truncated) console.warn('T3 milestone history has a gap for', name);
          next = Math.max(1000, Math.min(600_000, (Date.parse(result.refreshBefore) - Date.now()) / 2));
        } catch (error) {
          if (!signal.aborted) console.warn('T3 milestone subscription failed', name, error instanceof Error ? error.message : 'unknown failure');
        }
        await delay(next, undefined, { signal }).catch(() => {});
      }
    }));
  }
  return { receive, follow };
}
