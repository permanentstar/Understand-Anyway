import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BuildPaths } from "./artifacts.js";
import { validatePhase2Checkpoint } from "./checkpoint.js";

const paths: BuildPaths = {
  stateRoot: "/repo",
  uaDir: "/repo/.understand-anything",
  intermediateDir: "/repo/.understand-anything/intermediate",
  scanPath: "/repo/.understand-anything/intermediate/scan-result.json",
  batchesPath: "/repo/.understand-anything/intermediate/batches.json",
  assembledPath: "/repo/.understand-anything/intermediate/assembled-graph.json",
  phase2ManifestPath: "/repo/.understand-anything/intermediate/phase2-input-manifest.json",
  graphPath: "/repo/.understand-anything/knowledge-graph.json",
  metaPath: "/repo/.understand-anything/meta.json",
  configPath: "/repo/.understand-anything/config.json",
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("validatePhase2Checkpoint", () => {
  it("accepts a valid checkpoint", () => {
    const scan = JSON.stringify({ files: [] });
    const batches = JSON.stringify({ batches: [{ batchIndex: 1 }] });
    const files: Record<string, string> = {
      [paths.scanPath]: scan,
      [paths.batchesPath]: batches,
      [paths.phase2ManifestPath]: JSON.stringify({
        version: 1,
        buildKind: "full",
        sourceGitCommit: "abc",
        sourceDirty: false,
        outputLanguage: "en",
        excludeTests: true,
        scanResultSha256: sha256(scan),
        batchesSha256: sha256(batches),
        batchCount: 1,
        createdAt: "2026-06-18T00:00:00",
      }),
      "/repo/.understand-anything/intermediate/batch-1.json": JSON.stringify({ nodes: [], edges: [] }),
    };

    const result = validatePhase2Checkpoint(paths, {
      existsSync: (p) => p in files,
      readFileSync: (p) => files[p]!,
    });

    expect(result.batchIndexes).toEqual([1]);
    expect(result.batches).toHaveLength(1);
  });

  it("throws on missing manifest", () => {
    expect(() => validatePhase2Checkpoint(paths, { existsSync: () => false, readFileSync: () => "" })).toThrow(/manifest/);
  });

  it("throws on hash mismatch", () => {
    const files: Record<string, string> = {
      [paths.scanPath]: "changed",
      [paths.batchesPath]: JSON.stringify({ batches: [] }),
      [paths.phase2ManifestPath]: JSON.stringify({
        version: 1,
        scanResultSha256: "bad",
        batchesSha256: "bad",
        batchCount: 0,
      }),
    };

    expect(() =>
      validatePhase2Checkpoint(paths, {
        existsSync: (p) => p in files,
        readFileSync: (p) => files[p]!,
      }),
    ).toThrow(/hash mismatch/);
  });

  it("throws when the source commit does not match the resume context", () => {
    const scan = JSON.stringify({ files: [] });
    const batches = JSON.stringify({ batches: [] });
    const files: Record<string, string> = {
      [paths.scanPath]: scan,
      [paths.batchesPath]: batches,
      [paths.phase2ManifestPath]: JSON.stringify({
        sourceGitCommit: "old",
        sourceDirty: false,
        outputLanguage: "en",
        excludeTests: true,
        batchCount: 0,
      }),
    };

    expect(() =>
      validatePhase2Checkpoint(paths, {
        existsSync: (p) => p in files,
        readFileSync: (p) => files[p]!,
        expected: {
          sourceGitCommit: "new",
          sourceDirty: false,
          outputLanguage: "en",
          excludeTests: true,
        },
      }),
    ).toThrow(/source git commit mismatch/);
  });

  it("throws when dirty flag or build settings do not match the resume context", () => {
    const scan = JSON.stringify({ files: [] });
    const batches = JSON.stringify({ batches: [] });
    const baseFiles: Record<string, string> = {
      [paths.scanPath]: scan,
      [paths.batchesPath]: batches,
      [paths.phase2ManifestPath]: JSON.stringify({
        sourceGitCommit: "abc",
        sourceDirty: false,
        outputLanguage: "en",
        excludeTests: true,
        batchCount: 0,
      }),
    };
    const run = (expected: NonNullable<Parameters<typeof validatePhase2Checkpoint>[1]>["expected"]) =>
      validatePhase2Checkpoint(paths, {
        existsSync: (p) => p in baseFiles,
        readFileSync: (p) => baseFiles[p]!,
        expected,
      });

    expect(() => run({ sourceGitCommit: "abc", sourceDirty: true, outputLanguage: "en", excludeTests: true }))
      .toThrow(/source dirty mismatch/);
    expect(() => run({ sourceGitCommit: "abc", sourceDirty: false, outputLanguage: "zh", excludeTests: true }))
      .toThrow(/outputLanguage mismatch/);
    expect(() => run({ sourceGitCommit: "abc", sourceDirty: false, outputLanguage: "en", excludeTests: false }))
      .toThrow(/excludeTests mismatch/);
  });
});
