/**
 * `build` command: deterministic full-build of a repo's knowledge graph.
 *
 * Locates the upstream Understand-Anything plugin at runtime (never bundled),
 * then runs the six-phase deterministic pipeline from `@understand-anyway/core`
 * (scan -> importMap -> compute-batches -> batch graph -> merge -> wrap) and
 * persists graph/meta/config under `<state-dir>/.understand-anything/`.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertUpstreamLlmContract,
  bootstrapUpstream,
  runBuildMode,
  type RunBuildModeResult,
} from "@understand-anyway/core";
import { buildProjectSourceMirrorPath, readProjectVersionState } from "@understand-anyway/gateway";
import type { BuildArgs } from "./args.js";
import { resolveBuildConfig, type ResolvedBuildOptions } from "./build-config.js";
import { buildEmbeddingProvider } from "./build-embedding.js";
import { buildLlmProvider } from "./build-llm.js";
import { CLI_ENTRY } from "./cli-entry.js";
import { loadResolvedConfig } from "./config/load.js";
import { resolveProjectContext } from "./project-context.js";

export interface RunBuildDeps {
  bootstrap?: typeof bootstrapUpstream;
  assertLlmContract?: typeof assertUpstreamLlmContract;
  runBuild?: typeof runBuildMode;
  loadConfig?: typeof loadResolvedConfig;
  buildLlmProvider?: typeof buildLlmProvider;
  buildEmbeddingProvider?: typeof buildEmbeddingProvider;
  resolveProjectContext?: typeof resolveProjectContext;
  /** Override for the CLI entry path; defaults to the cli.ts CLI_ENTRY export. */
  cliEntry?: string;
}

export interface RunBuildOptions {
  log?: (message: string) => void;
  deps?: RunBuildDeps;
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`build: ${label} is not a directory: ${path}`);
  }
}

/**
 * Build the worker-side --llm-* argv slice from the resolved build options and
 * CLI flags. Matches packages/cli/src/batch-mapper-worker.ts parser.
 */
function buildLlmWorkerArgs(
  providerPackageName: string | null,
  resolved: ResolvedBuildOptions,
  configPath: string | null,
): string[] {
  if (!resolved.llmAnalysis) return [];
  const argv: string[] = ["--llm-analysis"];
  if (configPath) argv.push("--config", configPath);
  if (providerPackageName) argv.push("--llm-provider", providerPackageName);
  if (resolved.llmModelCandidates.length > 0) {
    argv.push("--llm-model-candidates", resolved.llmModelCandidates.join(","));
  }
  if (resolved.llmRequired) argv.push("--llm-required");
  if (resolved.llmRetryPolicy.maxAttempts !== undefined) {
    argv.push("--llm-retry-max-attempts", String(resolved.llmRetryPolicy.maxAttempts));
  }
  if (resolved.llmRetryPolicy.initialBackoffMs !== undefined) {
    argv.push("--llm-retry-initial-backoff", String(resolved.llmRetryPolicy.initialBackoffMs));
  }
  if (resolved.llmRetryPolicy.maxBackoffMs !== undefined) {
    argv.push("--llm-retry-max-backoff", String(resolved.llmRetryPolicy.maxBackoffMs));
  }
  if (resolved.llmRetryPolicy.backoffMultiplier !== undefined) {
    argv.push("--llm-retry-backoff-multiplier", String(resolved.llmRetryPolicy.backoffMultiplier));
  }
  if (resolved.llmRetryPolicy.jitterRatio !== undefined) {
    argv.push("--llm-retry-jitter-ratio", String(resolved.llmRetryPolicy.jitterRatio));
  }
  return argv;
}

function resolveScanRoot(projectRoot: string, stateRoot: string): string | undefined {
  const state = readProjectVersionState(stateRoot);
  const currentVersion = String(state.currentVersion || "").trim();
  if (!currentVersion) return undefined;
  const mirrorPath = buildProjectSourceMirrorPath(currentVersion, stateRoot);
  return existsSync(mirrorPath) ? resolve(mirrorPath) : undefined;
}

