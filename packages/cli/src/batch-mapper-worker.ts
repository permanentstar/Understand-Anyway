/**
 * `batch-mapper-worker` child entry (C7.5).
 *
 * Spawned by the parent's segmented scheduler (`writeBatchGraphFilesSegmented`)
 * with a single segment's worth of work. Reads the indexes-file the parent
 * wrote, slices `intermediate/batches.json` accordingly, runs the
 * deterministic batch analyser for each batch (with optional LLM enrichment
 * + retry), and writes `batch-<n>.json` artefacts.
 *
 * Exit codes:
 *   0 success (every requested batch produced a valid artefact)
 *   2 argument / env error
 *   1 generic failure (analyser threw, LLM failed in --llm-required mode, etc.)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArgsError } from "./args.js";
import { analyzeSingleBatch, assertUpstreamLlmContract, bootstrapUpstream, createAnalyzerRegistry, currentGitHash, resolveBuildPaths, writeOneBatchGraphFile, runLlmFileAnalysis, type LLMFileAnalysis, type RetryPolicy } from "@understand-anyway/core";

export type WorkerLog = (line: string) => void;

export interface WorkerArgs {
  stateDir: string;
  projectRoot: string;
  outputLanguage: string;
  indexesFile: string;
  includePathsFile: string | null;
  config: string | null;
  pluginRoot: string | null;
  llmAnalysis: boolean;
  llmProvider: string | null;
  llmProfile: string | null;
  providerModelCandidates: string[];
  llmRequired: boolean;
  llmTimeoutMs: number | null;
  llmRetryPolicy: Partial<RetryPolicy>;
  globalLlmConcurrency: number | null;
  llmQpmLimit: number | null;
}

export interface RunWorkerDeps {
  /** Bootstrap upstream plugin; injected for tests. */
  bootstrap?: typeof bootstrapUpstream;
  assertLlmContract?: typeof assertUpstreamLlmContract;
  /** Build the analyzer registry; injected for tests. */
  createRegistry?: typeof createAnalyzerRegistry;
  /** Load an LLM provider by package name; null = no provider. */
  loadLlmProvider?: (packageName: string, configPath: string | null, llmProfile?: string | null) => Promise<{
    name: string;
    complete: (request: { prompt: string; timeoutMs?: number }) => Promise<{ text: string }>;
  } | undefined>;
  /** File system seam (defaults to node:fs). */
  readFileSync?: (path: string, encoding: "utf8") => string;
  existsSync?: (path: string) => boolean;
  /** Git hash resolver (defaults to running `git`). */
  resolveGitHash?: (projectRoot: string) => string;
  /** Run LLM file analysis (defaults to core helper). */
  runLlm?: typeof runLlmFileAnalysis;
  analyzeBatch?: typeof analyzeSingleBatch;
  writeBatchFile?: typeof writeOneBatchGraphFile;
}

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const required = new Set(["state-dir", "project-root", "output-language", "indexes-file"]);
  const seen = new Set<string>();
  let stateDir = "";
  let projectRoot = "";
  let outputLanguage = "en";
  let indexesFile = "";
  let includePathsFile: string | null = null;
  let config: string | null = null;
  let pluginRoot: string | null = null;
  let llmAnalysis = false;
  let llmProvider: string | null = null;
  let llmProfile: string | null = null;
  let providerModelCandidates: string[] = [];
  let llmRequired = false;
  let llmTimeoutMs: number | null = null;
  let globalLlmConcurrency: number | null = null;
  let llmQpmLimit: number | null = null;
  const retry: Partial<RetryPolicy> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const take = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new ArgsError(`missing value for ${arg}`);
      return value;
    };
    const takeInt = (min: number) => {
      const value = take();
      if (!/^\d+$/.test(value)) throw new ArgsError(`${arg} must be an integer >= ${min}`);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min) throw new ArgsError(`${arg} must be an integer >= ${min}`);
      return parsed;
    };
    const takeNumber = (min: number, max = Number.POSITIVE_INFINITY) => {
      const value = take();
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new ArgsError(`${arg} must be a number in [${min}, ${max}]`);
      }
      return parsed;
    };
    switch (arg) {
      case "--state-dir":
        stateDir = take();
        seen.add("state-dir");
        break;
      case "--project-root":
        projectRoot = take();
        seen.add("project-root");
        break;
      case "--output-language":
        outputLanguage = take();
        seen.add("output-language");
        break;
      case "--indexes-file":
        indexesFile = take();
        seen.add("indexes-file");
        break;
      case "--include-paths-file":
        includePathsFile = take();
        break;
      case "--config":
        config = take();
        break;
      case "--plugin-root":
        pluginRoot = take();
        break;
      case "--llm-analysis":
        llmAnalysis = true;
        break;
      case "--llm-provider":
        llmProvider = take();
        break;
      case "--llm-profile":
        llmProfile = take();
        break;
      case "--llm-provider-model-candidates":
        providerModelCandidates = take().split(",").map((entry) => entry.trim()).filter(Boolean);
        break;
      case "--llm-required":
        llmRequired = true;
        break;
      case "--llm-timeout":
        llmTimeoutMs = takeInt(1);
        break;
      case "--llm-retry-max-attempts":
        retry.maxAttempts = takeInt(1);
        break;
      case "--llm-retry-initial-backoff":
        retry.initialBackoffMs = takeInt(0);
        break;
      case "--llm-retry-max-backoff":
        retry.maxBackoffMs = takeInt(0);
        break;
      case "--llm-retry-backoff-multiplier":
        retry.backoffMultiplier = takeNumber(1);
        break;
      case "--llm-retry-jitter-ratio":
        retry.jitterRatio = takeNumber(0, 1);
        break;
      case "--global-llm-concurrency":
        globalLlmConcurrency = takeInt(1);
        break;
      case "--llm-qpm-limit":
        llmQpmLimit = takeInt(1);
        break;
      default:
        throw new ArgsError(`unknown worker option: ${arg}`);
    }
  }
  for (const key of required) {
    if (!seen.has(key)) throw new ArgsError(`missing required worker option: --${key}`);
  }
  return {
    stateDir,
    projectRoot,
    outputLanguage,
    indexesFile,
    includePathsFile,
    config,
    pluginRoot,
    llmAnalysis,
    llmProvider,
    llmProfile,
    providerModelCandidates,
    llmRequired,
    llmTimeoutMs,
    llmRetryPolicy: retry,
    globalLlmConcurrency,
    llmQpmLimit,
  };
}

