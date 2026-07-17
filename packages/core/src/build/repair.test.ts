import { describe, expect, it, vi } from "vitest";
import { repairLlmFailures, repairLlmGraphFailures } from "./repair.js";

class FakeBuilder {
  nodes: any[] = [];
  edges: any[] = [];
  constructor(public project: string, public git: string) {}
  addFile(path: string, meta?: any) {
    this.nodes.push({ id: path, type: "file", filePath: path, summary: meta?.summary });
  }
  addFileWithAnalysis(path: string, _analysis: unknown, meta: any) {
    this.nodes.push({ id: path, type: "file", filePath: path, summary: meta?.summary });
  }
  addNonCodeFileWithAnalysis() {}
  addCallEdge() {}
  addImportEdge() {}
  build() {
    return { nodes: this.nodes, edges: this.edges };
  }
}

function makeCore() {
  const saved: Record<string, any> = {};
  return {
    core: {
      GraphBuilder: FakeBuilder,
      detectLayers: () => [{ name: "L" }],
      generateHeuristicTour: () => [{ order: 1 }],
      validateGraph: (g: any) => ({ success: true, data: g }),
      saveGraph: (root: string, g: any) => { saved.graph = { root, g }; },
      saveMeta: (root: string, m: any) => { saved.meta = { root, m }; },
      saveConfig: (root: string, c: any) => { saved.config = { root, c }; },
    },
    saved,
  };
}

const STATE = "/repo";
const GRAPH_PATH = "/repo/.understand-anything/knowledge-graph.json";
const STATS_PATH = "/repo/.understand-anything/llm/latest-stats.json";

function existingGraph(extra: any[] = []) {
  return {
    version: 3,
    project: { name: "repo", gitCommitHash: "old" },
    layers: [{ name: "L" }],
    nodes: [{ id: "src/a.ts", type: "file", filePath: "src/a.ts", summary: "old-a" }, ...extra],
    edges: [],
  };
}

function makeFixture(opts: {
  failures?: Array<{ filePath: string; reason: string }>;
  graph?: any;
  withStats?: boolean;
} = {}) {
  const failures = opts.failures ?? [{ filePath: "src/a.ts", reason: "timeout" }];
  const fileSystem: Record<string, string> = {
    [GRAPH_PATH]: JSON.stringify(opts.graph ?? existingGraph()),
    "/repo/src/a.ts": "source-a",
    "/repo/src/b.ts": "source-b",
  };
  if (opts.withStats !== false) {
    fileSystem[STATS_PATH] = JSON.stringify({
      enabled: true,
      providerName: "fake",
      requested: failures.length,
      analyzed: 0,
      failed: failures.length,
      skipped: 0,
      failures,
    });
  }
  const writes: Record<string, string> = {};
  const registry = {
    resolveImports: () => [],
    analyzeFile: () => ({ functions: [], classes: [] }),
    extractCallGraph: () => [],
  };
  const batches = [
    { batchIndex: 1, files: [{ path: "src/a.ts", language: "ts", fileCategory: "code" }], batchImportData: {} },
    { batchIndex: 2, files: [{ path: "src/b.ts", language: "ts", fileCategory: "code" }], batchImportData: {} },
  ];
  const deps = {
    existsSync: (p: string) => p in fileSystem || p in writes,
    readFileSync: (p: string) => {
      if (p in writes) return writes[p]!;
      const c = fileSystem[p];
      if (c === undefined) throw new Error(`missing ${p}`);
      return c;
    },
    writeFileSync: (p: string, d: string) => { writes[p] = d; },
    mkdirSync: () => {},
    resolveGitHash: () => "deadbeef",
    createRegistry: async () => registry,
    validateCheckpoint: () => ({ manifest: {} as any, batches, batchIndexes: [1, 2] }),
    now: () => new Date("2026-06-23T10:00:00.000Z"),
    runId: () => "run-1",
  };
  return { fileSystem, writes, deps, batches };
}

const REPORT_PATH = "/repo/.understand-anything/repair-runs/run-1/result.json";

