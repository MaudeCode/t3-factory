# Configuration

There are two configuration files. `.env` holds deployment values and credentials; `config.jsonc` holds editable scheduler settings. Neither belongs in Git. Start from [`.env.example`](../.env.example) and [`config.example.jsonc`](../config.example.jsonc).

The CLI and installation scripts load `.env` from the source or installed runtime directory. Set `T3_FACTORY_ENV` in the process environment to use a different file. Existing environment variables take precedence. The installers copy the selected file into the installed runtime, so editing the source `.env` alone does not update a running service.

## Scheduler settings

| Setting | Meaning |
| --- | --- |
| `enabled` | Allows new automatic ticket and discovery work; explicit manual runs remain available while paused. Upstream reviews have their own `upstream.enabled`. |
| `pollSeconds` | Time between cycles, at least 15 seconds. |
| `idleMinutes` | Required inactivity for the relevant provider in T3 before ticket and discovery work. Upstream reviews do not wait for it. |
| `concurrency.claude` / `concurrency.codex` | Nonnegative integer limits for simultaneous runs per provider, default 1 each. Zero disables that provider's automatic starts. They gate automatic starts; manual runs may exceed them. |
| `maxWaitingPRs` | Maximum parked jobs before further dispatches are held; `null` means unlimited. |
| `monitoringTimeoutMinutes` | When an inactive factory-owned monitor may be stopped and parked. Defaults to 30. |
| `runtimeMode` | T3 execution permission mode: `full-access`, `auto`, or `auto-accept-edits`. Choose according to the permissions you intend to grant. |
| `stateDir` | Absolute directory for the SQLite ledger, reports, and status. |
| `t3` | Local server origin and private session credential file. |
| `kaneo` | API origin, workspace ID, and readiness label. |

Changes to the JSONC file are read on later cycles. Running jobs retain their original prompts and models. Invalid settings block dispatch. Move state only as a deliberate migration with the services stopped; changing `stateDir` is not a safe way to reset job ownership.

## Models

The order of `models` is the ranking order, highest first. Each entry has a unique local `id`, a display `name`, a T3 `model` selection, an `automatic` flag, and a `maxDifficulty` of `low`, `med`, or `high`.

Use `model-catalog` to discover provider instance IDs, model slugs, and supported options. New presets default to manual-only. Difficulty ceilings apply to manual runs too. Missing or conflicting difficulty labels make a ticket ineligible; the scheduler never changes labels to fit an available model.

`quotaWindowId` optionally associates a Claude preset with a dedicated allowance reported by T3. The current budget schema names this pool `quota.claude.fable`. Leave the field absent for general Claude models. Do not assign an arbitrary window ID to bypass the provider's applicable budget.

## Quota budgets

Each pool has two values:

- `reservePercent` declines linearly with the fraction of the window remaining before reset.
- `minRemainingPercent` stays fixed and sets the minimum allowance needed to start another run.

Available quota must be greater than the larger of those thresholds. For example, a 50% reserve halfway through its window reserves 25%; a 10% fixed minimum only becomes decisive once the declining reserve drops below 10%.

General Claude models use the five-hour and weekly pools. A Claude model with a dedicated allowance uses the five-hour pool and its dedicated pool. Codex models use the Codex weekly budget settings for each window reported by T3. The providers have independent budgets and execution slots.

`quota.maxAgeSeconds` limits the age of a reading. Missing, stale, or expired quota data causes a targeted refresh. If that fails, affected models are unavailable; another provider can still proceed. These checks use T3's provider metadata, not a model prompt.

Manual overrides are described in [operations](operations.md#manual-runs). Existing jobs are allowed to finish when a reserve is reached.

## Projects

Each entry maps a Kaneo project to a T3 project and a local Git repository. `key` is the ticket prefix, such as `APP`; `githubRepo` is `OWNER/REPOSITORY`. `readyStatuses` and `doneStatuses` contain actual Kaneo column slugs, not assumed display names. New worktrees start from `origin/<baseBranch>`.

The readiness label is configured once at `kaneo.readyLabel`. Dependencies, parent blockers, open children, existing branches, T3 activity, and open PRs are checked separately from the label. Disable a project with `enabled: false` instead of deleting it while it owns unfinished jobs.

`priorityLabels` is an ordered list of exact Kaneo label names, highest first, editable in Projects on the web or Mac app. For example, `["security", "compatibility"]` puts security tickets ahead of compatibility tickets, and both ahead of unmatched tickets. A ticket with multiple matching labels uses its highest rank. Ranks are compared across enabled projects: a first-ranked label in any project beats a second-ranked label elsewhere. Within each rank, the existing urgency, model order, project backlog size, rotation, and oldest-ticket rules apply. An empty list, the default, leaves urgency ordering unchanged. Labels never bypass readiness, blockers, classification, model capacity, or quota checks. Manual dispatch of a specific ticket remains explicit. Upstream reviews retain their existing precedence over ticket work.

`labelLimits` maps a Kaneo label to the most runs of this project carrying it that may run at once, for example `{ "app": 2 }` when each run boots a simulator; edit it under Runs at once by label in Projects. Runs waiting for you free their slot, and zero stops automatic starts for that label. It gates automatic starts, chain continuations and manual runs; only a manual run with Override limits on may exceed it. The default `{}` limits nothing.

## Workflow skills

The repository supplies scheduling and report handling. The operator supplies the agent's delivery and discovery workflows.

`factorySkill` points to a local delivery skill readable by the selected T3 runtime. It must cover ticket validation, scoped implementation, tests, PR review, CI, tracker updates, and the [merge authorization contract](operations.md#merge-authorization). The scheduler's prompt preserves human-only validation and deployment holds. A skill installation for one coding tool does not automatically make it available to another.

`discovery.promptFile` points to a local discovery invocation. [`prompts/discovery.md`](../prompts/discovery.md) is a starting point, not the discovery skill itself. Install a `discover-tickets` skill in each selected runtime or adapt the invocation to an equivalent workflow. It should validate findings, deduplicate the backlog, split large work into deliverable tickets, and apply the existing tracker labels. Discovery creates tickets, not implementations.

Projects may override `discoveryPromptFile`. `discovery.emptyCooldownHours` controls how long a project waits after a no-work discovery result. The scheduler appends the required JSON report path and format to each job prompt; the agent must use that contract to report completion or a human-input pause.

### Upstream release reviews

A project's `upstreams` list names GitHub repositories whose releases the project should review: `name`, `repo` (`OWNER/REPOSITORY`), `prereleases` (default `false`), and `firstBase`, the tag or commit the first review starts from. Each repository belongs to one project. `upstream.promptFile` is the review invocation; the scheduler replaces `{{name}}`, `{{repo}}`, `{{base}}` and `{{candidate}}` in it. [`prompts/upstream-review.md`](../prompts/upstream-review.md) is a starting point. `upstream.checkMinutes` (default 360) limits how often each repository's releases are read; an upstream's own `checkMinutes` overrides it, for example `1440` to review a busy repository at most once a day. `upstream.enabled` (default `false`) allows new reviews, independently of the top-level `enabled`; a config written before this setting existed keeps reviews paused until it is turned on.

Keep actual skill paths and deployment-specific prompt variants in your private configuration. These skills are not downloaded by the installer.
