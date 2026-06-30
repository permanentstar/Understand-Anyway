# Contributing to Understand-Anyway

Thanks for opening this file — that already lowers our bug-fix latency. This
doc has two layers: a short onboarding path for first-time contributors, then
the maintainer notes used for day-to-day work on the OSS package set.

## Onboarding (read this once)

### Prerequisites

- **Node.js >= 20** and **pnpm >= 9** (the repo uses pnpm workspaces).
- A local checkout of the upstream
  [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) plugin
  is **optional** for most tasks; it's only required by the `compat` /
  `fixture-regression` jobs and by `pnpm run delivery:local`. Both code paths
  skip cleanly when the plugin is absent.
- macOS or Linux. The shell scripts under `scripts/` are bash; running them on
  native Windows is not supported (WSL works).

### Clone, install, build

```bash
git clone https://github.com/permanentstar/Understand-Anyway.git
cd Understand-Anyway
pnpm install
pnpm -r build
```

### How to run the checks locally

The CI gate runs these in order; you can reproduce it exactly with:

```bash
pnpm -r typecheck          # tsc --noEmit on every package
pnpm -r test               # vitest per package (no upstream plugin required)
pnpm -r build              # tsup esm + dts on every package
pnpm lint:isolation        # dashboard / main-pipeline boundary lint
pnpm lint:isolation:test   # self-test for the lint above
pnpm lint:scripts          # bash -n + shellcheck on scripts/*.sh
pnpm test:scripts          # behavior tests for scripts/ and scripts/lib/
```

Two best-effort CI jobs (`fixture-regression`, `compat-drift`) need the
upstream plugin on disk. They are not part of the blocking gate; if you do
have the plugin locally:

```bash
export UA_PLUGIN_ROOT="$HOME/.understand-anything/repo/understand-anything-plugin"
pnpm --filter @understand-anyway/core test fixture-regression
node packages/cli/dist/cli.js compat --plugin-root "$UA_PLUGIN_ROOT"
```

### Submitting a change

1. **Open an issue first** for anything bigger than a typo — it's faster to
   agree on the shape before code review.
2. **Branch from `main`**. Keep the diff focused; mixing unrelated cleanups
   into a feature PR is the #1 reason reviews stall.
3. **Write a real test** for the behavior you're changing. The repo standard
   is "tests assert behavior, not implementation"; happy-path-only "checkbox"
   tests are usually rejected at review.
4. **Open a PR against `main`**. The PR description should answer (a) what
   changed, (b) why, (c) how reviewers should verify. The PR template (if any)
   asks the same.
5. **CI must be green** on the gate jobs before merge. Best-effort jobs may
   stay red if upstream drift is the cause — flag it in the PR.

You do NOT need to bump a version or write a changelog entry. Maintainers
decide when to cut a release and drive the version bump manually — see
"Maintainer notes" below for the exact command.

### Commit / DCO

