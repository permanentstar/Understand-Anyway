/**
 * `serve` command: start the read-only gateway against a pre-built state dir.
 *
 * Config is discovered + parsed + interpolated + layered ONCE here, then handed
 * to both builders (replacing the old per-builder JSON reads). Layering follows
 * CLI > env > profile > base; `--serve-profile` selects the profile section.
 *
 * The open-source default is NoAuthProvider — there is intentionally NO
 * "prod must enable SSO" guard. The dashboard runtime token still gates the
 * data API + static serving regardless of auth. SSO is opt-in via a configured
 * AuthProvider (package name from the YAML), not required to run.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  ProjectRegistryStore,
  startGatewayServer,
  type MaintenanceState,
  type RunningGateway,
} from "@understand-anyway/gateway";
import type { EmbeddingProvider, ProfileSection, ProvidersConfig, ResolvedConfig } from "@understand-anyway/plugin-api";
import { ArgsError, type ServeArgs } from "./args.js";
import { buildEmbeddingProvider } from "./build-embedding.js";
import { buildRecordProvider } from "./build-record.js";
import { buildProviders, type PortalDisplayConfig } from "./build-providers.js";
import { loadResolvedConfig, selectProfile, type LoadConfigDeps } from "./config/load.js";
import { resolveLayered } from "./config/layered.js";
import { resolveProjectContext, resolveProjectDistDir, resolveProjectsRoot } from "./project-context.js";
import {
  buildGatewayRegistryPath,
  buildPortalAssetsRoot,
  buildProjectsConfigPath,
} from "./projects-config.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

export interface RunServeOptions {
  log?: (message: string) => void;
  /** When false, do not install SIGINT/SIGTERM handlers (used in tests). */
  installSignalHandlers?: boolean;
  /** Pre-resolved config (skips discovery/parse). Injectable for tests. */
  config?: ResolvedConfig;
  /** Loader dependency overrides for tests. */
  loadDeps?: LoadConfigDeps;
  buildEmbeddingProvider?: typeof buildEmbeddingProvider;
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`serve: ${label} is not a directory: ${path}`);
  }
}

function resolvePortalDisplay(
  profile: ProfileSection | undefined,
  deploy: ResolvedConfig["deploy"],
): PortalDisplayConfig {
  const pick = <T>(key: string): T | undefined =>
    (profile?.[key] as T | undefined) ?? (deploy?.[key] as T | undefined);
  return {
    title: pick<string>("title"),
    links: pick("links"),
    lang: pick<string>("lang"),
    wordmarkAlt: pick<string>("wordmarkAlt"),
  };
}

/**
 * Restrict the active provider blocks to a profile's `use` list. Without a
 * profile (or without `use`) all configured providers stay active.
 */
function resolveActiveProviders(
  providers: ProvidersConfig | undefined,
  profile: ProfileSection | undefined,
): ProvidersConfig {
  if (!providers) return {};
  const use = profile?.use;
  if (!use) return providers;
  const allowed = new Set(use);
  const filtered: ProvidersConfig = {};
  if (allowed.has("auth") && providers.auth) filtered.auth = providers.auth;
  if (allowed.has("orgPolicy") && providers.orgPolicy) filtered.orgPolicy = providers.orgPolicy;
  if (allowed.has("portalAssets") && providers.portalAssets) {
    filtered.portalAssets = providers.portalAssets;
  }
  if (allowed.has("embedding") && providers.embedding) filtered.embedding = providers.embedding;
  return filtered;
}

function resolveMaintenanceState(args: ServeArgs): MaintenanceState | null {
  if (!args.maintenanceEnabled) return null;
  return {
    enabled: true,
    scope: args.maintenanceScope,
    projectIds: args.maintenanceScope === "project" ? args.maintenanceProjectIds : undefined,
    title: args.maintenanceTitle,
    message: args.maintenanceMessage,
    eta: args.maintenanceEta,
    contact: args.maintenanceContact,
  };
}

function readEnvString(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

function readEnvPort(env: Record<string, string | undefined>, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new ArgsError(`invalid ${key}: ${raw}`);
  }
  return parsed;
}

/**
 * Two-tier portal convention: derive `<projectsRoot>/gateway/portal-assets/` and
 * `<projectsRoot>/gateway/config/projects.json` from the resolved projects root. Env
 * overrides exist purely for IPC (the daemon honors what the dispatcher
 * resolved); end users never set these by hand.
 */
function resolvePortalConventionPaths(env: NodeJS.ProcessEnv): {
  portalAssetsRoot: string;
  projectsConfigPath: string;
} {
  const envAssets = (env.UA_PORTAL_ASSETS_ROOT ?? "").trim();
  const envConfig = (env.UA_PROJECTS_CONFIG_PATH ?? "").trim();
  if (envAssets && envConfig) {
    return { portalAssetsRoot: envAssets, projectsConfigPath: envConfig };
  }
  const projectsRoot = resolveProjectsRoot({ env });
  return {
    portalAssetsRoot: envAssets || buildPortalAssetsRoot(projectsRoot),
    projectsConfigPath: envConfig || buildProjectsConfigPath(projectsRoot),
  };
}