function readUtf8(path: string, deps: RunWorkerDeps): string {
  const read = deps.readFileSync ?? ((p: string, e: "utf8") => readFileSync(p, e));
  return read(path, "utf8");
}

function fileExists(path: string, deps: RunWorkerDeps): boolean {
  const exists = deps.existsSync ?? existsSync;
  return exists(path);
}

function readIndexes(path: string, deps: RunWorkerDeps): Array<number | string> {
  return readUtf8(path, deps)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((token) => /^\d+$/.test(token) ? Number(token) : token);
}

function readIncludePaths(path: string | null, deps: RunWorkerDeps): ReadonlySet<string> | null {
  if (!path) return null;
  const lines = readUtf8(path, deps)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return new Set(lines);
}

async function maybeLoadLlmProvider(args: WorkerArgs, deps: RunWorkerDeps) {
  if (!args.llmAnalysis) return undefined;
  if (!args.llmProvider) {
    throw new ArgsError("--llm-analysis requires --llm-provider in the worker");
  }
  if (!deps.loadLlmProvider) {
    throw new ArgsError("worker cannot load --llm-provider: no provider loader injected");
  }
  const provider = args.llmProfile
    ? await deps.loadLlmProvider(args.llmProvider, args.config, args.llmProfile)
    : await deps.loadLlmProvider(args.llmProvider, args.config);
  if (!provider) throw new ArgsError(`failed to load LLM provider: ${args.llmProvider}`);
  return provider;
}

