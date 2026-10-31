# Configuration

There are two configuration files. `.env` holds deployment values and credentials; `config.jsonc` holds editable scheduler settings. Neither belongs in Git. Start from [`.env.example`](../.env.example) and [`config.example.jsonc`](../config.example.jsonc).

The CLI and installation scripts load `.env` from the source or installed runtime directory. Set `T3_FACTORY_ENV` in the process environment to use a different file. Existing environment variables take precedence. The installers copy the selected file into the installed runtime, so editing the source `.env` alone does not update a running service.

## Scheduler settings

| Setting | Meaning |
| --- | --- |
| `enabled` | Allows new automatic ticket and discovery work; explicit manual runs remain available while paused. Upstream reviews have their own `upstream.enabled`. |
| `pollSeconds` | Maintenance fallback cadence, at least 15 seconds. Kanvil inventory changes arrive through SSE. |
| `idleMinutes` | Required inactivity for the relevant provider in T3 before ticket and discovery work. Upstream reviews do not wait for it. |
| `concurrency.claude` / `concurrency.codex` | Nonnegative integer limits for simultaneous runs per provider, default 1 each. Zero disables that provider's automatic starts. They gate automatic starts and manual starts without a provider override; manual runs with `providers` selected may exceed them. |
| `maxWaitingPRs` | Maximum parked jobs before further dispatches are held; `null` means unlimited. |
| `monitoringTimeoutMinutes` | When an inactive factory-owned monitor may be stopped and parked. Defaults to 30. |
| `runtimeMode` | T3 execution permission mode: `full-access`, `auto`, or `auto-accept-edits`. Choose according to the permissions you intend to grant. |
| `stateDir` | Absolute directory for the SQLite ledger, reports, and status. |
| `t3` | Local server origin and private session credential file. |
| `kanvil` | HTTPS origin and workspace ID. HTTP is allowed only for loopback. The API credential is `KANVIL_API_KEY` in the environment. |

Changes to the JSONC file are read on later cycles. Running jobs retain their original prompts and models. Invalid settings block dispatch. Move state only as a deliberate migration with the services stopped; changing `stateDir` is not a safe way to reset job ownership.

## Models

The order of `models` is the ranking order, highest first. Each entry has a unique local `id`, a display `name`, a T3 `model` selection, an `automatic` flag, and a `maxDifficulty` of `low`, `med`, or `high`.

Use `model-catalog` to discover provider instance IDs, model slugs, and supported options. New presets default to manual-only. Difficulty ceilings apply to manual runs too. A missing native difficulty or conflicting difficulty labels make a ticket ineligible; the scheduler never changes difficulty to fit an available model.

`quotaWindowId` optionally associates a Claude preset with a dedicated allowance reported by T3. The current budget schema names this pool `quota.claude.fable`. Leave the field absent for general Claude models. Do not assign an arbitrary window ID to bypass the provider's applicable budget.

## Quota budgets

Each pool has two values:

- `reservePercent` declines linearly with the fraction of the window remaining before reset.
- `minRemainingPercent` stays fixed and sets the minimum allowance needed to start another run.

Available quota must be greater than the larger of those thresholds. For example, a 50% reserve halfway through its window reserves 25%; a 10% fixed minimum only becomes decisive once the declining reserve drops below 10%.

General Claude models use the five-hour and weekly pools. A Claude model with a dedicated allowance uses the five-hour pool and its dedicated pool. Codex models use the Codex weekly budget settings for each window reported by T3. The providers have independent budgets and execution slots.

`quota.maxAgeSeconds` limits the age of a reading. Missing, stale, or expired quota data causes a targeted refresh. If that fails, the last good reading for the same account keeps serving until it is older than `maxAgeSeconds` or predates a newer start, and Factory retries the provider after 1, 2, 5 and 10 seconds, then every 30 seconds, until a fresh reading arrives. Without a usable reading the affected models are unavailable; another provider can still proceed. These checks use T3's provider metadata, not a model prompt.

