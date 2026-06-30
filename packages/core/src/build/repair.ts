/**
 * D9 — controlled repair commands (out-of-band, human-triggered; never part of
 * the nightly main path). Two engines:
 *
 *   repairLlmFailures      re-run the LLM file-analysis tasks that failed in the
 *                          last build (read back from
 *                          `.understand-anything/llm/latest-stats.json`),
 *                          patch the affected batch artefacts, re-merge into the
 *                          existing graph, and persist. Writes a repair report.
 *   repairLlmGraphFailures graph-level layer/project/tour enrichment repair
 *                          using the same upstream prompt/parser wiring as the
 *                          wrap phase. This path mutates the current graph only
 *                          when a provider is configured and dry-run is false.
 *
 * Everything is injected (fs / git / registry / checkpoint / llm / clock) so the
 * CI gate runs with fakes and no upstream / no API key. Mirrors the partial-
 * update path in pipeline.ts; it does not introduce a new merge strategy.
 */

import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import type { LlmProvider } from "@understand-anyway/plugin-api";
import { resolveBuildPaths, UA_DIR } from "./artifacts.js";
import { writeBatchGraphFiles } from "./batch-graph.js";
import { validatePhase2Checkpoint } from "./checkpoint.js";
import { currentGitHash } from "./git.js";
import { mergeGraphPartialUpdate } from "./graph-update.js";
import { type LlmBuildStats, type LlmGraphStats, type LLMFileAnalysis, runLlmFileAnalysis, runLlmGraphEnhancement } from "./llm.js";
import type { RetryPolicy } from "./llm-retry.js";
import { persistValidatedGraph } from "./pipeline.js";
import { createAnalyzerRegistry } from "./registry.js";
import type { BuildLog } from "./scan.js";
import { selectBatchesForFiles } from "./selection.js";
import { formatLocalTimestamp } from "./time.js";

export interface RepairLlmOptions {
  /** Upstream runtime: loaded core module. */
  core: any;
  /** Repo root (for git metadata + file reads). */
  projectRoot: string;
  /** Root files are analyzed under (defaults to projectRoot). */
  analysisRoot?: string;
  /** Where `.understand-anything/` state lives (defaults to projectRoot). */
  stateRoot?: string;
  outputLanguage?: string;
  excludeTests?: boolean;
  /** Scan + plan only; never re-run the provider or rewrite the graph. */
  dryRun?: boolean;
  /** Cap the number of failed files to repair this run. */
  maxTasks?: number;
  /** Project context string handed to the prompt builder (defaults to basename). */
  projectContext?: string;
  /** LLM provider + knobs. Provider is required for a non-dry-run repair. */
  llm?: {
    provider?: LlmProvider;
    required?: boolean;
    timeoutMs?: number;
    retryPolicy?: RetryPolicy;
  };
  log?: BuildLog;
}

export interface RepairDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
  mkdirSync?: (path: string, options: { recursive: boolean }) => void;
  resolveGitHash?: (projectRoot: string) => string;
  createRegistry?: (core: any) => Promise<any>;
  validateCheckpoint?: typeof validatePhase2Checkpoint;
  runLlmFileAnalysis?: typeof runLlmFileAnalysis;
  runLlmGraphEnhancement?: typeof runLlmGraphEnhancement;
  now?: () => Date;
  runId?: () => string;
}

export interface RepairFailureEntry {
  filePath: string;
  reason: string;
}

export interface RepairLlmFailuresResult {
  runId: string;
  ts: string;
  command: "llm-failures";
  dryRun: boolean;
  maxTasks: number | null;
  /** Failed files selected for this run (after max-tasks truncation). */
  requested: number;
  /** Files actually handed to the provider (0 on dry-run). */
  attempted: number;
  repaired: number;
  stillFailed: number;
  targets: string[];
  repairedFiles: string[];
  failedFiles: RepairFailureEntry[];
  batchesPatched: Array<number | string>;
  stats: LlmBuildStats | null;
  reportPath: string;
}

export interface RepairGraphGaps {
  nodesMissingSummary: number;
  missingLayers: boolean;
  missingProjectSummary: boolean;
}

export interface RepairLlmGraphFailuresResult {
  runId: string;
  ts: string;
  command: "llm-graph-failures";
  status: "repaired" | "dry_run" | "skipped";
  gaps: RepairGraphGaps;
  reason?: string;
  stats: LlmGraphStats | null;
  reportPath: string;
}

function bindIo(deps: RepairDeps) {
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const read = deps.readFileSync ?? ((p: string, e: "utf8") => nodeReadFileSync(p, e));
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  const mkdir = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { nodeMkdirSync(p, o); });
  const now = deps.now ?? (() => new Date());
  const runId = deps.runId ?? (() => `repair-${now().getTime()}`);
  return { existsSync, read, write, mkdir, now, runId };
}

