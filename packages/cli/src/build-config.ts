/**
 * Build config/deploy-profile resolution.
 *
 * This keeps the public CLI template-oriented while still allowing stable build
 * defaults in deploy.yaml deployProfiles. Per-run repair targets (`--include`) and
 * rare tuning knobs intentionally stay out of the YAML contract.
 */

import type { ResolvedConfig } from "@understand-anyway/plugin-api";
import {
  DEFAULT_RETRY_POLICY,
  defaultMapperConcurrencyForHost,
  readHostMetrics,
  type HostMetricsDeps,
  type RetryPolicy,
} from "@understand-anyway/core";
import { ArgsError, type BatchMode, type BuildArgs, type BuildMode } from "./args.js";

export interface ResolvedBuildOptions {
  mode: BuildMode;
  includePaths: string[];
  excludeTests: boolean;
  pluginRoot: string | null;
  outputLanguage: string;
  llmAnalysis: boolean;
  llmRequired: boolean;
  llmRetryPolicy: RetryPolicy;
  llmConcurrencyPerMapper: number;
  llmQpmLimit: number;
  batchMode: BatchMode;
  mappers: number;
}

interface BuildSection {
  mode?: unknown;
  outputLanguage?: string;
  excludeTests?: boolean;
  pluginRoot?: string;
  llmAnalysis?: boolean;
  llmRequired?: boolean;
  llmRetry?: LlmRetrySection;
  llmConcurrencyPerMapper?: unknown;
  llmQpmLimit?: unknown;
  batchMode?: unknown;
  mappers?: unknown;
}

interface LlmRetrySection {
  maxAttempts?: unknown;
  initialBackoffMs?: unknown;
  backoffMultiplier?: unknown;
  maxBackoffMs?: unknown;
  jitterRatio?: unknown;
}

function modeValue(value: unknown): BuildMode | undefined {
  if (value === undefined) return undefined;
  if (value === "full" || value === "incremental" || value === "resume" || value === "backfill") return value;
  throw new ArgsError(`invalid build.mode: ${String(value)}`);
}

function modeFromEnv(env: NodeJS.ProcessEnv, key: string): BuildMode | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  if (raw === "full" || raw === "incremental" || raw === "resume" || raw === "backfill") return raw;
  throw new ArgsError(`invalid ${key}: ${raw}`);
}

function buildSection(value: unknown): BuildSection {
  return value && typeof value === "object" ? (value as BuildSection) : {};
}

export interface ResolveBuildConfigDeps {
  /** Environment lookup (UA_LLM_RETRY_*); injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Host metric sources for mapper auto-defaults; injectable for tests. */
  hostMetrics?: HostMetricsDeps;
}

function readEnvInt(env: NodeJS.ProcessEnv, key: string, { min }: { min: number }): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new ArgsError(`invalid ${key}: ${raw}`);
  }
  return parsed;
}

function readEnvNumber(env: NodeJS.ProcessEnv, key: string, { min, max }: { min: number; max?: number }): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    throw new ArgsError(`invalid ${key}: ${raw}`);
  }
  return parsed;
}

function intFromYaml(value: unknown, path: string, { min }: { min: number }): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ArgsError(`invalid ${path}: ${String(value)}`);
  }
  return value;
}

function numberFromYaml(value: unknown, path: string, { min, max }: { min: number; max?: number }): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    throw new ArgsError(`invalid ${path}: ${String(value)}`);
  }
  return value;
}

function resolveLlmRetryPolicy(
  args: BuildArgs,
  profileBuild: BuildSection,
  baseBuild: BuildSection,
  env: NodeJS.ProcessEnv,
  profileBuildPath = "deployProfile.build",
): RetryPolicy {
  const profileRetry = profileBuild.llmRetry;
  const baseRetry = baseBuild.llmRetry;

  const profileMax = intFromYaml(profileRetry?.maxAttempts, `${profileBuildPath}.llmRetry.maxAttempts`, { min: 1 });
  const baseMax = intFromYaml(baseRetry?.maxAttempts, "deploy.build.llmRetry.maxAttempts", { min: 1 });
  const profileInitial = intFromYaml(profileRetry?.initialBackoffMs, `${profileBuildPath}.llmRetry.initialBackoffMs`, { min: 0 });
  const baseInitial = intFromYaml(baseRetry?.initialBackoffMs, "deploy.build.llmRetry.initialBackoffMs", { min: 0 });
  const profileMaxBackoff = intFromYaml(profileRetry?.maxBackoffMs, `${profileBuildPath}.llmRetry.maxBackoffMs`, { min: 0 });
  const baseMaxBackoff = intFromYaml(baseRetry?.maxBackoffMs, "deploy.build.llmRetry.maxBackoffMs", { min: 0 });
  const profileMultiplier = numberFromYaml(profileRetry?.backoffMultiplier, `${profileBuildPath}.llmRetry.backoffMultiplier`, { min: 1 });
  const baseMultiplier = numberFromYaml(baseRetry?.backoffMultiplier, "deploy.build.llmRetry.backoffMultiplier", { min: 1 });
  const profileJitter = numberFromYaml(profileRetry?.jitterRatio, `${profileBuildPath}.llmRetry.jitterRatio`, { min: 0, max: 1 });
  const baseJitter = numberFromYaml(baseRetry?.jitterRatio, "deploy.build.llmRetry.jitterRatio", { min: 0, max: 1 });

  return {
    maxAttempts:
      args.llmRetry.maxAttempts
      ?? readEnvInt(env, "UA_LLM_RETRY_MAX_ATTEMPTS", { min: 1 })
      ?? profileMax
      ?? baseMax
      ?? DEFAULT_RETRY_POLICY.maxAttempts,
    initialBackoffMs:
      args.llmRetry.initialBackoffMs
      ?? readEnvInt(env, "UA_LLM_RETRY_INITIAL_BACKOFF_MS", { min: 0 })
      ?? profileInitial
      ?? baseInitial
      ?? DEFAULT_RETRY_POLICY.initialBackoffMs,
    maxBackoffMs:
      args.llmRetry.maxBackoffMs
      ?? readEnvInt(env, "UA_LLM_RETRY_MAX_BACKOFF_MS", { min: 0 })
      ?? profileMaxBackoff
      ?? baseMaxBackoff
      ?? DEFAULT_RETRY_POLICY.maxBackoffMs,
    backoffMultiplier:
      readEnvNumber(env, "UA_LLM_RETRY_MULTIPLIER", { min: 1 })
      ?? profileMultiplier
      ?? baseMultiplier
      ?? DEFAULT_RETRY_POLICY.backoffMultiplier,
    jitterRatio:
      readEnvNumber(env, "UA_LLM_RETRY_JITTER_RATIO", { min: 0, max: 1 })
      ?? profileJitter
      ?? baseJitter
      ?? DEFAULT_RETRY_POLICY.jitterRatio,
  };
}

