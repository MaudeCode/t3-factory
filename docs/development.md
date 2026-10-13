# Development

Use Node.js 24.13 or later. TypeScript runs directly in Node; `npm run check` checks types without emitting a build.

```sh
npm ci
npm run check
npm test
```

Tests use fixtures and temporary state. They cover quota policy, provider routing, ownership, manual dispatch, monitoring, reopened tickets, merge approval, the journal, web authentication, and the web app's live stream. They do not require production credentials or prove compatibility with a live T3 build.

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

### Web interface

The browser app is plain ES modules served by `src/web.ts`; there is no bundler or build step. Preact, signals, and htm live in `web/vendor/` with their imports rewritten to relative paths, so the page needs no import map. After changing those versions in `package.json`, run `npm run vendor:web` and commit the result. The font is bundled in `web/fonts/` so the installed app works offline. Colours are CSS variables set by `web/lib/theme.js`; `web/lib/themes.js` is generated from a T3 Code checkout by `npm run vendor:themes -- <path>` and holds T3 Code's palettes, so the Theme picker offers the same themes as T3 Code in light and dark.

| Directory | Responsibility |
| --- | --- |
| `web/lib/` | Runtime re-exports (`h.js`), the fetch wrapper, the router, formatting helpers, and the store: signals plus every action that changes state |
| `web/ui/` | Component library: controls bound to config paths, the dropdown, segmented filters, the drag-to-reorder list, meters, tags, tables, timelines, dialog, toast |
| `web/views/` | Pages: login, deck, runs and run detail, activity, models, capacity, projects, upstream, and the app root |

Pages are real paths (`/runs`, `/runs/<id>`, `/models`, and so on) handled by `web/lib/router.js`; the server returns `index.html` for any extensionless path. Server state enters through `applyState` in `web/lib/store.js`. The page opens `/api/events`, a server-sent event stream that pushes the full state whenever the scheduler writes `status.json` or the config file changes; if the stream is unavailable the store polls `/api/state` every 15 seconds. A one-second clock signal keeps relative times and countdowns current between pushes. Inputs that take a `path` read and write the config signal directly, so adding a setting means adding one bound input. `test/web-ui.test.ts` imports the store and helpers in Node without a DOM; `test/web-live.test.ts` covers the stream and run endpoints.

### Journal

`Store.save` is the only job write path, so it records an event whenever a job is created, changes state, or gains a pull request. `Store.decide` records a check only when its outcome differs from the previous one, or when it dispatched or failed. Events live in the `events` table of `state.sqlite` (capped at 5000) and reach the page as `status.journal`; `/api/jobs/<id>/report` returns one run with its events and completion report. `t3-factory sources` (served as `/api/sources`) lists T3 projects, Kaneo projects with their columns, and workspace labels so the projects page can pick instead of typing identifiers. `t3-factory job-stop <jobId>` asks T3 to stop a run's thread; the web app's Stop button calls it through `/api/jobs/<id>/stop`.

## T3 compatibility

The integration uses application APIs that can change between T3 builds. Matching the T3 product name or having a provider signed in is not enough. The current client speaks T3 orchestration protocol v2 and requires:

- The `x-t3-orchestration-protocol: 2` header on every HTTP request, and `orchestrationProtocol=2` on the WebSocket URL.
- Authenticated HTTP snapshots from `/api/orchestration/shell` and `/api/orchestration/threads/<id>/bounded`.
- WebSocket tickets from `/api/auth/websocket-ticket` and the `/ws` endpoint.
- Effect RPC methods `server.getConfig`, `server.refreshProviders`, `orchestration.launchThread`, `orchestration.dispatchCommand`, `vcs.removeWorktree`, `subscribeTerminalMetadata` (stream; the first event is a terminal snapshot), and `terminal.close`.
- The `terminal:operate` scope on the scheduler credential, for the two terminal methods.
- Provider model metadata and usage windows with timestamps, remaining-window information, and reset times.
- Thread launch input and the `thread.stop` command compatible with the payloads in `src/scheduler.ts`.

T3 hosts that predate protocol negotiation (v1) are not supported. When T3 rejects the protocol header, the client reads `/.well-known/t3/environment` and reports `T3 orchestration protocol mismatch` with the version the server requires.

Liveness comes from each v2 thread's `status` (its latest run), `activeRunId`, `pendingRuntimeRequest`, and `pendingBackgroundTasks`. A pending request means the thread is waiting for a person. Background tasks of kind `monitor`, including pull request watches, are passive monitoring; any other kind is active work. An active run whose provider sessions are all `stopped` or `error`, on a thread unchanged for 30 minutes, is orphaned and does not count as executing. Detection reads `runs` and `providerSessions` from `/api/orchestration/threads/<id>/bounded`; a failed or ambiguous read keeps the run executing.

Dispatch launches a thread over RPC with a `worktree` workspace strategy. T3 creates the worktree from the project's workspace root, which must match the configured `repoPath`, and runs the project's setup script. The plain HTTP dispatcher does not prepare worktrees. The scheduler validates the fields it consumes and stops affected dispatches when the contract is incompatible. It does not edit T3's database or fall back to driving its UI.

Quota refreshes target the selected provider with `server.refreshProviders({ instanceId, refreshModels: true })`. Despite its name, `refreshModels` also invalidates T3's cached capability and usage probe. A refresh without that flag can return the old quota snapshot. Factory refreshes stale reads with cache invalidation and retries once if the probe still returns stale or unavailable quota. Two failed probes block the run and report that automatic refresh failed.

Run `doctor` against your actual T3 build before enabling automatic work. Live verification requires your own credentials and configured projects; keep those outside tracked files.

Completed-workspace cleanup closes the completed thread's idle T3 terminals with `terminal.close`, always passing `terminalId` and `deleteHistory: false`. It never closes a terminal that is starting or running a command, or one owned by another thread. It also requires `lsof` to verify process working directories. If the terminal snapshot or that check is unavailable or fails, the workspace is preserved. Removal uses `force: false`; workspace metadata updates use the expected worktree path to prevent changing a different binding.

## Changes and review

Keep runtime behavior documented in the relevant guide and examples aligned with the configuration schema. Use generic fixture names, domains, and paths. Review changes before committing, run type checks and relevant tests for code changes, and build the menu app when changing Swift code.

Documentation changes need link and example validation, not live ticket dispatches. Keep installation separate from development: the installers restart services and copy the runtime, so they are deployment commands rather than build checks.

`LOCAL.md` may contain private deployment instructions for a particular checkout. It is ignored by Git and is not distributed to contributors.
