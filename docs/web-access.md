# Web access

The web page controls the same factory as the CLI and menu-bar app. It can show provider status, pause or resume automation, dispatch a ticket, and edit models, budgets, projects, and discovery settings.

The backend binds to loopback by default. Choose how clients reach it and set `FACTORY_PUBLIC_ORIGIN` to that exact browser origin. Host and origin checks reject unconfigured origins. Authentication settings are read at startup.

## OIDC sign-in

Set `FACTORY_AUTH_MODE=oidc` in `.env`. Register a confidential authorization-code client with PKCE at your provider and configure:

| Setting | Value |
| --- | --- |
| Redirect URI | `https://YOUR_HOSTNAME/auth/callback` |
| Scopes | `openid profile email groups offline_access` |
| Allowed users | Restrict the client to the intended group at the provider |
| `OIDC_ISSUER` | Provider's HTTPS issuer URL |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Client credentials |
| `OIDC_REQUIRED_GROUP` | Exact group name required in UserInfo's `groups` array |
| `OIDC_SESSION_HOURS` | Absolute factory session lifetime, default 720 hours / 30 days |
| `OIDC_RECHECK_SECONDS` | Membership recheck interval while in use, default 60, maximum 300 seconds |

Pocket ID is a supported deployment option. Other OIDC providers must supply the same group claim and required protocol features; compatibility with every provider is not established.

Sign-in uses state, nonce, PKCE, token validation, and a browser-bound transaction cookie. The app checks group membership itself, in addition to the provider's client restrictions. Missing membership or revoked credentials invalidate the session. A temporary identity-provider failure blocks the request with a retryable error but keeps the session for recovery. Tokens stay on the server; the browser receives a Secure, HttpOnly session cookie. Access tokens can be refreshed within the absolute session lifetime.

OIDC mode disables pairing endpoints and rejects old pairing cookies. An incomplete configuration stops startup. Signing out removes the factory session without signing the user out of other applications. Sessions survive web-service restarts in `<stateDir>/web-sessions.json`, a private mode-0600 file containing session credentials. Restored sessions recheck membership before granting access. Changing the OIDC settings or public origin invalidates stored sessions. Set the provider client's refresh-token lifetime to at least the desired factory session lifetime; a short provider lifetime can require earlier sign-in.

## Device pairing

For a trusted private network without OIDC, explicitly choose `FACTORY_AUTH_MODE=pairing` and set `FACTORY_WEB_SESSION_SECRET` to at least 32 random characters. For example, generate a value locally with `openssl rand -hex 32` and save it only in `.env`.

After starting the service:

```sh
t3-factory web-pair
```

Open the resulting one-use link within ten minutes. The device receives a 30-day HttpOnly session cookie. A pairing link grants control of the factory; treat it as a credential. Rotating the session secret invalidates paired sessions after restart.

Private HTTP origins are accepted in pairing mode, but HTTPS protects the session on the network. OIDC mode requires an HTTPS public origin.

## HTTPS and DNS

You can use an existing reverse proxy. Route the configured hostname to the machine running the factory and proxy to `FACTORY_WEB_HOST:FACTORY_WEB_PORT`, preserving the original Host header. Keep the backend on loopback when the proxy runs on that machine. A private DNS record is enough for local access; external access is a separate networking decision.

The optional [Caddy template](../deploy/Caddyfile) uses a Cloudflare DNS challenge. It requires a Caddy binary with `dns.providers.cloudflare` and these environment values:

- `FACTORY_HOSTNAME`: browser hostname, without a scheme or path.
- `FACTORY_WEB_UPSTREAM`: backend address, usually `127.0.0.1:3848`.
- `CLOUDFLARE_API_TOKEN`: a DNS-challenge credential scoped to the relevant zone.
- `CADDY_BINARY`: executable path, or `caddy` if available on `PATH`.

```sh
node scripts/run-caddy.ts
```

The launcher reads `.env` without evaluating it as shell code. DNS challenges do not require a public inbound HTTP listener. Certificate issuance still needs DNS-provider and certificate-authority access. Manage Caddy with your own service manager if it should stay running; the factory installers do not install Caddy or create DNS records. Other DNS providers need a different Caddy configuration.

## Install and verify

After the base scheduler setup and web environment configuration:

```sh
node scripts/install-web.ts
```

Visit `FACTORY_PUBLIC_ORIGIN` and sign in or pair. Verify that an unauthenticated browser cannot read `/api/state`, that the intended group can sign in, and that a user outside that group is denied. In OIDC mode, `/api/pair` and pairing exchanges return 403.

The page saves settings through the CLI's validation and stale-edit checks. Manual runs retain the [dispatch guards](operations.md#manual-runs). Web dispatches have persistent request IDs; a lost response should be investigated in status before trying a different request.

The page retries a status read once after HTTP 502, 503, or 504, and handles empty or HTML proxy errors without losing the HTTP status. It never automatically resends a dispatch POST. Keep the proxy's upstream idle timeout shorter than the backend's keep-alive timeout; the Caddy template uses two seconds, below Node's five-second default.
