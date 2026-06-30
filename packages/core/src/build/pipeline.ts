/**
 * Deterministic full-build pipeline orchestrator. Wires the six phases —
 * scan -> importMap -> compute-batches -> batch graph -> merge -> wrap — then
 * validates and persists the graph/meta/config via upstream core. Ported from
 * deploy `runFullPipeline` + the entry's post-pipeline save block, then extended
 * with the migrated incremental/resume/backfill, LLM, embedding, and segmented
 * mapper paths.
 */

import { execFileSync as nodeExecFileSync } from "node:child_process";
import type { EmbeddingProvider } from "@understand-anyway/plugin-api";
import {
  cpSync as nodeCpSync,
  existsSync as nodeExistsSync,
  mkdtempSync as nodeMkdtempSync,
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  rmSync as nodeRmSync,
  symlinkSync as nodeSymlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { tmpdir as nodeTmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { ensureBuildDirs, resolveBuildPaths, UA_DIR, type BuildPaths } from "./artifacts.js";
import { buildPhase2InputManifest, runBatchesPhase } from "./batches.js";
import { writeBatchGraphFiles } from "./batch-graph.js";
import { writeBatchGraphFilesSegmented } from "./batch-graph-segmented.js";
import { decideBatchMode, type BatchMode } from "./batch-mode-decide.js";
import { validatePhase2Checkpoint } from "./checkpoint.js";
import { currentGitDirty, currentGitHash } from "./git.js";
import { mergeGraphPartialUpdate } from "./graph-update.js";
import { augmentScanResultWithImportMap } from "./import-map.js";
import {
  type LlmAttemptJournalEntry,
  type LlmBuildOptions,
  type LlmPromptStub,
  type LLMFileAnalysis,
  runLlmFileAnalysis,
  runLlmGraphEnhancement,
} from "./llm.js";
import { runMergePhase } from "./merge.js";
import { createAnalyzerRegistry } from "./registry.js";
import { runScanPhase, type BuildLog } from "./scan.js";
import { normalizeIncludePaths, selectBatchesForFiles } from "./selection.js";
import { formatLocalTimestamp } from "./time.js";
import { GRAPH_VERSION, wrapAsKnowledgeGraph } from "./wrap.js";

export interface BuildPipelineDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
  mkdirSync?: (path: string, options: { recursive: boolean }) => void;
  readdirSync?: typeof nodeReaddirSync;
  symlinkSync?: typeof nodeSymlinkSync;
  cpSync?: typeof nodeCpSync;
  rmSync?: typeof nodeRmSync;
  mkdtempSync?: typeof nodeMkdtempSync;
  tmpdir?: () => string;
  execFileSync?: typeof nodeExecFileSync;
  /** Override git hash resolution (defaults to running `git`). */
  resolveGitHash?: (projectRoot: string) => string;
  /** Override git dirty-state resolution (defaults to running `git`). */
  resolveGitDirty?: (projectRoot: string) => boolean;
  /** Override analyzer-registry construction (defaults to upstream tree-sitter). */
  createRegistry?: (core: any) => Promise<any>;
  /** Override intermediate-dir creation (defaults to mkdir -p). */
  ensureDirs?: (paths: BuildPaths) => void;
  /** Test seam for optional LLM file analysis. */
  runLlmFileAnalysis?: typeof runLlmFileAnalysis;
  /** Test seam for optional LLM graph-level enhancement. */
  runLlmGraphEnhancement?: typeof runLlmGraphEnhancement;
  /** Test seam for build-mode dispatch. */
  runFullBuild?: (options: RunFullBuildOptions, deps?: BuildPipelineDeps) => Promise<RunFullBuildResult>;
  /** Test seam for build-mode dispatch. */
  runResumeBuild?: (options: RunBuildModeOptions, deps?: BuildPipelineDeps) => Promise<RunBuildModeResult>;
  /** Test seam for build-mode dispatch. */
  runPartialUpdate?: (options: RunBuildModeOptions, deps?: BuildPipelineDeps) => Promise<RunBuildModeResult>;
  /** Test seam for checkpoint validation. */
  validateCheckpoint?: typeof validatePhase2Checkpoint;
}

export interface RunFullBuildOptions {
  /** Upstream runtime: loaded core module + located skill dir. */
  core: any;
  skillDir: string;
  /** Repo root (for git metadata + import resolution). */
  projectRoot: string;
  /** Root that files are scanned/analyzed under (defaults to projectRoot). */
  analysisRoot?: string;
  /** Optional source root used by scan/import-map/phase-2 reads when distinct from analysisRoot. */
  scanRoot?: string;
  /** Where `.understand-anything/` state is written (defaults to projectRoot). */
  stateRoot?: string;
  outputLanguage?: string;
  excludeTests?: boolean;
  /** Optional LLM enrichment (default: disabled). */
  llm?: LlmBuildOptions;
  /** Optional semantic embedding generation (default: disabled). */
  embedding?: {
    enabled: boolean;
    provider?: EmbeddingProvider;
  };
  log?: BuildLog;
  /** C7 batch-mode selector (default: 'auto'). */
  batchMode?: BatchMode;
  /** C7 batches per spawned mapper segment (segmented mode only). */
  mapperBatchCount?: number;
  /** C7 parallel mapper segments (segmented mode only). */
  mapperConcurrency?: number;
  /** C7 absolute CLI entry path; required by the segmented scheduler to spawn workers. */
  cliEntry?: string;
  /** C7 extra argv slice to append to each worker's --llm-* invocation. */
  llmWorkerArgs?: string[];
  /** Plugin root override; forwarded to each spawned worker (segmented only). */
  pluginRoot?: string | null;
}

export interface RunFullBuildResult {
  graph: any;
  gitHash: string;
  analyzedFiles: number;
  paths: BuildPaths;
}

export type BuildMode = "full" | "incremental" | "resume" | "backfill";

export interface RunBuildModeOptions extends RunFullBuildOptions {
  mode?: BuildMode;
  includePaths?: string[];
}

export interface RunBuildModeResult extends RunFullBuildResult {
  mode: BuildMode;
  updatedFiles?: string[];
}

function prepareComputeBatchesRoot(
  analysisRoot: string,
  scanRoot: string | undefined,
  intermediateDir: string,
  deps: Pick<BuildPipelineDeps, "mkdirSync" | "rmSync" | "readdirSync" | "symlinkSync"> = {},
): { root: string; cleanup: () => void } {
  const effectiveScanRoot = scanRoot ? resolve(scanRoot) : resolve(analysisRoot);
  if (effectiveScanRoot === resolve(analysisRoot)) {
    return { root: analysisRoot, cleanup: () => {} };
  }

  const mkdir = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { nodeMkdirSync(p, o); });
  const rm = deps.rmSync ?? ((p: string, o: { recursive: boolean; force: boolean }) => { nodeRmSync(p, o); });
  const readdir = deps.readdirSync ?? nodeReaddirSync;
  const symlink = deps.symlinkSync ?? nodeSymlinkSync;
  const computeRoot = resolve(intermediateDir, "..", "tmp", "compute-batches-root");
  rm(computeRoot, { recursive: true, force: true });
  mkdir(computeRoot, { recursive: true });
  symlink(resolve(analysisRoot, UA_DIR), resolve(computeRoot, UA_DIR), "dir");

  for (const entry of readdir(effectiveScanRoot, { withFileTypes: true })) {
    const name = typeof entry === "string" ? entry : entry.name;
    if (name === UA_DIR || name === "dashboard-dist") continue;
    symlink(resolve(effectiveScanRoot, name), resolve(computeRoot, name));
  }

  return {
    root: computeRoot,
    cleanup: () => rm(computeRoot, { recursive: true, force: true }),
  };
}

