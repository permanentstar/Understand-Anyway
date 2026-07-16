/**
 * Neutral configuration contract for the layered YAML deploy config.
 *
 * The open-source CLI discovers a single `deploy.yaml` (see
 * {@link CONFIG_FILE_NAMES} / {@link CONFIG_ENV_VAR}), parses + interpolates it,
 * then layers CLI/env/deploy-profile/base values into a {@link ResolvedConfig}.
 * This module only declares the shape + the discovery constants; the actual
 * discovery/interpolation/layering mechanism lives in the CLI package.
 *
 * Mirrors the "type + runtime constant" co-location of provider-factory.ts and
 * keeps plugin-api free of any runtime dependency. Provider package names only
 * ever come from `providers.*.package` in the YAML — never from code.
 */

/** Stable build template defaults. Occasional expert tuning does not live here. */
export interface BuildConfig {
  outputLanguage?: string;
  excludeTests?: boolean;
  pluginRoot?: string;
  mode?: "full" | "incremental" | "resume" | "backfill";
  /** Stable toggle: enable optional LLM enrichment. Default false. */
  llmAnalysis?: boolean;
  /** Stable toggle: fail the build when LLM analysis fails. Default false. */
  llmRequired?: boolean;
  /** Ordered model candidates for provider requests. Omitted = provider default. */
  llmModelCandidates?: string[];
  /** Transient-retry policy around a single LLM call (C8). Defaults to DEFAULT_RETRY_POLICY. */
  llmRetry?: LlmRetryConfig;
  /** Phase 2 batch-mode (C7). `auto` falls back to fixture-size based decision. */
  batchMode?: "auto" | "full" | "segmented";
  /** Batches per spawned mapper segment (C7). Omitted = host-aware default. */
  mapperBatchCount?: number;
  /** Parallel mapper segments (C7). Omitted = host-aware default. */
  mapperConcurrency?: number;
}

/** Stable transient-retry tuning (C8). Omitted fields fall back to defaults. */
export interface LlmRetryConfig {
  maxAttempts?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
}

/** Global deploy defaults (layer 4, base). Extra fields pass through verbatim. */
export interface DeployConfig {
  host?: string;
  port?: number;
  outputLanguage?: string;
  build?: BuildConfig;
  [key: string]: unknown;
}

/** Shared gateway runtime defaults. */
export interface GatewayConfig {
  retain?: number;
}

/** A single dynamically-loaded provider: package name + opaque factory config. */
export interface ProviderEntry {
  /** Package name to `import()`; the only source of provider package names. */
  package: string;
  /** Passed verbatim to the package's factory export. */
  config?: unknown;
}

/** Provider wiring block. Each provider is optional. */
export interface ProvidersConfig {
  auth?: ProviderEntry;
  orgPolicy?: ProviderEntry;
  portalAssets?: ProviderEntry;
  llm?: ProviderEntry;
  embedding?: ProviderEntry;
  notify?: ProviderEntry;
}

/** Record sink section: which providers to compose + per-provider config. */
export interface RecordSection {
  /** Ordered provider names (e.g. ["local", "feishu-sheets"]). */
  providers?: string[];
  /** Per-provider config, keyed by provider name. */
  config?: Record<string, unknown>;
}

/**
 * A named profile (layer 3). `use` references provider blocks by key; the
 * remaining known fields toggle serve routes. Unknown fields pass through.
 */
export interface ProfileSection {
  host?: string;
  port?: number;
  portal?: boolean;
  projectRoute?: boolean;
  registry?: string;
  build?: BuildConfig;
  /** References to `providers.*` keys to activate for this profile. */
  use?: string[];
  [key: string]: unknown;
}

/**
 * Deployment environment profile. Keeps environment topology/spec choices
 * orthogonal to LLM provider protocol choices.
 */
export interface DeployProfileSection {
  deploy?: DeployConfig;
  gateway?: GatewayConfig;
  build?: BuildConfig;
  [key: string]: unknown;
}

/** Fully discovered + interpolated + layered runtime config. */
export interface ResolvedConfig {
  deploy?: DeployConfig;
  gateway?: GatewayConfig;
  providers?: ProvidersConfig;
  record?: RecordSection;
  profiles?: Record<string, ProfileSection>;
  deployProfiles?: Record<string, DeployProfileSection>;
  llmProfiles?: Record<string, ProviderEntry>;
}

/** Default config filenames, searched in order relative to each base dir. */
export const CONFIG_FILE_NAMES = ["deploy.yaml", "config/deploy.yaml"] as const;

/** Env var that may point at a config file/dir (lower priority than --config). */
export const CONFIG_ENV_VAR = "UA_CONFIG" as const;
