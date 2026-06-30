/**
 * Phase 1.5 — compute batches. Delegates to the upstream `compute-batches.mjs`
 * script (§9b), reads back `batches.json`, and writes the phase-2 input
 * manifest used to gate batch resumes. Ported from deploy.
 */

import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync as nodeReadFileSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupBatchArtifacts, type BuildPaths } from "./artifacts.js";
import { currentGitDirty, type GitDeps } from "./git.js";
import type { BuildLog } from "./scan.js";
import { formatLocalTimestamp } from "./time.js";

export interface BatchesFsDeps extends GitDeps {
  execFileSync?: typeof nodeExecFileSync;
  readFileSync?: (path: string) => Buffer | string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
  currentGitDirty?: (projectRoot: string) => boolean;
}

export interface Phase2InputManifest {
  version: 1;
  buildKind: ManifestBuildKind;
  sourceGitCommit: string;
  sourceDirty: boolean;
  baseGraphCommit?: string;
  changedFiles?: string[];
  outputLanguage: string;
  excludeTests: boolean;
  scanResultSha256: string;
  batchesSha256: string;
  batchCount: number;
  createdAt: string;
}

export type ManifestBuildKind = "full" | "incremental" | "backfill";

export interface RunBatchesOptions {
  skillDir: string;
  computeRoot: string;
  paths: BuildPaths;
  projectRoot: string;
  outputLanguage: string;
  excludeTests: boolean;
  gitHash: string;
  buildKind?: ManifestBuildKind;
  baseGraphCommit?: string;
  changedFiles?: string[];
  log: BuildLog;
}

function sha256File(filePath: string, read: (p: string) => Buffer | string): string {
  return createHash("sha256").update(read(filePath)).digest("hex");
}

export interface RunBatchesResult {
  batches: any[];
  manifest: Phase2InputManifest;
}

export interface BatchCoverageFile {
  path?: string;
}

export interface BatchCoverageBatch {
  batchIndex?: unknown;
  files?: BatchCoverageFile[];
}

function listDiff(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort();
}

export function validateBatchCoverage(scanFiles: BatchCoverageFile[], batches: BatchCoverageBatch[]): void {
  const expected = new Set(
    scanFiles
      .map((file) => String(file.path || "").trim())
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const batch of batches) {
    for (const file of batch.files ?? []) {
      const path = String(file.path || "").trim();
      if (!path) continue;
      if (seen.has(path)) duplicates.add(path);
      seen.add(path);
    }
  }
  const missing = listDiff(expected, seen);
  const extra = listDiff(seen, expected);
  if (missing.length > 0) {
    throw new Error(`build: batch coverage missing files: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(`build: batch coverage extra files: ${extra.join(", ")}`);
  }
  if (duplicates.size > 0) {
    throw new Error(`build: batch coverage duplicate files: ${[...duplicates].sort().join(", ")}`);
  }
}

export function runBatchesPhase(options: RunBatchesOptions, deps: BatchesFsDeps = {}): RunBatchesResult {
  const exec = deps.execFileSync ?? nodeExecFileSync;
  const read = deps.readFileSync ?? ((p: string) => nodeReadFileSync(p));
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  const { skillDir, computeRoot, paths, projectRoot, outputLanguage, excludeTests, gitHash, log } = options;

  log("phase 1.5/4 compute-batches");
  cleanupBatchArtifacts(paths.intermediateDir);
  exec(process.execPath, [join(skillDir, "compute-batches.mjs"), computeRoot], { stdio: "inherit" });

  const scanData = JSON.parse(String(read(paths.scanPath))) as { files?: BatchCoverageFile[] };
  const batchData = JSON.parse(String(read(paths.batchesPath)));
  const batches = Array.isArray(batchData.batches) ? batchData.batches : [];
  validateBatchCoverage(Array.isArray(scanData.files) ? scanData.files : [], batches);
  log(`batches ready: ${batches.length}`);

  const manifest = buildPhase2InputManifest(options, deps, batches);
  write(paths.phase2ManifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { batches, manifest };
}

export function buildPhase2InputManifest(
  options: RunBatchesOptions,
  deps: BatchesFsDeps = {},
  batchesIn?: any[],
): Phase2InputManifest {
  const read = deps.readFileSync ?? ((p: string) => nodeReadFileSync(p));
  const batches = batchesIn ?? [];
  const manifest: Phase2InputManifest = {
    version: 1,
    buildKind: options.buildKind ?? "full",
    sourceGitCommit: options.gitHash,
    sourceDirty: deps.currentGitDirty ? deps.currentGitDirty(options.projectRoot) : currentGitDirty(options.projectRoot, deps),
    outputLanguage: options.outputLanguage,
    excludeTests: options.excludeTests,
    scanResultSha256: sha256File(options.paths.scanPath, read),
    batchesSha256: sha256File(options.paths.batchesPath, read),
    batchCount: batches.length,
    createdAt: formatLocalTimestamp(),
  };
  if (options.baseGraphCommit) manifest.baseGraphCommit = options.baseGraphCommit;
  if (options.changedFiles) manifest.changedFiles = [...options.changedFiles];
  return manifest;
}