export function persistValidatedGraph(
  core: any,
  stateRoot: string,
  graph: any,
  gitHash: string,
  analyzedFiles: number,
  outputLanguage: string,
  excludeTests: boolean,
): any {
  const { saveGraph, saveMeta, saveConfig, validateGraph } = core;
  const validation = validateGraph(graph);
  if (!validation.success) {
    throw new Error(`build: graph validation failed: ${validation.fatal || "unknown error"}`);
  }
  saveGraph(stateRoot, validation.data);
  saveMeta(stateRoot, {
    lastAnalyzedAt: formatLocalTimestamp(),
    gitCommitHash: gitHash || validation.data.project.gitCommitHash,
    version: GRAPH_VERSION,
    analyzedFiles: analyzedFiles || validation.data.nodes.length,
  });
  saveConfig(stateRoot, { autoUpdate: false, outputLanguage, excludeTests });
  return validation.data;
}

function sanitizeArtifactSegment(value: string): string {
  return String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "artifact";
}

function writeJsonArtifact(
  filePath: string,
  data: unknown,
  mkdir: (path: string, options: { recursive: boolean }) => void,
  write: (path: string, data: string, encoding: "utf8") => void,
): void {
  mkdir(dirname(filePath), { recursive: true });
  write(filePath, JSON.stringify(data, null, 2), "utf8");
}

function writePromptStubs(
  stateRoot: string,
  promptStubs: LlmPromptStub[] | undefined,
  mkdir: (path: string, options: { recursive: boolean }) => void,
  write: (path: string, data: string, encoding: "utf8") => void,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (!promptStubs || promptStubs.length === 0) return files;
  const dir = resolve(stateRoot, UA_DIR, "llm", "prompts");
  mkdir(dir, { recursive: true });
  promptStubs.forEach((stub, index) => {
    const prefix = String(index + 1).padStart(2, "0");
    const base = stub.target
      ? `${prefix}-${sanitizeArtifactSegment(stub.operation)}-${sanitizeArtifactSegment(stub.target)}.txt`
      : `${prefix}-${sanitizeArtifactSegment(stub.operation)}.txt`;
    const path = resolve(dir, base);
    write(path, stub.prompt, "utf8");
    files[stub.operation] = path;
  });
  return files;
}

function writeAttemptJournal(
  stateRoot: string,
  entries: LlmAttemptJournalEntry[],
  mkdir: (path: string, options: { recursive: boolean }) => void,
  write: (path: string, data: string, encoding: "utf8") => void,
): void {
  if (entries.length === 0) return;
  const path = resolve(stateRoot, UA_DIR, "metrics", "llm-attempts.ndjson");
  mkdir(dirname(path), { recursive: true });
  write(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function buildEmbeddingText(node: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (label: string, value: unknown) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) parts.push(`${label}: ${text}`);
  };
  const pushList = (label: string, value: unknown) => {
    if (!Array.isArray(value)) return;
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (items.length > 0) parts.push(`${label}: ${items.join(", ")}`);
  };

  push("id", node.id);
  push("type", node.type);
  push("name", node.name);
  push("path", node.filePath);
  push("summary", node.summary);
  push("description", node.description);
  pushList("tags", node.tags);
  pushList("frameworks", node.frameworks);

  return parts.join("\n");
}

function normalizeEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isFinite(item));
}

async function writeEmbeddingsArtifact(
  stateRoot: string,
  graph: any,
  embedding: RunFullBuildOptions["embedding"] | undefined,
  mkdir: (path: string, options: { recursive: boolean }) => void,
  write: (path: string, data: string, encoding: "utf8") => void,
  log: BuildLog,
): Promise<void> {
  if (!embedding?.enabled || !embedding.provider) return;

  try {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
      const records = (nodes as unknown[])
        .map((node: unknown) => (node && typeof node === "object" ? node as Record<string, unknown> : null))
        .filter((node: Record<string, unknown> | null): node is Record<string, unknown> => node !== null)
      .map((node: Record<string, unknown>) => ({
        id: typeof node.id === "string" ? node.id.trim() : "",
        text: buildEmbeddingText(node),
      }))
      .filter((record: { id: string; text: string }) => record.id && record.text);

    const vectors = embedding.provider.embedBatch
      ? await embedding.provider.embedBatch(records.map((record: { text: string }) => record.text))
      : await Promise.all(records.map((record: { text: string }) => embedding.provider!.embed(record.text)));

    const artifact: Record<string, number[]> = {};
    records.forEach((record: { id: string; text: string }, index: number) => {
      const vector = normalizeEmbeddingVector(vectors[index]);
      if (vector.length > 0) artifact[record.id] = vector;
    });

    writeJsonArtifact(resolve(stateRoot, UA_DIR, "embeddings.json"), artifact, mkdir, write);
  } catch (error) {
    log(`embedding generation skipped: ${(error as Error).message}`);
  }
}

