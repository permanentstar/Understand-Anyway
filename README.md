# Understand-Anyway

English | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

> **Build, publish, serve, and keep many Understand-Anything projects in sync from one place.**

Understand-Anything is great at understanding a project. The missing piece for
real deployment is everything around it: repeated builds, versioned releases, a
shared read-only gateway, scheduled refresh jobs, and environment-specific
integrations. Understand-Anyway is that operational layer.

It does not replace the upstream analyzer. It wraps it in a multi-project CLI,
gateway, and release flow that teams can actually run.

## ✨ Core capabilities

- **Multi-project orchestration** — build and refresh many repositories under
  one operational model.
- **Read-only gateway and portal** — expose project graphs and dashboards
  behind a shared public entry.
- **Versioned runtime publishing** — publish immutable project and gateway
  releases, then switch `current` / `stable` atomically.
- **Scheduled sync** — run daily/nightly update flows instead of babysitting
  manual rebuilds.
- **Pluggable providers** — swap auth, org policy, record, LLM, embedding, and
  notify integrations without recompiling the core.
- **Incremental and backfill workflows** — support regular refreshes plus
  rebuild / recovery paths when state drifts.

## ✅ Good fit

- You want to host a shared knowledge portal for more than one repository.
- You need repeatable build / publish / rollback workflows instead of ad-hoc
  scripts.
- You want a stable OSS core with deployment-specific integrations provided as
  plugins.

## ❌ Not the right fit

- You only want single-repo interactive analysis inside an IDE.
- You want a new graph-analysis engine instead of an orchestration layer.
- You need the upstream plugin bundled into this repository.

## Quick start

Requirements:

- Node.js **>= 20**
- pnpm **>= 9**
- The upstream
  [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
  plugin installed somewhere on disk

```bash
git clone https://github.com/permanentstar/Understand-Anyway.git
cd Understand-Anyway
pnpm install
pnpm -r build

export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"
node packages/cli/dist/cli.js --help
```

For a full deployment walk-through, start with
[docs/deployment.md](docs/deployment.md). For an end-to-end local rehearsal,
see [docs/local-release-verification.md](docs/local-release-verification.md) or
run `pnpm run delivery:local`.

## Documentation map

- [Deployment architecture](docs/deployment.md) — runtime model, config
  layering, command families, and gateway versioning.
- [Deployment CLI manual](docs/deployment-cli.md) — `deploy.yaml` template and
  common operator scenarios.
- [Release test matrix](docs/release-tests/README.md) — local / external
  release-gate coverage and entry points.
- [Local release verification](docs/local-release-verification.md) — local
  registry rehearsal and clean-install verification.
- [Plugin API](packages/plugin-api/README.md) — provider SPI and runtime
  factory contracts.
- [Agent guide](AGENTS.md) — repo navigation, constraints, and verification for
  coding agents.

## Repository layout

```text
docs/                        # public docs, deployment notes, release tests
packages/cli/                # CLI entrypoints and orchestration wiring
packages/core/               # build pipeline and graph processing
packages/gateway/            # shared gateway, portal, runtime publishing
packages/plugin-api/         # provider SPI contracts
packages/provider-*/         # OSS providers and runtime adapters
scripts/                     # ops, release, regression, and script tests
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