export async function runServe(args: ServeArgs, options: RunServeOptions = {}): Promise<RunningGateway> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const env = options.loadDeps?.env ?? process.env;

  // Public `serve --project <id>` resolves stateDir/distDir/projectRoot/token
  // from <projectsRoot>/gateway/config/projects.json + the gateway project registry.
  // The explicit state/dist/token triplet is only accepted by the hidden
  // dashboard-server parser and reaches runServe as already-parsed args.
  let effectiveStateDir = args.stateDir;
  let effectiveDistDir = args.distDir;
  let effectiveToken = args.token;
  let effectiveProjectRoot = args.projectRoot;
  let effectiveConfigPath = args.config;
  if (args.projectId) {
    const ctx = resolveProjectContext(args.projectId, { env });
    effectiveStateDir = ctx.stateRoot;
    effectiveDistDir = resolveProjectDistDir(ctx.stateRoot);
    effectiveConfigPath = args.config ?? ctx.deployConfigPath;
    if (!effectiveProjectRoot) effectiveProjectRoot = ctx.repoPath;
    if (!effectiveToken) {
      const registryPath = buildGatewayRegistryPath(ctx.projectsRoot);
      const store = new ProjectRegistryStore(registryPath);
      const record = store.get(ctx.projectId);
      const token = record?.prodToken ?? "";
      if (!token) {
        throw new ArgsError(
          `serve --project ${ctx.projectId}: no runtime token in registry (${registryPath}); ` +
            `start the dashboard first or pass --token`,
        );
      }
      effectiveToken = token;
    }
  }

  const stateRoot = resolve(effectiveStateDir);
  const distDir = resolve(effectiveDistDir);
  const projectRoot = effectiveProjectRoot ? resolve(effectiveProjectRoot) : null;

  assertDirectory(stateRoot, "--state-dir");
  assertDirectory(distDir, "--dist-dir");
  if (projectRoot) assertDirectory(projectRoot, "--project-root");

  const config = options.config ?? loadResolvedConfig({
    ...args,
    config: effectiveConfigPath,
    configExplicit: Boolean(args.config),
  }, options.loadDeps);
  const profile = selectProfile(config, args.serveProfile);
  const activeConfig: ResolvedConfig = {
    ...config,
    providers: resolveActiveProviders(config.providers, profile),
  };

  const host =
    resolveLayered<string>({
      cli: args.hostExplicit ? args.host : null,
      env: readEnvString(env, "UA_SERVE_HOST"),
      profile: typeof profile?.host === "string" ? profile.host : undefined,
      base: config.deploy?.host,
    }) ?? args.host;
  const port =
    resolveLayered<number>({
      cli: args.portExplicit ? args.port : null,
      env: readEnvPort(env, "UA_SERVE_PORT"),
      profile: typeof profile?.port === "number" ? profile.port : undefined,
      base: config.deploy?.port,
    }) ?? args.port;

  const portal =
    resolveLayered<boolean>({
      cli: args.portal ? true : null,
      profile: profile?.portal,
    }) ?? false;
  const projectRoute =
    resolveLayered<boolean>({
      cli: args.projectRoute ? true : null,
      profile: profile?.projectRoute,
    }) ?? false;
  const registryPath =
    resolveLayered<string>({
      cli: args.registryPath,
      profile: profile?.registry,
    }) ?? null;
  const embeddingPackageName = effectivePackageName({
    cli: args.embeddingProvider,
    configured: activeConfig.providers?.embedding?.package ?? null,
    profileUse: profile?.use,
  });

  if ((portal || projectRoute) && !registryPath) {
    throw new ArgsError("--portal/--project-route requires a registry (--registry or config profile.registry)");
  }

  const effectiveArgs: ServeArgs = { ...args, portal, projectRoute, registryPath, embeddingProvider: embeddingPackageName };

  const portalConvention = resolvePortalConventionPaths(env);

  const record = await buildRecordProvider(effectiveArgs, { stateRoot, log, record: config.record });
  if (record) log(`record sink: ${record.name}`);

  const embeddingProvider: EmbeddingProvider | undefined = embeddingPackageName
    ? await (options.buildEmbeddingProvider ?? buildEmbeddingProvider)({
        enabled: true,
        packageName: embeddingPackageName,
        config: activeConfig,
      })
    : undefined;
  const providers = await buildProviders(effectiveArgs, {
    config: activeConfig,
    registryPath,
    portalDisplay: resolvePortalDisplay(profile, config.deploy),
    portalAssetsRoot: portal ? portalConvention.portalAssetsRoot : undefined,
    projectsConfigPath: portal ? portalConvention.projectsConfigPath : undefined,
    log,
  });
  if (providers.authProvider) log(`auth provider: ${providers.authProvider.name}`);
  if (providers.orgPolicy) log(`org policy: ${providers.orgPolicy.name}`);
  if (providers.portal) log("portal: enabled");
  if (providers.projectRoute) log("project routing: enabled");
  const maintenanceState = resolveMaintenanceState(effectiveArgs);
  if (maintenanceState?.enabled) log(`maintenance: ${maintenanceState.scope}`);

  const running = await startGatewayServer({
    host,
    port,
    stateRoot,
    distDir,
    runtimeToken: effectiveToken,
    projectRoot,
    record,
    embeddingProvider,
    authProvider: providers.authProvider,
    orgPolicy: providers.orgPolicy,
    portal: providers.portal,
    projectRoute: providers.projectRoute,
    resolveMaintenanceState: maintenanceState ? () => maintenanceState : undefined,
    log,
  });

  if (options.installSignalHandlers !== false) {
    const shutdown = (signal: string) => {
      log(`received ${signal}, shutting down gateway`);
      running.close().then(() => process.exit(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  }

  return running;
}

function effectivePackageName(
  source: { cli: string | null; configured: string | null; profileUse: string[] | undefined },
): string | null {
  if (source.cli) return source.cli;
  if (!source.configured) return null;
  if (source.profileUse && source.profileUse.length > 0 && !source.profileUse.includes("embedding")) {
    return null;
  }
  return source.configured;
}