export async function runFullBuild(
  options: RunFullBuildOptions,
  deps: BuildPipelineDeps = {},
): Promise<RunFullBuildResult> {
  const log = options.log ?? (() => {});
  const read = deps.readFileSync ?? ((p: string, e: "utf8") => nodeReadFileSync(p, e));
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const execFileSync = deps.execFileSync ?? nodeExecFileSync;
  const resolveGit = deps.resolveGitHash ?? ((root: string) => currentGitHash(root));
  const buildRegistry = deps.createRegistry ?? createAnalyzerRegistry;
  const ensureDirs = deps.ensureDirs ?? ensureBuildDirs;
  const mkdir = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { nodeMkdirSync(p, o); });
  const runLlm = deps.runLlmFileAnalysis ?? runLlmFileAnalysis;
  const runGraphLlm = deps.runLlmGraphEnhancement ?? runLlmGraphEnhancement;
  const llmAttemptEntries: LlmAttemptJournalEntry[] = [];

  const projectRoot = resolve(options.projectRoot);
  const analysisRoot = resolve(options.analysisRoot ?? projectRoot);
  const scanRoot = resolve(options.scanRoot ?? analysisRoot);
  const stateRoot = resolve(options.stateRoot ?? projectRoot);
  const statePaths = resolveBuildPaths(stateRoot);
  const outputLanguage = options.outputLanguage ?? "en";
  const excludeTests = options.excludeTests ?? false;
  const projectName = basename(projectRoot);
  const { core, skillDir } = options;

  // Upstream compute-batches/merge scripts hardcode `<scanRoot>/.understand-anything/
  // intermediate/`, so intermediate artifacts must live under the analysis root.
  // The final graph/meta/config are saved separately to the state root below.
  const paths = resolveBuildPaths(analysisRoot);
  ensureDirs(paths);

  const gitHash = resolveGit(projectRoot);

  // Phase 1 — scan + filters
  let scan = runScanPhase(
    { skillDir, scanInputRoot: scanRoot, scanPath: paths.scanPath, excludeTests, core, log },
    { readFileSync: read, writeFileSync: write, execFileSync },
  );

  // Phase 1.2 — import map
  log("phase 1.2/4 build import map");
  const registry = await buildRegistry(core);
  scan = augmentScanResultWithImportMap(
    { registry, projectRoot, analysisRoot: scanRoot, scanPath: paths.scanPath, scan, log },
    { readFileSync: read, writeFileSync: write },
  );

  // Phase 1.5 — compute batches
  const computeBatchesRoot = prepareComputeBatchesRoot(analysisRoot, scanRoot, paths.intermediateDir, {
    mkdirSync: deps.mkdirSync,
    rmSync: deps.rmSync,
    readdirSync: deps.readdirSync,
    symlinkSync: deps.symlinkSync,
  });
  let batches: any[];
  try {
    ({ batches } = runBatchesPhase(
      {
        skillDir,
        computeRoot: computeBatchesRoot.root,
        paths,
        projectRoot,
        outputLanguage,
        excludeTests,
        gitHash,
        log,
      },
      { execFileSync, readFileSync: (p) => read(p, "utf8"), writeFileSync: write },
    ));
  } finally {
    computeBatchesRoot.cleanup();
  }

  // Phase 2 — batch graphs. Resolve the effective batch-mode (auto -> full
  // for fixture-scale workloads, segmented otherwise). Full mode runs the
  // in-process loop; segmented spawns child workers per segment.
  log("phase 2/4 analyze batches");
  const fileCount = (scan.files as Array<unknown>).length;
  const decision = decideBatchMode({
    mode: options.batchMode ?? "auto",
    batchCount: batches.length,
    fileCount,
  });
  log(`phase 2/4 batch-mode: ${decision.mode} — ${decision.reason}`);
  if (decision.mode === "full") {
    let llmAnalyses: Map<string, LLMFileAnalysis> | undefined;
    if (options.llm?.enabled) {
      log("phase 2/4 llm enrichment");
      const llmRun = await runLlm({
        enabled: true,
        required: options.llm.required,
        files: scan.files as Array<{ path: string }>,
          analysisRoot: scanRoot,
        projectContext: projectName,
        readFile: (absPath: string) => read(absPath, "utf8"),
        provider: options.llm.provider,
        core,
        timeoutMs: options.llm.timeoutMs,
        retryPolicy: options.llm.retryPolicy,
        modelCandidates: options.llm.modelCandidates,
        modelCooldownMs: options.llm.modelCooldownMs,
      });
      llmAnalyses = llmRun.analyses;
      const llmDir = resolve(stateRoot, UA_DIR, "llm");
      mkdir(llmDir, { recursive: true });
      write(resolve(llmDir, "latest-stats.json"), JSON.stringify(llmRun.stats, null, 2), "utf8");
      writeJsonArtifact(resolve(llmDir, "guard-metrics.json"), { modelGuards: llmRun.stats.modelGuards ?? [] }, mkdir, write);
      writePromptStubs(stateRoot, llmRun.artifacts?.promptStubs, mkdir, write);
      llmAttemptEntries.push(...(llmRun.artifacts?.attemptJournal ?? []));
    }
    writeBatchGraphFiles(
      {
        core,
        registry,
        analysisRoot: scanRoot,
        intermediateDir: paths.intermediateDir,
        batches,
        outputLanguage,
        projectName,
        gitHash,
        log,
        llmAnalyses,
      },
      { readFileSync: read, writeFileSync: write },
    );
  } else {
    if (!options.cliEntry) {
      throw new Error("build: segmented batch-mode requires a cliEntry; pass options.cliEntry from the CLI layer");
    }
    await writeBatchGraphFilesSegmented({
      cliEntry: options.cliEntry,
      analysisRoot,
      projectRoot,
      intermediateDir: paths.intermediateDir,
      batches: batches as Array<{ batchIndex: number | string; files?: Array<{ path: string }> }>,
      outputLanguage,
      projectName,
      gitHash,
      scanRoot,
      pluginRoot: options.pluginRoot ?? null,
      mapperBatchCount: Math.max(1, options.mapperBatchCount ?? 50),
      mapperConcurrency: Math.max(1, options.mapperConcurrency ?? 1),
      llm: options.llm?.enabled
        ? {
            enabled: true,
            extraArgs: options.llmWorkerArgs ?? [],
            globalConcurrency: 1,
            qpmLimit: 1,
          }
        : undefined,
      log,
    });
  }

  // Phase 3 — merge
  runMergePhase({ skillDir, analysisRoot, log }, { execFileSync });

  // Phase 4 — wrap final graph
  log("phase 4/4 wrap final graph");
  if (!existsSync(paths.assembledPath)) {
    throw new Error(`build: merge phase did not produce ${paths.assembledPath}`);
  }
  const assembled = JSON.parse(read(paths.assembledPath, "utf8"));
  let graph = wrapAsKnowledgeGraph({
    scan,
    assembled,
    projectName,
    gitHash,
    outputLanguage,
    core,
  });
  if (options.llm?.enabled) {
    log("phase 4/4 llm graph enhancement");
    const graphLlmRun = await runGraphLlm({
      enabled: true,
      required: options.llm.required,
      graph,
      projectContext: projectName,
      provider: options.llm.provider,
      core,
      timeoutMs: options.llm.timeoutMs,
      retryPolicy: options.llm.retryPolicy,
      modelCandidates: options.llm.modelCandidates,
    });
    graph = graphLlmRun.graph;
    const llmDir = resolve(stateRoot, UA_DIR, "llm");
    mkdir(llmDir, { recursive: true });
    write(resolve(llmDir, "latest-graph-stats.json"), JSON.stringify(graphLlmRun.stats, null, 2), "utf8");
    const promptFiles = writePromptStubs(stateRoot, graphLlmRun.artifacts?.promptStubs, mkdir, write);
    llmAttemptEntries.push(...(graphLlmRun.artifacts?.attemptJournal ?? []));
    if (Array.isArray(graph.layers) && graph.layers.length > 0) {
      writeJsonArtifact(resolve(llmDir, "layers.json"), {
        generatedAt: formatLocalTimestamp(),
        promptFile: promptFiles.layers ?? null,
        layers: graph.layers,
      }, mkdir, write);
    }
    if (graph.project?.summary !== undefined) {
      writeJsonArtifact(resolve(llmDir, "project-summary.json"), {
        generatedAt: formatLocalTimestamp(),
        promptFile: promptFiles["project-summary"] ?? null,
        summary: graph.project.summary,
        frameworks: Array.isArray(graph.project.frameworks) ? graph.project.frameworks : [],
        tags: Array.isArray(graph.project.tags) ? graph.project.tags : [],
      }, mkdir, write);
    }
  }
  writeAttemptJournal(stateRoot, llmAttemptEntries, mkdir, write);
  const analyzedFiles = (scan.totalFiles as number) || graph.nodes.length;

  const validatedGraph = persistValidatedGraph(core, stateRoot, graph, gitHash, analyzedFiles, outputLanguage, excludeTests);
  await writeEmbeddingsArtifact(stateRoot, validatedGraph, options.embedding, mkdir, write, log);

  log(`build complete: nodes=${validatedGraph.nodes.length} edges=${validatedGraph.edges.length}`);
  return { graph: validatedGraph, gitHash, analyzedFiles, paths };
}

