# T3 Factory

T3 Factory turns a ready Kaneo ticket into a coding run in T3 Code. It selects work by priority, matches it to an available model, and creates a separate task and Git worktree for each ticket.

Control the queue from the command line, a macOS menu-bar app, or a web page. Automatic runs wait for provider activity and quota checks; manual runs let you choose a ticket and model directly.

## What it does

- Ranks models and limits each one to a maximum ticket difficulty.
- Sets independent simultaneous-run limits for Claude and Codex.
- Reserves subscription quota according to the time remaining before reset.
- Skips blocked, unclassified, or already-owned tickets.
- Releases a provider's slot when a job needs human input, while preserving its task and worktree.
- Starts discovery work when the ready queue is empty.
- Protects web controls with group-restricted OIDC sign-in or device pairing.

Ticket delivery follows a configured software-factory skill. Merging requires verified current-head Codex approval or explicit user approval, plus the workflow's review, CI, and human-validation gates.

## Requirements

The supported deployment is macOS 14 or later with Node.js 24.13 or later, Git, and the GitHub CLI. You also need a compatible T3 Code server running locally, authenticated model providers, a Kaneo workspace, and local Git repositories registered in both applications.

This is an early integration with T3's application APIs. Compatibility depends on the HTTP and RPC contracts in [the integration guide](docs/development.md#t3-compatibility), including orchestration protocol v2, provider usage reporting, and worktree launch. T3 builds from before orchestration protocol negotiation are not supported. It is not a standalone model runner or an official T3 Code product.

Delivery and discovery skills are supplied by the operator; they are not bundled in this repository. See [the workflow requirements](docs/configuration.md#workflow-skills).

## Get started

```sh
npm ci
cp config.example.jsonc config.jsonc
cp .env.example .env
chmod 600 config.jsonc .env
```

Fill in your own project mappings, local paths, credentials, and models using the [setup guide](docs/setup.md). The example configuration starts with automation disabled. A paused scheduler can still accept explicit manual runs.

## Documentation

| Guide | Contents |
| --- | --- |
| [Setup](docs/setup.md) | Credentials, project mappings, validation, and macOS installation |
| [Configuration](docs/configuration.md) | Models, budgets, projects, and workflow skills |
| [Running the factory](docs/operations.md) | CLI commands, queue behavior, pauses, and recovery |
| [Web access](docs/web-access.md) | OIDC, pairing, HTTPS, and reverse proxies |
| [Development](docs/development.md) | Tests, source layout, and T3 compatibility |
| [Security](SECURITY.md) | Trust boundaries, private files, and disclosure |

Keep machine-specific deployment notes in `LOCAL.md`, which is ignored by Git. Deployment values belong in `.env`; scheduler settings belong in your private `config.jsonc`.

## License

[MIT](LICENSE).
