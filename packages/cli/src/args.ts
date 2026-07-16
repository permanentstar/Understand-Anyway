/**
 * Minimal argument parser for the understand-anyway CLI.
 *
 * Implemented commands:
 *   serve   start the read-only gateway for a registered project
 *   build   deterministic graph build modes (full / incremental / resume / backfill)
 * Scheduling commands land in later milestones.
 */

export type RecordProviderName = "local" | "feishu-sheets";
export type BuildMode = "full" | "incremental" | "resume" | "backfill";
export type BatchMode = "auto" | "full" | "segmented";

export interface ServeArgs {
  command: "serve";
  host: string;
  port: number;
  /** Whether --host was explicitly provided; needed so default values do not shadow config. */
  hostExplicit?: boolean;
  /** Whether --port was explicitly provided; needed so default values do not shadow config. */
  portExplicit?: boolean;
  /**
   * Public `serve --project <id>` entry. `stateDir / distDir / token` are
   * populated by project/gateway conventions or by the hidden daemon parser.
   */
  projectId: string | null;
  stateDir: string;
  distDir: string;
  token: string;
  projectRoot: string | null;
  /** Record sinks to enable, in order. Empty = no recording (Noop). */
  recordProviders: RecordProviderName[];
  /** Package name of an AuthProvider factory to dynamically load. Null = NoAuth. */
  authProvider: string | null;
  /** Package name of an OrgPolicyProvider factory to dynamically load. Null = AllowAll. */
  orgPolicy: string | null;
  /** Package name of an EmbeddingProvider factory to dynamically load. Null = disabled. */
  embeddingProvider: string | null;
  /** When true, serve the portal landing page (requires a registry, flag or config). */
  portal: boolean;
  /** Package name of a PortalAssets factory to dynamically load (optional, portal only). */
  portalAssets: string | null;
  /** When true, serve /project/<id>/ routes (requires a registry, flag or config). */
  projectRoute: boolean;
  /** Project registry JSON path, shared by portal + project routing. */
  registryPath: string | null;
  maintenanceEnabled: boolean;
  maintenanceScope: "global" | "project";
  maintenanceProjectIds: string[];
  maintenanceTitle: string | null;
  maintenanceMessage: string | null;
  maintenanceEta: string | null;
  maintenanceContact: string | null;
  /** Unified YAML deploy config file/dir (providers + record + profiles). Null = discover. */
  config: string | null;
  /** Named profile in the config's `profiles` map to apply (layer 3). */
  serveProfile: string | null;
}

export interface BuildArgs {
  command: "build";
  /** Required project id, resolved through `<projectsRoot>/gateway/config/projects.json`. */
  projectId: string;
  /** Filter test files out of the graph. Null = defer to config/default true. */
  excludeTests: boolean | null;
  /** Override upstream plugin location (else env/home discovery). */
  pluginRoot: string | null;
  /** Output language for summaries/descriptions. Null = config/deploy-profile/default. */
  outputLanguage: string | null;
  /** Build intent; C5 keeps public modes template-oriented. */
  mode: BuildMode;
  /** Explicit repair targets for --backfill. */
  includePaths: string[];
  /** Unified YAML deploy config file/dir. Null = discover. */
  config: string | null;
  /** Deployment environment profile from deployProfiles.*. */
  deployProfile: string | null;
  /** Enable optional LLM enrichment. Null = unset (CLI defers to config/default off). */
  llmAnalysis: boolean | null;
  /** Provider package name for LLM enrichment. Null = unset (defers to config). */
  llmProvider: string | null;
  /** LLM provider profile from llmProfiles.*. */
  llmProfile: string | null;
  /** Provider package name for semantic embeddings. Null = unset. */
  embeddingProvider: string | null;
  /** Ordered model candidates for provider requests. Empty = provider default. */
  llmModelCandidates: string[];
  /** Fail the build on LLM provider/parse failures. Null = unset (defers to config/default off). */
  llmRequired: boolean | null;
  /** CLI-supplied retry policy overrides for the LLM call. Null fields = defer to config/defaults. */
  llmRetry: LlmRetryArgs;
  /** Phase 2 batch-mode selector. */
  batchMode: BatchMode;
  /** Batches per spawned mapper segment. Null = host-aware default (auto only). */
  mapperBatchCount: number | null;
  /** Parallel mapper segments. Null = host-aware default (auto only). */
  mapperConcurrency: number | null;
}

export interface LlmRetryArgs {
  maxAttempts: number | null;
  initialBackoffMs: number | null;
  maxBackoffMs: number | null;
}

export interface CompatArgs {
  command: "compat";
  /** Override upstream plugin location (else env/home discovery). */
  pluginRoot: string | null;
  /** Emit the machine-readable report (or fresh baseline with --update) as JSON. */
  json: boolean;
  /** Print a fresh baseline extracted from the installed upstream instead of diffing. */
  update: boolean;
}

export type DashboardAction = "start" | "build-dist" | "stop" | "stop-all" | "status" | "dev";

interface DashboardCommonArgs {
  command: "dashboard";
}

export interface DashboardStartCliArgs extends DashboardCommonArgs {
  action: "start";
  projectId: string;
  projectRoot: string | null;
  host: string;
  port: number;
  /** When omitted, dashboard-prod auto-generates a 32-byte hex token. */
  token: string | null;
  noOpen: boolean;
  config: string | null;
  serveProfile: string | null;
  portal: boolean;
  projectRoute: boolean;
  registryPath: string | null;
  /** Upstream Understand-Anything plugin root; required when dashboard-dist/ must be built. */
  pluginRoot: string | null;
  /** When true, force-rebuild <stateRoot>/dashboard-dist/ even if present. */
  rebuildDashboard: boolean;
}

export interface DashboardBuildDistCliArgs extends DashboardCommonArgs {
  action: "build-dist";
  projectId: string;
  pluginRoot: string;
  rebuildDashboard: boolean;
}

export interface DashboardStopCliArgs extends DashboardCommonArgs {
  action: "stop";
  projectId: string;
}

export interface DashboardStopAllCliArgs extends DashboardCommonArgs {
  action: "stop-all";
  projectsRoot: string;
}

export interface DashboardStatusCliArgs extends DashboardCommonArgs {
  action: "status";
  projectId: string | null;
  projectsRoot: string | null;
}

/**
 * Hidden maintainer command: `dashboard dev`. Foreground-only Vite server
 * spawned against the same patched workspace prod uses (D3). See D3-dev in
 * the master plan; surfaced via `dashboard --help-dev`, never the default
 * help.
 */
