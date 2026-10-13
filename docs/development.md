# Development

Use Node.js 24.13 or later. TypeScript runs directly in Node; `npm run check` checks types without emitting a build.

```sh
npm ci
npm run check
npm test
```

Tests use fixtures and temporary state. They cover quota policy, provider routing, ownership, manual dispatch, monitoring, reopened tickets, merge approval, the journal, web authentication, and the web app's live stream. They do not require production credentials or prove compatibility with a live T3 build.

`package.json` keeps `private: true` to prevent accidental npm publication. This is a source-installed application.

For the native app, install Xcode Command Line Tools and run `npm run build:menu`. Building does not replace a running app. Use the [setup guide](setup.md#optional-interfaces) to install it after quitting the previous version. The app reads `status.json` and talks to the scheduler through the CLI; `T3Factory --render <dir>` draws the panel and every window page to PNG files from the current state and quits, which is how its views are checked without screen recording.

## Source layout

| File or directory | Responsibility |
| --- | --- |
| `src/main.ts` | CLI entry point and process lifecycle |
| `src/scheduler.ts` | Inventory, reconciliation, and dispatch |
| `src/service.ts`, `src/control.ts` | The long-lived scheduler, its triggers, and the control socket |
| `src/config.ts`, `src/settings.ts` | Configuration validation and edits |
| `src/models.ts`, `src/policy.ts` | Quota and eligibility decisions |
| `src/clients.ts`, `src/rpc.ts` | T3 and Kaneo integration |
| `src/store.ts` | SQLite ownership and job history |
| `src/prompts.ts`, `src/codex-approval.ts` | Agent reporting and merge authorization |
| `src/web.ts`, `src/oidc.ts` | Web API and authentication |
| `web/`, `macos/` | Browser and native interfaces |
| `scripts/`, `deploy/` | macOS installation and optional proxy launcher |

### Web interface

The browser app is plain ES modules served by `src/web.ts`; there is no bundler or build step. Preact, signals, and htm live in `web/vendor/` with their imports rewritten to relative paths, so the page needs no import map. The same script writes `web/vendor/icons.js` with the provider glyphs from `@lobehub/icons-static-svg` and the pull request glyph from `@primer/octicons` as path data. After changing those versions in `package.json`, run `npm run vendor:web` and commit the result. The font is bundled in `web/fonts/` so the installed app works offline. Colours are CSS variables set by `web/lib/theme.js`; `web/lib/themes.js` is generated from a T3 Code checkout by `npm run vendor:themes -- <path>` and holds T3 Code's palettes, so the Theme picker offers the same themes as T3 Code in light and dark.

| Directory | Responsibility |
| --- | --- |
| `web/lib/` | Runtime re-exports (`h.js`), the fetch wrapper, the router, formatting helpers, and the store: signals plus every action that changes state |
| `web/ui/` | Component library: controls bound to config paths, the dropdown, segmented filters, the drag-to-reorder list, meters, tags, tables, timelines, dialog, toast |
| `web/views/` | Pages: login, deck, runs and run detail, activity, models, capacity, projects, upstream, and the app root |

Pages are real paths (`/runs`, `/runs/<id>`, `/models`, and so on) handled by `web/lib/router.js`; the server returns `index.html` for any extensionless path. Server state enters through `applyState` in `web/lib/store.js`. The page opens `/api/events`, a server-sent event stream that pushes the full state whenever the scheduler writes `status.json` or the config file changes; if the stream is unavailable the store polls `/api/state` every 15 seconds. A one-second clock signal keeps relative times and countdowns current between pushes. Inputs that take a `path` read and write the config signal directly, so adding a setting means adding one bound input. `test/web-ui.test.ts` imports the store and helpers in Node without a DOM; `test/web-live.test.ts` covers the stream and run endpoints.

Web confirmations for cancelling a chain, stopping a run, and discarding edits on sign-out share the themed `Confirmation` overlay and `web/lib/confirmation.js`. The action runs only after confirmation; Cancel, Escape, and backdrop clicks dismiss it. The browser's tab-close warning for unsaved edits remains browser-managed.

### Scheduler service

`t3-factory run` starts one long-lived process (`src/service.ts`). It holds the store claim, one T3 client, and one connected Kaneo client, and runs passes in series from a single queue. A pass starts when something changes rather than on a clock: T3's `orchestration.subscribeShell` stream reports a project or thread change (bursts settle for 750 ms into one pass), the config file changes, a command arrives, or the `pollSeconds` fallback timer fires. Each pass reads the shell and providers once, reconciles jobs, reads only the ready columns of each project, examines tickets concurrently, and dispatches with the queue it just built; before a launch it re-reads only the ticket, new threads, and the quota. Every pass also reads each provider's allowance for display and writes the queue it would dispatch from as `status.upNext`. Between passes the service fingerprints the ready columns every 15 seconds and starts a pass when they change, and re-reads allowances on a timer so a reading is never older than about `quota.maxAgeSeconds`.

The service listens on `control.sock` in the state directory (`src/control.ts`). `t3-factory dispatch`, `once`, `doctor`, `job-stop`, and `plan-cancel`, and the web server's dispatch, stop, and cancel endpoints, send their command there: dispatches, checks, dry runs, and diagnostics run as a pass on the scheduler's queue and return its decision; stops and cancels return their result and wake a pass. Without a running service they do the work themselves, as before. Before a launch the scheduler re-reads the ticket's labels from the workspace and its blockers, so a label or relation that changed since the queue was read stops the start.

### Chains

A manual dispatch of a ticket that waits on other tickets is not refused. The scheduler walks `blocks` relations, subtask parents, and umbrella children through Kaneo (`blockerTree`) and answers `blocked-ticket-plan-required` with the whole tree. The caller then dispatches again with `--chain first`, which starts the highest-priority ticket in the tree that can start now, or `--chain all`, which stores a plan (`plans` table) and starts every runnable ticket within the run limits. Every pass advances active plans (`runPlans`), whether or not ticket automation is on: tickets start in priority order as the ones ahead of them finish in Kaneo, tickets without the ready label run with that waiver, and the target runs last. Only the launches made while the user chooses the chain carry manual policy; later continuations keep the automatic quota and idle policy, apply only the chain's recorded override, and use automatic models only when the chain was started with the automatic model. `t3-factory plan-cancel <id>` and `/api/plans/<id>/cancel` stop a plan; running tickets finish on their own. Active plans reach the page as `status.plans`.

### Journal

`Store.save` is the only job write path, so it records an event whenever a job is created, changes state, or gains a pull request. `Store.decide` records a check only when its outcome differs from the previous one or when it failed; a dispatch is journaled by the job it creates. Routine disabled checks update the latest decision without adding "Automation paused" events. Existing journal history is retained. Events live in the `events` table of `state.sqlite` (capped at 5000) and reach the page as `status.journal`; `/api/jobs/<id>/report` returns one run with its events and completion report. `t3-factory sources` (served as `/api/sources`) lists T3 projects, Kaneo projects with their columns, and workspace labels so the projects page can pick instead of typing identifiers. `t3-factory job-stop <jobId>` asks T3 to stop a run's thread and the service reconciles at once; the web app's Stop button calls it through `/api/jobs/<id>/stop`.

## T3 compatibility

The integration uses application APIs that can change between T3 builds. Matching the T3 product name or having a provider signed in is not enough. The current client speaks T3 orchestration protocol v2 and requires:

- The `x-t3-orchestration-protocol: 2` header on every HTTP request, and `orchestrationProtocol=2` on the WebSocket URL.
- Authenticated HTTP snapshots from `/api/orchestration/shell` and `/api/orchestration/threads/<id>/bounded`.
- WebSocket tickets from `/api/auth/websocket-ticket` and the `/ws` endpoint.
- Effect RPC methods `server.getConfig`, `server.refreshProviders`, `orchestration.launchThread`, `orchestration.dispatchCommand`, `vcs.removeWorktree`, `subscribeTerminalMetadata` (stream; the first event is a terminal snapshot), and `terminal.close`.
- The `terminal:read` scope on the scheduler credential for `subscribeTerminalMetadata`, and `terminal:operate` for `terminal.close`. Without `terminal:read`, workspace cleanup stops with `EnvironmentAuthorizationError`.
- Provider model metadata and usage windows with timestamps, remaining-window information, and reset times.
- Thread launch input and the `thread.stop` command compatible with the payloads in `src/scheduler.ts`.

T3 hosts that predate protocol negotiation (v1) are not supported. When T3 rejects the protocol header, the client reads `/.well-known/t3/environment` and reports `T3 orchestration protocol mismatch` with the version the server requires.

Liveness comes from each v2 thread's `status` (its latest run), `activeRunId`, `pendingRuntimeRequest`, and `pendingBackgroundTasks`. Only a pending human-facing request, such as an approval or question, means the thread is waiting for a person. `dynamic_tool_call` and `auth_refresh` requests are internal work and retain execution capacity. A `waiting` status without a human-facing request also retains capacity until T3 settles the handoff, without adding a "needs you" event. Unknown request kinds remain human-facing. Background tasks of kind `monitor`, including pull request watches, are passive monitoring; any other kind is active work. An active run whose provider sessions are all `stopped` or `error`, on a thread unchanged for 30 minutes, is orphaned and does not count as executing. Detection reads `runs` and `providerSessions` from `/api/orchestration/threads/<id>/bounded`; a failed or ambiguous read keeps the run executing.

Dispatch launches a thread over RPC with a `worktree` workspace strategy. T3 creates the worktree from the project's workspace root, which must match the configured `repoPath`, and runs the project's setup script. The plain HTTP dispatcher does not prepare worktrees. The scheduler validates the fields it consumes and stops affected dispatches when the contract is incompatible. It does not edit T3's database or fall back to driving its UI.

Quota refreshes target the selected provider with `server.refreshProviders({ instanceId, refreshModels: true })`. Despite its name, `refreshModels` also invalidates T3's cached capability and usage probe. A refresh without that flag can return the old quota snapshot. Factory refreshes stale reads with cache invalidation and retries once if the probe still returns stale or unavailable quota. Two failed probes block the run and report that automatic refresh failed.

Run `doctor` against your actual T3 build before enabling automatic work. Live verification requires your own credentials and configured projects; keep those outside tracked files.

Completed-workspace cleanup closes the completed thread's idle T3 terminals with `terminal.close`, always passing `terminalId` and `deleteHistory: false`. It never closes a terminal that is starting or running a command, or one owned by another thread. It also requires `lsof` to verify process working directories. If the terminal snapshot or that check is unavailable or fails, the workspace is preserved. Removal uses `force: false`; workspace metadata updates use the expected worktree path to prevent changing a different binding.

## Changes and review

Keep runtime behavior documented in the relevant guide and examples aligned with the configuration schema. Use generic fixture names, domains, and paths. Review changes before committing, run type checks and relevant tests for code changes, and build the menu app when changing Swift code.

Documentation changes need link and example validation, not live ticket dispatches. Keep installation separate from development: the installers restart services and copy the runtime, so they are deployment commands rather than build checks.

`LOCAL.md` may contain private deployment instructions for a particular checkout. It is ignored by Git and is not distributed to contributors.