Manual overrides are described in [operations](operations.md#manual-runs). Existing jobs are allowed to finish when a reserve is reached.

## Projects

Each entry maps a Kanvil project to a T3 project and a local Git repository. `key` is the ticket prefix, such as `APP`; `githubRepo` is `OWNER/REPOSITORY`. `readyStatuses` and `doneStatuses` contain native Kanvil status categories, not custom state names or slugs. New worktrees start from `origin/<baseBranch>`.

Native `automationReady` must be true, `holdReason` must be empty, and the ticket must be unarchived. Native `difficulty` determines model eligibility; a conflicting difficulty label holds dispatch. The final native server readiness check retains description, acceptance criteria, duplicate and claim gates. The `sf` label is not required. Legacy `kanvil.readyLabel` settings are accepted and ignored. Manual runs cannot override native readiness or another worker's ownership. Dependencies, parent blockers, open children, existing branches, T3 activity, and open PRs are checked before dispatch. Disable a project with `enabled: false` instead of deleting it while it owns unfinished jobs.

`priorityLabels` is an ordered list of exact Kanvil label names, highest first, editable in Projects on the web or Mac app. For example, `["security", "compatibility"]` puts security tickets ahead of compatibility tickets, and both ahead of unmatched tickets. A ticket with multiple matching labels uses its highest rank. Ranks are compared across enabled projects: a first-ranked label in any project beats a second-ranked label elsewhere. Within each rank, the existing urgency, model order, project backlog size, rotation, and oldest-ticket rules apply. An empty list, the default, leaves urgency ordering unchanged. Labels never bypass readiness, blockers, classification, model capacity, or quota checks. Manual dispatch of a specific ticket remains explicit. Upstream reviews retain their existing precedence over ticket work.

`labelLimits` maps a Kanvil label to a limit for this project's runs; edit it under Runs at once by label in Projects. Each label has two radio buttons beside its limit: a lock for Full block and a play icon for Running block. Tooltips name both modes. Full block counts running and human-waiting runs until completion or dismissal, protecting resources such as simulators that may remain active while a run waits. Running block frees human-waiting slots. For example, `{ "app": { "limit": 2, "mode": "full" }, "web": { "limit": 3, "mode": "running" } }` protects two app resource slots while allowing three running web jobs. Existing numbers such as `{ "app": 2 }` retain Running block behavior; newly selected labels also start with Running block. Zero stops starts for that label. Both modes gate automatic starts, chain continuations and manual runs; only a manual run that overrides label limits may exceed them. Provider run limits and the waiting cap keep their separate policies. The default `{}` limits nothing.

## Workflow skills

The repository supplies scheduling and report handling. The operator supplies the agent's delivery and discovery workflows.

`factorySkill` points to a local delivery skill readable by the selected T3 runtime. It must cover ticket validation, scoped implementation, tests, PR review, CI, tracker updates, and the [merge authorization contract](operations.md#merge-authorization). The scheduler's prompt preserves human-only validation and deployment holds. A skill installation for one coding tool does not automatically make it available to another.

`discovery.promptFile` points to a local discovery invocation. [`prompts/discovery.md`](../prompts/discovery.md) is a starting point, not the discovery skill itself. Install a `discover-tickets` skill in each selected runtime or adapt the invocation to an equivalent workflow. It should validate findings, deduplicate the backlog, split large work into deliverable tickets, and apply the existing tracker labels. Discovery creates tickets, not implementations.

Projects may override `discoveryPromptFile`. `discovery.emptyCooldownHours` controls how long a project waits after a no-work discovery result. The scheduler appends the required JSON report path and format to each job prompt; the agent must use that contract to report completion or a human-input pause.

### Upstream release reviews

A project's `upstreams` list names GitHub repositories whose releases the project should review: `name`, `repo` (`OWNER/REPOSITORY`), `prereleases` (default `false`), and `firstBase`, the tag or commit the first review starts from. Each repository belongs to one project. `upstream.promptFile` is the review invocation; the scheduler replaces `{{name}}`, `{{repo}}`, `{{base}}` and `{{candidate}}` in it. [`prompts/upstream-review.md`](../prompts/upstream-review.md) is a starting point. `upstream.checkMinutes` (default 360) limits how often each repository's releases are read; an upstream's own `checkMinutes` overrides it, for example `1440` to review a busy repository at most once a day. `upstream.enabled` (default `false`) allows new reviews, independently of the top-level `enabled`; a config written before this setting existed keeps reviews paused until it is turned on.

### Inbox triage

The `inbox-triage` work kind checks untrusted public reports against a project's tickets and code, then applies only schema-validated fields. It follows the upstream pattern: each project names the inbox that feeds it, and a global section holds the switch and prompt.

- `projects[].inbox`: `{ kanvilId, label }` names the Kanvil project of untrusted reports about this project, and the label that marks a report for triage (default `intake`). The project is the inbox's target. Its `repoPath`, `githubRepo` and `baseBranch` provide the code and evidence links. A project has at most one inbox. An inbox may feed only one project, and it cannot itself be listed in `projects`, so inbox tickets are never dispatched for implementation.
- `projects[].scopes`: the project's native scope names. Required with `inbox`; the triage output may only choose scopes from this list.
- `projects[].inbox.maxPromotionsPerDay`: the most reports this inbox promotes in a rolling 24 hours. Absent or `null` is unlimited (the default). `0` pauses promotion for this inbox: triage keeps running and eligible reports wait with `promotion-queued`. Reports over the limit wait the same way and promote oldest first, with no human step, once the window or a raised limit allows. The web Triage page sets it in its settings (the cog beside Inboxes) with Paused, 5, 10, 20, 40, Other for any number, and Unlimited; the scheduler uses a saved value without a restart.
- `projects[].inbox.intakeHold`: the `holdReason` the intake puts on every new report, for example `Untrusted intake: human triage required`. Promotion ignores exactly this hold. Any other hold, or this one when `intakeHold` is unset, keeps the report out of promotion.
- `projects[].inbox.sensitivePaths`: globs, relative to the repository root, whose change needs the owner instead of promotion. Setting it replaces the built-in list: `.github/**`, `releases/**`, release, deploy and signing scripts, dependency manifests and lockfiles, and auth, credential, crypto, keychain and secret modules (`DEFAULT_SENSITIVE_PATHS` in [`src/triage.ts`](../src/triage.ts)).
- `triage.enabled` (default `false`) allows new triage runs, independently of the top-level `enabled`. `triage.promptFile` is the triage invocation, required once any project has an inbox. The scheduler replaces `{{project}}`, `{{scopes}}`, `{{key}}`, `{{nonce}}` and `{{report}}` in it. [`prompts/inbox-triage.md`](../prompts/inbox-triage.md) is a starting point.

The service reacts to Kanvil events. A report is waiting when it is open and unarchived, carries its inbox label, and has neither `triaged` nor `triage-failed`. Waiting reports from every inbox run oldest first, one at a time overall. Runs are held by the Claude quota budget like other jobs. They do not occupy a T3 run slot, so `concurrency.claude` does not gate them: triage runs even while Claude T3 jobs are off. The first configured Claude model is checked against that budget, and the run passes it to the CLI with `--model`, so the allowance that was checked is the one spent. A triage run creates no job, so each admission is recorded as Claude consumption: the next report needs a quota reading taken after it, which forces a refresh. Public reports cannot run past the reserve on one reading. The switch and the budget are rechecked before each report, so pausing triage stops the next run. Each run:

1. Writes the ticket export from the Kanvil client's live projections of the inbox and its project, making no Kanvil request. A disconnected or unsettled projection delays the run until the next pass.
2. Fetches the project's `baseBranch` from `origin` and extracts `git archive` of that commit into a new temporary snapshot:
   - `code/`: no `.git`, untracked or ignored files, or symlinks.
   - `tickets/target.jsonl`: every project ticket; open tickets and those closed within 180 days include the first 1,500 description characters.
   - `tickets/inbox.jsonl`: other non-spam inbox reports with their report text, each marked `"untrusted": true`.
   - `report.md`: the report being triaged.
3. Runs `claude -p` in the snapshot under the read-only sandbox in [SECURITY.md](../SECURITY.md#inbox-triage). The prompt is filled from `triage.promptFile`. Each run has a 300-second timeout and one retry after a timeout.
4. Validates the JSON result against the project's scopes and applies it to the report:
   - native kind, difficulty, priority and scopes;
   - the work-type, difficulty, scope, `triaged`, `verdict:<verdict>` and `validation:<validation>` labels, plus `injection-suspected` when flagged;
   - one comment quoting the summary, with evidence links to `githubRepo` at the snapshot commit;
   - a `duplicate` relation when `duplicateOf` names an exported ticket;
   - `cancelled` for spam.

   `automationReady`, `holdReason`, the project, and other statuses are never changed, and target tickets are never edited or commented on.

Invalid output, a CLI error, or a second timeout labels the report `triage-failed` and changes nothing else. Evidence locations missing from the snapshot are dropped. The snapshot is deleted after every run.

#### Promotion

An `actionable` verdict also returns a `proposal`: a title (at most 120 characters), problem (1,500), expected behavior (800), and 1 to 8 acceptance criteria (200 each), written by the model from what it verified in the code. Factory code keeps that output with a hash of the report text. On a later pass, a triaged `verdict:actionable` report without a final promotion label or a `holdReason` other than `intakeHold` goes through these checks in order:

1. **Gate.** Not `injectionSuspected`, not a duplicate, and a proposal is present. `research` needs the owner. A `bug` needs `confirmed-in-code`, a `feature` `confirmed-in-code` or `plausible`, and each needs at least one evidence location that exists in the snapshot (`validity`). Every proposal field must pass the lint rules `url`, `network` (host names, IP addresses, and exfiltration terms), `code`, `shell`, `secret`, `path` (absolute or outside the repository) and `directive` (agent-aimed phrases such as "ignore" or "system prompt"). Webhook wording is blocked by default. References to webhook sessions, sections, groups, disclosures, lists or rows pass only when the entire proposal uses the reviewed presentation vocabulary in `WEBHOOK_DISPLAY_WORDS`, fixed local list/navigation phrases, counts and ticket keys. Response and destination wording is allowed only in the phrases "server's session list response" (also "server session list response") and "View all destination". Unknown wording keeps the block; payloads and delivery instructions are not exempt. Every accepted display proposal still requires the safety review below. `workType: sec`, or an evidence or proposal path matching `sensitivePaths`, needs the owner.
2. **Daily limit.** Over `maxPromotionsPerDay`, the report is labelled `promotion-queued` and waits.
3. **Safety review.** A second run with no tools at all (`--tools ""`) in an empty directory sees only the rendered ticket and the report in nonce tags, and returns `{ safe, reason }`. It is admitted against the Claude budget like a triage run.
4. **Create.** One ticket in the target project, created with a request ID derived from the inbox ticket so a retry cannot create a second. The title is the proposal title. The description has Problem, Expected, Evidence links at the snapshot commit, and an origin line naming the inbox key; it carries no report text. The acceptance criteria are the proposal items. Native kind, difficulty, priority and scopes are set, with labels for the work type, difficulty and scopes plus `from-user-report`, and the project's first ready status. The inbox ticket is reread first, so a hold placed since the pass started stops the create. The ticket is created with `automationReady: false` and a verification `holdReason`, read back and checked field by field, and only then released to `automationReady: true` with no hold.
5. **Close the report.** The inbox ticket is retitled with the vetted title, related `duplicate` to the new ticket, labelled `promoted`, commented with the new key, and moved to `done`.

Outcomes on the inbox ticket:

| Label | Cause | Next step |
| --- | --- | --- |
| `promoted` | Created and verified | Factory delivers the new ticket |
| `promotion-queued` | Daily limit reached, or `0` | Promotes automatically when allowed |
| `promotion-blocked` | Gate, lint or validity failure, or an unsafe review; a comment names the reason | None; the report stays in the inbox |
| `needs-owner` | `research`, `sec`, or a sensitive path; `holdReason` names the check | The owner decides |
| `promotion-failed` | The readback did not match; the created ticket keeps its verification hold and is not ready | Never retried automatically |

An actionable report triaged before proposals existed, or whose report text has changed since, has no usable saved output, so it is triaged again first, replacing its earlier `verdict:` and `validation:` labels. Promotion runs in the triage passes, so the triage switch pauses it for every inbox.

Status reports a triage stream beside upstream reviews: `triageEnabled`, `triageDecision`, `triageResults`, and `triageStreams` with one row per inbox.
- Each `triageStreams` row holds the waiting count, `triage-failed` count, the running report, the oldest waiting report and its age, the `promoted`, `queued`, `blocked` and `needsOwner` counts, and the inbox's `limit` from the current config (`null` for unlimited). Rows come from the same live projections, with no extra requests, and show `synchronized: false` with null counts until a projection is current.
- Every finished report is recorded in the journal as a `triage` event: verdict, duplicate, promotion outcome, or failure reason. `triageResults` holds the 30 most recent.

The web Triage page has two lists. **Tickets** holds each promoted ticket, as the scheduler last read it from the tracker, until a run launches or it leaves the ready statuses: Start, the report it came from, and the same start provider, limit overrides, order, search, filters and multi-select as Session tickets; Start is disabled with the reason when the ticket's project is not configured or is disabled. **Activity** lists every recent result by its report key and outcome, never the report's own title; a promoted result's tag opens its ticket. Each inbox's queue and promotion counts sit on one line under Inboxes; the cog beside it opens the triage switch (also `triage-pause` / `triage-resume`), each inbox's limit (Unlimited, Paused, or N per day) and the prompt file. A start that does not go through is reported in the notification area. The Activity page can filter to triage events, and the menu bar app shows the queue rows.

Keep actual skill paths and deployment-specific prompt variants in your private configuration. These skills are not downloaded by the installer.