export async function runBatchMapperWorker(
  args: WorkerArgs,
  log: WorkerLog,
  deps: RunWorkerDeps = {},
): Promise<{ processed: number }> {
  const projectRoot = resolve(args.projectRoot);
  const stateRoot = resolve(args.stateDir);
  const paths = resolveBuildPaths(stateRoot);
  const indexesFile = resolve(args.indexesFile);
  if (!fileExists(paths.batchesPath, deps)) {
    throw new Error(`worker: batches.json not found at ${paths.batchesPath}`);
  }
  if (!fileExists(indexesFile, deps)) {
    throw new Error(`worker: indexes file not found at ${indexesFile}`);
  }
  const requestedIndexes = readIndexes(indexesFile, deps);
  if (requestedIndexes.length === 0) {
    throw new Error("worker: indexes file is empty");
  }
  const indexSet = new Set(requestedIndexes.map(String));
  const batchesJson = JSON.parse(readUtf8(paths.batchesPath, deps)) as { batches?: Array<Record<string, unknown>> };
  const allBatches = Array.isArray(batchesJson.batches) ? batchesJson.batches : [];
  const segmentBatches = allBatches.filter((batch) => indexSet.has(String(batch.batchIndex)));
  if (segmentBatches.length !== requestedIndexes.length) {
    const missing = requestedIndexes.filter((idx) => !segmentBatches.some((b) => String(b.batchIndex) === String(idx)));
    throw new Error(`worker: missing batch entries in batches.json: ${missing.join(",")}`);
  }

  const bootstrap = deps.bootstrap ?? bootstrapUpstream;
  const buildRegistry = deps.createRegistry ?? createAnalyzerRegistry;
  const resolveGit = deps.resolveGitHash ?? ((root: string) => currentGitHash(root));
  const llmRun = deps.runLlm ?? runLlmFileAnalysis;
  const analyzeBatch = deps.analyzeBatch ?? analyzeSingleBatch;
  const writeBatchFile = deps.writeBatchFile ?? writeOneBatchGraphFile;
  const upstream = await bootstrap({ pluginRoot: args.pluginRoot ?? undefined });
  if (args.llmAnalysis) {
    const assertLlmContract = deps.assertLlmContract ?? assertUpstreamLlmContract;
    assertLlmContract(upstream.core, upstream.skillDir);
  }
  const registry = await buildRegistry(upstream.core);
  const llmProvider = await maybeLoadLlmProvider(args, deps);
  const includePaths = readIncludePaths(args.includePathsFile, deps);
  const gitHash = process.env.UA_BATCH_GIT_HASH ?? resolveGit(projectRoot);
  const projectName = process.env.UA_BATCH_PROJECT_NAME ?? projectRoot.split("/").pop() ?? "project";
  const scanRoot = process.env.UA_BATCH_SCAN_ROOT ?? stateRoot;

  let processed = 0;
  for (const batch of segmentBatches) {
    const files = Array.isArray((batch as { files?: unknown }).files)
      ? ((batch as { files?: Array<{ path: string }> }).files ?? [])
      : [];
    const selectedFiles = includePaths
      ? files.filter((file) => includePaths.has(file.path))
      : files;

    let llmAnalyses: Map<string, LLMFileAnalysis> | undefined;
    if (args.llmAnalysis && llmProvider && selectedFiles.length > 0) {
      const run = await llmRun({
        enabled: true,
        required: args.llmRequired,
        files: selectedFiles,
        analysisRoot: scanRoot,
        projectContext: projectName,
        readFile: (absPath) => readUtf8(absPath, deps),
        provider: llmProvider,
        core: upstream.core,
        timeoutMs: args.llmTimeoutMs ?? undefined,
        retryPolicy: { ...args.llmRetryPolicy } as RetryPolicy,
        qpmLimit: args.llmQpmLimit ?? undefined,
        globalConcurrency: args.globalLlmConcurrency ?? undefined,
        modelCandidates: args.providerModelCandidates,
        outputLanguage: args.outputLanguage,
      });
      llmAnalyses = run.analyses;
    }

    const enrichedBatch = { ...(batch as object), files: selectedFiles } as Parameters<typeof analyzeSingleBatch>[0]["batch"];
    const result = analyzeBatch({
      core: upstream.core,
      registry,
      analysisRoot: scanRoot,
      batch: enrichedBatch,
      outputLanguage: args.outputLanguage,
      projectName,
      gitHash,
      log,
      llmAnalyses,
    });
    if (!result) {
      log(`worker: batch ${String((batch as { batchIndex: unknown }).batchIndex)} produced no artefact (skipped)`);
      continue;
    }
    const output = args.llmAnalysis
      ? { ...result, artifact: { ...result.artifact, llmEnriched: true } } as typeof result
      : result;
    writeBatchFile(paths.intermediateDir, output);
    processed += 1;
  }

  return { processed };
}
