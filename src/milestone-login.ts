import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as oauth from 'openid-client';
import { z } from 'zod';
import type { Config } from './config.ts';

const grant = z.object({ origin: z.url(), token: z.string().min(1), secret: z.string().regex(/^whsec_[A-Za-z0-9+/]{43}=$/) });
const file = (config: Config) => join(config.stateDir, 'milestone-grant.json');
export function milestoneGrant(config: Config) {
  if (!existsSync(file(config))) return;
  const saved = grant.parse(JSON.parse(readFileSync(file(config), 'utf8')));
  if (saved.origin !== new URL(config.t3.url).origin) throw new Error('T3 origin changed; run milestone-login for the new environment');
  return saved;
}

// T3 registers outside clients dynamically and returns the approved grant to a loopback callback.
export async function milestoneLogin(config: Config) {
  const issuer = new URL(new URL(config.t3.url).origin);
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)))
    throw new Error('T3 OAuth requires HTTPS or loopback HTTP');
  const state = oauth.randomState(), verifier = oauth.randomPKCECodeVerifier(), resource = new URL('/mcp', issuer).href;
  const server = createServer();
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing callback port');
    const redirect = 'http://127.0.0.1:' + address.port + '/callback';
    const client = await oauth.dynamicClientRegistration(issuer, {
      client_name: 'T3 Factory milestones', redirect_uris: [redirect], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none',
    }, oauth.None(), { algorithm: 'oauth2', timeout: 15, execute: issuer.protocol === 'http:' ? [oauth.allowInsecureRequests] : [] });
    const authorize = oauth.buildAuthorizationUrl(client, { redirect_uri: redirect, response_type: 'code', state, resource, scope: 'orchestration:read',
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
    const callback = Promise.withResolvers<URL>();
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirect);
      if (req.method !== 'GET' || url.origin + url.pathname !== redirect || url.searchParams.get('state') !== state) {
        res.writeHead(400).end(); return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Return to the Factory terminal to finish.');
      callback.resolve(url);
    });
    const timeout = setTimeout(() => callback.reject(new Error('Factory sign-in expired')), 300_000);
    try {
      console.log('Open this address on this computer to approve read access:\n' + authorize.href);
      const tokens = await oauth.authorizationCodeGrant(client, await callback.promise, { pkceCodeVerifier: verifier, expectedState: state }, { resource, redirect_uri: redirect });
      const secret = 'whsec_' + randomBytes(32).toString('base64');
      mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      const tmp = file(config) + '.' + randomUUID();
      writeFileSync(tmp, JSON.stringify({ origin: issuer.origin, token: tokens.access_token, secret }), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file(config));
      console.log('Milestone access saved. Restart the Factory web service to subscribe.');
    } finally { clearTimeout(timeout); }
  } finally { server.closeAllConnections(); server.close(); }
}