export interface DashboardDevCliArgs extends DashboardCommonArgs {
  action: "dev";
  projectId: string;
  pluginRoot: string;
  host: string;
  port: number;
  noOpen: boolean;
}

export type DashboardArgs =
  | DashboardStartCliArgs
  | DashboardBuildDistCliArgs
  | DashboardStopCliArgs
  | DashboardStopAllCliArgs
  | DashboardStatusCliArgs
  | DashboardDevCliArgs;

export type GatewayAction = "publish" | "set-stable" | "rollback" | "list" | "gc" | "start" | "stop";

interface GatewayCommonArgs {
  command: "gateway";
  /** Gateway runtime root container (defaults to env / `~/understand-projects`). */
  projectsRoot: string;
}

export interface GatewayPublishCliArgs extends GatewayCommonArgs {
  action: "publish";
  versionId: string | null;
  stable: boolean;
  retain: number | null;
  reason: string | null;
  gc: boolean;
  pluginRoot: string | null;
}

export interface GatewaySetStableCliArgs extends GatewayCommonArgs {
  action: "set-stable";
  /** Falls back to current release when omitted. */
  versionId: string | null;
}

export interface GatewayRollbackCliArgs extends GatewayCommonArgs {
  action: "rollback";
}

export interface GatewayListCliArgs extends GatewayCommonArgs {
  action: "list";
  json: boolean;
}

export interface GatewayGcCliArgs extends GatewayCommonArgs {
  action: "gc";
  retain: number | null;
}

export interface GatewayStartCliArgs extends GatewayCommonArgs {
  action: "start";
  host: string;
  port: number;
  noOpen: boolean;
  config: string | null;
  serveProfile: string | null;
}

export interface GatewayStopCliArgs extends GatewayCommonArgs {
  action: "stop";
}

export type GatewayArgs =
  | GatewayPublishCliArgs
  | GatewaySetStableCliArgs
  | GatewayRollbackCliArgs
  | GatewayListCliArgs
  | GatewayGcCliArgs
  | GatewayStartCliArgs
  | GatewayStopCliArgs;

export type ProjectStateAction = "publish" | "set-stable" | "rollback" | "list" | "gc";

interface ProjectStateCommonArgs {
  command: "project-state";
  /** Required project id, resolved through `<projectsRoot>/gateway/config/projects.json`. */
  projectId: string;
}

export interface ProjectStatePublishCliArgs extends ProjectStateCommonArgs {
  action: "publish";
  versionId: string;
  sourceRoot: string | null;
  stable: boolean;
  retain: number | null;
}

export interface ProjectStateSetStableCliArgs extends ProjectStateCommonArgs {
  action: "set-stable";
  versionId: string | null;
}

export interface ProjectStateRollbackCliArgs extends ProjectStateCommonArgs {
  action: "rollback";
}

export interface ProjectStateListCliArgs extends ProjectStateCommonArgs {
  action: "list";
}

export interface ProjectStateGcCliArgs extends ProjectStateCommonArgs {
  action: "gc";
  retain: number | null;
}

export type ProjectStateArgs =
  | ProjectStatePublishCliArgs
  | ProjectStateSetStableCliArgs
  | ProjectStateRollbackCliArgs
  | ProjectStateListCliArgs
  | ProjectStateGcCliArgs;

export interface ReviewGraphHealthArgs {
  command: "review-graph-health";
  projectId: string;
  output: string;
}

export interface ReviewRunHookArgs {
  command: "run-review-hook";
  reviewCmd: string;
}

export type RepairAction = "llm-failures" | "llm-graph-failures";

export interface RepairArgs {
  command: "repair";
  action: RepairAction;
  /** Required project id, resolved through `<projectsRoot>/gateway/config/projects.json`. */
  projectId: string;
  /** Override upstream plugin location (else env/home discovery). */
  pluginRoot: string | null;
  /** Provider package name for the re-run LLM analysis (CLI override > config). */
  llmProvider: string | null;
  /** Unified YAML deploy config file/dir. Null = discover. */
  config: string | null;
  /** Scan + plan only; never re-run the provider or rewrite the graph. */
  dryRun: boolean;
  /** Cap the number of failed files repaired this run. Null = no cap. */
  maxTasks: number | null;
  /** Always true: repair is an out-of-band path that never starts a dashboard. */
  noDashboard: boolean;
}

export type InitExplicitField = "iconFile" | "version" | "sortOrder" | "repoPath";

export interface InitArgs {
  command: "init";
  /** Repo path positional argument (resolved against CWD). Required. */
  repo: string;
  /** Project id; defaults to basename(resolve(repo)) when omitted. */
  projectId: string | null;
  /** Path to a local icon file copied into <portalAssetsRoot>/icons/<id>.<ext>. */
  iconFile: string | null;
  /** Display version (entry.version). */
  version: string | null;
  /** Portal sort key (ascending). May be 0 or negative. */
  sortOrder: number | null;
  /** Repo path template override (supports `${projectBaseDir}` etc.). */
  repoPath: string | null;
  /** Print effective plan as JSON, do not touch the filesystem. */
  dryRun: boolean;
  /** Overwrite conflict-tracked fields (currently `repoPath`). */
  force: boolean;
  /**
   * Which patch fields were explicitly set by the user. `runInit` uses this
   * to skip fields the user did not touch (so re-running `init` does not
   * silently overwrite values with `null`).
   */
  explicit: Set<InitExplicitField>;
}

export interface HelpArgs {
  command: "help";
}

export type NotifyAction = "nightly";

export interface NotifyNightlyCliArgs {
  command: "notify";
  action: "nightly";
  /** Path to the aggregate nightly report JSON to summarize. */
  report: string;
  /** Provider package name to load. Null = LocalFileNotifyProvider default. */
  provider: string | null;
  /** Unified YAML deploy config file/dir. Null = discover. */
  config: string | null;
  /** Best-effort delivery: never escalate failure to a non-zero exit code. */
  bestEffort: boolean;
  /** Skip actual delivery; print what would be sent. */
  dryRun: boolean;
}

export type NotifyArgs = NotifyNightlyCliArgs;

export type ParsedArgs =
  | ServeArgs
  | BuildArgs
  | CompatArgs
  | DashboardArgs
  | GatewayArgs
  | ProjectStateArgs
  | ReviewGraphHealthArgs
  | ReviewRunHookArgs
  | RepairArgs
  | NotifyArgs
  | InitArgs
  | HelpArgs;

export class ArgsError extends Error {}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

