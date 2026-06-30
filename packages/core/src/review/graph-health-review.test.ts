import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGraphHealthReview } from "./graph-health-review.js";

interface FixtureOptions {
  graph?: unknown;
  meta?: unknown;
  config?: unknown;
  modules?: unknown;
  llmStats?: unknown;
  repoFiles?: string[];
}

function makeFixture(opts: FixtureOptions = {}): { repoDir: string; stateDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "ua-graph-health-repo-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ua-graph-health-state-"));
  const stateAA = join(stateDir, ".understand-anything");
  mkdirSync(stateAA, { recursive: true });
  if (opts.graph !== undefined) {
    writeFileSync(join(stateAA, "knowledge-graph.json"), JSON.stringify(opts.graph));
  }
  if (opts.meta !== undefined) {
    writeFileSync(join(stateAA, "meta.json"), JSON.stringify(opts.meta));
  }
  if (opts.config !== undefined) {
    writeFileSync(join(stateAA, "config.json"), JSON.stringify(opts.config));
  }
  if (opts.modules !== undefined) {
    mkdirSync(join(stateAA, "runtime"), { recursive: true });
    writeFileSync(join(stateAA, "runtime", "modules.json"), JSON.stringify(opts.modules));
  }
  if (opts.llmStats !== undefined) {
    mkdirSync(join(stateAA, "llm"), { recursive: true });
    writeFileSync(join(stateAA, "llm", "latest-stats.json"), JSON.stringify(opts.llmStats));
  }
  for (const file of opts.repoFiles ?? []) {
    const target = join(repoDir, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "// placeholder");
  }
  return {
    repoDir,
    stateDir,
    cleanup: () => {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

const FAKE_HASH = "deadbeef0000000000000000000000000000beef";
const fakeExec: any = (_cmd: string, args: readonly string[]) => {
  if (args && args.includes("rev-parse")) return Buffer.from(`${FAKE_HASH}\n`);
  return Buffer.from("");
};

const minimalHealthyGraph = {
  nodes: [
    { id: "f1", type: "file", path: "src/a.ts" },
    { id: "f2", type: "file", path: "src/b.ts" },
  ],
  edges: [
    { type: "contains", source: "f1", target: "f2" },
    { type: "imports", source: "f1", target: "f2" },
    { type: "calls", source: "f1", target: "f2" },
  ],
};

const minimalMeta = { gitCommitHash: FAKE_HASH };
const minimalConfig = { schemaVersion: 1 };
const activeModules = { modules: [{ id: "scan", status: "active" }] };

describe("runGraphHealthReview — required artifacts", () => {
  it("flags graph_missing / meta_missing / config_missing as critical and returns early", () => {
    const fx = makeFixture();
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.approved).toBe(false);
    const ids = result.issues.map((i) => i.id).sort();
    expect(ids).toEqual(["config_missing", "graph_missing", "meta_missing"]);
    fx.cleanup();
  });

  it("flags artifact_json_invalid when knowledge-graph.json is malformed", () => {
    const fx = makeFixture({
      meta: minimalMeta,
      config: minimalConfig,
    });
    writeFileSync(join(fx.stateDir, ".understand-anything", "knowledge-graph.json"), "{not-json");
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.approved).toBe(false);
    expect(result.issues.some((i) => i.id === "artifact_json_invalid")).toBe(true);
    fx.cleanup();
  });

  it("resolves current version pointer before reading graph artifacts", () => {
    const fx = makeFixture({ repoFiles: ["src/a.ts", "src/b.ts"] });
    rmSync(join(fx.stateDir, ".understand-anything"), { recursive: true, force: true });
    const versionRoot = join(fx.stateDir, "versions", "v1");
    const versionAA = join(versionRoot, ".understand-anything");
    mkdirSync(versionAA, { recursive: true });
    writeFileSync(join(versionAA, "knowledge-graph.json"), JSON.stringify(minimalHealthyGraph));
    writeFileSync(join(versionAA, "meta.json"), JSON.stringify(minimalMeta));
    writeFileSync(join(versionAA, "config.json"), JSON.stringify(minimalConfig));
    mkdirSync(join(versionAA, "runtime"), { recursive: true });
    writeFileSync(join(versionAA, "runtime", "modules.json"), JSON.stringify(activeModules));
    symlinkSync(versionRoot, join(fx.stateDir, "current"));

    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });

    expect(result.approved).toBe(true);
    expect(result.stats.effectiveStateRoot).toBe(versionRoot);
    expect(result.stats.resolutionSource).toBe("current-link");
    expect(result.stats.resolvedVersionId).toBe("v1");
    fx.cleanup();
  });
});

