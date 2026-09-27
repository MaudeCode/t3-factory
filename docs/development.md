# Development

Use Node.js 24.13 or later. TypeScript runs directly in Node; `npm run check` checks types without emitting a build.

```sh
npm ci
npm run check
npm test
```

Tests use fixtures and temporary state. They cover quota policy, provider routing, ownership, manual dispatch, monitoring, reopened tickets, merge approval, and web authentication. They do not require production credentials or prove compatibility with a live T3 build.

`package.json` keeps `private: true` to prevent accidental npm publication. This is a source-installed application.

For the native app, install Xcode Command Line Tools and run `npm run build:menu`. Building does not replace a running app. Use the [setup guide](setup.md#optional-interfaces) to install it after quitting the previous version.

## Source layout

| File or directory | Responsibility |
| --- | --- |
| `src/main.ts` | CLI entry point and process lifecycle |
| `src/scheduler.ts` | Inventory, reconciliation, and dispatch |
| `src/config.ts`, `src/settings.ts` | Configuration validation and edits |
| `src/models.ts`, `src/policy.ts` | Quota and eligibility decisions |
| `src/clients.ts`, `src/rpc.ts` | T3 and Kaneo integration |
| `src/store.ts` | SQLite ownership and job history |
| `src/prompts.ts`, `src/codex-approval.ts` | Agent reporting and merge authorization |
| `src/web.ts`, `src/oidc.ts` | Web API and authentication |
| `web/`, `macos/` | Browser and native interfaces |
| `scripts/`, `deploy/` | macOS installation and optional proxy launcher |

## T3 compatibility

The integration uses application APIs that can change between T3 builds. Matching the T3 product name or having a provider signed in is not enough. The current client requires:

- Authenticated HTTP snapshots from `/api/orchestration/shell` and `/api/orchestration/threads/<id>`.
- WebSocket tickets from `/api/auth/websocket-ticket` and the `/ws` endpoint.
- Effect RPC methods `server.getConfig`, `server.refreshProviders`, and `orchestration.dispatchCommand`.
- Provider model metadata and usage windows with timestamps, remaining-window information, and reset times.
- Worktree bootstrap and dispatch commands compatible with the payloads in `src/scheduler.ts`.

Dispatch goes through RPC because T3's plain HTTP dispatcher does not perform the required worktree preparation. The scheduler validates the fields it consumes and stops affected dispatches when the contract is incompatible. It does not edit T3's database or fall back to driving its UI.

Quota refreshes target the selected provider with `server.refreshProviders({ instanceId, refreshModels: true })`. Despite its name, `refreshModels` also invalidates T3's cached capability and usage probe. A refresh without that flag can return the old quota snapshot. Factory retries stale reads once with cache invalidation and still rejects quota that remains stale.

Run `doctor` against your actual T3 build before enabling automatic work. Live verification requires your own credentials and configured projects; keep those outside tracked files.

## Changes and review

Keep runtime behavior documented in the relevant guide and examples aligned with the configuration schema. Use generic fixture names, domains, and paths. Review changes before committing, run type checks and relevant tests for code changes, and build the menu app when changing Swift code.

Documentation changes need link and example validation, not live ticket dispatches. Keep installation separate from development: the installers restart services and copy the runtime, so they are deployment commands rather than build checks.

`LOCAL.md` may contain private deployment instructions for a particular checkout. It is ignored by Git and is not distributed to contributors.
