/**
 * Phase 2 — batch graph (full mode, deterministic). For each batch, builds a
 * sub-graph with the upstream GraphBuilder: analyzes each file into nodes/call
 * edges, adds import edges from the batch import data, and writes
 * `batch-<n>.json`. Ported from deploy `analyzeFileIntoBuilder` +
 * `writeBatchGraphFiles` (full path). Optional LLM analyses are injected as
 * already-parsed per-file annotations; this module still owns only deterministic
 * graph assembly.
 */

import { readFileSync as nodeReadFileSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dedupeEdges, type GraphEdge } from "./graph-utils.js";
import {
  complexityFromLines,
  fileSummary,
  nonCodeType,
  symbolSummary,
} from "./summaries.js";
import type { LLMFileAnalysis } from "./llm.js";
import type { BuildLog } from "./scan.js";

export interface BatchGraphFsDeps {
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
}

interface BatchFile {
  path: string;
  language?: string;
  fileCategory?: string;
  sizeLines?: number;
}

interface Batch {
  batchIndex: number | string;
  files?: BatchFile[];
  batchImportData?: Record<string, string[]>;
}

export function analyzeFileIntoBuilder(
  builder: any,
  registry: any,
  analysisRoot: string,
  file: BatchFile,
  outputLanguage: string,
  read: (path: string, encoding: "utf8") => string,
  llmAnalysis?: LLMFileAnalysis | null,
): void {
  const relPath = file.path;
  const absPath = join(analysisRoot, relPath);
  const content = read(absPath, "utf8");
  const analysis = registry.analyzeFile(absPath, content);
  const complexity = llmAnalysis?.complexity ?? complexityFromLines(file.sizeLines || 0);
  const tags = llmAnalysis?.tags ?? [file.language, file.fileCategory].filter(Boolean);
  const summary = llmAnalysis?.fileSummary ?? fileSummary(relPath, file.language || "unknown", analysis, outputLanguage);

  if (file.fileCategory === "code" || file.fileCategory === "script") {
    if (analysis && ((analysis.functions?.length || 0) || (analysis.classes?.length || 0))) {
      const summaries: Record<string, string> = {};
      for (const fn of analysis.functions || []) {
        summaries[fn.name] = llmAnalysis?.functionSummaries?.[fn.name]
          ?? symbolSummary("function", fn.name, relPath, outputLanguage);
      }
      for (const cls of analysis.classes || []) {
        summaries[cls.name] = llmAnalysis?.classSummaries?.[cls.name]
          ?? symbolSummary("class", cls.name, relPath, outputLanguage);
      }
      builder.addFileWithAnalysis(relPath, analysis, {
        fileSummary: summary,
        summary,
        tags,
        complexity,
        summaries,
      });
    } else {
      builder.addFile(relPath, { summary, tags, complexity });
    }
  } else {
    builder.addNonCodeFileWithAnalysis(relPath, {
      nodeType: nonCodeType(file.fileCategory || ""),
      summary,
      tags,
      complexity,
      definitions: analysis?.definitions || [],
      services: analysis?.services || [],
      endpoints: analysis?.endpoints || [],
      steps: analysis?.steps || [],
      resources: analysis?.resources || [],
      sections: analysis?.sections || [],
    });
  }

  const calls = typeof registry.extractCallGraph === "function"
    ? registry.extractCallGraph(absPath, content) || []
    : [];
  const symbolIndex = new Set<string>([
    ...(analysis?.functions || []).map((fn: { name: string }) => fn.name),
    ...(analysis?.classes || []).map((cls: { name: string }) => cls.name),
  ]);
  for (const edge of calls) {
    if (symbolIndex.has(edge.caller) && symbolIndex.has(edge.callee)) {
      builder.addCallEdge(relPath, edge.caller, relPath, edge.callee);
    }
  }
}

export interface AnalyzeSingleBatchOptions {
  core: any;
  registry: any;
  analysisRoot: string;
  batch: Batch;
  outputLanguage: string;
  projectName: string;
  gitHash: string;
  log: BuildLog;
  /** Optional per-file LLM analysis keyed by repo-relative path. */
  llmAnalyses?: Map<string, LLMFileAnalysis>;
}