export async function runBuildMode(
  options: RunBuildModeOptions,
  deps: BuildPipelineDeps = {},
): Promise<RunBuildModeResult> {
  const mode = options.mode ?? "full";
  if (mode === "full") {
    const runFull = deps.runFullBuild ?? runFullBuild;
    const result = await runFull(options, deps);
    return { ...result, mode: "full" };
  }
  if (mode === "resume") {
    const runResume = deps.runResumeBuild ?? runResumeBuild;
    const result = await runResume(options, deps);
    return { ...result, mode: "resume" };
  }
  const projectRoot = resolve(options.projectRoot);
  const stateRoot = resolve(options.stateRoot ?? projectRoot);
  const paths = resolveBuildPaths(stateRoot);
  const existsSync = deps.existsSync ?? nodeExistsSync;
  if (!existsSync(paths.graphPath)) {
    throw new Error(`build: ${mode} requires existing graph; run full build explicitly first: ${paths.graphPath}`);
  }

  const runPartial = deps.runPartialUpdate ?? runPartialBuildUpdate;
  const result = await runPartial(options, deps);
  return { ...result, mode };
}

function normalizeGraphFilePaths(graph: any): Set<string> {
  return new Set(
    (Array.isArray(graph?.nodes) ? graph.nodes : [])
      .map((node: { filePath?: unknown }) => (typeof node?.filePath === "string" ? node.filePath : ""))
      .filter(Boolean),
  );
}