describe("runGraphHealthReview — graph integrity", () => {
  it("approves a healthy fixture", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.approved).toBe(true);
    expect(result.stats.nodeCount).toBe(2);
    expect(result.stats.containsEdges).toBe(1);
    expect(result.stats.importsEdges).toBe(1);
    expect(result.stats.callsEdges).toBe(1);
    fx.cleanup();
  });

  it("flags graph_nodes_empty + graph_edges_empty + contains_edges_missing", () => {
    const fx = makeFixture({
      graph: { nodes: [], edges: [] },
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain("graph_nodes_empty");
    expect(ids).toContain("graph_edges_empty");
    expect(ids).toContain("contains_edges_missing");
    expect(result.approved).toBe(false);
    fx.cleanup();
  });

  it("flags imports_edges_missing only when file nodes look importable", () => {
    const fx = makeFixture({
      graph: {
        nodes: [{ id: "f1", type: "file", path: "src/a.ts" }],
        edges: [{ type: "contains", source: "f1", target: "f1" }],
      },
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["src/a.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.issues.some((i) => i.id === "imports_edges_missing")).toBe(true);
    fx.cleanup();
  });

  it("does NOT flag imports_edges_missing for non-importable file extensions", () => {
    const fx = makeFixture({
      graph: {
        nodes: [{ id: "f1", type: "file", path: "doc/README.md" }],
        edges: [{ type: "contains", source: "f1", target: "f1" }],
      },
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["doc/README.md"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.issues.map((i) => i.id)).not.toContain("imports_edges_missing");
    fx.cleanup();
  });

  it("warns when 0 < missing/total <= 25%", () => {
    const fx = makeFixture({
      graph: {
        nodes: [
          { id: "f1", type: "file", path: "src/a.ts" },
          { id: "f2", type: "file", path: "src/b.ts" },
          { id: "f3", type: "file", path: "src/c.ts" },
          { id: "f4", type: "file", path: "src/d.ts" },
          { id: "f5", type: "file", path: "src/missing.ts" },
        ],
        edges: [
          { type: "contains", source: "f1", target: "f1" },
          { type: "imports", source: "f1", target: "f2" },
          { type: "calls", source: "f1", target: "f2" },
        ],
      },
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.warnings.some((w) => w.id === "missing_file_nodes")).toBe(true);
    expect(result.issues.some((i) => i.id === "missing_file_nodes_high")).toBe(false);
    fx.cleanup();
  });

  it("flags missing_file_nodes_high when missing/total > 25%", () => {
    const fx = makeFixture({
      graph: {
        nodes: [
          { id: "f1", type: "file", path: "src/a.ts" },
          { id: "f2", type: "file", path: "src/missing1.ts" },
          { id: "f3", type: "file", path: "src/missing2.ts" },
        ],
        edges: [
          { type: "contains", source: "f1", target: "f1" },
          { type: "imports", source: "f1", target: "f2" },
          { type: "calls", source: "f1", target: "f2" },
        ],
      },
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["src/a.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.issues.some((i) => i.id === "missing_file_nodes_high")).toBe(true);
    fx.cleanup();
  });

  it("warns calls_edges_missing when zero call edges", () => {
    const fx = makeFixture({
      graph: {
        nodes: [{ id: "f1", type: "file", path: "src/a.ts" }],
        edges: [
          { type: "contains", source: "f1", target: "f1" },
          { type: "imports", source: "f1", target: "f1" },
        ],
      },
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["src/a.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.warnings.some((w) => w.id === "calls_edges_missing")).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.approved).toBe(true);
    fx.cleanup();
  });
});

describe("runGraphHealthReview — git hash + modules + llm", () => {
  it("flags git_hash_mismatch when meta diverges from HEAD", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: { gitCommitHash: "0000beef" },
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.issues.some((i) => i.id === "git_hash_mismatch")).toBe(true);
    fx.cleanup();
  });

  it("warns runtime_modules_missing when modules.json absent", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.warnings.some((w) => w.id === "runtime_modules_missing")).toBe(true);
    expect(result.approved).toBe(true);
    fx.cleanup();
  });

  it("flags runtime_module_not_active for non-active modules", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      modules: { modules: [{ id: "scan", status: "failed" }] },
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.issues.some((i) => i.id === "runtime_module_not_active")).toBe(true);
    fx.cleanup();
  });

  it("exempts llm-analysis: deferred from runtime_module_not_active", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      modules: { modules: [{ id: "llm-analysis", status: "deferred" }, { id: "scan", status: "active" }] },
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.issues).toEqual([]);
    expect(result.approved).toBe(true);
    fx.cleanup();
  });

  it("returns null llm stats when latest-stats.json missing", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    expect(result.stats.llm).toBeNull();
    fx.cleanup();
  });

  it("marks llm stats stale when repoCommit diverges from meta", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      llmStats: {
        enabled: true,
        status: "ok",
        provider: "fake",
        model: "x",
        repoCommit: "stale-commit",
        graphHash: "h",
        requests: 9,
      },
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    const llm = result.stats.llm as Record<string, unknown>;
    expect(llm.status).toBe("stale");
    expect(llm.enabled).toBe(false);
    expect(llm.requests).toBe(0);
    fx.cleanup();
  });

  it("marks llm stats invalid_stats when payload is malformed JSON", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      llmStats: { placeholder: true },
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    writeFileSync(join(fx.stateDir, ".understand-anything", "llm", "latest-stats.json"), "{not-json");
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    const llm = result.stats.llm as Record<string, unknown>;
    expect(llm.status).toBe("invalid_stats");
    expect(llm.failures).toBe(1);
    fx.cleanup();
  });

  it("propagates llm stats fields when valid + matching commit", () => {
    const fx = makeFixture({
      graph: minimalHealthyGraph,
      meta: minimalMeta,
      config: minimalConfig,
      modules: activeModules,
      llmStats: {
        enabled: true,
        status: "ok",
        provider: "fakep",
        model: "fake-model",
        repoCommit: FAKE_HASH,
        graphHash: "h",
        requests: 3,
        tasks: 5,
        processedTasks: 5,
        failures: 0,
        timeouts: 0,
        skippedFiles: 0,
        candidateFiles: 5,
        processedFiles: 5,
        breakerTripped: false,
        enrichedNodes: 7,
        durationMs: 1234,
      },
      repoFiles: ["src/a.ts", "src/b.ts"],
    });
    const result = runGraphHealthReview({ repoPath: fx.repoDir, stateDir: fx.stateDir, execFileSync: fakeExec });
    const llm = result.stats.llm as Record<string, unknown>;
    expect(llm.enabled).toBe(true);
    expect(llm.provider).toBe("fakep");
    expect(llm.requests).toBe(3);
    expect(llm.enrichedNodes).toBe(7);
    fx.cleanup();
  });
});