There is no Conventional Commits requirement, but please write a useful
subject line. We follow the
[Developer Certificate of Origin](https://developercertificate.org/) — by
opening a PR you assert your contribution is licensed under the project MIT
license; no separate CLA.

### Versioning

The six `@understand-anyway/*` packages share one version number
(monorepo lockstep). Contributors don't touch versions; maintainers cut
releases with `node scripts/release.mjs <patch|minor|major>` (see
"Releasing" under Maintainer notes).

### Repo layout (the 10-second tour)

```
packages/cli           # main CLI entry, dispatcher, subcommand families
packages/core          # multi-project orchestration over upstream
packages/gateway       # read-only gateway server + portal + versioning
packages/plugin-api    # SPI: provider interfaces only (no node:* runtime)
packages/provider-feishu-auth     # optional auth provider
packages/provider-feishu-sheets   # optional record provider
scripts/               # bash + node helpers: daily/nightly/refresh/aggregate
docs/                  # user-facing deploy + release-test docs
```

### Code of conduct

This project follows the
[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Be kind, assume good intent, take feedback gracefully. Report unacceptable
behavior via a GitHub issue with the `cc:conduct` label.

---

# Maintainer notes

End-user docs live in `README.md` and the deploy guide under `docs/`.

## Releasing

The six `@understand-anyway/*` packages are versioned in lockstep. There is no
Changesets flow and no automated release PR — maintainers cut a release by
running the release script from a clean `main`:

```bash
# Preview what would happen (does not touch anything):
node scripts/release.mjs patch --dry-run

# Actually cut a release:
node scripts/release.mjs patch          # 0.0.1 → 0.0.2
node scripts/release.mjs minor          # 0.0.1 → 0.1.0
node scripts/release.mjs major          # 0.0.1 → 1.0.0
node scripts/release.mjs 0.4.0          # explicit version

# Local Verdaccio rehearsal (no commit/tag/push, publish to local registry only):
node scripts/release.mjs patch --skip-git --registry http://127.0.0.1:4873
```

The script:

1. Refuses to execute on a dirty tree. Real public releases also require
   branch `main`, synced with `origin/main` (local `--skip-git` rehearsals skip
   the branch/sync check only).
2. Refuses to run if the six packages are not all at the same version, if the
   target version already exists in the target registry, or if the local
   baseline is older than the latest registry version.
3. Rewrites every `packages/*/package.json` `version` field.
4. Refreshes `pnpm-lock.yaml`, runs `pnpm -r build`, then runs package
   publish dry-runs in dependency order (aborts on failure).
5. `git commit -am "chore(release): v<next>"`, then creates an annotated
   `git tag -a v<next> -m "v<next>"`.
6. Publishes each package with `pnpm publish packages/<pkg-dir> --access public --no-git-checks`
   in dependency order.
7. `git push origin main --follow-tags`.

Escape hatches for verifying without touching the public npm registry or the
remote git:

- `--registry <url>` points registry preflight and package publishes at
  Verdaccio. Custom registries require `--skip-git`; public npm publishes always
  pin `https://registry.npmjs.org`.
- `--skip-git` skips commit/tag/push for local registry rehearsal.
- `--skip-publish --skip-git` prints and executes only the pre-publish build
  steps.

`--skip-git` still rewrites the six package versions and `pnpm-lock.yaml`.
After a local registry rehearsal, restore those files before returning to normal
development if you do not intend to keep the bumped version.

If the real publish step fails, the script stops before any git push. Do not
rerun `release.mjs` from that already-bumped commit: the version guard will
reject the same explicit version or advance a bump like `patch` to the next
version. Inspect npm, publish only the missing packages from the local release
commit with `pnpm --filter <pkg> publish --access public --no-git-checks`, then
run `git push origin main --follow-tags`. If no package was published, delete
the local tag/commit before another attempt.

Prerequisites for a real release:

- Logged in to npm with publish rights on the `@understand-anyway` scope
  (`npm whoami` → the account with access).
- Clean working tree on `main`, up-to-date with `origin/main`.
- `pnpm -r test` and `pnpm lint:isolation` green locally.

After the tag is pushed, cut a matching **GitHub Release** off `v<next>` and
paste release notes there — the repo intentionally does not ship a
`CHANGELOG.md` (GitHub Release notes are the source of truth).

## Adding a CLI command

Before adding a command, decide whether the new surface is an action, a reusable
parameter template, or a one-off override.

1. If it is one stable top-level operation over explicit inputs and outputs,
   add or extend a flat command. Existing examples: `build`, `serve`, `compat`.
2. If it changes lifecycle state for an existing resource, put it under that
   resource's verb-family subcommand. Existing examples: `dashboard start`,
   `gateway rollback`, `notify nightly`, `repair llm-failures`.
3. If it is only a reusable set of values, put it in a YAML profile. Do not add
   a command or subcommand for a parameter bundle.
4. If it is only a one-run override, keep it as an explicit CLI flag. CLI flags
   must override env, profile, deploy defaults, and built-in defaults.

The hard boundary: profile never expresses the action. `gateway rollback` is a
subcommand; `build --profile nightly` is a build with a parameter template.

## Profile design rules

Profiles are per-command-family parameter templates. They should remain stable
enough to be reused by cron, local repro, and docs examples.

| Command family | Profile fields belong here | Keep out of profile |
|---|---|---|
| `build` | `mode`, `excludeTests`, `outputLanguage`, optional LLM enablement, retry policy, batch tuning | repo path, `--include` repair targets, temporary low-concurrency overrides |
| `serve` / `dashboard start` | host/port defaults, portal/project route toggles, provider use-set, registry path | stop/status actions, one-off runtime token, local absolute debug dist unless documented |
| `notify nightly` | provider use-set and provider config | report path for the current run |
| `repair` | provider defaults for a repair run | choosing `llm-failures` vs `llm-graph-failures`, dry-run intent, max task cap for a one-off incident |
| `gateway` | normally none | publish, rollback, set-stable, retention decisions |

When adding a profile field, update all three places in the same change:

- `packages/cli/deploy.example.yaml`;
- `packages/cli/src/config/deploy.schema.json`;
- [deployment.md](./deployment.md), if the field affects user-facing deploy
  behavior.

## Debugging the dashboard frontend (dev)

`understand-anyway dashboard dev` is a **maintainer-only** foreground command
that runs the upstream plugin's Vite dev server against the same patched
workspace prod (`dashboard start`) builds from. It's the recommended path
when you're iterating on patches under
`packages/cli/src/dashboard-shared/dashboard-patch.ts` or chasing a regression
that only reproduces against an interactive HMR session.

### Usage

```bash
understand-anyway dashboard dev \
  --project <id> \
  --plugin-root /path/to/upstream/Understand-Anything-plugin
```

Flags:

- `--project` (required) — project id registered by `understand-anyway init`.
  The patched workspace lands under the project's conventional state root.
- `--plugin-root` (required) — upstream plugin checkout supplying the patch
  source.
- `--host` (default `127.0.0.1`) — Vite `--host`.
- `--port` (default `5173`) — Vite `--port`.
- `--no-open` — skip auto-opening the browser.

The command stays in the foreground; Ctrl-C sends SIGINT to Vite and exits.
There is no daemon, no pid file, no stop subcommand, and no gateway / project
registry integration. Use `dashboard start` for the prod-shaped daemon flow.

Use this command for UI patch iteration only. A normal reproduction loop is:

```bash
understand-anyway dashboard dev \
  --project mini-project \
  --plugin-root /path/to/upstream/plugin \
  --no-open
```

Then edit `packages/cli/src/dashboard-shared/dashboard-patch.ts` and refresh the
browser. If the issue only appears in the daemon/prod lifecycle, reproduce with
`dashboard start` instead; `dashboard dev` deliberately bypasses pid files,
single-instance reuse, gateway release pointers, and project registry routing.

### Discoverability

`dashboard dev` is intentionally **hidden from the main `--help` output** to
avoid first-time users running it instead of `dashboard start`. The source of
truth for its surface is this section + `dashboard --help-dev` (which currently
prints the same help as `dashboard --help` and is reserved for future
expansion).

### Isolation contract

The implementation lives at `packages/cli/src/dashboard-dev/**` and is bound by
the same isolation guard the deploy team relies on (see
`scripts/lint-isolation.mjs`):

- `dashboard-dev/**` may import only `dashboard-shared/**`,
  `@understand-anyway/plugin-api`, and Node stdlib;
- it must never import `dashboard-prod/**`, `gateway/**`, or any
  `runtime`/`registry`/`router` module from the main pipeline;
- `dashboard-prod/**` must never import `dashboard-dev/**`.

The CLI dispatcher (`packages/cli/src/cli.ts`) is the only main-pipeline file
allowed to reach into either dashboard zone, and it loads `dashboard-dev`
through a **dynamic import** so the directory can be deleted entirely without
breaking the main build:

```bash
# Smoke-test the deletion contract locally (CI does this in a future job):
mv packages/cli/src/dashboard-dev /tmp/ua-dashboard-dev-backup
pnpm -r build && pnpm -r test       # must stay green
mv /tmp/ua-dashboard-dev-backup packages/cli/src/dashboard-dev
```

If you find yourself wanting to share code between `dashboard-dev` and
`dashboard-prod`, push it into `dashboard-shared/` instead — that's why it
exists.

## CI isolation guard

`scripts/lint-isolation.mjs` is the deploy-surface boundary check. Run it before
committing any dashboard, gateway, or CLI dispatcher changes:

```bash
pnpm lint:isolation
```

The guard fails when code crosses one of these boundaries:

- `dashboard-dev/**` imports prod runtime, gateway, registry, or router code.
- `dashboard-prod/**` imports `dashboard-dev/**`.
- dashboard zones bypass `dashboard-shared/**` for shared code.
- the CLI dispatcher stops using dynamic imports for optional maintainer-only
  code.

Fix failures by moving shared logic into `dashboard-shared/**`, keeping
prod-only lifecycle code under `dashboard-prod/**`, and keeping dev-only Vite
helpers under `dashboard-dev/**`. Do not silence the guard with broad allowlists
unless the boundary itself changed and the docs explain the new rule.
