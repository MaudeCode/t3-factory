import * as client from "openid-client";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

export const oidcSchema = z.object({
  issuer: z
    .url()
    .refine(
      (v) => new URL(v).protocol === "https:",
      "OIDC issuer must use HTTPS",
    ),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  requiredGroup: z.string().min(1),
  sessionHours: z.coerce.number().positive().max(720).default(24),
  recheckSeconds: z.coerce.number().int().min(1).max(300).default(60),
});
export type OidcSettings = z.infer<typeof oidcSchema>;
export function cookie(req: IncomingMessage, name: string) {
  return req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
const sessionCookie = "__Host-factory_session";
const flowCookie = "__Host-factory_login";
const setCookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${seconds}`;
export class AccessDenied extends Error {}

export async function createOidc(
  settings: OidcSettings,
  origin: string,
  config?: client.Configuration,
  now = Date.now,
) {
  if (new URL(origin).protocol !== "https:")
    throw new Error("SSO requires an HTTPS public origin");
  config ??= await client.discovery(
    new URL(settings.issuer),
    settings.clientId,
    settings.clientSecret,
    undefined,
    { timeout: 10, execute: [client.enableNonRepudiationChecks] },
  );
  origin = new URL(origin).origin;
  const provider = config;
  const callback = `${origin}/auth/callback`;
  type Flow = {
    state: string;
    nonce: string;
    verifier: string;
    expires: number;
  };
  type Session = {
    subject: string;
    token: string;
    refresh?: string;
    tokenExpires: number;
    expires: number;
    checked: number;
    checking?: Promise<boolean>;
  };
  // ponytail: sessions live in this single web process; a restart requires sign-in again.
  const flows = new Map<string, Flow>(),
    sessions = new Map<string, Session>();
  const prune = () => {
    for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id);
    for (const [id, session] of sessions)
      if (session.expires <= now()) sessions.delete(id);
  };
  const allowed = (claims: Record<string, unknown>) =>
    Array.isArray(claims.groups) &&
    claims.groups.includes(settings.requiredGroup);
  return {
    async login(req: IncomingMessage, res: ServerResponse) {
      // Canonical host keeps the transaction cookie on the registered callback host.
      if (req.headers.host !== new URL(origin).host) {
        res.writeHead(302, { Location: `${origin}/auth/login` });
        res.end();
        return;
      }
      prune();
      if (flows.size >= 1000) throw new Error("Too many sign-in attempts");
      const id = client.randomState(),
        state = client.randomState(),
        nonce = client.randomNonce(),
        verifier = client.randomPKCECodeVerifier();
      flows.set(id, { state, nonce, verifier, expires: now() + 600_000 });
      const url = client.buildAuthorizationUrl(provider, {
        redirect_uri: callback,
        scope: "openid profile email groups offline_access",
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      res.writeHead(302, {
        Location: url.href,
        "Set-Cookie": setCookie(flowCookie, id, 600),
      });
      res.end();
    },
    async callback(req: IncomingMessage, res: ServerResponse) {
      const id = cookie(req, flowCookie) ?? "",
        flow = flows.get(id);
      flows.delete(id);
      res.setHeader("Set-Cookie", setCookie(flowCookie, "", 0));
      if (
        !flow ||
        flow.expires <= now() ||
        req.headers.host !== new URL(origin).host
      )
        throw new AccessDenied();
      const tokens = await client.authorizationCodeGrant(
        provider,
        new URL(req.url!, origin),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
        },
      );
      const subject = tokens.claims()?.sub;
      if (!subject) throw new AccessDenied();
      const info = await client.fetchUserInfo(
        provider,
        tokens.access_token,
        subject,
      );
      if (!allowed(info)) throw new AccessDenied();
      prune();
      if (sessions.size >= 1000) throw new Error("Too many active sessions");
      const session = client.randomState();
      sessions.set(session, {
        subject,
        token: tokens.access_token,
        refresh: tokens.refresh_token,
        tokenExpires: now() + (tokens.expires_in ?? 300) * 1000,
        expires: now() + settings.sessionHours * 3_600_000,
        checked: now(),
      });
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": [
          setCookie(flowCookie, "", 0),
          setCookie(sessionCookie, session, settings.sessionHours * 3600),
        ],
      });
      res.end();
    },
    async authenticated(req: IncomingMessage) {
      const id = cookie(req, sessionCookie) ?? "",
        session = sessions.get(id);
      if (!session) return false;
      if (session.expires <= now()) {
        sessions.delete(id);
        return false;
      }
      if (session.checking) return session.checking;
      if (
        session.checked + settings.recheckSeconds * 1000 > now() &&
        session.tokenExpires > now() + 30_000
      )
        return true;
      session.checking = (async () => {
        try {
          if (session.tokenExpires <= now() + 30_000) {
            if (!session.refresh) throw new AccessDenied();
            const tokens = await client.refreshTokenGrant(
              provider,
              session.refresh,
            );
            session.token = tokens.access_token;
            session.refresh = tokens.refresh_token ?? session.refresh;
            session.tokenExpires = now() + (tokens.expires_in ?? 300) * 1000;
          }
          const info = await client.fetchUserInfo(
            provider,
            session.token,
            session.subject,
          );
          if (!allowed(info)) throw new AccessDenied();
          session.checked = now();
          return sessions.get(id) === session && session.expires > now();
        } catch {
          sessions.delete(id);
          return false;
        } finally {
          session.checking = undefined;
        }
      })();
      return session.checking;
    },
    logout(req: IncomingMessage, res: ServerResponse) {
      sessions.delete(cookie(req, sessionCookie) ?? "");
      res.setHeader("Set-Cookie", setCookie(sessionCookie, "", 0));
    },
  };
}