function collectAutoIncludedBackfillFiles(scan: any, existingGraph: any): string[] {
  const existingFilePaths = normalizeGraphFilePaths(existingGraph);
  const selected = new Set<string>();
  for (const file of Array.isArray(scan?.files) ? scan.files : []) {
    const path = typeof file?.path === "string" ? file.path : "";
    const category = typeof file?.fileCategory === "string" ? file.fileCategory : "";
    if (!path) continue;
    if (category !== "code" && category !== "script") continue;
    if (existingFilePaths.has(path)) continue;
    selected.add(path);
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}

function createBackfillWorkspace(
  projectRoot: string,
  deps: BuildPipelineDeps,
): { root: string; analysisRoot: string; cleanup: () => void } {
  const mkdtempSync = deps.mkdtempSync ?? nodeMkdtempSync;
  const cpSync = deps.cpSync ?? nodeCpSync;
  const rmSync = deps.rmSync ?? nodeRmSync;
  const root = mkdtempSync(resolve((deps.tmpdir ?? nodeTmpdir)(), "ua-backfill-"));
  const analysisRoot = resolve(root, "workspace");
  cpSync(projectRoot, analysisRoot, {
    recursive: true,
    dereference: false,
    filter: (src) => !src.includes(`${projectRoot}/${UA_DIR}`),
  });
  return {
    root,
    analysisRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export async function runResumeBuild(
  options: RunBuildModeOptions,
  deps: BuildPipelineDeps = {},
): Promise<RunBuildModeResult> {
  const log = options.log ?? (() => {});
  const read = deps.readFileSync ?? ((p: string, e: "utf8") => nodeReadFileSync(p, e));
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  const mkdir = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { nodeMkdirSync(p, o); });
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const execFileSync = deps.execFileSync ?? nodeExecFileSync;
  const resolveGit = deps.resolveGitHash ?? ((root: string) => currentGitHash(root));
  const resolveDirty = deps.resolveGitDirty ?? ((root: string) => currentGitDirty(root));
  const buildRegistry = deps.createRegistry ?? createAnalyzerRegistry;
  const ensureDirs = deps.ensureDirs ?? ensureBuildDirs;
  const validateCheckpoint = deps.validateCheckpoint ?? validatePhase2Checkpoint;

  const projectRoot = resolve(options.projectRoot);
  const analysisRoot = resolve(options.analysisRoot ?? projectRoot);
  const stateRoot = resolve(options.stateRoot ?? projectRoot);
  const statePaths = resolveBuildPaths(stateRoot);
  const outputLanguage = options.outputLanguage ?? "en";
  const excludeTests = options.excludeTests ?? false;
  const projectName = basename(projectRoot);
  const { core, skillDir } = options;
  const paths = resolveBuildPaths(analysisRoot);
  ensureDirs(paths);
  const gitHash = resolveGit(projectRoot);
  const checkpoint = validateCheckpoint(paths, {
    existsSync,
    readFileSync: (p) => read(p, "utf8"),
    expected: {
      sourceGitCommit: gitHash,
      sourceDirty: resolveDirty(projectRoot),
      outputLanguage,
      excludeTests,
    },
  });
  const scan = JSON.parse(read(paths.scanPath, "utf8"));
  const buildKind = checkpoint.manifest.buildKind ?? "full";

  log("resume phase 2/4 analyze batches");
  const registry = await buildRegistry(core);
  writeBatchGraphFiles(
    { core, registry, analysisRoot, intermediateDir: paths.intermediateDir, batches: checkpoint.batches, outputLanguage, projectName, gitHash, log },
    { readFileSync: read, writeFileSync: write },
  );
  if (buildKind === "incremental" || buildKind === "backfill") {
    if (!existsSync(statePaths.graphPath)) {
      throw new Error("build: resume rejected: partial resume requires an existing graph");
    }
    const existingGraph = JSON.parse(read(statePaths.graphPath, "utf8"));
    const existingCommit = String(existingGraph?.project?.gitCommitHash || readMetaGitCommitHash(statePaths.metaPath, { existsSync, readFileSync: read }) || "");
    const baseGraphCommit = String(checkpoint.manifest.baseGraphCommit || "");
    if (!baseGraphCommit || baseGraphCommit !== existingCommit) {
      throw new Error(`build: resume base graph mismatch: manifest=${baseGraphCommit || "<missing>"} current=${existingCommit || "<missing>"}`);
    }
    const changedFiles = Array.isArray(checkpoint.manifest.changedFiles) ? checkpoint.manifest.changedFiles : [];
    const updateGraph = { nodes: [] as any[], edges: [] as any[] };
    for (const batch of checkpoint.batches) {
      const artifact = JSON.parse(read(resolve(paths.intermediateDir, `batch-${batch.batchIndex}.json`), "utf8"));
      updateGraph.nodes.push(...(Array.isArray(artifact.nodes) ? artifact.nodes : []));
      updateGraph.edges.push(...(Array.isArray(artifact.edges) ? artifact.edges : []));
    }
    const merged = mergeGraphPartialUpdate(existingGraph, updateGraph, changedFiles);
    const validatedGraph = persistValidatedGraph(core, stateRoot, merged, gitHash, changedFiles.length, outputLanguage, excludeTests);
    await writeEmbeddingsArtifact(stateRoot, validatedGraph, options.embedding, mkdir, write, log);
    return { graph: validatedGraph, gitHash, analyzedFiles: changedFiles.length, paths, mode: "resume", updatedFiles: changedFiles };
  }

  runMergePhase({ skillDir, analysisRoot, log }, { execFileSync });

  if (!existsSync(paths.assembledPath)) {
    throw new Error(`build: merge phase did not produce ${paths.assembledPath}`);
  }
  const assembled = JSON.parse(read(paths.assembledPath, "utf8"));
  const graph = wrapAsKnowledgeGraph({ scan, assembled, projectName, gitHash, outputLanguage, core });
  const analyzedFiles = (scan.totalFiles as number) || graph.nodes.length;
  const validatedGraph = persistValidatedGraph(core, stateRoot, graph, gitHash, analyzedFiles, outputLanguage, excludeTests);
  await writeEmbeddingsArtifact(stateRoot, validatedGraph, options.embedding, mkdir, write, log);
  return { graph: validatedGraph, gitHash, analyzedFiles, paths, mode: "resume" };
}

/**
 * Incremental build entry. Uses upstream `core.getChangedFiles(projectRoot,
 * baseCommit)` for commit-range changed-file detection.
 *
 * **Intentional skip:** upstream `core.extractFileFingerprint` /
 * `compareFingerprints` / `buildFingerprintStore` / `analyzeChanges` /
 * `classifyUpdate` (the "fingerprint chain") are NOT wired here. git diff
 * is sufficient for the current granularity (file-level staleness); AST-hash
 * fingerprints would only refine "format-only / comment-only changes are no-op",
 * which is a quality-of-life refinement, not a correctness fix.
 *
 * Decision context: E1 audit 2026-06-23, decision matrix B1.
 *
 * A2/G4 is handled here by requiring the upstream commit-range helper instead
 * of falling back to a worktree-only `git diff HEAD` command.
 */
export async function runPartialBuildUpdate(
  options: RunBuildModeOptions,
  deps: BuildPipelineDeps = {},
): Promise<RunBuildModeResult> {
  const mode = options.mode;
  if (mode !== "incremental" && mode !== "backfill") {
    throw new Error(`build: partial update only supports incremental/backfill, got ${mode ?? "full"}`);
  }

  const log = options.log ?? (() => {});
  const read = deps.readFileSync ?? ((p: string, e: "utf8") => nodeReadFileSync(p, e));
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  const mkdir = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { nodeMkdirSync(p, o); });
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const execFileSync = deps.execFileSync ?? nodeExecFileSync;
  const resolveGit = deps.resolveGitHash ?? ((root: string) => currentGitHash(root));
  const buildRegistry = deps.createRegistry ?? createAnalyzerRegistry;
  const validateCheckpoint = deps.validateCheckpoint ?? validatePhase2Checkpoint;
  const ensureDirs = deps.ensureDirs ?? ensureBuildDirs;

  const projectRoot = resolve(options.projectRoot);
  const stateRoot = resolve(options.stateRoot ?? projectRoot);
  const outputLanguage = options.outputLanguage ?? "en";
  const excludeTests = options.excludeTests ?? false;
  const projectName = basename(projectRoot);
  const { core, skillDir } = options;
  const statePaths = resolveBuildPaths(stateRoot);
  if (!existsSync(statePaths.graphPath)) {
    throw new Error(`build: ${mode} requires existing graph; run full build explicitly first: ${statePaths.graphPath}`);
  }
  const existingGraph = JSON.parse(read(statePaths.graphPath, "utf8"));

  // Reject incompatible graph formats explicitly instead of silently merging a
  // newer/older `graph.version` into the partial-update path. `existingGraph`
  // is the source of truth; `meta.version` (when present) must agree. The
  // operator's recourse is `--full` to regenerate.
  const existingGraphVersion = typeof existingGraph?.version === "string" ? existingGraph.version : "";
  if (existingGraphVersion && existingGraphVersion !== GRAPH_VERSION) {
    throw new Error(
      `build: ${mode} aborted: existing graph version '${existingGraphVersion}' does not match current GRAPH_VERSION '${GRAPH_VERSION}'. ` +
        `Run a full build to regenerate (${statePaths.graphPath}).`,
    );
  }
  if (existsSync(statePaths.metaPath)) {
    try {
      const meta = JSON.parse(read(statePaths.metaPath, "utf8")) as Record<string, unknown>;
      const metaVersion = typeof meta?.version === "string" ? meta.version : "";
      if (metaVersion && metaVersion !== GRAPH_VERSION) {
        throw new Error(
          `build: ${mode} aborted: meta version '${metaVersion}' does not match current GRAPH_VERSION '${GRAPH_VERSION}'. ` +
            `Run a full build to regenerate (${statePaths.metaPath}).`,
        );
      }
    } catch (err) {
      // Re-throw our own abort messages; swallow only malformed-meta JSON
      // since the graph-version check above already gates compatibility.
      if (err instanceof Error && err.message.startsWith(`build: ${mode} aborted:`)) throw err;
    }
  }

  if (mode === "backfill") {
    const workspace = createBackfillWorkspace(projectRoot, deps);
    try {
      const analysisRoot = workspace.analysisRoot;
      const paths = resolveBuildPaths(analysisRoot);
      ensureDirs(paths);
      const gitHash = resolveGit(projectRoot);
      let scan = runScanPhase(
        { skillDir, scanInputRoot: analysisRoot, scanPath: paths.scanPath, excludeTests, core, log },
        { readFileSync: read, writeFileSync: write, execFileSync },
      );
      const registry = await buildRegistry(core);
      scan = augmentScanResultWithImportMap(
        { registry, projectRoot, analysisRoot, scanPath: paths.scanPath, scan, log },
        { readFileSync: read, writeFileSync: write },
      );
      const affectedFiles = (options.includePaths ?? []).length > 0
        ? normalizeIncludePaths(options.includePaths ?? [], projectRoot)
        : collectAutoIncludedBackfillFiles(scan, existingGraph);
      if (affectedFiles.length === 0) {
        return { graph: existingGraph, gitHash, analyzedFiles: 0, paths, mode, updatedFiles: [] };
      }
      const scannedFiles = new Set(
        (Array.isArray(scan.files) ? scan.files : [])
          .map((file: { path?: string }) => (typeof file?.path === "string" ? file.path : ""))
          .filter(Boolean),
      );
      const missingIncludedFiles = affectedFiles.filter((filePath) => !scannedFiles.has(filePath));
      if (missingIncludedFiles.length > 0) {
        throw new Error(
          `build: backfill rejected: ${missingIncludedFiles.length} requested file(s) absent from current scan, first missing: ${missingIncludedFiles.slice(0, 10).join(", ")}`,
        );
      }
      const { batches } = runBatchesPhase(
        {
          skillDir,
          computeRoot: analysisRoot,
          paths,
          projectRoot,
          outputLanguage,
          excludeTests,
          gitHash,
          buildKind: "backfill",
          log,
        },
        { execFileSync, readFileSync: (p) => read(p, "utf8"), writeFileSync: write, currentGitDirty: deps.resolveGitDirty },
      );
      const selectedBatches = selectBatchesForFiles(batches, affectedFiles);
      if (selectedBatches.length === 0) {
        throw new Error(`build: backfill could not map affected files to current batches: ${affectedFiles.join(", ")}`);
      }
      const baseGraphCommit = String(existingGraph?.project?.gitCommitHash || readMetaGitCommitHash(statePaths.metaPath, { existsSync, readFileSync: read }) || "");
      const manifest = buildPhase2InputManifest({
        skillDir,
        computeRoot: analysisRoot,
        paths,
        projectRoot,
        outputLanguage,
        excludeTests,
        gitHash,
        buildKind: "backfill",
        baseGraphCommit,
        changedFiles: affectedFiles,
        log,
      }, { readFileSync: (p) => read(p, "utf8"), currentGitDirty: deps.resolveGitDirty }, selectedBatches);
      write(paths.phase2ManifestPath, JSON.stringify(manifest, null, 2), "utf8");
      writeBatchGraphFiles(
        { core, registry, analysisRoot, intermediateDir: paths.intermediateDir, batches: selectedBatches, outputLanguage, projectName, gitHash, log },
        { readFileSync: read, writeFileSync: write },
      );
      const updateGraph = { nodes: [] as any[], edges: [] as any[] };
      for (const batch of selectedBatches) {
        const artifact = JSON.parse(read(resolve(paths.intermediateDir, `batch-${batch.batchIndex}.json`), "utf8"));
        updateGraph.nodes.push(...(Array.isArray(artifact.nodes) ? artifact.nodes : []));
        updateGraph.edges.push(...(Array.isArray(artifact.edges) ? artifact.edges : []));
      }
      const merged = mergeGraphPartialUpdate(existingGraph, updateGraph, affectedFiles);
      const validatedGraph = persistValidatedGraph(core, stateRoot, merged, gitHash, affectedFiles.length, outputLanguage, excludeTests);
      await writeEmbeddingsArtifact(stateRoot, validatedGraph, options.embedding, mkdir, write, log);
      return { graph: validatedGraph, gitHash, analyzedFiles: affectedFiles.length, paths, mode, updatedFiles: affectedFiles };
    } finally {
      workspace.cleanup();
    }
  }

  const analysisRoot = resolve(options.analysisRoot ?? projectRoot);
  const paths = resolveBuildPaths(analysisRoot);

  const checkpoint = validateCheckpoint(paths, { existsSync, readFileSync: (p) => read(p, "utf8") });
  const affectedFiles = getIncrementalChangedFiles(core, projectRoot, existingGraph, statePaths.metaPath, { existsSync, readFileSync: read });
  if (affectedFiles.length === 0) {
    throw new Error(`build: ${mode} found no affected files; no build was run`);
  }

  const selectedBatches = selectBatchesForFiles(checkpoint.batches, affectedFiles);
  if (selectedBatches.length === 0) {
    if (isDeletionOnlyUpdate(affectedFiles, projectRoot, existsSync)) {
      const gitHash = resolveGit(projectRoot);
      const merged = mergeGraphPartialUpdate(existingGraph, { nodes: [], edges: [] }, affectedFiles);
      const validatedGraph = persistValidatedGraph(core, stateRoot, merged, gitHash, affectedFiles.length, outputLanguage, excludeTests);
      await writeEmbeddingsArtifact(stateRoot, validatedGraph, options.embedding, mkdir, write, log);
      return { graph: validatedGraph, gitHash, analyzedFiles: 0, paths, mode, updatedFiles: affectedFiles };
    }
    throw new Error(`build: ${mode} could not map affected files to existing batches: ${affectedFiles.join(", ")}`);
  }

  const gitHash = resolveGit(projectRoot);
  const registry = await buildRegistry(core);
  const baseGraphCommit = String(existingGraph?.project?.gitCommitHash || readMetaGitCommitHash(statePaths.metaPath, { existsSync, readFileSync: read }) || "");
  const manifest = buildPhase2InputManifest({
    skillDir: options.skillDir,
    computeRoot: analysisRoot,
    paths,
    projectRoot,
    outputLanguage,
    excludeTests,
    gitHash,
    buildKind: mode,
    baseGraphCommit,
    changedFiles: affectedFiles,
    log,
  }, { readFileSync: (p) => read(p, "utf8"), currentGitDirty: deps.resolveGitDirty }, selectedBatches);
  write(paths.phase2ManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  writeBatchGraphFiles(
    { core, registry, analysisRoot, intermediateDir: paths.intermediateDir, batches: selectedBatches, outputLanguage, projectName, gitHash, log },
    { readFileSync: read, writeFileSync: write },
  );

  const updateGraph = { nodes: [] as any[], edges: [] as any[] };
  for (const batch of selectedBatches) {
    const artifact = JSON.parse(read(resolve(paths.intermediateDir, `batch-${batch.batchIndex}.json`), "utf8"));
    updateGraph.nodes.push(...(Array.isArray(artifact.nodes) ? artifact.nodes : []));
    updateGraph.edges.push(...(Array.isArray(artifact.edges) ? artifact.edges : []));
  }

  const merged = mergeGraphPartialUpdate(existingGraph, updateGraph, affectedFiles);
  const validatedGraph = persistValidatedGraph(core, stateRoot, merged, gitHash, affectedFiles.length, outputLanguage, excludeTests);
  await writeEmbeddingsArtifact(stateRoot, validatedGraph, options.embedding, mkdir, write, log);
  return { graph: validatedGraph, gitHash, analyzedFiles: affectedFiles.length, paths, mode, updatedFiles: affectedFiles };
}

function isDeletionOnlyUpdate(
  affectedFiles: string[],
  projectRoot: string,
  existsSync: (path: string) => boolean,
): boolean {
  return affectedFiles.length > 0 && affectedFiles.every((file) => !existsSync(resolve(projectRoot, file)));
}

function getIncrementalChangedFiles(
  core: any,
  projectRoot: string,
  existingGraph: any,
  metaPath: string,
  deps: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: "utf8") => string;
  },
): string[] {
  if (typeof core.getChangedFiles !== "function") {
    throw new Error("build: incremental build requires upstream core.getChangedFiles; update the upstream plugin or run full build");
  }
  const baseCommit = String(existingGraph?.project?.gitCommitHash || readMetaGitCommitHash(metaPath, deps) || "");
  if (!baseCommit) {
    throw new Error("build: incremental build requires existing graph project.gitCommitHash; run full build first");
  }
  const changed = core.getChangedFiles(projectRoot, baseCommit);
  if (!Array.isArray(changed)) {
    throw new Error("build: upstream core.getChangedFiles returned a non-array result");
  }
  return normalizeIncludePaths(changed.map((file) => String(file)), projectRoot);
}

function readMetaGitCommitHash(
  metaPath: string,
  deps: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: "utf8") => string;
  },
): string {
  if (!deps.existsSync(metaPath)) return "";
  try {
    const meta = JSON.parse(deps.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    return String(meta.gitCommitHash || meta.gitHash || "");
  } catch {
    return "";
  }
}