export async function runBuild(args: BuildArgs, options: RunBuildOptions = {}): Promise<RunBuildModeResult> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const bootstrap = options.deps?.bootstrap ?? bootstrapUpstream;
  const assertLlmContract = options.deps?.assertLlmContract ?? assertUpstreamLlmContract;
  const runBuildPipeline = options.deps?.runBuild ?? runBuildMode;
  const loadConfig = options.deps?.loadConfig ?? loadResolvedConfig;
  const loadLlmProvider = options.deps?.buildLlmProvider ?? buildLlmProvider;
  const loadEmbeddingProvider = options.deps?.buildEmbeddingProvider ?? buildEmbeddingProvider;
  const resolveCtx = options.deps?.resolveProjectContext ?? resolveProjectContext;
  const cliEntry = options.deps?.cliEntry ?? CLI_ENTRY;

  const ctx = resolveCtx(args.projectId);
  const projectRoot = ctx.repoPath;
  const stateRoot = ctx.stateRoot;
  const scanRoot = resolveScanRoot(projectRoot, stateRoot);

  assertDirectory(projectRoot, "repo");
  const effectiveConfigPath = args.config ?? ctx.deployConfigPath;
  const config = loadConfig({ ...args, config: effectiveConfigPath, configExplicit: Boolean(args.config) }, {
    cwd: process.cwd(),
    env: process.env,
  });
  const resolved = resolveBuildConfig(args, config);
  const llmProviderPackageName = args.llmProvider ?? config.providers?.llm?.package ?? null;
  const embeddingPackageName = args.embeddingProvider ?? config.providers?.embedding?.package ?? null;

  log(`resolving upstream plugin${resolved.pluginRoot ? ` (--plugin-root ${resolved.pluginRoot})` : ""}`);
  const upstream = await bootstrap({ pluginRoot: resolved.pluginRoot });
  log(`upstream plugin: ${upstream.pluginRoot}`);
  if (resolved.llmAnalysis) {
    assertLlmContract(upstream.core, upstream.skillDir);
    log("upstream LLM contract preflight passed");
  }

  const llmProvider = resolved.llmAnalysis
    ? await loadLlmProvider({
        enabled: true,
          packageName: llmProviderPackageName,
        config,
      })
    : undefined;
  const embeddingProvider = embeddingPackageName
    ? await loadEmbeddingProvider({
        enabled: true,
        packageName: embeddingPackageName,
        config,
      })
    : undefined;

  const result = await runBuildPipeline({
    core: upstream.core,
    skillDir: upstream.skillDir,
    projectRoot,
    scanRoot,
    stateRoot,
    mode: resolved.mode,
    includePaths: resolved.includePaths,
    outputLanguage: resolved.outputLanguage,
    excludeTests: resolved.excludeTests,
    llm: {
      enabled: resolved.llmAnalysis,
      required: resolved.llmRequired,
      provider: llmProvider,
      retryPolicy: resolved.llmRetryPolicy,
      modelCandidates: resolved.llmModelCandidates,
    },
    embedding: {
      enabled: Boolean(embeddingProvider),
      provider: embeddingProvider,
    },
    batchMode: resolved.batchMode,
    mapperBatchCount: resolved.mapperBatchCount,
    mapperConcurrency: resolved.mapperConcurrency,
    pluginRoot: resolved.pluginRoot,
    cliEntry,
    llmWorkerArgs: buildLlmWorkerArgs(
      llmProviderPackageName,
      resolved,
      effectiveConfigPath && existsSync(effectiveConfigPath) ? effectiveConfigPath : null,
    ),
    log,
  });

  log(
    `graph written to ${stateRoot}/.understand-anything ` +
      `(nodes=${result.graph.nodes.length} edges=${result.graph.edges.length} files=${result.analyzedFiles})`,
  );
  return result;
}
