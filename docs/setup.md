# Setup

Run commands from the repository root unless stated otherwise. The bundled service installers use macOS launchd and the signed-in user's account. They require an active login session; they are not system daemons.

## Prepare the environment

Install Node.js 24.13 or later, Git, the GitHub CLI. Run `node --version`, `git --version`, and `gh auth status` to verify your tools. The GitHub account must have access to each configured repository.

```sh
npm ci
cp config.example.jsonc config.jsonc
cp .env.example .env
chmod 600 config.jsonc .env
```

In `.env`, set `T3_FACTORY_CONFIG` to the absolute path of your `config.jsonc`. The default is `~/.config/t3-factory/config.jsonc` if no override is set. JSONC paths must be absolute; `~` and shell variables are not expanded inside JSON strings.

The example is intentionally incomplete. It keeps automation off and contains placeholder IDs, paths, and a sample T3 port. [Configuration](configuration.md) explains the fields.

## Connect T3 Code

Start a compatible T3 Code build on the same machine. Register each repository as a T3 project and sign in to the providers you plan to use.

Set `t3.url` to its loopback HTTP or HTTPS origin. Use that build's native authentication tooling to issue a session credential. Store it privately at `t3.credentialFile` with this shape:

```json
{
  "token": "YOUR_T3_SESSION_TOKEN",
  "expiresAt": "EXPIRATION_REPORTED_BY_T3"
}
```

`expiresAt` is optional; when present, use the actual ISO timestamp issued by T3. Keep the file mode at `0600`. Do not copy browser cookies, write to the T3 application database, or assume a particular token lifetime.

