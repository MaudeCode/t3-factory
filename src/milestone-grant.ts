import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as oauth from 'openid-client';
import { z } from 'zod';
import type { Config } from './config.ts';
import { T3 } from './clients.ts';

const grant = z.object({ origin: z.url(), token: z.string().min(1), secret: z.string().regex(/^whsec_[A-Za-z0-9+/]{43}=$/), expiresAt: z.number().optional() });
const file = (config: Config) => join(config.stateDir, 'milestone-grant.json');
export function milestoneGrant(config: Config) {
  if (!existsSync(file(config))) return;
  const saved = grant.parse(JSON.parse(readFileSync(file(config), 'utf8')));
  if (saved.origin === new URL(config.t3.url).origin) return saved;
}

// T3 authorizes pairing-token issuance against the configured session's access:write and delegated scopes.
export async function provisionGrant(config: Config, signal: AbortSignal, previousSecret?: string) {
  const issuer = new URL(new URL(config.t3.url).origin);
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)))
    throw new Error('T3 OAuth requires HTTPS or loopback HTTP');
  const resource = new URL('/mcp', issuer).href;
  // T3 returns this redirect in the decision response. The service never opens a browser or a listener.
  const redirect = 'http://127.0.0.1/factory-milestones';
  const client = await oauth.dynamicClientRegistration(issuer, {
    client_name: 'T3 Factory milestones', redirect_uris: [redirect], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none',
  }, oauth.None(), { algorithm: 'oauth2', timeout: 15, execute: issuer.protocol === 'http:' ? [oauth.allowInsecureRequests] : [] });
  signal.throwIfAborted();
  const t3 = new T3(config.t3);
  let pairing;
  try {
    pairing = z.object({ credential: z.string().min(1), access: z.literal('read-only') }).parse(
      await t3.request('/api/auth/pairing-token', { label: 'T3 Factory milestones', access: 'read-only' }));
  } finally { await t3.close(); }
  const verifier = oauth.randomPKCECodeVerifier(), state = oauth.randomState();
  const authorize = oauth.buildAuthorizationUrl(client, { redirect_uri: redirect, response_type: 'code', state, resource,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
  const response = await fetch(new URL('/oauth/mcp/decision', issuer), {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorization: Object.fromEntries(authorize.searchParams), decision: { _tag: 'pairing-code', access: 'read-only', code: pairing.credential } }),
  });
  if (!response.ok) throw new Error('T3 refused read-only MCP approval (HTTP ' + response.status + ')');
  const callback = new URL((await response.json()).redirectTo);
  if (callback.origin + callback.pathname !== redirect) throw new Error('T3 returned an unexpected approval redirect');
  const tokens = await oauth.authorizationCodeGrant(client, callback, { pkceCodeVerifier: verifier, expectedState: state }, { resource });
  if (tokens.scope !== 'orchestration:read' || !tokens.expires_in) throw new Error('T3 did not return an expiring read-only grant');
  signal.throwIfAborted();
  const saved = { origin: issuer.origin, token: tokens.access_token, secret: previousSecret ?? ('whsec_' + randomBytes(32).toString('base64')), expiresAt: Date.now() + tokens.expires_in * 1000 };
  const tmp = file(config) + '.' + randomUUID();
  writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file(config));
  return saved;
}
