import type { Config } from './config.ts';
import type { FactoryEvent, Store } from './store.ts';
import { log, safeError } from './scheduler.ts';

// The body of Cowtail's POST /api/items: a source token sets the source, so the item does not name one.
export interface CowtailItem {
  kind: 'question' | 'done'; urgency: 'today' | 'whenever'; title: string; body?: string;
  links?: { label: string; url: string }[]; dedupeKey: string; context?: Record<string, string>;
}
export interface CowtailSettings { url: string; token: string }

// Config validation requires both settings or neither.
export function cowtailSettings(c: Pick<Config, 'cowtail'>, token = process.env.COWTAIL_TOKEN?.trim()): CowtailSettings | undefined {
  return c.cowtail && token ? { url: c.cowtail.url, token } : undefined;
}

const prLinks = (urls: string[]) => urls.map(url => ({ label: url.replace(/^https:\/\/github\.com\//, ''), url }));

// The journal events that reach the owner's phone: a run that needs them, a run that delivered PRs, and a finished
// Epic, chain or queued run. Every other event posts nothing.
export function cowtailItem(event: FactoryEvent, prUrls: (jobId: string) => string[]): CowtailItem | undefined {
  const { state, reason, ticketKey, projectId } = event.data, id = event.jobId ?? event.data.planId;
  let item: Pick<CowtailItem, 'kind' | 'urgency' | 'links'> | undefined;
  if (event.kind === 'job.state' && event.jobId && state === 'waiting') item = { kind: 'question', urgency: 'today', links: prLinks(prUrls(event.jobId)) };
  else if (event.kind === 'job.state' && event.jobId && state === 'complete') {
    const urls = prUrls(event.jobId);
    if (urls.length) item = { kind: 'done', urgency: 'whenever', links: prLinks(urls) };
  } else if (event.kind === 'plan.state' && state === 'done' && event.text.endsWith('finished')) item = { kind: 'done', urgency: 'today' };
  if (!item || typeof id !== 'string') return undefined;
  const context = Object.fromEntries(Object.entries({ ticketKey, projectId }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]));
  return {
    kind: item.kind, urgency: item.urgency, title: event.text.slice(0, 500),
    ...typeof reason === 'string' && reason ? { body: reason.slice(0, 20_000) } : {},
    ...item.links?.length ? { links: item.links.slice(0, 20) } : {},
    dedupeKey: `t3-factory:${event.kind}:${id}:${state}`,
    ...Object.keys(context).length ? { context } : {},
  };
}

// Posts mapped journal events to Cowtail without waiting: a slow or failing Cowtail never holds up or fails a store write.
export class CowtailNotifier {
  private readonly store: Store;
  private readonly settings: () => CowtailSettings | undefined;
  private readonly request: typeof fetch;
  constructor(store: Store, settings: () => CowtailSettings | undefined, request: typeof fetch = (...args) => fetch(...args)) {
    this.store = store; this.settings = settings; this.request = request;
  }
  readonly notify = (event: FactoryEvent) => {
    const settings = this.settings();
    if (!settings) return;
    const item = cowtailItem(event, jobId => this.store.job(jobId)?.prUrls ?? []);
    if (item) void this.send(settings, item);
  };
  private async send({ url, token }: CowtailSettings, item: CowtailItem) {
    try {
      const response = await this.request(new URL('/api/items', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 't3-factory' }, body: JSON.stringify(item),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Cowtail item post returned HTTP ${response.status}`);
    } catch (error) {
      log('cowtail-error', { dedupeKey: item.dedupeKey, message: safeError(error) });
    }
  }
}