const HELP_TEXT = `understand-anyway — open-source code understanding deploy CLI

Usage:
  understand-anyway init <repo> [options]
  understand-anyway build --project <id> [options]
  understand-anyway serve --project <id> [options]
  understand-anyway compat [options]
  understand-anyway dashboard <start|build-dist|stop|stop-all|status> [options]
  understand-anyway gateway <start|stop|publish|set-stable|rollback|list|gc> [options]
  understand-anyway review-graph-health --project <id> --output <file>
  understand-anyway run-review-hook [--review-cmd '<command>']
  understand-anyway repair <llm-failures|llm-graph-failures> --project <id> [options]
  understand-anyway notify nightly --report <file> [options]
  understand-anyway --help

init options:
  <repo>                Repo path (required). The default projectId is basename(repo).
  --project <id>        Override the inferred projectId (default: basename(repo))
  --icon-file <path>    Copy an SVG/PNG/WEBP/JPG/JPEG into
                        <projectsRoot>/gateway/portal-assets/icons/<projectId>.<ext> for portal
                        rendering. The portal scans this convention; no entry field
                        records the icon path.
  --version <str>       Display version (entry.version); independent from buildVersion
  --sort-order <n>      Portal card ordering (integer, may be negative; ascending)
  --repo-path <tmpl>    Override entry.repoPath. Accepts \${projectBaseDir}/\${projectId}/\${projectsRoot}/\${HOME}
                        plus process.env identifiers.
  --dry-run             Print the planned entry as JSON; do not touch the filesystem
  --force               Overwrite conflict-tracked fields (currently \`repoPath\`)

build options:
  --project <id>        Project id registered through \`init\` (required). The CLI
                        resolves repo + stateRoot through <projectsRoot>/gateway/config/projects.json.
  --incremental         Incremental update only; never falls back to full implicitly
  --resume              Resume from existing Phase 2 checkpoint
  --backfill            Repair missing/current files via explicit --include or auto-detect
  --include <path>      Optional include path for --backfill (repeatable)
  --config <file|dir>   Unified YAML deploy config; discovered if omitted
  --deploy-profile <p>  Apply deployProfiles.<p>.build defaults (ppe=small, prod=large)
  --llm-profile <name>  Apply llmProfiles.<name> provider config
  --exclude-tests       Filter test files out of the graph (default)
  --include-tests       Keep test files in the graph
  --plugin-root <dir>   Override upstream Understand-Anything plugin location
  --output-language <l> Summary/description language (default: config/deploy-profile/en)
  --llm-analysis        Enable optional LLM enrichment (default: disabled)
  --llm-provider <pkg>  Provider package for LLM enrichment (required with --llm-analysis)
  --embedding-provider <pkg> Provider package for semantic embeddings / search
  --llm-required        Fail the build on LLM provider/parse failures (default: best-effort)
  --llm-retry-max-attempts <n>      Max attempts incl. first try (default: 3 from config; 1 = no retry)
  --batch-mode <auto|full|segmented>  Phase 2 strategy (default: auto)
  --mapper-batch-count <n>          Batches per spawned mapper segment (default: host-aware)
  --mapper-concurrency <n>          Parallel mapper segments (default: host-aware)
  --no-dashboard       Accepted for deploy-script compatibility; build never starts a dashboard

compat options:
  --plugin-root <dir>   Override upstream Understand-Anything plugin location
  --json                Emit the report (or baseline with --update) as JSON
  --update              Print a fresh baseline extracted from the installed upstream

serve options:
  --project <id>        Project id registered through \`init\` (required). Runtime
                        paths and token are resolved from gateway state.
  --project-root <dir>  Source repo root used to relativize served graph paths (optional)
  --record-provider <l> Record sinks, comma-separated: local,feishu-sheets (default: none)
  --auth-provider <pkg> Package name of an AuthProvider factory to load (default: NoAuth)
  --org-policy <pkg>    Package name of an OrgPolicyProvider factory to load (default: AllowAll)
  --embedding-provider <pkg> Package name of an EmbeddingProvider factory to load
  --portal              Serve the portal landing page (requires a registry)
  --portal-assets <pkg> Package name of a PortalAssets factory to load (optional, portal only)
  --project-route       Serve /project/<id>/ routes (requires a registry)
  --registry <path>     Project registry JSON path (for --portal / --project-route)
  --maintenance         Force gateway maintenance responses
  --maintenance-scope <global|project>  Maintenance scope (default: global)
  --maintenance-project <csv>           Project ids when scope=project
  --maintenance-title <text>            Maintenance title
  --maintenance-message <text>          Maintenance body copy
  --maintenance-eta <text>              Estimated recovery hint
  --maintenance-contact <text>          Contact hint
  --config <file|dir>   Unified YAML deploy config (providers/record/profiles); discovered if omitted
  --serve-profile <name> Apply a named profile from the config's profiles map
  --host <host>         Listen host (default ${DEFAULT_HOST})
  --port <port>         Listen port (default ${DEFAULT_PORT}, 0 = auto-assign)
  -h, --help            Show this help

dashboard subcommands:
  dashboard start --project <id> [options]
                        Start a single-instance daemon serving the project's
                        gateway. Reuses an existing live daemon when stateRoot
                        + distDir match. Default opens browser; --no-open skips.

      --project <id>         Project id registered through \`init\` (required)
      --project-root <dir>   Source repo root override (optional; default: registry repoPath)
      --host <host>          Listen host (default ${DEFAULT_HOST})
      --port <port>          Listen port (default 0 = auto-assign)
      --no-open              Don't open the default browser
      --config <file|dir>    Unified YAML deploy config; discovered if omitted
      --serve-profile <name> Profile from the config's profiles map
        --portal               Enable portal rendering in the daemonized serve path
        --project-route        Enable /project/<id>/ routing in the daemonized serve path
        --registry <path>      Registry JSON path for --portal / --project-route
      --plugin-root <dir>    Upstream Understand-Anything plugin root; required
                             when dashboard-dist/ must be patched + built
      --rebuild-dashboard    Force-rebuild dashboard-dist/ even if it exists

    dashboard build-dist --project <id> --plugin-root <dir> [--rebuild-dashboard]
                         Build or refresh <stateRoot>/dashboard-dist without
                         starting a daemon.

  dashboard stop --project <id>
                        Send SIGTERM, wait grace period, then SIGKILL if needed.

  dashboard stop-all --projects-root <dir>
                        Scan <dir>/*/.understand-anything/dashboard.pid and
                        stop every live daemon found.

  dashboard status [--project <id> | --projects-root <dir>]
                        Show pid + url + alive/dead classification.

gateway subcommands (immutable releases + current/stable + rollback + GC):
  All gateway subcommands accept --projects-root <dir>. Default is
  $UA_PROJECTS_ROOT or \`~/understand-projects\` (when no env). The gateway root
  is then \`<projects-root>/gateway/\`.

    gateway start [--host <host>] [--port <port>] [--no-open] [--serve-profile <name>] [--config <file|dir>]
                        Start the shared portal gateway. State, registry,
                        project metadata, and portal assets are resolved from
                        the projectsRoot convention.

    gateway stop        Stop the shared portal gateway.

    gateway publish [<versionId>] [--stable] [--retain N] [--reason "..."] [--gc] [--plugin-root <dir>]
                        Promote <versionId> to current. When omitted, package
                        the current CLI dist into a fresh release id first.
                        --stable also flips the stable pointer. Publish always
                        runs GC; --gc is accepted for deploy-script compatibility.

  gateway set-stable [<versionId>]
                        Mark a release as stable; defaults to current.

  gateway rollback      Atomically point current back at the stable release.

  gateway list [--json] List releases with current/stable/manifest.

  gateway gc [--retain N]
                        Apply retention.maxVersions; protects current + stable.

project-state subcommands (one project state root, versioned graph pointers):
  project-state publish <versionId> --project <id> [--source-root <dir>] [--stable] [--retain N]
                        Seed an immutable project version from the current
                        .understand-anything state and optional source mirror.

  project-state set-stable [<versionId>] --project <id>
                        Mark a project version as stable; defaults to current.

  project-state rollback --project <id>
                        Flip current back to the recorded stable version
                        (mirrors gateway rollback). Rejects when no stable
                        version is recorded. Writes an audit.ndjson entry.

  project-state list --project <id>
                        List project version ids under versions/.

  project-state gc --project <id> [--retain N]
                        Delete non-protected old project versions.

review subcommands (deterministic graph-health gate + UA_REVIEW_CMD hook):

  review-graph-health --project <id> --output <file>
                        Run the default graph-health gate against a registered
                        project. Writes the full review JSON to <file> and
                        prints a one-line {approved,issueCount,warningCount}
                        summary. Exits 0 when approved, 1 when rejected.

  run-review-hook [--review-cmd '<command>']
                        Execute a UA_REVIEW_CMD hook (env tunnel + bash -lc).
                        Exit codes: 0 ok / 2 missing_command / 3 command_failed
                        / 4 output_missing / 5 output_invalid.

repair subcommands (controlled, out-of-band; never part of nightly):
  Re-runs only the LLM gaps in the CURRENT project's CURRENT state; does not
  consume historical runs. Implies --no-dashboard. Re-build artifacts must
  already exist (run a full --llm-analysis build first). Writes a repair report
  to <stateRoot>/.understand-anything/repair-runs/<run-id>/result.json.

  repair llm-failures --project <id> [options]
                        Re-run the LLM file-analysis tasks that failed in the
                        last build (read from
                        .understand-anything/llm/latest-stats.json), patch the
                        affected batch artifacts, re-merge into the existing
                        graph, and persist. Fails fast (non-dry-run) when no LLM
                        provider is configured.

  repair llm-graph-failures --project <id> [options]
                        Re-run graph-level layer/project/tour enrichment with
                        the configured LLM provider, persist the graph, and
                        write a repair report. --repair-dry-run records gaps
                        without loading a provider or mutating the graph.

      --project <id>        Project id registered through \`init\` (required)
      --plugin-root <dir>   Override upstream Understand-Anything plugin location
      --llm-provider <pkg>  Provider package for the re-run analysis
      --config <file|dir>   Unified YAML deploy config; discovered if omitted
      --repair-dry-run      Scan + plan only; never re-run the provider or rewrite the graph
      --repair-max-tasks <n> Cap the number of failed files repaired this run (min 1)
      --no-dashboard        Accepted for symmetry; repair never starts a dashboard

notify subcommands (delivers nightly aggregate summary; default is local-file):
  notify nightly --report <file> [options]
                        Read the structured nightly report (\`aggregate/nightly-latest.json\`
                        produced by D8) and hand it to the configured NotifyProvider. The
                        open-source default writes the report to
                        <projectsRoot>/notifications/<run-id>.json. External delivery
                        (chat / IM) is opt-in via --notify-provider <pkg> or providers.notify
                        in the YAML config.

      --report <file>       Aggregate nightly report JSON (required)
      --notify-provider <p> Package name of a NotifyProvider factory to load (optional)
      --config <file|dir>   Unified YAML deploy config; discovered if omitted
      --best-effort         Never escalate delivery failure to a non-zero exit code
      --dry-run             Skip actual delivery; print what would be sent
`;