describe("repairLlmFailures", () => {
  it("re-runs failed files, patches batches, rewrites graph, writes report", async () => {
    const { core, saved } = makeCore();
    const { writes, deps } = makeFixture();
    const runLlm = vi.fn().mockResolvedValue({
      analyses: new Map([["src/a.ts", { fileSummary: "LLM-A", tags: [], complexity: "simple", functionSummaries: {}, classSummaries: {} }]]),
      stats: { enabled: true, providerName: "fake", requested: 1, analyzed: 1, failed: 0, skipped: 0, failures: [] },
    });

    const result = await repairLlmFailures(
      { core, projectRoot: STATE, stateRoot: STATE, llm: { provider: {} as any }, log: () => {} },
      { ...deps, runLlmFileAnalysis: runLlm as any },
    );

    expect(runLlm).toHaveBeenCalledOnce();
    expect(runLlm.mock.calls[0]![0].files).toEqual([{ path: "src/a.ts" }]);
    expect(result.command).toBe("llm-failures");
    expect(result.repaired).toBe(1);
    expect(result.repairedFiles).toEqual(["src/a.ts"]);
    expect(result.batchesPatched).toEqual([1]);
    expect(result.dryRun).toBe(false);

    // graph persisted via upstream core
    expect(saved.graph).toBeDefined();
    const newNode = saved.graph.g.nodes.find((n: any) => n.id === "src/a.ts");
    expect(newNode.summary).toBe("LLM-A");

    // report written
    expect(writes[REPORT_PATH]).toBeDefined();
    const report = JSON.parse(writes[REPORT_PATH]!);
    expect(report).toMatchObject({ runId: "run-1", command: "llm-failures", repaired: 1, requested: 1 });
    expect(report.repairedFiles).toEqual(["src/a.ts"]);
  });

  it("dry-run scans without calling llm or persisting the graph", async () => {
    const { core, saved } = makeCore();
    const { writes, deps } = makeFixture();
    const runLlm = vi.fn();

    const result = await repairLlmFailures(
      { core, projectRoot: STATE, stateRoot: STATE, dryRun: true, log: () => {} },
      { ...deps, runLlmFileAnalysis: runLlm as any },
    );

    expect(runLlm).not.toHaveBeenCalled();
    expect(saved.graph).toBeUndefined();
    expect(result.dryRun).toBe(true);
    expect(result.requested).toBe(1);
    expect(result.attempted).toBe(0);
    expect(result.repaired).toBe(0);
    const report = JSON.parse(writes[REPORT_PATH]!);
    expect(report.dryRun).toBe(true);
    expect(report.targets).toEqual(["src/a.ts"]);
  });

  it("truncates targets to --repair-max-tasks", async () => {
    const { core } = makeCore();
    const { deps } = makeFixture({
      failures: [
        { filePath: "src/a.ts", reason: "timeout" },
        { filePath: "src/b.ts", reason: "overload" },
      ],
    });
    const runLlm = vi.fn().mockResolvedValue({
      analyses: new Map([["src/a.ts", { fileSummary: "LLM-A", tags: [], complexity: "simple", functionSummaries: {}, classSummaries: {} }]]),
      stats: { enabled: true, requested: 1, analyzed: 1, failed: 0, skipped: 0, failures: [] },
    });

    const result = await repairLlmFailures(
      { core, projectRoot: STATE, stateRoot: STATE, maxTasks: 1, llm: { provider: {} as any }, log: () => {} },
      { ...deps, runLlmFileAnalysis: runLlm as any },
    );

    expect(runLlm.mock.calls[0]![0].files).toEqual([{ path: "src/a.ts" }]);
    expect(result.requested).toBe(1);
    expect(result.maxTasks).toBe(1);
  });

  it("no-ops when latest-stats is missing", async () => {
    const { core, saved } = makeCore();
    const { writes, deps } = makeFixture({ withStats: false });
    const runLlm = vi.fn();
    const logs: string[] = [];

    const result = await repairLlmFailures(
      { core, projectRoot: STATE, stateRoot: STATE, llm: { provider: {} as any }, log: (line) => logs.push(line) },
      { ...deps, runLlmFileAnalysis: runLlm as any },
    );

    expect(runLlm).not.toHaveBeenCalled();
    expect(saved.graph).toBeUndefined();
    expect(result.requested).toBe(0);
    expect(result.repaired).toBe(0);
    expect(writes[REPORT_PATH]).toBeDefined();
    expect(logs.join("\n")).toContain("build --resume");
  });

  it("fails fast when no provider is configured (non-dry-run)", async () => {
    const { core } = makeCore();
    const { deps } = makeFixture();
    // No runLlmFileAnalysis override → exercises the real implementation,
    // which throws when provider is absent.

    await expect(
      repairLlmFailures(
        { core, projectRoot: STATE, stateRoot: STATE, log: () => {} },
        { ...deps },
      ),
    ).rejects.toThrow(/build: no LLM provider configured/);
  });

  it("throws when the existing graph is missing", async () => {
    const { core } = makeCore();
    const { deps, fileSystem } = makeFixture();
    delete fileSystem[GRAPH_PATH];

    await expect(
      repairLlmFailures(
        { core, projectRoot: STATE, stateRoot: STATE, llm: { provider: {} as any }, log: () => {} },
        { ...deps },
      ),
    ).rejects.toThrow(/existing graph/);
  });
});

describe("repairLlmGraphFailures", () => {
  it("repairs graph-level gaps by running LLM graph enhancement and persisting the graph", async () => {
    const { core, saved } = makeCore();
    const graph = existingGraph([{ id: "src/c.ts", type: "file", filePath: "src/c.ts" }]);
    const { writes, deps } = makeFixture({ graph });
    const runGraphLlm = vi.fn().mockImplementation(async ({ graph }) => ({
      graph: {
        ...graph,
        project: { ...graph.project, summary: "LLM project" },
        layers: [{ id: "llm", name: "LLM", nodeIds: ["src/a.ts", "src/c.ts"] }],
      },
      stats: { enabled: true, providerName: "fake", requested: 2, applied: 2, failed: 0, skipped: 0, failures: [] },
    }));

    const result = await repairLlmGraphFailures(
      { core, projectRoot: STATE, stateRoot: STATE, llm: { provider: { name: "fake", complete: async () => ({ text: "ok" }) } }, log: () => {} },
      { ...deps, runLlmGraphEnhancement: runGraphLlm as any },
    );

    expect(result.command).toBe("llm-graph-failures");
    expect(result.status).toBe("repaired");
    expect(result.gaps?.nodesMissingSummary).toBe(1);
    expect(runGraphLlm).toHaveBeenCalledOnce();
    expect(saved.graph.g.project.summary).toBe("LLM project");
    const report = JSON.parse(writes[REPORT_PATH]!);
    expect(report.status).toBe("repaired");
    expect(report.stats).toMatchObject({ applied: 2 });
  });

  it("throws when the existing graph is missing", async () => {
    const { core } = makeCore();
    const { deps, fileSystem } = makeFixture();
    delete fileSystem[GRAPH_PATH];

    await expect(
      repairLlmGraphFailures(
        { core, projectRoot: STATE, stateRoot: STATE, log: () => {} },
        { ...deps },
      ),
    ).rejects.toThrow(/existing graph/);
  });
});