function writeReport(
  io: ReturnType<typeof bindIo>,
  stateRoot: string,
  runId: string,
  report: unknown,
): string {
  const dir = resolve(stateRoot, UA_DIR, "repair-runs", runId);
  io.mkdir(dir, { recursive: true });
  const reportPath = resolve(dir, "result.json");
  io.write(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

export async function repairLlmFailures(
  options: RepairLlmOptions,
  deps: RepairDeps = {},
): Promise<RepairLlmFailuresResult> {
  const io = bindIo(deps);
  const log = options.log ?? (() => {});
  const projectRoot = resolve(options.projectRoot);
  const analysisRoot = resolve(options.analysisRoot ?? projectRoot);
  const stateRoot = resolve(options.stateRoot ?? projectRoot);
  const outputLanguage = options.outputLanguage ?? "en";
  const excludeTests = options.excludeTests ?? false;
  const projectContext = options.projectContext ?? basename(projectRoot);
  const dryRun = options.dryRun ?? false;
  const maxTasks = options.maxTasks ?? null;

  const paths = resolveBuildPaths(analysisRoot);
  const statePaths = resolveBuildPaths(stateRoot);
  if (!io.existsSync(statePaths.graphPath)) {
    throw new Error(`repair requires existing graph; run a full build first: ${statePaths.graphPath}`);
  }

  const runId = io.runId();
  const ts = formatLocalTimestamp(io.now());
  const statsPath = resolve(stateRoot, UA_DIR, "llm", "latest-stats.json");

  const emit = (result: RepairLlmFailuresResult): RepairLlmFailuresResult => {
    result.reportPath = writeReport(io, stateRoot, runId, {
      runId,
      ts,
      command: result.command,
      dryRun: result.dryRun,
      maxTasks: result.maxTasks,
      requested: result.requested,
      attempted: result.attempted,
      repaired: result.repaired,
      stillFailed: result.stillFailed,
      targets: result.targets,
      repairedFiles: result.repairedFiles,
      failedFiles: result.failedFiles,
      batchesPatched: result.batchesPatched,
      stats: result.stats,
    });
    return result;
  };

  const base = (): RepairLlmFailuresResult => ({
    runId,
    ts,
    command: "llm-failures",
    dryRun,
    maxTasks,
    requested: 0,
    attempted: 0,
    repaired: 0,
    stillFailed: 0,
    targets: [],
    repairedFiles: [],
    failedFiles: [],
    batchesPatched: [],
    stats: null,
    reportPath: "",
  });

  if (!io.existsSync(statsPath)) {
    log("repair: no llm/latest-stats.json found; nothing to repair");
    return emit(base());
  }

  const stats = JSON.parse(io.read(statsPath, "utf8")) as LlmBuildStats;
  const allFailures: RepairFailureEntry[] = Array.isArray(stats.failures)
    ? stats.failures.map((f) => ({ filePath: f.filePath, reason: f.reason }))
    : [];
  const selected = maxTasks !== null ? allFailures.slice(0, Math.max(0, maxTasks)) : allFailures;
  const targets = selected.map((f) => f.filePath);

  if (targets.length === 0) {
    log("repair: latest-stats reports no failures; nothing to repair");
    return emit({ ...base(), requested: 0 });
  }

  if (dryRun) {
    log(`repair: dry-run — ${targets.length} file(s) would be re-analyzed`);
    return emit({ ...base(), requested: targets.length, targets });
  }

  const validateCheckpoint = deps.validateCheckpoint ?? validatePhase2Checkpoint;
  const buildRegistry = deps.createRegistry ?? createAnalyzerRegistry;
  const runLlm = deps.runLlmFileAnalysis ?? runLlmFileAnalysis;
  const resolveGit = deps.resolveGitHash ?? ((root: string) => currentGitHash(root));

  const checkpoint = validateCheckpoint(paths, {
    existsSync: io.existsSync,
    readFileSync: (p) => io.read(p, "utf8"),
  });
  const gitHash = resolveGit(projectRoot);
  const registry = await buildRegistry(options.core);

  log(`repair: re-running ${targets.length} llm file-analysis task(s)`);
  const llmRun = await runLlm({
    enabled: true,
    required: options.llm?.required ?? false,
    files: targets.map((path) => ({ path })),
    analysisRoot,
    projectContext,
    readFile: (absPath: string) => io.read(absPath, "utf8"),
    provider: options.llm?.provider,
    core: options.core,
    timeoutMs: options.llm?.timeoutMs,
    retryPolicy: options.llm?.retryPolicy,
  });

  const analyses: Map<string, LLMFileAnalysis> = llmRun.analyses;
  const repairedFiles = targets.filter((path) => analyses.has(path));
  const reasonByFile = new Map(llmRun.stats.failures.map((f) => [f.filePath, f.reason]));
  const failedFiles: RepairFailureEntry[] = targets
    .filter((path) => !analyses.has(path))
    .map((filePath) => ({ filePath, reason: reasonByFile.get(filePath) ?? "unknown" }));

  const batchesPatched: Array<number | string> = [];
  if (repairedFiles.length > 0) {
    const selectedBatches = selectBatchesForFiles(checkpoint.batches, repairedFiles);
    writeBatchGraphFiles(
      {
        core: options.core,
        registry,
        analysisRoot,
        intermediateDir: paths.intermediateDir,
        batches: selectedBatches,
        outputLanguage,
        projectName: projectContext,
        gitHash,
        log,
        llmAnalyses: analyses,
      },
      { readFileSync: io.read, writeFileSync: io.write },
    );

    const updateGraph = { nodes: [] as any[], edges: [] as any[] };
    for (const batch of selectedBatches) {
      const artifactPath = resolve(paths.intermediateDir, `batch-${batch.batchIndex}.json`);
      if (!io.existsSync(artifactPath)) continue;
      const artifact = JSON.parse(io.read(artifactPath, "utf8"));
      updateGraph.nodes.push(...(Array.isArray(artifact.nodes) ? artifact.nodes : []));
      updateGraph.edges.push(...(Array.isArray(artifact.edges) ? artifact.edges : []));
      batchesPatched.push(batch.batchIndex);
    }

    const existingGraph = JSON.parse(io.read(statePaths.graphPath, "utf8"));
    const merged = mergeGraphPartialUpdate(existingGraph, updateGraph, repairedFiles);
    persistValidatedGraph(options.core, stateRoot, merged, gitHash, repairedFiles.length, outputLanguage, excludeTests);
    log(`repair: rewrote graph (repaired=${repairedFiles.length} batches=${batchesPatched.length})`);
  } else {
    log("repair: no files were successfully re-analyzed; graph left unchanged");
  }

  return emit({
    runId,
    ts,
    command: "llm-failures",
    dryRun: false,
    maxTasks,
    requested: targets.length,
    attempted: targets.length,
    repaired: repairedFiles.length,
    stillFailed: failedFiles.length,
    targets,
    repairedFiles,
    failedFiles,
    batchesPatched,
    stats: llmRun.stats,
    reportPath: "",
  });
}

export async function repairLlmGraphFailures(
  options: RepairLlmOptions,
  deps: RepairDeps = {},
): Promise<RepairLlmGraphFailuresResult> {
  const io = bindIo(deps);
  const log = options.log ?? (() => {});
  const stateRoot = resolve(options.stateRoot ?? resolve(options.projectRoot));
  const statePaths = resolveBuildPaths(stateRoot);
  if (!io.existsSync(statePaths.graphPath)) {
    throw new Error(`repair requires existing graph; run a full build first: ${statePaths.graphPath}`);
  }

  const runId = io.runId();
  const ts = formatLocalTimestamp(io.now());
  const graph = JSON.parse(io.read(statePaths.graphPath, "utf8"));
  const nodes: any[] = Array.isArray(graph.nodes) ? graph.nodes : [];
  const gaps: RepairGraphGaps = {
    nodesMissingSummary: nodes.filter((n) => n.type === "file" && !n.summary).length,
    missingLayers: !Array.isArray(graph.layers) || graph.layers.length === 0,
    missingProjectSummary: !graph.project?.summary,
  };
  if (options.dryRun) {
    const reason = "dry-run: graph-level gaps recorded, graph left unchanged";
    log(`repair: graph-level dry-run — nodesMissingSummary=${gaps.nodesMissingSummary}`);
    const reportPath = writeReport(io, stateRoot, runId, {
      runId,
      ts,
      command: "llm-graph-failures",
      status: "dry_run",
      gaps,
      reason,
      stats: null,
    });
    return { runId, ts, command: "llm-graph-failures", status: "dry_run", gaps, reason, stats: null, reportPath };
  }

  const runGraphLlm = deps.runLlmGraphEnhancement ?? runLlmGraphEnhancement;
  const resolveGit = deps.resolveGitHash ?? ((root: string) => currentGitHash(root));
  const gitHash = resolveGit(resolve(options.projectRoot));
  log(`repair: running graph-level llm enhancement — nodesMissingSummary=${gaps.nodesMissingSummary}`);
  const graphRun = await runGraphLlm({
    enabled: true,
    required: options.llm?.required ?? false,
    graph,
    projectContext: options.projectContext ?? graph.project?.name ?? basename(resolve(options.projectRoot)),
    provider: options.llm?.provider,
    core: options.core,
    timeoutMs: options.llm?.timeoutMs,
    retryPolicy: options.llm?.retryPolicy,
  });

  persistValidatedGraph(
    options.core,
    stateRoot,
    graphRun.graph,
    gitHash,
    Array.isArray(graphRun.graph.nodes) ? graphRun.graph.nodes.length : 0,
    options.outputLanguage ?? "en",
    options.excludeTests ?? false,
  );

  const reportPath = writeReport(io, stateRoot, runId, {
    runId,
    ts,
    command: "llm-graph-failures",
    status: "repaired",
    gaps,
    stats: graphRun.stats,
  });

  return { runId, ts, command: "llm-graph-failures", status: "repaired", gaps, stats: graphRun.stats, reportPath };
}