export function helpText(): string {
  return HELP_TEXT;
}

function takeValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("-")) {
    throw new ArgsError(`missing value for ${flag}`);
  }
  return value;
}

const VALID_RECORD_PROVIDERS: readonly RecordProviderName[] = ["local", "feishu-sheets"];

function parseRecordProviders(flag: string, raw: string): RecordProviderName[] {
  const names = parseCsvList(raw);
  for (const name of names) {
    if (!VALID_RECORD_PROVIDERS.includes(name as RecordProviderName)) {
      throw new ArgsError(`invalid ${flag} value: ${name} (expected one of ${VALID_RECORD_PROVIDERS.join(", ")})`);
    }
  }
  return names as RecordProviderName[];
}

function parseCsvList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseMaintenanceScope(raw: string): "global" | "project" {
  if (raw === "global" || raw === "project") return raw;
  throw new ArgsError(`invalid --maintenance-scope: ${raw}`);
}

function parseBuildArgs(rest: string[]): ParsedArgs {
  let projectId: string | null = null;
  let excludeTests: boolean | null = null;
  let pluginRoot: string | null = null;
  let outputLanguage: string | null = null;
  let mode: BuildMode | null = null;
  const includePaths: string[] = [];
  let config: string | null = null;
  let deployProfile: string | null = null;
  let llmAnalysis: boolean | null = null;
  let llmProvider: string | null = null;
  let llmProfile: string | null = null;
  let embeddingProvider: string | null = null;
  let llmModelCandidates: string[] = [];
  let llmRequired: boolean | null = null;
  let retryMaxAttempts: number | null = null;
  let batchMode: BatchMode = "auto";
  let mapperBatchCount: number | null = null;
  let mapperConcurrency: number | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--project":
        projectId = takeValue(arg, rest[++i]);
        break;
      case "--incremental":
        if (mode !== null) throw new ArgsError(`choose only one build mode (already selected --${mode})`);
        mode = "incremental";
        break;
      case "--resume":
        if (mode !== null) throw new ArgsError(`choose only one build mode (already selected --${mode})`);
        mode = "resume";
        break;
      case "--backfill":
        if (mode !== null) throw new ArgsError(`choose only one build mode (already selected --${mode})`);
        mode = "backfill";
        break;
      case "--include":
        includePaths.push(takeValue(arg, rest[++i]));
        break;
      case "--config":
        config = takeValue(arg, rest[++i]);
        break;
      case "--deploy-profile":
        deployProfile = takeValue(arg, rest[++i]);
        break;
      case "--llm-profile":
        llmProfile = takeValue(arg, rest[++i]);
        break;
      case "--exclude-tests":
        excludeTests = true;
        break;
      case "--include-tests":
        excludeTests = false;
        break;
      case "--plugin-root":
        pluginRoot = takeValue(arg, rest[++i]);
        break;
      case "--output-language":
        outputLanguage = takeValue(arg, rest[++i]);
        break;
      case "--llm-analysis":
        llmAnalysis = true;
        break;
      case "--llm-provider":
        llmProvider = takeValue(arg, rest[++i]);
        break;
      case "--embedding-provider":
        embeddingProvider = takeValue(arg, rest[++i]);
        break;
      case "--llm-model-candidates":
        llmModelCandidates = parseCsvList(takeValue(arg, rest[++i]));
        break;
      case "--llm-required":
        llmRequired = true;
        break;
      case "--llm-retry-max-attempts":
        retryMaxAttempts = parseRetryInt(arg, takeValue(arg, rest[++i]), { min: 1 });
        break;
      case "--batch-mode":
        batchMode = parseBatchMode(arg, takeValue(arg, rest[++i]));
        break;
      case "--mapper-batch-count":
        mapperBatchCount = parseRetryInt(arg, takeValue(arg, rest[++i]), { min: 1 });
        break;
      case "--mapper-concurrency":
        mapperConcurrency = parseRetryInt(arg, takeValue(arg, rest[++i]), { min: 1 });
        break;
      case "--no-dashboard":
        // Accepted for deploy-script compatibility; build never starts a dashboard.
        break;
      default:
        if (arg.startsWith("-")) {
          throw new ArgsError(`unknown option: ${arg}`);
        }
        throw new ArgsError(`unexpected positional argument: ${arg} (build requires --project <id>)`);
    }
  }

  if (!projectId) throw new ArgsError("build: missing required --project <id>");
  const selectedMode = mode ?? "full";
  if (selectedMode !== "backfill" && includePaths.length > 0) {
    throw new ArgsError("--include requires --backfill");
  }

  return {
    command: "build",
    projectId,
    excludeTests,
    pluginRoot,
    outputLanguage,
    mode: selectedMode,
    includePaths,
    config,
    deployProfile,
    llmAnalysis,
    llmProvider,
    llmProfile,
    embeddingProvider,
    llmModelCandidates,
    llmRequired,
    llmRetry: {
      maxAttempts: retryMaxAttempts,
      initialBackoffMs: null,
      maxBackoffMs: null,
    },
    batchMode,
    mapperBatchCount,
    mapperConcurrency,
  };
}

