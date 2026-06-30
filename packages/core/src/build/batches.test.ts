import { describe, expect, it, vi } from "vitest";
import { buildPhase2InputManifest, runBatchesPhase, validateBatchCoverage } from "./batches.js";
import type { BuildPaths } from "./artifacts.js";

describe("validateBatchCoverage", () => {
  it("accepts exact scan-file coverage across batches", () => {
    expect(() => validateBatchCoverage(
      [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      [
        { batchIndex: 1, files: [{ path: "src/a.ts" }] },
        { batchIndex: 2, files: [{ path: "src/b.ts" }] },
      ],
    )).not.toThrow();
  });

  it("rejects missing scan files", () => {
    expect(() => validateBatchCoverage(
      [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      [{ batchIndex: 1, files: [{ path: "src/a.ts" }] }],
    )).toThrow(/missing.*src\/b\.ts/);
  });

  it("rejects extra files outside scan result", () => {
    expect(() => validateBatchCoverage(
      [{ path: "src/a.ts" }],
      [{ batchIndex: 1, files: [{ path: "src/a.ts" }, { path: "src/extra.ts" }] }],
    )).toThrow(/extra.*src\/extra\.ts/);
  });

  it("rejects duplicate file coverage", () => {
    expect(() => validateBatchCoverage(
      [{ path: "src/a.ts" }],
      [
        { batchIndex: 1, files: [{ path: "src/a.ts" }] },
        { batchIndex: 2, files: [{ path: "src/a.ts" }] },
      ],
    )).toThrow(/duplicate.*src\/a\.ts/);
  });
});

describe("runBatchesPhase batch coverage", () => {
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

  it("fails before writing manifest when compute-batches omits a scan file", () => {
    const writes: Record<string, string> = {};
    const reads: Record<string, string> = {
      [paths.scanPath]: JSON.stringify({ files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }),
      [paths.batchesPath]: JSON.stringify({ batches: [{ batchIndex: 1, files: [{ path: "src/a.ts" }] }] }),
    };

    expect(() => runBatchesPhase(
      {
        skillDir: "/skill",
        computeRoot: "/repo",
        paths,
        projectRoot: "/repo",
        outputLanguage: "en",
        excludeTests: true,
        gitHash: "abc",
        log: () => {},
      },
      {
        readFileSync: (path) => reads[path] ?? "",
        writeFileSync: (path, data) => { writes[path] = data; },
        execFileSync: vi.fn() as never,
      },
    )).toThrow(/batch coverage missing/);
    expect(writes[paths.phase2ManifestPath]).toBeUndefined();
  });
});

describe("buildPhase2InputManifest", () => {
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

  it("includes baseGraphCommit and changedFiles for partial build manifests", () => {
    const reads: Record<string, string> = {
      [paths.scanPath]: JSON.stringify({ files: [{ path: "src/a.ts" }] }),
      [paths.batchesPath]: JSON.stringify({ batches: [{ batchIndex: 1 }] }),
    };
    const manifest = buildPhase2InputManifest(
      {
        skillDir: "/skill",
        computeRoot: "/repo",
        paths,
        projectRoot: "/repo",
        outputLanguage: "en",
        excludeTests: true,
        gitHash: "head123",
        buildKind: "incremental",
        baseGraphCommit: "base456",
        changedFiles: ["src/a.ts"],
        log: () => {},
      },
      {
        readFileSync: (path) => reads[path] ?? "",
        currentGitDirty: () => false,
      },
      [{ batchIndex: 1 }],
    );

    expect(manifest.baseGraphCommit).toBe("base456");
    expect(manifest.changedFiles).toEqual(["src/a.ts"]);
    expect(manifest.buildKind).toBe("incremental");
  });
});
