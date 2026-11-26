import type { Config } from './config.ts';
import type { FactoryEvent, Store } from './store.ts';
import { log, safeError, UNCONFIRMED_LAUNCH } from './scheduler.ts';

// The body of Cowtail's POST /api/items: a source token sets the source, so the item does not name one.
export interface CowtailItem {
  kind: 'alert' | 'failure' | 'approval' | 'question' | 'fyi' | 'done'; urgency: 'now' | 'today' | 'whenever'; title: string; body?: string;
  links?: { label: string; url: string }[]; dedupeKey: string; context?: Record<string, string>;
}
export type CowtailEvents = NonNullable<Config['cowtail']>['events'];
export interface CowtailSettings { url: string; token: string; events: CowtailEvents }
export type CowtailOutcome = { ok: true } | { ok: false; status?: number; message: string } | { ok: false; reason: 'not-configured' };

// Config validation requires both settings or neither.
export function cowtailSettings(c: Pick<Config, 'cowtail'>, token = process.env.COWTAIL_TOKEN?.trim()): CowtailSettings | undefined {
  return c.cowtail && token ? { url: c.cowtail.url, token, events: c.cowtail.events } : undefined;
}

const prLinks = (urls: string[]) => urls.map(url => ({ label: url.replace(/^https:\/\/github\.com\//, ''), url }));

// Each setting in cowtail.events, with the fixed kind of the items it covers. The setting picks their urgency or turns them off.
const KINDS = { needsYou: 'question', failed: 'failure', quotaHold: 'fyi', noPr: 'done', finished: 'done' } as const satisfies Record<keyof CowtailEvents, CowtailItem['kind']>;

// The journal events that reach the owner's phone and the setting each one belongs to. Every other event posts nothing.
function eventSetting(event: FactoryEvent, urls: string[]): { key: keyof CowtailEvents; title?: string; body?: string } | undefined {
  const { state, reason, stage, message } = event.data;
  if (event.kind === 'job.state' && event.jobId) {
    if (state === 'waiting') return { key: 'needsYou' };
    if (state === 'complete') return urls.length ? { key: 'finished' } : { key: 'noPr', title: `${event.text} without a PR` };
    if (state === 'dismissed' && reason === UNCONFIRMED_LAUNCH) return { key: 'failed' };
  }
  if (event.kind === 'dispatch.failed') return { key: 'failed', body: `${stage}: ${message}` };
  if (event.kind === 'quota.hold') return { key: 'quotaHold' };
  if (event.kind === 'plan.state' && state === 'done' && event.text.endsWith('finished')) return { key: 'finished' };
}

export function cowtailItem(event: FactoryEvent, prUrls: (jobId: string) => string[], events: CowtailEvents): CowtailItem | undefined {
  const { state, reason, ticketKey, projectId } = event.data, id = event.jobId ?? event.data.planId ?? event.data.requestId ?? event.data.holdId;
  const urls = event.jobId ? prUrls(event.jobId) : [], setting = eventSetting(event, urls), urgency = setting && events[setting.key];
  if (!setting || !urgency || urgency === 'off' || typeof id !== 'string') return undefined;
  const body = setting.body ?? reason;
  const context = Object.fromEntries(Object.entries({ ticketKey, projectId }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]));
  return {
    kind: KINDS[setting.key], urgency, title: (setting.title ?? event.text).slice(0, 500),
    ...typeof body === 'string' && body ? { body: body.slice(0, 20_000) } : {},
    ...urls.length ? { links: prLinks(urls).slice(0, 20) } : {},
    dedupeKey: `t3-factory:${event.kind}:${id}:${state}`,
    ...Object.keys(context).length ? { context } : {},
  };
}

// Posts mapped journal events to Cowtail without waiting: a slow or failing Cowtail never holds up or fails a store write.
export class CowtailNotifier {
  private readonly store: Pick<Store, 'job'>;
  private readonly settings: () => CowtailSettings | undefined;
  private readonly request: typeof fetch;
  constructor(store: Pick<Store, 'job'>, settings: () => CowtailSettings | undefined, request: typeof fetch = (...args) => fetch(...args)) {
    this.store = store; this.settings = settings; this.request = request;
  }
  readonly notify = (event: FactoryEvent) => {
    const settings = this.settings();
    if (!settings) return;
    const item = cowtailItem(event, jobId => this.store.job(jobId)?.prUrls ?? [], settings.events);
    if (item) void this.post(settings, item).then(outcome => { if (!outcome.ok) log('cowtail-error', { dedupeKey: item.dedupeKey, message: outcome.message }); });
  };
  // The owner's check from Settings: pushes at once and ignores the per-event settings.
  readonly test = async (): Promise<CowtailOutcome> => {
    const settings = this.settings();
    if (!settings) return { ok: false, reason: 'not-configured' };
    const at = new Date().toISOString();
    return this.post(settings, { kind: 'fyi', urgency: 'now', title: 'Test notification from t3 Factory', dedupeKey: `t3-factory:test:${at}` });
  };
  private async post({ url, token }: CowtailSettings, item: CowtailItem): Promise<{ ok: true } | { ok: false; status?: number; message: string }> {
    try {
      const response = await this.request(new URL('/api/items', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 't3-factory' }, body: JSON.stringify(item),
      });
      await response.body?.cancel();
      return response.ok ? { ok: true } : { ok: false, status: response.status, message: `Cowtail item post returned HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, message: safeError(error) };
    }
  }
}