function parseRetryInt(flag: string, raw: string, { min }: { min: number }): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new ArgsError(`invalid ${flag}: ${raw}`);
  }
  return parsed;
}

function parseBatchMode(flag: string, raw: string): BatchMode {
  if (raw === "auto" || raw === "full" || raw === "segmented") return raw;
  throw new ArgsError(`invalid ${flag}: ${raw} (expected one of auto, full, segmented)`);
}

function parseCompatArgs(rest: string[]): ParsedArgs {
  let pluginRoot: string | null = null;
  let json = false;
  let update = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--plugin-root":
        pluginRoot = takeValue(arg, rest[++i]);
        break;
      case "--json":
        json = true;
        break;
      case "--update":
        update = true;
        break;
      default:
        throw new ArgsError(`unknown option: ${arg}`);
    }
  }

  return { command: "compat", pluginRoot, json, update };
}

function parsePort(flag: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new ArgsError(`invalid ${flag}: ${raw}`);
  }
  return parsed;
}

function parseDashboardArgs(rest: string[]): ParsedArgs {
  const action = rest[0];
  if (action === undefined || action === "-h" || action === "--help" || action === "--help-dev") {
    return { command: "help" };
  }
  if (
    action !== "start" &&
    action !== "build-dist" &&
    action !== "stop" &&
    action !== "stop-all" &&
    action !== "status" &&
    action !== "dev"
  ) {
    throw new ArgsError(
      `unknown dashboard subcommand: ${action} (expected start | stop | stop-all | status | build-dist | dev)`,
    );
  }

  let projectId: string | null = null;
  let projectsRoot: string | null = null;
  let projectRoot: string | null = null;
  let host = DEFAULT_HOST;
  // `dev` defaults to Vite's standard 5173; other actions default to auto-assign (0).
  let port = action === "dev" ? 5173 : DEFAULT_PORT;
  let noOpen = false;
  let config: string | null = null;
  let serveProfile: string | null = null;
  let portal = false;
  let projectRoute = false;
  let registryPath: string | null = null;
  let pluginRoot: string | null = null;
  let rebuildDashboard = false;

  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
      case "--help-dev":
        return { command: "help" };
      case "--project":
        projectId = takeValue(arg, rest[++i]);
        break;
      case "--projects-root":
        projectsRoot = takeValue(arg, rest[++i]);
        break;
      case "--project-root":
        projectRoot = takeValue(arg, rest[++i]);
        break;
      case "--host":
        host = takeValue(arg, rest[++i]);
        break;
      case "--port":
        port = parsePort(arg, takeValue(arg, rest[++i]));
        break;
      case "--no-open":
        noOpen = true;
        break;
      case "--config":
        config = takeValue(arg, rest[++i]);
        break;
      case "--serve-profile":
        serveProfile = takeValue(arg, rest[++i]);
        break;
      case "--portal":
        portal = true;
        break;
      case "--project-route":
        projectRoute = true;
        break;
      case "--registry":
        registryPath = takeValue(arg, rest[++i]);
        break;
      case "--plugin-root":
        pluginRoot = takeValue(arg, rest[++i]);
        break;
      case "--rebuild-dashboard":
        rebuildDashboard = true;
        break;
      default:
        throw new ArgsError(`unknown option: ${arg}`);
    }
  }

  if (action === "start") {
    if (!projectId) throw new ArgsError("dashboard start: missing required --project <id>");
    return {
      command: "dashboard",
      action: "start",
      projectId,
      projectRoot,
      host,
      port,
      token: null,
      noOpen,
      config,
      serveProfile,
      portal,
      projectRoute,
      registryPath,
      pluginRoot,
      rebuildDashboard,
    };
  }
  if (action === "build-dist") {
    if (!projectId) throw new ArgsError("dashboard build-dist: missing required --project <id>");
    if (!pluginRoot) throw new ArgsError("dashboard build-dist: missing required --plugin-root");
    return {
      command: "dashboard",
      action: "build-dist",
      projectId,
      pluginRoot,
      rebuildDashboard,
    };
  }
  if (action === "stop") {
    if (!projectId) throw new ArgsError("dashboard stop: missing required --project <id>");
    return { command: "dashboard", action: "stop", projectId };
  }
  if (action === "stop-all") {
    if (!projectsRoot) throw new ArgsError("dashboard stop-all: missing required --projects-root");
    return { command: "dashboard", action: "stop-all", projectsRoot };
  }
  if (action === "dev") {
    if (!projectId) throw new ArgsError("dashboard dev: missing required --project <id>");
    if (!pluginRoot) throw new ArgsError("dashboard dev: missing required --plugin-root");
    return { command: "dashboard", action: "dev", projectId, pluginRoot, host, port, noOpen };
  }
  // status
  if (projectId && projectsRoot) {
    throw new ArgsError("dashboard status: pass only one of --project or --projects-root");
  }
  return { command: "dashboard", action: "status", projectId, projectsRoot };
}

