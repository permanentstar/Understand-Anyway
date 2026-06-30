import { createHash } from "node:crypto";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BuildPaths } from "./artifacts.js";
import type { Phase2InputManifest } from "./batches.js";

export interface CheckpointDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
  expected?: CheckpointExpectedContext;
}

export interface ValidCheckpoint {
  manifest: Phase2InputManifest;
  batches: any[];
  batchIndexes: number[];
}

export interface CheckpointExpectedContext {
  sourceGitCommit?: string;
  sourceDirty?: boolean;
  outputLanguage?: string;
  excludeTests?: boolean;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertExpectedString(name: string, actual: unknown, expected: string | undefined): void {
  if (expected === undefined || actual === undefined) return;
  if (String(actual) !== expected) {
    throw new Error(`build: resume ${name} mismatch: manifest=${String(actual)} current=${expected}`);
  }
}

function assertExpectedBoolean(name: string, actual: unknown, expected: boolean | undefined): void {
  if (expected === undefined || actual === undefined) return;
  if (Boolean(actual) !== expected) {
    throw new Error(`build: resume ${name} mismatch: manifest=${Boolean(actual)} current=${expected}`);
  }
}

export function validatePhase2Checkpoint(paths: BuildPaths, deps: CheckpointDeps = {}): ValidCheckpoint {
  const exists = deps.existsSync ?? nodeExistsSync;
  const read = deps.readFileSync ?? ((p: string) => nodeReadFileSync(p, "utf8"));

  if (!exists(paths.phase2ManifestPath)) throw new Error(`build: resume manifest not found: ${paths.phase2ManifestPath}`);
  if (!exists(paths.scanPath)) throw new Error(`build: resume scan result not found: ${paths.scanPath}`);
  if (!exists(paths.batchesPath)) throw new Error(`build: resume batches not found: ${paths.batchesPath}`);

  const scanRaw = read(paths.scanPath);
  const batchesRaw = read(paths.batchesPath);
  const manifest = JSON.parse(read(paths.phase2ManifestPath)) as Phase2InputManifest;
  if (manifest.scanResultSha256 && sha256(scanRaw) !== manifest.scanResultSha256) {
    throw new Error("build: resume scan-result hash mismatch");
  }
  if (manifest.batchesSha256 && sha256(batchesRaw) !== manifest.batchesSha256) {
    throw new Error("build: resume batches hash mismatch");
  }
  assertExpectedString("source git commit", manifest.sourceGitCommit, deps.expected?.sourceGitCommit);
  assertExpectedBoolean("source dirty", manifest.sourceDirty, deps.expected?.sourceDirty);
  assertExpectedString("outputLanguage", manifest.outputLanguage, deps.expected?.outputLanguage);
  assertExpectedBoolean("excludeTests", manifest.excludeTests, deps.expected?.excludeTests);

  const parsed = JSON.parse(batchesRaw) as { batches?: Array<{ batchIndex?: unknown }> };
  const batches = Array.isArray(parsed.batches) ? parsed.batches : [];
  if (typeof manifest.batchCount === "number" && manifest.batchCount !== batches.length) {
    throw new Error(`build: resume batch count mismatch: manifest=${manifest.batchCount} current=${batches.length}`);
  }

  const batchIndexes = batches.map((b) => Number(b.batchIndex)).filter((n): n is number => Number.isInteger(n));
  for (const index of batchIndexes) {
    const file = resolve(paths.intermediateDir, `batch-${index}.json`);
    if (!exists(file)) throw new Error(`build: resume batch artifact missing: ${file}`);
  }

  return { manifest, batches, batchIndexes };
}
