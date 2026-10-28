import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readContext, waitFor } from './read-context.ts';

const exec = promisify(execFile);
export const pullRequestsSchema = z.array(z.object({ title: z.string(), headRefName: z.string(), body: z.string() }));
const pageSchema = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ repository: z.object({ pullRequests: z.object({ nodes: pullRequestsSchema, pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }) }) });
const query = 'query($owner:String!,$repo:String!,$cursor:String){repository(owner:$owner,name:$repo){pullRequests(states:OPEN,first:100,after:$cursor){nodes{title headRefName body}pageInfo{hasNextPage endCursor}}}}';

/** The service owns one authenticated HTTP session; standalone commands retain the CLI path. */
export class GitHub {
  private credential?: Promise<string>;
  private readonly abort = new AbortController();
  private readonly token: (signal?: AbortSignal) => Promise<string>;
  private readonly request: typeof fetch;
  private readonly endpoint: string;
  constructor(token: (signal?: AbortSignal) => Promise<string> = async signal => {
    const { stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, signal });
    return stdout.trim();
  }, request: typeof fetch = (...args) => fetch(...args), endpoint = 'https://api.github.com/graphql') { this.token = token; this.request = request; this.endpoint = endpoint; }
  private connect() {
    this.abort.signal.throwIfAborted();
    if (!this.credential) {
      const pending = this.token(this.abort.signal).then(value => { if (!value.trim()) throw new Error('GitHub authentication returned no credential'); return value.trim(); });
      this.credential = pending;
      void pending.catch(() => { if (this.credential === pending) this.credential = undefined; });
    }
    return this.credential;
  }
  close() { this.abort.abort(new Error('GitHub client closed')); this.credential = undefined; }
  async pullRequests(repository: string, signal = readContext()?.signal) {
    this.abort.signal.throwIfAborted();
    const [owner, repo, extra] = repository.split('/');
    if (!owner || !repo || extra) throw new Error('Invalid GitHub repository');
    const stop = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000), ...signal ? [signal] : []]);
    const rows: z.infer<typeof pullRequestsSchema> = [], cursors = new Set<string>(); let cursor: string | null = null;
    for (;;) {
      let response: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        const credential = this.connect(), token = await waitFor(credential, stop);
        response = await this.request(this.endpoint, { method: 'POST', redirect: 'error', signal: stop, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 't3-factory' }, body: JSON.stringify({ query, variables: { owner, repo, cursor } }) });
        if (response.status !== 401 || attempt) break;
        await response.body?.cancel();
        if (this.credential === credential) this.credential = undefined; // A sibling may already be refreshing it.
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub pull request read returned HTTP ${response.status}`); }
      const payload = pageSchema.parse(await response.json());
      if (payload.errors?.length) throw new Error('GitHub pull request query returned partial or failed data');
      const page: z.infer<typeof pageSchema>['data']['repository']['pullRequests'] = payload.data.repository.pullRequests;
      rows.push(...page.nodes);
      if (rows.length > 1000 || page.pageInfo.hasNextPage && rows.length >= 1000) throw new Error('GitHub pull request inventory exceeds its verified limit');
      if (!page.pageInfo.hasNextPage) return rows;
      const next: string | null = page.pageInfo.endCursor;
      if (!next || cursors.has(next) || !page.nodes.length) throw new Error('GitHub returned an invalid pull request cursor');
      cursors.add(next); cursor = next;
    }
  }
}