function parsePositiveInt(flag: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ArgsError(`invalid ${flag}: ${raw}`);
  }
  return parsed;
}

function defaultProjectsRoot(): string {
  const fromEnv = process.env.UA_PROJECTS_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  // Fallback: $HOME/understand-projects. We deliberately keep this neutral
  // (no internal hostnames / IPs); deployment docs cover overrides via env.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home ? `${home}/understand-projects` : "understand-projects";
}

function parseGatewayArgs(rest: string[]): ParsedArgs {
  const action = rest[0];
  if (action === undefined || action === "-h" || action === "--help") {
    return { command: "help" };
  }
  if (
    action !== "publish" &&
    action !== "set-stable" &&
    action !== "rollback" &&
    action !== "list" &&
    action !== "gc" &&
    action !== "start" &&
    action !== "stop"
  ) {
    throw new ArgsError(`unknown gateway subcommand: ${action} (expected start | stop | publish | set-stable | rollback | list | gc)`);
  }

  let projectsRoot: string | null = null;
  let positional: string | null = null;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let noOpen = false;
  let config: string | null = null;
  let serveProfile: string | null = null;
  let stable = false;
  let retain: number | null = null;
  let reason: string | null = null;
  let gc = false;
  let pluginRoot: string | null = null;
  let json = false;

  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--projects-root":
        projectsRoot = takeValue(arg, rest[++i]);
        break;
      case "--host":
        host = takeValue(arg, rest[++i]);
        break;
      case "--port":
        port = parsePort(arg, takeValue(arg, rest[++i]));
        break;
      case "--no-open":
        noOpen = true;
        break;
      case "--config":
        config = takeValue(arg, rest[++i]);
        break;
      case "--serve-profile":
        serveProfile = takeValue(arg, rest[++i]);
        break;
      case "--stable":
        stable = true;
        break;
      case "--retain":
        retain = parsePositiveInt(arg, takeValue(arg, rest[++i]));
        break;
      case "--reason":
        reason = takeValue(arg, rest[++i]);
        break;
      case "--gc":
        gc = true;
        break;
      case "--plugin-root":
        pluginRoot = takeValue(arg, rest[++i]);
        break;
      case "--json":
        json = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new ArgsError(`unknown option: ${arg}`);
        }
        if (positional !== null) {
          throw new ArgsError(`unexpected positional argument: ${arg}`);
        }
        positional = arg;
        break;
    }
  }

  const finalProjectsRoot = projectsRoot ?? defaultProjectsRoot();

  if (action === "start") {
    if (positional) throw new ArgsError(`gateway start: unexpected positional ${positional}`);
    return {
      command: "gateway",
      action: "start",
      projectsRoot: finalProjectsRoot,
      host,
      port,
      noOpen,
      config,
      serveProfile,
    };
  }
  if (action === "stop") {
    if (positional) throw new ArgsError(`gateway stop: unexpected positional ${positional}`);
    return { command: "gateway", action: "stop", projectsRoot: finalProjectsRoot };
  }
  if (action === "publish") {
    return {
      command: "gateway",
      action: "publish",
      projectsRoot: finalProjectsRoot,
      versionId: positional,
      stable,
      retain,
      reason,
      gc,
      pluginRoot,
    };
  }
  if (action === "set-stable") {
    return { command: "gateway", action: "set-stable", projectsRoot: finalProjectsRoot, versionId: positional };
  }
  if (action === "rollback") {
    if (positional) throw new ArgsError(`gateway rollback: unexpected positional ${positional}`);
    return { command: "gateway", action: "rollback", projectsRoot: finalProjectsRoot };
  }
  if (action === "list") {
    if (positional) throw new ArgsError(`gateway list: unexpected positional ${positional}`);
    return { command: "gateway", action: "list", projectsRoot: finalProjectsRoot, json };
  }
  // gc
  if (positional) throw new ArgsError(`gateway gc: unexpected positional ${positional}`);
  return { command: "gateway", action: "gc", projectsRoot: finalProjectsRoot, retain };
}