export interface AnalyzedBatch {
  batchIndex: number | string;
  analyzed: number;
  artifact: { nodes: any[]; edges: GraphEdge[]; llmEnriched?: boolean };
}

/**
 * Runs the deterministic analyzer + GraphBuilder for a single batch and
 * returns the assembled artefact, without writing to disk. Shared by the
 * legacy full-mode loop (writeBatchGraphFiles below) and the segmented
 * worker entry (C7.5), so both code paths produce byte-identical batches.
 *
 * Returns `null` when no files in the batch were successfully analyzed,
 * mirroring deploy's "skip empty batches" behaviour.
 */
export function analyzeSingleBatch(options: AnalyzeSingleBatchOptions, deps: BatchGraphFsDeps = {}): AnalyzedBatch | null {
  const read = deps.readFileSync ?? ((p: string, e: "utf8") => nodeReadFileSync(p, e));
  const { core, registry, analysisRoot, batch, outputLanguage, projectName, gitHash, log, llmAnalyses } = options;
  const { GraphBuilder } = core;
  const builder = new GraphBuilder(projectName, gitHash);
  const selectedFiles = batch.files || [];
  let analyzed = 0;
  for (const file of selectedFiles) {
    try {
      analyzeFileIntoBuilder(builder, registry, analysisRoot, file, outputLanguage, read, llmAnalyses?.get(file.path));
      analyzed += 1;
    } catch (error) {
      log(`batch ${batch.batchIndex} skip ${file.path}: ${(error as Error).message}`);
    }
  }
  if (analyzed === 0) return null;
  for (const file of selectedFiles) {
    const targets = batch.batchImportData?.[file.path] || [];
    for (const target of targets) {
      if (target && target !== file.path) {
        builder.addImportEdge(file.path, target);
      }
    }
  }
  const graph = builder.build();
  const artifact = {
    nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
    edges: dedupeEdges(Array.isArray(graph?.edges) ? (graph.edges as GraphEdge[]) : []),
  };
  return { batchIndex: batch.batchIndex, analyzed, artifact };
}

/**
 * Writes one analyzed batch artefact to disk as `batch-<n>.json`. Pulled out
 * of writeBatchGraphFiles so the C7 worker can call it on a single batch
 * after analyzeSingleBatch.
 */
export function writeOneBatchGraphFile(
  intermediateDir: string,
  result: AnalyzedBatch,
  deps: BatchGraphFsDeps = {},
): void {
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  write(
    resolve(intermediateDir, `batch-${result.batchIndex}.json`),
    JSON.stringify(result.artifact, null, 2),
    "utf8",
  );
}

export interface WriteBatchGraphsOptions {
  core: any;
  registry: any;
  analysisRoot: string;
  intermediateDir: string;
  batches: Batch[];
  outputLanguage: string;
  projectName: string;
  gitHash: string;
  log: BuildLog;
  /** Optional per-file LLM analysis keyed by repo-relative path. */
  llmAnalyses?: Map<string, LLMFileAnalysis>;
}

export interface WriteBatchGraphsResult {
  written: number;
  analyzed: number;
}

export function writeBatchGraphFiles(
  options: WriteBatchGraphsOptions,
  deps: BatchGraphFsDeps = {},
): WriteBatchGraphsResult {
  const { core, registry, analysisRoot, intermediateDir, batches, outputLanguage, projectName, gitHash, log, llmAnalyses } = options;
  let written = 0;
  let analyzed = 0;
  for (const batch of batches) {
    const result = analyzeSingleBatch(
      { core, registry, analysisRoot, batch, outputLanguage, projectName, gitHash, log, llmAnalyses },
      deps,
    );
    if (!result) continue;
    writeOneBatchGraphFile(intermediateDir, result, deps);
    written += 1;
    analyzed += result.analyzed;
  }
  log(`batch graph files written: ${written}, files analyzed: ${analyzed}`);
  return { written, analyzed };
}