The required T3 endpoints and RPC methods are listed in [development](development.md#t3-compatibility). This repository does not bundle or install T3 Code.

## Connect Kanvil and map projects

The scheduler talks directly to Kanvil's HTTP API and durable server-sent event feed. Create a revocable API credential with `read` access to every project the factory will inspect, then set `KANVIL_API_KEY` privately in `.env` under the OS account running Factory. The delivery worker uses its own Kanvil integration for writes. Keep credentials out of JSONC, Git and command arguments. No MCP subprocess or device login is needed by the scheduler.

Set `kanvil.url` to the HTTPS web origin, or a loopback HTTP origin for local development, without `/api` or `/mcp`. Set `kanvil.workspaceId` to the verified workspace ID. For each project, set `kanvilId` to its actual Kanvil project ID and `key` to its current ticket prefix, alongside the T3 project ID, local repository path and GitHub `OWNER/REPOSITORY`. Use native status categories such as `todo` and `done`, including for custom workflow states. The configured base branch must exist on `origin`.

In Projects, choose a Kanvil workspace, then a project in it. Add project and Setup use the same picker and list only workspaces and projects the API credential can read. The selection saves `projects[].kanvilWorkspaceId`; projects without it keep using `kanvil.workspaceId`. Factory reads ticket inventory, session reports and Epics across the configured workspaces, and includes each project's workspace in its worker prompt. Changing a mapping takes effect in the running service after Save.

The server must support `/api/v1/checkpoint`, `/snapshot`, `/events`, `/tickets/resolve`, project workflow states, and native ticket readiness. A reverse proxy must preserve SSE streaming and disable buffering. Ticket changes wake Factory immediately; there is no periodic ticket-inventory or label scan. A lost connection replays from its processed cursor, and an expired cursor starts a new snapshot. Automation waits while the event feed is disconnected. The general maintenance and allowance timers still run.

### Migrate an existing installation

Pause the old scheduler and let its owned jobs finish before changing backends. Back up its private configuration and state. Replace the `kaneo` configuration section with `kanvil`, replace project `kaneoId` fields with verified Kanvil IDs, and replace old column slugs with native status categories. IDs from the old tracker are not interchangeable with Kanvil IDs. Use a separate `stateDir` for Kanvil and retain the old directory unchanged.

Restore the existing Factory data before starting the new scheduler. With the new configuration selected, preview the migration with `node scripts/migrate-kaneo.ts /path/to/old-config.jsonc`. Stop both scheduler and web services, then repeat with `--apply`. The command backs up the destination database, matches tickets by the original task IDs recorded in Kanvil's import footer, and refuses missing or ambiguous session-ticket identities. It restores runs as read-only history, including their reports and journal, and preserves session-ticket provenance, dismissals, consumption and scan cursors. Historical runs never become new scheduler or cleanup ownership. This migrates local Factory state; it does not import or edit Kanvil tickets. Keep the old state directory because historical report paths still refer to it.

Start the services, verify Runs, the Queue's Sessions view, Sources and the collection error state, and confirm native readiness before enabling automation. An empty new ledger or a collection warning is not a successful cutover. Replaying all old conversations against the new tracker can exhaust credential limits and cannot reconstruct original creation evidence after ticket IDs and import timestamps change. This source change does not restart or deploy the running installation.

Prepare the delivery and discovery skills described in [configuration](configuration.md#workflow-skills), and put their local paths in your settings.

## Validate before enabling automation

Once the configuration has valid paths and mappings, inspect T3's available models:

```sh
node src/main.ts config-get
node src/main.ts model-catalog
```

Use the returned provider `instanceId` and model slug in `models`. Preset IDs such as `default-model` are your own names; they are not provider model names. The model list may expose options specific to a provider.

Enable automatic eligibility on the models you want the scheduler to use, leaving the top-level `enabled` switch off while checking the setup:

```sh
node src/main.ts doctor
```

`doctor` reads live services and updates local observations without starting work. It can reveal missing credentials, incompatible T3 APIs, invalid mappings, or quota data that is unavailable. Config validation alone does not prove those integrations work. Review its decision and skipped-ticket reasons before continuing.

For a manual preview, substitute a real ready ticket and your configured model ID:

```sh
node src/main.ts dispatch --ticket APP-123 --model default-model --dry-run
```

## Install the scheduler

```sh
node scripts/install.ts
```

The installer copies the runtime to `~/.local/share/t3-factory/app`, creates `~/.local/bin/t3-factory`, and installs a LaunchAgent. When reinstalling, it first copies the new runtime into a staging directory inside the installed one while the previous service keeps running, then waits up to 15 seconds for launchd to unload that service, moves the staged files into place, and loads the new one; it stops if the old service is still loaded. Links in `node_modules` are copied as written, so they point inside the runtime rather than at the checkout. The web installer does the same. A failed copy leaves the previous service running on its previous files and needs nothing done by hand: fix the cause and run the installer again. If an install stops after the old service was unloaded, the service stays stopped until the installer is run again. Both installers record the checkout's version in the runtime's `VERSION` file: the tag on its commit, such as `v0.5.0` from a release, else its short commit SHA. The web app's sidebar shows it. Add `~/.local/bin` to your shell's `PATH` if needed. The scheduler runs with `--max-old-space-size=1024`, about four times its live heap, so V8 collects regularly instead of letting garbage grow toward Node's multi-gigabyte default. The service starts immediately, but the example's `enabled: false` keeps automatic dispatch paused.

When ready to authorize automatic work:

```sh
t3-factory resume
```

Model and project eligibility still apply. Pausing later stops new automatic dispatches; existing T3 work continues.

### Deploy releases automatically

```sh
node scripts/install-deploy.ts
```

Run it once, from a checkout of your repository with its `.env`, after the scheduler and web service are installed. It installs a `.deploy` LaunchAgent that fetches tags over HTTPS every five minutes. When a `vX.Y.Z` tag newer than the one it last tried appears, it checks that tag out in `~/.local/share/t3-factory/deploy/source` and runs the tag's `./install-release` (`npm ci`, then `scripts/install.ts` and `scripts/install-web.ts`), using the `.env` it was installed with. A deployer of your own can run the same script from a checked-out tag, with `T3_FACTORY_ENV` set to that `.env`. Prerelease tags are skipped. Each tag is tried once and recorded in `~/.local/share/t3-factory/deploy/tag`; after a failure, read `~/Library/Logs/t3-factory-deploy-error.log`, fix the cause and release the next version. Tags come from the release workflow, which creates one only after CI passes on the commit; see [development](development.md#releases).

## Web controls

For browser and phone controls, continue with [web access](web-access.md). The web page reuses the same CLI and private configuration.