function parseProjectStateArgs(rest: string[]): ParsedArgs {
  const action = rest[0];
  if (action === undefined || action === "-h" || action === "--help") {
    return { command: "help" };
  }
  if (action !== "publish" && action !== "set-stable" && action !== "rollback" && action !== "list" && action !== "gc") {
    throw new ArgsError(`unknown project-state subcommand: ${action} (expected publish | set-stable | rollback | list | gc)`);
  }

  let projectId: string | null = null;
  let sourceRoot: string | null = null;
  let positional: string | null = null;
  let stable = false;
  let retain: number | null = null;

  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--project":
        projectId = takeValue(arg, rest[++i]);
        break;
      case "--source-root":
        sourceRoot = takeValue(arg, rest[++i]);
        break;
      case "--stable":
        stable = true;
        break;
      case "--retain":
        retain = parsePositiveInt(arg, takeValue(arg, rest[++i]));
        break;
      default:
        if (arg.startsWith("-")) throw new ArgsError(`unknown option: ${arg}`);
        if (positional !== null) throw new ArgsError(`unexpected positional argument: ${arg}`);
        positional = arg;
        break;
    }
  }

  if (!projectId) throw new ArgsError("project-state: missing required --project <id>");
  if (action === "publish") {
    if (!positional) throw new ArgsError("project-state publish: missing required <versionId>");
    return { command: "project-state", action: "publish", projectId, versionId: positional, sourceRoot, stable, retain };
  }
  if (action === "set-stable") {
    return { command: "project-state", action: "set-stable", projectId, versionId: positional };
  }
  if (action === "rollback") {
    if (positional) throw new ArgsError(`project-state rollback: unexpected positional ${positional}`);
    return { command: "project-state", action: "rollback", projectId };
  }
  if (action === "list") {
    if (positional) throw new ArgsError(`project-state list: unexpected positional ${positional}`);
    return { command: "project-state", action: "list", projectId };
  }
  if (positional) throw new ArgsError(`project-state gc: unexpected positional ${positional}`);
  return { command: "project-state", action: "gc", projectId, retain };
}

function parseReviewGraphHealthArgs(rest: string[]): ParsedArgs {
  let projectId = process.env.UA_PROJECT_ID ?? "";
  let output = process.env.UA_REVIEW_JSON ?? "";

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--project":
        projectId = takeValue(arg, rest[++i]);
        break;
      case "--output":
        output = takeValue(arg, rest[++i]);
        break;
      default:
        throw new ArgsError(`unknown option: ${arg}`);
    }
  }

  if (!projectId) throw new ArgsError("review-graph-health: missing required --project <id>");
  if (!output) throw new ArgsError("review-graph-health: missing required --output");
  return { command: "review-graph-health", projectId, output };
}

function parseRunReviewHookArgs(rest: string[]): ParsedArgs {
  let reviewCmd = process.env.UA_REVIEW_CMD ?? "";

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--review-cmd":
        reviewCmd = takeValue(arg, rest[++i]);
        break;
      default:
        throw new ArgsError(`unknown option: ${arg}`);
    }
  }

  return { command: "run-review-hook", reviewCmd };
}

function parseRepairArgs(rest: string[]): ParsedArgs {
  const action = rest[0];
  if (action === undefined || action === "-h" || action === "--help") {
    return { command: "help" };
  }
  if (action !== "llm-failures" && action !== "llm-graph-failures") {
    throw new ArgsError(`unknown repair subcommand: ${action} (expected llm-failures | llm-graph-failures)`);
  }

  let projectId: string | null = null;
  let pluginRoot: string | null = null;
  let llmProvider: string | null = null;
  let config: string | null = null;
  let dryRun = false;
  let maxTasks: number | null = null;

  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--project":
        projectId = takeValue(arg, rest[++i]);
        break;
      case "--plugin-root":
        pluginRoot = takeValue(arg, rest[++i]);
        break;
      case "--llm-provider":
        llmProvider = takeValue(arg, rest[++i]);
        break;
      case "--config":
        config = takeValue(arg, rest[++i]);
        break;
      case "--repair-dry-run":
        dryRun = true;
        break;
      case "--repair-max-tasks":
        maxTasks = parsePositiveInt(arg, takeValue(arg, rest[++i]));
        break;
      case "--no-dashboard":
        // Accepted for symmetry; repair never starts a dashboard regardless.
        break;
      default:
        if (arg.startsWith("-")) {
          throw new ArgsError(`unknown option: ${arg}`);
        }
        throw new ArgsError(`unexpected positional argument: ${arg} (repair requires --project <id>)`);
    }
  }

  if (!projectId) throw new ArgsError(`repair ${action}: missing required --project <id>`);
  return {
    command: "repair",
    action,
    projectId,
    pluginRoot,
    llmProvider,
    config,
    dryRun,
    maxTasks,
    noDashboard: true,
  };
}

function parseSignedInt(flag: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ArgsError(`invalid ${flag}: ${raw}`);
  }
  return parsed;
}

function parseInitArgs(rest: string[]): ParsedArgs {
  let repo: string | null = null;
  let projectId: string | null = null;
  let iconFile: string | null = null;
  let version: string | null = null;
  let sortOrder: number | null = null;
  let repoPath: string | null = null;
  let dryRun = false;
  let force = false;
  const explicit = new Set<InitExplicitField>();

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--project":
        projectId = takeValue(arg, rest[++i]);
        break;
      case "--icon-file":
        iconFile = takeValue(arg, rest[++i]);
        explicit.add("iconFile");
        break;
      case "--version":
        version = takeValue(arg, rest[++i]);
        explicit.add("version");
        break;
      case "--sort-order": {
        const raw = rest[++i];
        if (raw === undefined) {
          throw new ArgsError(`missing value for ${arg}`);
        }
        sortOrder = parseSignedInt(arg, raw);
        explicit.add("sortOrder");
        break;
      }
      case "--repo-path":
        repoPath = takeValue(arg, rest[++i]);
        explicit.add("repoPath");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new ArgsError(`unknown option: ${arg}`);
        }
        if (repo !== null) {
          throw new ArgsError(`unexpected positional argument: ${arg}`);
        }
        repo = arg;
        break;
    }
  }

  if (!repo) throw new ArgsError("init: missing required <repo>");
  return {
    command: "init",
    repo,
    projectId,
    iconFile,
    version,
    sortOrder,
    repoPath,
    dryRun,
    force,
    explicit,
  };
}

function parseNotifyArgs(rest: string[]): ParsedArgs {
  const action = rest[0];
  if (action === undefined || action === "-h" || action === "--help") {
    return { command: "help" };
  }
  if (action !== "nightly") {
    throw new ArgsError(`unknown notify subcommand: ${action} (expected nightly)`);
  }

  let report: string | null = null;
  let provider: string | null = null;
  let config: string | null = null;
  let bestEffort = false;
  let dryRun = false;

  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--report":
        report = takeValue(arg, rest[++i]);
        break;
      case "--notify-provider":
        provider = takeValue(arg, rest[++i]);
        break;
      case "--config":
        config = takeValue(arg, rest[++i]);
        break;
      case "--best-effort":
        bestEffort = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new ArgsError(`unknown option: ${arg}`);
    }
  }

  if (!report) throw new ArgsError("notify nightly: missing required --report");
  return {
    command: "notify",
    action: "nightly",
    report,
    provider,
    config,
    bestEffort,
    dryRun,
  };
}

