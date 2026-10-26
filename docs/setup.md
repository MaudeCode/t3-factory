# Setup

Run commands from the repository root unless stated otherwise. The bundled service installers use macOS launchd and the signed-in user's account. They require an active login session; they are not system daemons.

## Prepare the environment

Install Node.js 24.13 or later, Git, the GitHub CLI, and Xcode Command Line Tools if you want the menu-bar app. Run `node --version`, `git --version`, and `gh auth status` to verify your tools. The GitHub account must have access to each configured repository.

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

The server must support `/api/v1/checkpoint`, `/snapshot`, `/events`, `/tickets/resolve`, project workflow states, and native ticket readiness. A reverse proxy must preserve SSE streaming and disable buffering. Ticket changes wake Factory immediately; there is no periodic ticket-inventory or label scan. A lost connection replays from its processed cursor, and an expired cursor starts a new snapshot. Automation waits while the event feed is disconnected. The general maintenance and allowance timers still run.

### Migrate an existing installation

Pause the old scheduler and let its owned jobs finish before changing backends. Back up its private configuration and state. Replace the `kaneo` configuration section with `kanvil`, replace project `kaneoId` fields with verified Kanvil IDs, and replace old column slugs with native status categories. IDs from the old tracker are not interchangeable with Kanvil IDs. Use a fresh `stateDir` for Kanvil; retain the old state directory for its job history and cleanup evidence. Factory does not import tickets or rewrite historical job ownership. Re-map the projects through Sources and confirm native readiness before enabling automation. This source change does not restart or deploy the running installation.

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

The installer copies the runtime to `~/.local/share/t3-factory/app`, creates `~/.local/bin/t3-factory`, and installs a LaunchAgent. When reinstalling, it waits up to 15 seconds for launchd to unload the previous service before loading the new one, and stops if it is still loaded. The web installer does the same. Add `~/.local/bin` to your shell's `PATH` if needed. The service starts immediately, but the example's `enabled: false` keeps automatic dispatch paused.

When ready to authorize automatic work:

```sh
t3-factory resume
```

Model and project eligibility still apply. Pausing later stops new automatic dispatches; existing T3 work continues.

## Optional interfaces

For the macOS menu-bar app:

```sh
npm run build:menu
mkdir -p "$HOME/Applications"
ditto "build/T3 Factory.app" "$HOME/Applications/T3 Factory.app"
open "$HOME/Applications/T3 Factory.app"
```

The app is ad-hoc signed and requires macOS 14 or later. Quit it before replacing the bundle during an update. Left-click opens its status panel: the automation switch, each provider's allowance, runs that need you, running work, chains, the queue, and a way to start a run. The count beside the icon is the number of runs waiting for you. Right-click opens Settings. The panel follows the scheduler's status file as it changes and sends commands through the CLI, so it reaches the running scheduler the same way the web app does. Quitting the app leaves the scheduler running.

For browser and phone controls, continue with [web access](web-access.md). Both interfaces reuse the same CLI and private configuration.
