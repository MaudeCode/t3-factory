# Running the factory

The CLI works from source as `node src/main.ts COMMAND`, or as `t3-factory COMMAND` after installation. The web page and menu-bar app call the same backend.

## Common commands

| Command | Effect |
| --- | --- |
| `status` | Reads the local ledger and writes a current status snapshot. |
| `doctor` | Checks live integrations and reports a possible decision without dispatching. |
| `once --dry-run` | Previews a cycle using the current enabled state and policy. |
| `pause` / `resume` | Disables or enables new automatic work. |
| `run` | Runs the scheduler continuously. |
| `model-catalog` | Reads the models and options advertised by T3. |
| `config-get` | Prints validated scheduler configuration. |
| `config-save` | Reads `{ "base": ..., "config": ... }` on stdin; rejects stale edits and preserves JSONC comments where possible. |

Diagnostic commands can update local observations, but `doctor` and dry runs do not create tickets, PRs, tasks, or worktrees. A busy scheduler may hold the local cycle lock; stop its service before a long diagnostic run if necessary.

## Manual runs

```sh
t3-factory dispatch --ticket APP-123 --model default-model --dry-run
t3-factory dispatch --ticket APP-123 --model default-model
t3-factory dispatch --override-limits
```

Use your own ticket key and configured model ID. Omitting the ticket selects the next eligible one. `--model auto` selects from eligible automatic presets; an explicit model ID can select a manual-only preset. Manual dispatch starts ticket work, never discovery.

Manual jobs can overlap other runs and can start while automatic dispatch is paused. `--override-limits` skips the scheduler's idle and quota thresholds for that run. It cannot select a model whose applicable allowance is exhausted, even when the override is enabled. Automatic model selection skips exhausted presets and tries the next eligible model. It does not bypass provider-enforced limits, difficulty ceilings, readiness, dependencies, duplicate ownership, or merge gates. Manual Codex runs already omit the scheduler's idle and reserve checks; they still require valid provider quota information.

If a specific manual ticket lacks the configured readiness label, the web page offers **Cancel** or **Run anyway**. Confirmation skips only that label requirement for that ticket and request; it does not add a label or change automatic scheduling. Status, classification, dependencies, model limits, quota availability, duplicate ownership, and merge gates remain enforced. CLI users can make the same explicit choice with `dispatch --ticket APP-123 --allow-missing-ready-label`.

## Automatic scheduling

Tickets are considered in priority order: urgent, high, medium, low, then no priority. Within a priority, the highest-ranked available model with a sufficient difficulty ceiling gets first choice. Project ticket counts, rotating ties, and oldest-ticket order break remaining ties.

Claude and Codex have separate simultaneous-run limits, configured under Automation. Each defaults to one. Set either limit to zero to turn off automatic starts for that provider, including discovery; manual starts remain available. Active factory runs, including manual runs, count toward the limit for new automatic starts. Waiting runs free capacity. Lowering a limit holds new starts until there is room; it does not stop running work. Each stream checks that provider's personal activity in T3. Scheduler prompts do not count as personal activity; user replies do. Local commands, tests, and PR waits consume no provider turn and do not keep extending the idle timer. A child-agent marker is resolved against its live thread: a stale idle child cannot keep a completed parent active. Live or unresolved workers remain protected; native idle children without a run lifecycle retain protection while the parent or child has changed within the monitoring timeout. The idle clock retains actual messages, human responses, and completion times. The factory does not track usage outside T3.

List non-Factory workflows that run autonomously in `t3.autonomousThreadIds`. Their activity and linked child tasks are excluded from the personal-idle gate, even while executing. This does not waive subscription quota checks or change Factory run limits. Changing the list rebuilds the personal-activity clock so an excluded workflow cannot leave a stale blocker behind.

A job waiting for human input releases its provider slot. Active turns and background workers keep it. Parked jobs are unlimited unless `maxWaitingPRs` sets a cap. A factory-owned passive monitor that exceeds the configured timeout is stopped and confirmed inactive before being parked. Personal sessions are never stopped by this rule.

Discovery runs only when there are no eligible tickets and no otherwise-ready tickets waiting for difficulty classification. It uses an available automatic model and a separate task and worktree. A no-work result starts the project's configured discovery cooldown.

## Completion and recovery

A ticket is complete only after its report, Kaneo Done status, and merged PR evidence agree. A model turn ending or a PR opening is not completion. Failed starts and unexplained endings park for inspection instead of triggering blind retries.

