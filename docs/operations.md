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

Manual jobs can overlap other runs and can start while automatic dispatch is paused. `--override-limits` skips the scheduler's idle and quota thresholds for that run. It does not bypass provider-enforced limits, difficulty ceilings, readiness, dependencies, duplicate ownership, or merge gates. Manual Codex runs already omit the scheduler's idle and reserve checks; they still require valid provider quota information.

## Automatic scheduling

Tickets are considered in priority order: urgent, high, medium, low, then no priority. Within a priority, the highest-ranked available model with a sufficient difficulty ceiling gets first choice. Project ticket counts, rotating ties, and oldest-ticket order break remaining ties.

Claude and Codex have separate simultaneous-run limits, configured under Automation. Each defaults to one. Active factory runs, including manual runs, count toward the limit for new automatic starts. Waiting runs free capacity. Lowering a limit holds new starts until there is room; it does not stop running work. Each stream checks that provider's personal activity in T3. Scheduler prompts do not count as personal activity; user replies do. Inactive personal CI watchers do not keep extending the idle timer. The factory does not track usage outside T3.

A job waiting for human input releases its provider slot. Active turns and background workers keep it. Parked jobs are unlimited unless `maxWaitingPRs` sets a cap. A factory-owned passive monitor that exceeds the configured timeout is stopped and confirmed inactive before being parked. Personal sessions are never stopped by this rule.

Discovery runs only when there are no eligible tickets and no otherwise-ready tickets waiting for difficulty classification. It uses an available automatic model and a separate task and worktree. A no-work result starts the project's configured discovery cooldown.

## Completion and recovery

A ticket is complete only after its report, Kaneo Done status, and merged PR evidence agree. A model turn ending or a PR opening is not completion. Failed starts and unexplained endings park for inspection instead of triggering blind retries.

Completed jobs retain history but release their live ticket claim. Reopened tickets can run again when historical tasks are inactive and unchanged, and historical branch tips still match verified merged PRs. New work and open PRs continue to block duplicates.

The scheduler records a dispatch before submitting it to T3. Restarting reconciles the recorded task IDs. Uncertain submissions are not replaced with new tasks automatically. Web dispatches also use persistent request IDs, so repeated taps cannot create a second accepted request.

Stopping the service does not stop T3 work. Preserve the ledger, reports, tasks, and worktrees when investigating an uncertain run. T3 remains the place for notifications, human questions, and manual resumption.

## Merge authorization

The agent records a baseline immediately after opening a PR and after each new head, before waiting for Codex review:

```sh
t3-factory approval-record OWNER/REPOSITORY PR_NUMBER /absolute/path/to/review-proof.json
t3-factory approval-check OWNER/REPOSITORY PR_NUMBER /absolute/path/to/review-proof.json
```

Only a fresh PR-body `+1` reaction from the verified Codex account, with an unchanged recorded head, satisfies this authorization route. Old reactions, another actor, or a changed head do not. Otherwise, the workflow requires explicit structured user approval.

The helper checks authorization evidence only. The delivery workflow must also finish CI, resolve review findings, and satisfy required human validation. Explicit holds remain binding. Recheck the head and approval immediately before merging and use `gh pr merge --match-head-commit` to guard the approved SHA.

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

Re-run the relevant installer after source or environment changes. Existing configuration, credentials, and state are preserved. The web service holds login sessions in memory, so restarting it requires another sign-in. Caddy is operated separately; see [web access](web-access.md).
