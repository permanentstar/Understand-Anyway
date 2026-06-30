/**
 * Intermediate-artifact path layout and cleanup for the deterministic build.
 *
 * Mirrors the upstream `.understand-anything/` convention: a state root holds
 * the final graph/meta/config, and `intermediate/` holds the scan/batch/merge
 * working files that the pipeline reads back across phases.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const UA_DIR = ".understand-anything";
export const INTERMEDIATE_DIR = "intermediate";

export interface BuildPaths {
  stateRoot: string;
  uaDir: string;
  intermediateDir: string;
  scanPath: string;
  batchesPath: string;
  assembledPath: string;
  phase2ManifestPath: string;
  graphPath: string;
  metaPath: string;
  configPath: string;
}

export function resolveBuildPaths(stateRoot: string): BuildPaths {
  const uaDir = resolve(stateRoot, UA_DIR);
  const intermediateDir = resolve(uaDir, INTERMEDIATE_DIR);
  return {
    stateRoot,
    uaDir,
    intermediateDir,
    scanPath: resolve(intermediateDir, "scan-result.json"),
    batchesPath: resolve(intermediateDir, "batches.json"),
    assembledPath: resolve(intermediateDir, "assembled-graph.json"),
    phase2ManifestPath: resolve(intermediateDir, "phase2-input-manifest.json"),
    graphPath: resolve(uaDir, "knowledge-graph.json"),
    metaPath: resolve(uaDir, "meta.json"),
    configPath: resolve(uaDir, "config.json"),
  };
}

export function ensureBuildDirs(paths: BuildPaths): void {
  mkdirSync(paths.intermediateDir, { recursive: true });
}

export function cleanupBatchArtifacts(intermediateDir: string): void {
  if (!existsSync(intermediateDir)) return;
  for (const entry of readdirSync(intermediateDir)) {
    if (
      entry === "batches.json"
      || entry === "assembled-graph.json"
      || /^batch-\d+(?:-part-\d+)?\.json$/.test(entry)
      || /^batch-indexes-\d+-\d+\.txt$/.test(entry)
      || entry === "batch-include-paths.txt"
    ) {
      rmSync(resolve(intermediateDir, entry), { recursive: true, force: true });
    }
  }
}
