# Security

T3 Factory can start coding agents with access to local repositories, authenticated providers, Kaneo, and GitHub. Operate it under an account whose permissions match the work you authorize. The `runtimeMode` setting controls the permission mode requested from T3.

## Access boundaries

T3 must be a loopback HTTP or HTTPS endpoint. Browser controls require OIDC sign-in or explicit device pairing. OIDC requires an exact group match, rechecks membership during use, and disables the pairing route. See [web access](docs/web-access.md) for the complete authentication behavior.

Host and origin validation, request limits, and dispatch deduplication supplement authentication. These do not turn a trusted local automation tool into a multi-tenant service. All authorized web users control the same factory and configuration; there are no per-user project permissions.

The agent receives scoped ticket instructions, but its configured runtime still has the permissions of its host account. Human-only validation, production changes, and merge holds remain part of the delivery workflow.

## Private files

Keep `.env`, local configuration, credentials, job state, logs, reports, review proofs, and machine runbooks out of Git. The repository ignores the standard root-level private filenames and `LOCAL.md`; arbitrary external paths remain the operator's responsibility. Use restrictive permissions for credentials.

Example files contain placeholders. Do not replace those placeholders with real deployment values and commit the result. Logs and screenshots can also reveal repository names, paths, ticket contents, and identity-provider details.

Before making a repository or fork public, inspect its full reachable Git history and hosted artifacts, including old branches, tags, releases, and CI logs. Deleting a value from the current tree does not remove it from earlier commits. Rotate any exposed credential before arranging a history cleanup. A source scan is not a guarantee that every secret has been found.

## Reporting a vulnerability

Use the hosting platform's private vulnerability-reporting feature if the repository offers it. Otherwise, ask a maintainer for a private reporting channel before sending exploit details or secrets. Do not include live credentials, session cookies, pairing links, or unredacted logs in a public issue.