After verified completion, the scheduler automatically removes the assigned workspace. It closes passive monitors, detaches the idle T3 workspace binding, closes the completed thread's idle T3 terminals, and removes the clean Git worktree through T3 without force. It rechecks the assigned workspace, merged branch and head, ticket status, thread activity, shared workspace references, and running process working directories. Dirty, unmerged, resumed, shared, or active work is preserved, as is a workspace whose T3 terminal is still running a command or that any other process still uses. A merged PR verifies the workspace when its head branch matches or its head commit equals the local branch tip, so a branch pushed under another name still counts. When the workspace directory is already gone and Git no longer registers it, cleanup only detaches the binding. Cleanup retries safely after a failure, retains the conversation and completion history, and never runs during diagnostics or dry runs. Discovery workspaces are eligible only when their clean head is already part of the release branch.

Completed jobs retain history but release their live ticket claim. Reopened tickets can run again when historical tasks are inactive and unchanged, and historical branch tips still match verified merged PRs. New work and open PRs continue to block duplicates.

The scheduler records a dispatch before submitting it to T3. Restarting reconciles the recorded task IDs. Uncertain submissions are not replaced with new tasks automatically. Web dispatches also use persistent request IDs, so repeated taps cannot create a second accepted request.

Explicitly settling an inactive factory task in T3 dismisses it from the factory view and releases its ticket claim. A later launch creates a fresh task and worktree. The old worktree is preserved; open PRs, changed branches, or uncommitted changes still block duplicate work. Automatic T3 settled status alone is not a dismissal.

Stopping the service does not stop T3 work. Preserve the ledger, reports, tasks, and worktrees when investigating an uncertain run. T3 remains the place for notifications, human questions, and manual resumption.

## Review and merge

The configured `factorySkill` is the delivery workflow. For every ticket dispatch, Factory reads that file and includes its complete current text in the prompt, along with its source path for resolving references. Skill edits apply to the next dispatch without restarting Factory. A missing or empty skill blocks dispatch.

Factory authorizes merges when the supplied skill's current gates pass. The skill controls local review, Codex review, CI, regression proof, device validation, and holds. Factory adds no separate human merge-confirmation requirement. Existing threads retain the prompt they received until given updated instructions.

Automatic ticket runs replace the routine physical-phone checkpoint with agent-owned visual validation. The agent runs the changed build in the existing browser or simulator workflow, exercises the acceptance criteria, captures and inspects screenshots, and records and inspects video when static images cannot prove the interaction. Visual defects must be fixed and the evidence attached to the PR. Missing essential validation remains a concrete blocker; CI, review, regression proof, and holds still apply. Automatic runs do not request a user phone check. Manual runs keep the supplied skill's phone/device workflow, even when their model selection is `auto`.

When the supplied skill calls for Codex clean-review evidence, these helpers record the review baseline and check for a fresh reaction:

```sh
t3-factory approval-record OWNER/REPOSITORY PR_NUMBER /absolute/path/to/review-proof.json
t3-factory approval-check OWNER/REPOSITORY PR_NUMBER /absolute/path/to/review-proof.json
```

Only a fresh PR-body `+1` reaction from the verified Codex account, with an unchanged recorded head, satisfies the helper's clean-review evidence check. Old reactions, another actor, or a changed head do not. The skill also handles Codex reviews that contain findings and determines when a correction head needs another review.

The helper supplies review evidence, not the whole merge gate. Follow the supplied skill and use its expected-head guard when merging.

## macOS services and files

The default service label is `local.t3-factory`; `.web` identifies the web service. Substitute your `T3_FACTORY_SERVICE_LABEL` if overridden.

```sh
launchctl print "gui/$(id -u)/local.t3-factory"
launchctl bootout "gui/$(id -u)/local.t3-factory"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.t3-factory.plist"
```

The standard installer uses these paths:

| Path | Purpose |
| --- | --- |
| `~/.local/share/t3-factory/app` | Installed runtime and private `.env` copy |
| `~/.local/bin/t3-factory` | CLI launcher |
| `~/Library/LaunchAgents/<label>.plist` | User service definition |
| `~/Library/Logs/t3-factory*.log` | Scheduler and web logs |
| `<stateDir>/state.sqlite` | Job ledger |
| `<stateDir>/status.json` | Status snapshot |
| `<stateDir>/reports` | Agent reports |
| `<stateDir>/web-requests` | Web dispatch request records |

Re-run the relevant installer after source or environment changes. Existing configuration, credentials, and state are preserved. OIDC login sessions are stored privately under `stateDir` and survive web-service restarts. Caddy is operated separately; see [web access](web-access.md).
