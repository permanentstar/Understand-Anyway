# Understand-Anyway

> An unofficial deployment & orchestration layer built on top of
> [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (MIT).
> It doesn't try to understand code better — it just helps you get it built,
> served, and synced across projects, anyway.

## What it is

Understand-Anyway turns [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
into a server-side, multi-project deployment tool:

- **Multi-project orchestration** — build knowledge graphs for many repos.
- **Pluggable LLM providers** — drive the semantic phase with any LLM CLI
  (claude, codex, gemini, local models, OpenAI-compatible), not bound to a host.
- **Read-only gateway / portal** — serve graphs and dashboards over a single
  shared public port.
- **Scheduled sync** — nightly/daily incremental rebuilds via cron.

## What it is NOT

If you just want to analyze a single repo interactively inside your IDE, use
[Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) directly
— that's its home turf. Understand-Anyway is for multi-project deployment and a
shared knowledge portal.

## Requirements

- Node.js **>= 20**
- pnpm **>= 9** (other package managers work for `npm install`, but this repo
  uses pnpm workspaces internally)
- The upstream [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
  plugin installed somewhere on disk (its absolute path becomes
  `UA_PLUGIN_ROOT` or the `--plugin-root` flag)

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/permanentstar/Understand-Anyway.git
cd Understand-Anyway
pnpm install
pnpm -r build

# 2. Discover available commands
node packages/cli/dist/cli.js --help

# 3. (Optional) install globally so `understand-anyway` is on PATH:
#    npm i -g @understand-anyway/cli
#    understand-anyway --help

# 4. Run the local delivery test suite (smoke-checks the whole stack
#    against an in-repo fixture project; expects upstream plugin on disk):
export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"
pnpm run delivery:local
```

For a step-by-step deployment walk-through (init a project, run a build,
publish a gateway release) see [docs/deployment.md](./docs/deployment.md).

## Relationship to upstream

- Understand-Anything is a **runtime dependency**; we don't bundle or
  redistribute its source or build artifacts. You install it separately.
- We rely on upstream's **public contracts** (graph schema, prompt/parser
  exports, pipeline scripts) and detect version drift rather than reverse-
  engineering its internals.

## CLI command shape

The CLI has two public shapes:

- **Flat commands** for one stable top-level action: `build`, `serve`, and
  `compat`. `batch-mapper-worker` is an internal worker entry spawned by the
  segmented mapper scheduler.
- **Verb-family subcommands** for resources with lifecycle actions:
  `dashboard <start|build-dist|stop|stop-all|status>` (plus a maintainer-only
  `dashboard dev` subcommand), `gateway <publish|set-stable|rollback|list|gc|start|stop>`,
  `project-state <publish|set-stable|rollback|list|gc>`, `notify nightly`,
  `repair <llm-failures|llm-graph-failures>`, plus the top-level lifecycle
  entries `init`, `review-graph-health`, and `run-review-hook`.

Use profiles for reusable parameter sets, not actions. For example,
`build --profile nightly --mapper-concurrency 1` is a build with one temporary
override; `gateway rollback` is an action and does not need a profile.

See [docs/deployment.md](./docs/deployment.md#4-cli-命令形态分层) for the full
CLI/profile/args rules and deployment examples.

## Security

Defaults to `--host 127.0.0.1` with **no authentication**. The gateway prints a
loud `[WARN]` to stderr if you bind it to a non-loopback host without an
`AuthProvider`. Before exposing it publicly, configure an `AuthProvider`
(OIDC/OAuth2 supported). Do not run it open to the internet unauthenticated.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Status

Pre-1.0; see [docs/ROADMAP.md](./docs/ROADMAP.md).