function batchModeFromYaml(value: unknown, path: string): BatchMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "full" || value === "segmented") return value;
  throw new ArgsError(`invalid ${path}: ${String(value)}`);
}

export function resolveBuildConfig(
  args: BuildArgs,
  config: ResolvedConfig,
  deps: ResolveBuildConfigDeps = {},
): ResolvedBuildOptions {
  const deployProfile = args.deployProfile ? config.deployProfiles?.[args.deployProfile] : undefined;
  if (args.deployProfile && !deployProfile) throw new ArgsError(`unknown --deploy-profile: ${args.deployProfile}`);

  const baseBuild = buildSection(config.deploy?.["build"]);
  const profileBuild = buildSection(deployProfile?.["build"]);
  const profileBuildPath = args.deployProfile
    ? `deployProfiles.${args.deployProfile}.build`
    : "deployProfile.build";
  const configuredMode = modeValue(profileBuild?.mode ?? baseBuild?.mode);
  const env = deps.env ?? process.env;
  const envModeOverride = modeFromEnv(env, "UA_BUILD_MODE_OVERRIDE");

  const cliBatchMode = args.batchMode !== "auto" ? args.batchMode : undefined;
  const batchMode: BatchMode =
    cliBatchMode
    ?? batchModeFromYaml(profileBuild?.batchMode, `${profileBuildPath}.batchMode`)
    ?? batchModeFromYaml(baseBuild?.batchMode, "deploy.build.batchMode")
    ?? "auto";

  const yamlMappers =
    intFromYaml(profileBuild?.mappers, `${profileBuildPath}.mappers`, { min: 1 })
    ?? intFromYaml(baseBuild?.mappers, "deploy.build.mappers", { min: 1 });
  const yamlLlmConcurrencyPerMapper =
    intFromYaml(profileBuild?.llmConcurrencyPerMapper, `${profileBuildPath}.llmConcurrencyPerMapper`, { min: 1 })
    ?? intFromYaml(baseBuild?.llmConcurrencyPerMapper, "deploy.build.llmConcurrencyPerMapper", { min: 1 });
  const yamlLlmQpmLimit =
    intFromYaml(profileBuild?.llmQpmLimit, `${profileBuildPath}.llmQpmLimit`, { min: 1 })
    ?? intFromYaml(baseBuild?.llmQpmLimit, "deploy.build.llmQpmLimit", { min: 1 });

  const metrics = readHostMetrics(deps.hostMetrics ?? {});
  const mappers =
    args.mappers
    ?? readEnvInt(env, "UA_MAPPERS", { min: 1 })
    ?? yamlMappers
    ?? defaultMapperConcurrencyForHost(metrics);
  const llmConcurrencyPerMapper =
    args.llmConcurrencyPerMapper
    ?? readEnvInt(env, "UA_LLM_CONCURRENCY_PER_MAPPER", { min: 1 })
    ?? yamlLlmConcurrencyPerMapper
    ?? 1;
  const llmQpmLimit =
    args.llmQpmLimit
    ?? readEnvInt(env, "UA_LLM_QPM_LIMIT", { min: 1 })
    ?? yamlLlmQpmLimit
    ?? 1;

  return {
    mode: args.mode !== "full" ? args.mode : envModeOverride ?? configuredMode ?? "full",
    includePaths: args.includePaths,
    excludeTests: args.excludeTests ?? profileBuild?.excludeTests ?? baseBuild?.excludeTests ?? true,
    pluginRoot: args.pluginRoot ?? profileBuild?.pluginRoot ?? baseBuild?.pluginRoot ?? null,
    outputLanguage:
      args.outputLanguage
      ?? profileBuild?.outputLanguage
      ?? baseBuild?.outputLanguage
      ?? config.deploy?.outputLanguage
      ?? "en",
    llmAnalysis: args.llmAnalysis ?? profileBuild?.llmAnalysis ?? baseBuild?.llmAnalysis ?? false,
    llmRequired: args.llmRequired ?? profileBuild?.llmRequired ?? baseBuild?.llmRequired ?? false,
    llmRetryPolicy: resolveLlmRetryPolicy(args, profileBuild, baseBuild, env, profileBuildPath),
    llmConcurrencyPerMapper,
    llmQpmLimit,
    batchMode,
    mappers,
  };
}
