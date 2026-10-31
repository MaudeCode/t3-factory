# Security

T3 Factory can start coding agents with access to local repositories, authenticated providers, Kanvil, and GitHub. Operate it under an account whose permissions match the work you authorize. The `runtimeMode` setting controls the permission mode requested from T3.

## Access boundaries

T3 must be a loopback HTTP or HTTPS endpoint. Browser controls require OIDC sign-in or explicit device pairing. OIDC requires an exact group match, rechecks membership during use, and disables the pairing route. See [web access](docs/web-access.md) for the complete authentication behavior.

Host and origin validation, request limits, and dispatch deduplication supplement authentication. These do not turn a trusted local automation tool into a multi-tenant service. All authorized web users control the same factory and configuration; there are no per-user project permissions.

The agent receives scoped ticket instructions, but its configured runtime still has the permissions of its host account. Human-only validation, production changes, and merge holds remain part of the delivery workflow.

## Inbox triage

[Inbox triage](docs/configuration.md#inbox-triage) gives untrusted public text to a model. Each configured inbox gets the same boundary. Its safety rests on capability limits; the hardened prompt is a second layer.

- **No writes or actions.** The CLI runs with `--restricted --safe-mode --tools "Read,Grep,Glob" --permission-mode dontAsk --strict-mcp-config --disable-slash-commands` and `--settings` that allow reads only inside the snapshot. It has no shell, network, MCP, task, or write tools, no T3 thread, and no `--add-dir`.
- **No reads outside the snapshot.** The working directory is a fresh snapshot of the target project's release commit and the ticket export; symlinks are removed. `--restricted` confines file tools to it. The child environment is an allowlist that excludes Kanvil, GitHub, and T3 credentials. The factory itself performs the only network step, a `git fetch`, before the run.
- **One output channel.** The model can only return a JSON object. Factory code rejects extra keys, out-of-range values and scopes outside the target project's `scopes`, checks `duplicateOf` and evidence against the snapshot, and applies a fixed allowlist to the report in its inbox project. The summary is quoted with links, images, HTML, and fences removed, in a comment visible only to project members. Reporters never see triage output; a future reporter-facing status must not carry triage text.
- **Other reports are data too.** Inbox entries in the export are marked untrusted and grant no extra capability.
- **Bounded cost.** One run at a time across all inboxes, a 300-second timeout, and the Claude quota budget. The budget is rechecked before each report, against a reading taken after the previous triage run, so a flood of reports cannot spend past the reserve.
- **Source follow-up.** An actionable plausible bug with valid evidence, no duplicate and no injection finding gets one additional read-only inspection before promotion eligibility is decided. This run uses the same sandbox, schema, budget admission and operator-hold checks. Completion is persisted with the report-specific output and recovery plan; a still-plausible actionable result may proceed with source evidence, while unsupported or evidence-free findings stay blocked. Every promoted ticket still needs the independent safety review and the remaining content and ownership gates.
- **No cross-project dispatch.** An inbox project can never be a delivery project, and each inbox feeds exactly one project; config validation enforces both.

### Promotion trust boundary

[Promotion](docs/configuration.md#promotion) turns an actionable report into a ready ticket that an agent with full tools implements, so no report text crosses into it.

- **Rendered by code.** The promoted ticket is a fixed template filled from the schema-bounded proposal, code-rendered evidence links, and the inbox key. The proposal is the triage model's own description of what it verified; the report itself is never copied.
- **Deterministic lint.** URLs, host names and IP addresses, data-exfiltration words, code, shell-like text, secret and credential words, absolute or outside paths, and agent-aimed directives block promotion. Webhook presentation references have a conservative exception only when every proposal field uses the reviewed display vocabulary and local list/navigation phrases, counts and ticket keys; unknown or data-bearing wording retains the block. Other lint rules still inspect the original text. Security work, `research`, and changes to CI, release, dependency, and auth paths need the owner.
- **Independent review.** A second model run with no tools, no snapshot and the same minimal environment compares the rendered ticket with the raw report and must answer `safe`.
- **Idempotent and verified.** One request ID per inbox ticket. The ticket is created held and not ready, read back, and released only when every field matches; a mismatch leaves it held and stops promotion without retry. A hold on the inbox report stops promotion.
- **Delivery guard.** A `from-user-report` ticket's dispatch prompt limits the run to the acceptance criteria in source and test files. Besides the factory's delivery workflow, it allows only the documented build and test commands, never a command taken from the ticket; it forbids opening the inbox ticket or fetching URLs, and stops for the owner before CI, release, dependency, credential, or auth edits.
- **Bounded rate.** `inbox.maxPromotionsPerDay` caps each inbox; `0` pauses it.

`doctor` runs the real CLI with the exact triage flags against a canary file outside a snapshot and a shell command. It fails unless both are refused. Run it after every Claude CLI upgrade.

## Private files

Keep `.env`, `web-sessions.json`, local configuration, credentials, job state, logs, reports, review proofs, and machine runbooks out of Git. The repository ignores the standard root-level private filenames and `LOCAL.md`; arbitrary external paths remain the operator's responsibility. Use restrictive permissions for credentials.

Example files contain placeholders. Do not replace those placeholders with real deployment values and commit the result. Logs and screenshots can also reveal repository names, paths, ticket contents, and identity-provider details.

Before making a repository or fork public, inspect its full reachable Git history and hosted artifacts, including old branches, tags, releases, and CI logs. Deleting a value from the current tree does not remove it from earlier commits. Rotate any exposed credential before arranging a history cleanup. A source scan is not a guarantee that every secret has been found.

## Reporting a vulnerability

Use the hosting platform's private vulnerability-reporting feature if the repository offers it. Otherwise, ask a maintainer for a private reporting channel before sending exploit details or secrets. Do not include live credentials, session cookies, pairing links, or unredacted logs in a public issue.
