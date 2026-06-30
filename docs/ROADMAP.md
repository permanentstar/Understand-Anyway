# Understand-Anyway Roadmap

> Where Understand-Anyway is today and where it's going. Living document — open
> a PR to propose changes.

## Where we are

The first OSS release ships the orchestration layer described in
[README.md](../README.md):

- 6 workspace packages — `cli`, `core`, `gateway`, `plugin-api`,
  `provider-feishu-auth`, `provider-feishu-sheets` — all at `0.0.1`.
- Deterministic multi-project build pipeline (scan → batch → merge → wrap).
- Read-only gateway with token-gated data API, portal landing page, and
  per-project `/project/<id>/` routing.
- Pluggable providers (Auth / Record / LLM / Embedding / Notify / OrgPolicy)
  wired through `@understand-anyway/plugin-api`; the open-source default for
  every slot is a Noop or local-file implementation.
- Incremental + backfill build modes with explicit graph-version compatibility
  checks (incompatible graph aborts; operator runs a full build).
- Gateway-level versioning: immutable `releases/<vid>/`, atomic `current` /
  `stable` symlinks, `rollback`, `gc`, and an `audit.ndjson`.
- Project-level versioning with `current` / `stable` symlinks, `publish`,
  `set-stable`, `list`, `gc` (and `rollback` — see "Near-term" below).
- Scheduled-sync helpers under [`scripts/`](../scripts/): daily / nightly
  update + aggregate.
- CI: typecheck + tests + build + isolation lint + scripts lint + a leak
  guard that fails on accidental private-fingerprint leaks.

## What we've intentionally kept out

- **Single-repo interactive analysis inside an IDE.** That is what the
  upstream [`Understand-Anything`](https://github.com/Egonex-AI/Understand-Anything)
  plugin does and we don't try to compete with it.
- **Bundling upstream source or build artifacts.** Upstream is a runtime
  dependency installed by the operator; we depend on its public contracts
  (graph schema, prompt/parser exports, pipeline scripts).
- **Vendor SDKs in the core.** Every external integration (LLM provider, SSO,
  record sink, IM notify) sits behind a plugin-api interface; the open-source
  default never imports a vendor SDK.

## Near-term (next minor)

| Item | Why |
|---|---|
| `project-state rollback` + `audit.ndjson` | Make the project-level version model isomorphic with the gateway-level one. |
| README `Quick start` / `Requirements` | Lower onboarding cost for external contributors. |
| `CONTRIBUTING.md` (top-level) | Today contribution rules live under `docs/contributing.md`; we want the top-level discovery path. |
| `plugin-api/README.md` with the SPI factory naming table | Today the provider-factory export contract is only discoverable by reading source. |
| Consistent `understand-anyway[<scope>]:` error message prefix | Several styles exist today — pick one and bring everything to it. |

## Later (post-1.0 / when demand surfaces)

| Item | Why it's parked |
|---|---|
| Multi-group aggregate gateway routing (proxy lib + WS) | Only worth doing once projects-per-deployment outgrows a single shared port. |
| MCP server front end | Frame for AI clients to call into the read-only API; pending broader MCP adoption. |
| First-class TypeScript publishing for `plugin-api` (independent versioning) | Today all six packages share one version via manual lockstep (`scripts/release.mjs`); SPI may want its own cadence after `0.1`. |
| Public release pipeline (npm publish via `scripts/release.mjs` from a maintainer machine) | Manual release script is wired; pending the first public maintainer credential and a shakedown release. |

## Upstream coupling

Understand-Anyway treats the upstream plugin's exports as a contract and
detects drift rather than reverse-engineering it. The current reuse matrix
lives at [`docs/contributing.md`](./contributing.md#upstream-api-reuse) and is
re-verified by the `compat-drift` CI job (best-effort; skips cleanly when no
upstream plugin is installed locally).

Active reuse covers: `validateGraph`, `saveGraph`/`saveMeta`/`saveConfig`,
`detectLayers`, `generateHeuristicTour`, `buildFileAnalysisPrompt` /
`parseFileAnalysisResponse`, `buildLayerDetectionPrompt` /
`parseLayerDetectionResponse` / `applyLLMLayers`,
`buildProjectSummaryPrompt` / `parseProjectSummaryResponse`,
`buildTourGenerationPrompt` / `parseTourGenerationResponse`,
`getChangedFiles`, `sanitizeGraph` / `autoFixGraph` (implicit),
`SemanticSearchEngine` / `cosineSimilarity`,
`LanguageRegistry` / `FrameworkRegistry` / builtin extractors.

A small number of upstream helpers are intentionally not re-used at the OSS
top level (the scan subprocess already calls them, or git diff already covers
the same correctness boundary). These cases are annotated in source jsdoc and
re-verified by CI.

## Feedback

Open an issue or a PR if you think a roadmap item is mis-prioritized, missing,
or should be moved between "Near-term" and "Later".