function parseServeArgs(rest: string[], mode: "public" | "daemon"): ParsedArgs {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let hostExplicit = false;
  let portExplicit = false;
  let projectId: string | null = null;
  let stateDir: string | null = null;
  let distDir: string | null = null;
  let token: string | null = null;
  let projectRoot: string | null = null;
  let recordProviders: RecordProviderName[] = [];
  let authProvider: string | null = null;
  let orgPolicy: string | null = null;
  let embeddingProvider: string | null = null;
  let portal = false;
  let portalAssets: string | null = null;
  let projectRoute = false;
  let registryPath: string | null = null;
  let maintenanceEnabled = false;
  let maintenanceScope: "global" | "project" = "global";
  let maintenanceProjectIds: string[] = [];
  let maintenanceTitle: string | null = null;
  let maintenanceMessage: string | null = null;
  let maintenanceEta: string | null = null;
  let maintenanceContact: string | null = null;
  let config: string | null = null;
  let serveProfile: string | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "-h":
      case "--help":
        return { command: "help" };
      case "--host":
        host = takeValue(arg, rest[++i]);
        hostExplicit = true;
        break;
      case "--port": {
        const raw = takeValue(arg, rest[++i]);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new ArgsError(`invalid --port: ${raw}`);
        }
        port = parsed;
        portExplicit = true;
        break;
      }
      case "--state-dir":
        if (mode !== "daemon") throw new ArgsError("unknown option: --state-dir");
        stateDir = takeValue(arg, rest[++i]);
        break;
      case "--project":
        if (mode !== "public") throw new ArgsError("unknown option: --project");
        projectId = takeValue(arg, rest[++i]);
        break;
      case "--dist-dir":
        if (mode !== "daemon") throw new ArgsError("unknown option: --dist-dir");
        distDir = takeValue(arg, rest[++i]);
        break;
      case "--token":
        if (mode !== "daemon") throw new ArgsError("unknown option: --token");
        token = takeValue(arg, rest[++i]);
        break;
      case "--project-root":
        projectRoot = takeValue(arg, rest[++i]);
        break;
      case "--record-provider":
        recordProviders = parseRecordProviders(arg, takeValue(arg, rest[++i]));
        break;
      case "--auth-provider":
        authProvider = takeValue(arg, rest[++i]);
        break;
      case "--org-policy":
        orgPolicy = takeValue(arg, rest[++i]);
        break;
      case "--embedding-provider":
        embeddingProvider = takeValue(arg, rest[++i]);
        break;
      case "--portal":
        portal = true;
        break;
      case "--portal-assets":
        portalAssets = takeValue(arg, rest[++i]);
        break;
      case "--project-route":
        projectRoute = true;
        break;
      case "--registry":
        registryPath = takeValue(arg, rest[++i]);
        break;
      case "--maintenance":
        maintenanceEnabled = true;
        break;
      case "--maintenance-scope":
        maintenanceScope = parseMaintenanceScope(takeValue(arg, rest[++i]));
        break;
      case "--maintenance-project":
        maintenanceProjectIds = parseCsvList(takeValue(arg, rest[++i]));
        break;
      case "--maintenance-title":
        maintenanceTitle = takeValue(arg, rest[++i]);
        break;
      case "--maintenance-message":
        maintenanceMessage = takeValue(arg, rest[++i]);
        break;
      case "--maintenance-eta":
        maintenanceEta = takeValue(arg, rest[++i]);
        break;
      case "--maintenance-contact":
        maintenanceContact = takeValue(arg, rest[++i]);
        break;
      case "--config":
        config = takeValue(arg, rest[++i]);
        break;
      case "--serve-profile":
        serveProfile = takeValue(arg, rest[++i]);
        break;
      default:
        throw new ArgsError(`unknown option: ${arg}`);
    }
  }

  if (mode === "public") {
    if (!projectId) throw new ArgsError("serve: missing required --project <id>");
  } else {
    if (!stateDir) throw new ArgsError("dashboard-server: missing required --state-dir");
    if (!distDir) throw new ArgsError("dashboard-server: missing required --dist-dir");
    if (!token) throw new ArgsError("dashboard-server: missing required --token");
  }
  // --portal/--project-route registry may come from the config (validated in serve).
  if (portalAssets && !portal) {
    throw new ArgsError("--portal-assets requires --portal");
  }

  return {
    command: "serve",
    host,
    port,
    hostExplicit,
    portExplicit,
    projectId,
    stateDir: stateDir ?? "",
    distDir: distDir ?? "",
    token: token ?? "",
    projectRoot,
    recordProviders,
    authProvider,
    orgPolicy,
    embeddingProvider,
    portal,
    portalAssets,
    projectRoute,
    registryPath,
    maintenanceEnabled,
    maintenanceScope,
    maintenanceProjectIds,
    maintenanceTitle,
    maintenanceMessage,
    maintenanceEta,
    maintenanceContact,
    config,
    serveProfile,
  };
}

export function parseServeDaemonArgs(rest: string[]): ServeArgs {
  const parsed = parseServeArgs(rest, "daemon");
  if (parsed.command !== "serve") throw new ArgsError("dashboard-server expects serve-shaped args");
  return parsed;
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    return { command: "help" };
  }

  const command = argv[0];
  if (command === "build") {
    return parseBuildArgs(argv.slice(1));
  }
  if (command === "compat") {
    return parseCompatArgs(argv.slice(1));
  }
  if (command === "dashboard") {
    return parseDashboardArgs(argv.slice(1));
  }
  if (command === "gateway") {
    return parseGatewayArgs(argv.slice(1));
  }
  if (command === "project-state") {
    return parseProjectStateArgs(argv.slice(1));
  }
  if (command === "review-graph-health") {
    return parseReviewGraphHealthArgs(argv.slice(1));
  }
  if (command === "run-review-hook") {
    return parseRunReviewHookArgs(argv.slice(1));
  }
  if (command === "repair") {
    return parseRepairArgs(argv.slice(1));
  }
  if (command === "notify") {
    return parseNotifyArgs(argv.slice(1));
  }
  if (command === "init") {
    return parseInitArgs(argv.slice(1));
  }
  if (command === "serve") {
    return parseServeArgs(argv.slice(1), "public");
  }
  throw new ArgsError(`unknown command: ${command}`);
}
