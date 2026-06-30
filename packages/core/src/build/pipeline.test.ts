import { describe, expect, it, vi } from "vitest";
import { runBuildMode, runFullBuild, runResumeBuild } from "./pipeline.js";
import { GRAPH_VERSION } from "./wrap.js";

class FakeBuilder {
  nodes: any[] = [];
  edges: any[] = [];
  constructor(public project: string, public git: string) {}
  addFile(path: string) {
    this.nodes.push({ id: path, type: "file", filePath: path });
  }
  addFileWithAnalysis(path: string) {
    this.nodes.push({ id: path, type: "file", filePath: path });
  }
  addNonCodeFileWithAnalysis() {}
  addCallEdge() {}
  addImportEdge(source: string, target: string) {
    this.edges.push({ type: "imports", source, target });
  }
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

describe("runFullBuild (orchestration)", () => {
  it("wires all six phases and persists the validated graph", async () => {
    const { core, saved } = makeCore();

    const scanResult = {
      files: [{ path: "src/a.ts", fileCategory: "code", language: "ts" }],
      totalFiles: 1,
      stats: { byLanguage: { ts: 1 } },
    };
    const assembled = {
      nodes: [{ id: "src/a.ts", filePath: "src/a.ts" }],
      edges: [{ type: "imports", source: "src/a.ts", target: "src/b.ts" }],
    };
    const batches = { batches: [{ batchIndex: 1, files: scanResult.files, batchImportData: {} }] };

    const fileSystem: Record<string, string> = {
      "/repo/.understand-anything/intermediate/scan-result.json": JSON.stringify(scanResult),
      "/repo/.understand-anything/intermediate/batches.json": JSON.stringify(batches),
      "/repo/.understand-anything/intermediate/assembled-graph.json": JSON.stringify(assembled),
      "/repo/src/a.ts": "source",
    };
    const writes: Record<string, string> = {};

    const registry = {
      resolveImports: () => [],
      analyzeFile: () => ({ functions: [], classes: [] }),
      extractCallGraph: () => [],
    };

    const result = await runFullBuild(
      {
        core,
        skillDir: "/skill",
        projectRoot: "/repo",
        outputLanguage: "en",
        excludeTests: false,
        log: () => {},
      },
      {
        execFileSync: vi.fn() as any,
        ensureDirs: () => {},
        resolveGitHash: () => "deadbeef",
        createRegistry: async () => registry,
        existsSync: (p) => p in fileSystem || p in writes,
        readFileSync: (p) => {
          if (p in writes) return writes[p]!;
          const c = fileSystem[p];
          if (c === undefined) throw new Error(`missing ${p}`);
          return c;
        },
        writeFileSync: (p, d) => { writes[p] = d; },
      },
    );

    expect(result.gitHash).toBe("deadbeef");
    expect(result).not.toHaveProperty("mode");
    expect(result.graph.version).toBe(GRAPH_VERSION);
    expect(result.graph.layers).toEqual([{ name: "L" }]);
    expect(result.graph.edges).toHaveLength(1);

    // persisted via upstream core
    expect(saved.graph.root).toBe("/repo");
    expect(saved.meta.m.version).toBe(GRAPH_VERSION);
    expect(saved.meta.m.gitCommitHash).toBe("deadbeef");
    expect(saved.config.c).toMatchObject({ autoUpdate: false, outputLanguage: "en", excludeTests: false });
  });

  function fullBuildFixture() {
    const { core } = makeCore();
    const scanResult = {
      files: [{ path: "src/a.ts", fileCategory: "code", language: "ts" }],
      totalFiles: 1,
      stats: { byLanguage: { ts: 1 } },
    };
    const assembled = {
      nodes: [{ id: "src/a.ts", filePath: "src/a.ts" }],
      edges: [],
    };
    const batches = { batches: [{ batchIndex: 1, files: scanResult.files, batchImportData: {} }] };
    const fileSystem: Record<string, string> = {
      "/repo/.understand-anything/intermediate/scan-result.json": JSON.stringify(scanResult),
      "/repo/.understand-anything/intermediate/batches.json": JSON.stringify(batches),
      "/repo/.understand-anything/intermediate/assembled-graph.json": JSON.stringify(assembled),
      "/repo/src/a.ts": "source",
    };
    const writes: Record<string, string> = {};
    const registry = {
      resolveImports: () => [],
      analyzeFile: () => ({ functions: [], classes: [] }),
      extractCallGraph: () => [],
    };
    const deps = {
      execFileSync: vi.fn() as any,
      ensureDirs: () => {},
      mkdirSync: () => {},
      resolveGitHash: () => "deadbeef",
      createRegistry: async () => registry,
      existsSync: (p: string) => p in fileSystem || p in writes,
      readFileSync: (p: string) => {
        if (p in writes) return writes[p]!;
        const c = fileSystem[p];
        if (c === undefined) throw new Error(`missing ${p}`);
        return c;
      },
      writeFileSync: (p: string, d: string) => { writes[p] = d; },
    };
    return { core, deps, writes };
  }

  it("does not run llm analysis by default", async () => {
    const { core, deps } = fullBuildFixture();
    const runLlm = vi.fn();

    await runFullBuild(
      { core, skillDir: "/skill", projectRoot: "/repo", outputLanguage: "en", log: () => {} },
      { ...deps, runLlmFileAnalysis: runLlm as any },
    );

    expect(runLlm).not.toHaveBeenCalled();
  });

    it("uses scanRoot for full-mode LLM file analysis when source mirror differs from analysisRoot", async () => {
      const { core } = makeCore();
      const scanResult = {
        files: [{ path: "src/a.ts", fileCategory: "code", language: "ts" }],
        totalFiles: 1,
        stats: { byLanguage: { ts: 1 } },
      };
      const batches = { batches: [{ batchIndex: 1, files: scanResult.files, batchImportData: {} }] };
      const assembled = { nodes: [{ id: "src/a.ts", filePath: "src/a.ts" }], edges: [] };
      const fs: Record<string, string> = {
        "/state/.understand-anything/intermediate/scan-result.json": JSON.stringify(scanResult),
        "/state/.understand-anything/intermediate/batches.json": JSON.stringify(batches),
        "/state/.understand-anything/intermediate/assembled-graph.json": JSON.stringify(assembled),
        "/mirror/src/a.ts": "source from mirror",
      };
      const writes: Record<string, string> = {};
      const runLlm = vi.fn().mockResolvedValue({
        analyses: new Map(),
        stats: { enabled: true, requested: 1, analyzed: 0, failed: 0, skipped: 0, failures: [] },
      });

      await runFullBuild(
        {
          core,
          skillDir: "/skill",
          projectRoot: "/repo",
          analysisRoot: "/state",
          scanRoot: "/mirror",
          outputLanguage: "en",
          llm: { enabled: true, required: false, provider: { name: "fake", complete: async () => ({ text: "ok" }) } },
          log: () => {},
        } as any,
        {
          execFileSync: vi.fn() as any,
          ensureDirs: () => {},
          resolveGitHash: () => "abc",
          createRegistry: async () => ({
            resolveImports: () => [],
            analyzeFile: () => ({ functions: [], classes: [] }),
            extractCallGraph: () => [],
          }),
          existsSync: (p: string) => p in fs || p in writes,
          readFileSync: (p: string) => {
            const c = writes[p] ?? fs[p];
            if (c === undefined) throw new Error(`missing ${p}`);
            return c;
          },
          writeFileSync: (p: string, d: string) => { writes[p] = d; },
          mkdirSync: vi.fn(),
          readdirSync: vi.fn().mockReturnValue([{ name: "src" }]) as any,
          rmSync: vi.fn(),
          symlinkSync: vi.fn(),
          runLlmFileAnalysis: runLlm as any,
        } as any,
      );

      expect(runLlm).toHaveBeenCalledOnce();
      expect(runLlm.mock.calls[0]![0].analysisRoot).toBe("/mirror");
    });

  it("runs llm analysis when enabled and writes latest stats", async () => {
    const { core, deps, writes } = fullBuildFixture();
    const runLlm = vi.fn().mockResolvedValue({
      analyses: new Map([["src/a.ts", { fileSummary: "LLM", tags: [], complexity: "simple", functionSummaries: {}, classSummaries: {} }]]),
      stats: {
        enabled: true,
        providerName: "fake",
        requested: 1,
        analyzed: 1,
        failed: 0,
        skipped: 0,
        failures: [],
        modelGuards: [{ model: "small", action: "cooldown", kind: "overload", reason: "busy", cooldownUntil: 123 }],
      },
      artifacts: {
        promptStubs: [{ operation: "file-analysis", target: "src/a.ts", prompt: "file prompt" }],
        attemptJournal: [{ scope: "file", operation: "file-analysis", target: "src/a.ts", status: "ok", attempts: [{ attempt: 1, kind: "ok" }] }],
      },
    });

    await runFullBuild(
      {
        core,
        skillDir: "/skill",
        projectRoot: "/repo",
        outputLanguage: "en",
        llm: { enabled: true, required: false, provider: { name: "fake", complete: async () => ({ text: "ok" }) } },
        log: () => {},
      },
      { ...deps, runLlmFileAnalysis: runLlm as any },
    );

    expect(runLlm).toHaveBeenCalledOnce();
    const statsPath = "/repo/.understand-anything/llm/latest-stats.json";
    expect(writes[statsPath]).toBeDefined();
    expect(JSON.parse(writes[statsPath]!)).toMatchObject({ enabled: true, analyzed: 1 });
    const guardPath = "/repo/.understand-anything/llm/guard-metrics.json";
    expect(JSON.parse(writes[guardPath]!)).toMatchObject({ modelGuards: [{ model: "small", kind: "overload" }] });
    const journalPath = "/repo/.understand-anything/metrics/llm-attempts.ndjson";
    expect(writes[journalPath]).toContain("\"scope\":\"file\"");
    const promptPath = "/repo/.understand-anything/llm/prompts/01-file-analysis-src_a.ts.txt";
    expect(writes[promptPath]).toBe("file prompt");
  });

  it("runs graph-level llm enhancement after deterministic wrap and writes graph stats", async () => {
    const { core, deps, writes } = fullBuildFixture();
    const runLlm = vi.fn().mockResolvedValue({
      analyses: new Map(),
      stats: { enabled: true, providerName: "fake", requested: 1, analyzed: 1, failed: 0, skipped: 0, failures: [] },
    });
    const runGraphLlm = vi.fn().mockImplementation(async ({ graph }) => ({
      graph: {
        ...graph,
        layers: [{ id: "llm", name: "LLM", nodeIds: ["src/a.ts"] }],
        project: { ...graph.project, summary: "LLM project" },
        tour: [{ order: 1, title: "LLM tour" }],
      },
      stats: { enabled: true, providerName: "fake", requested: 3, applied: 3, failed: 0, skipped: 0, failures: [] },
      artifacts: {
        promptStubs: [
          { operation: "layers", prompt: "layer prompt" },
          { operation: "project-summary", prompt: "summary prompt" },
          { operation: "tour", prompt: "tour prompt" },
        ],
        attemptJournal: [
          { scope: "graph", operation: "layers", status: "ok", attempts: [{ attempt: 1, kind: "ok" }] },
          { scope: "graph", operation: "project-summary", status: "ok", attempts: [{ attempt: 1, kind: "ok" }] },
        ],
      },
    }));

    const result = await runFullBuild(
      {
        core,
        skillDir: "/skill",
        projectRoot: "/repo",
        outputLanguage: "en",
        llm: { enabled: true, required: false, provider: { name: "fake", complete: async () => ({ text: "ok" }) } },
        log: () => {},
      },
      { ...deps, runLlmFileAnalysis: runLlm as any, runLlmGraphEnhancement: runGraphLlm as any },
    );

    expect(runGraphLlm).toHaveBeenCalledOnce();
    expect(runGraphLlm.mock.calls[0]![0].graph.layers).toEqual([{ name: "L" }]);
    expect(result.graph.layers).toEqual([{ id: "llm", name: "LLM", nodeIds: ["src/a.ts"] }]);
    expect(result.graph.project.summary).toBe("LLM project");
    expect(result.graph.tour).toEqual([{ order: 1, title: "LLM tour" }]);
    const graphStatsPath = "/repo/.understand-anything/llm/latest-graph-stats.json";
    expect(JSON.parse(writes[graphStatsPath]!)).toMatchObject({ enabled: true, applied: 3 });
    const layersPath = "/repo/.understand-anything/llm/layers.json";
    expect(JSON.parse(writes[layersPath]!)).toMatchObject({
      layers: [{ id: "llm", name: "LLM", nodeIds: ["src/a.ts"] }],
    });
    const summaryPath = "/repo/.understand-anything/llm/project-summary.json";
    expect(JSON.parse(writes[summaryPath]!)).toMatchObject({
      summary: "LLM project",
    });
    expect(writes["/repo/.understand-anything/llm/prompts/01-layers.txt"]).toBe("layer prompt");
    expect(writes["/repo/.understand-anything/llm/prompts/02-project-summary.txt"]).toBe("summary prompt");
  });

  it("writes embeddings.json when an embedding provider is enabled", async () => {
    const { core, deps, writes } = fullBuildFixture();
    const embedBatch = vi.fn().mockResolvedValue([[1, 0, 0.5]]);

    await runFullBuild(
      {
        core,
        skillDir: "/skill",
        projectRoot: "/repo",
        outputLanguage: "en",
        embedding: {
          enabled: true,
          provider: {
            name: "fake-embedding",
            embed: async () => [1, 0, 0.5],
            embedBatch,
          },
        },
        log: () => {},
      } as any,
      deps as any,
    );

    expect(embedBatch).toHaveBeenCalledOnce();
    expect(JSON.parse(writes["/repo/.understand-anything/embeddings.json"]!)).toEqual({
      "src/a.ts": [1, 0, 0.5],
    });
  });

  it("fails when llm is required and provider fails", async () => {
    const { core, deps } = fullBuildFixture();
    const runLlm = vi.fn().mockRejectedValue(new Error("provider down"));

    await expect(
      runFullBuild(
        {
          core,
          skillDir: "/skill",
          projectRoot: "/repo",
          outputLanguage: "en",
          llm: { enabled: true, required: true },
          log: () => {},
        },
        { ...deps, runLlmFileAnalysis: runLlm as any },
      ),
    ).rejects.toThrow(/provider down/);
  });

  it("throws when the merge phase produced no assembled graph", async () => {
    const { core } = makeCore();
    const scanResult = { files: [], totalFiles: 0, stats: { byLanguage: {} } };
    const batches = { batches: [] };
    const fs: Record<string, string> = {
      "/repo/.understand-anything/intermediate/scan-result.json": JSON.stringify(scanResult),
      "/repo/.understand-anything/intermediate/batches.json": JSON.stringify(batches),
    };

    await expect(
      runFullBuild(
        { core, skillDir: "/skill", projectRoot: "/repo", log: () => {} },
        {
          execFileSync: vi.fn() as any,
          ensureDirs: () => {},
          resolveGitHash: () => "x",
          createRegistry: async () => ({ resolveImports: () => [] }),
          existsSync: () => false,
          readFileSync: (p) => {
            const c = fs[p];
            if (c === undefined) throw new Error(`missing ${p}`);
            return c;
          },
          writeFileSync: () => {},
        },
      ),
    ).rejects.toThrow(/did not produce/);
  });

  it("throws when graph validation fails", async () => {
    const { core } = makeCore();
    core.validateGraph = () => ({ success: false, fatal: "bad graph", data: undefined }) as any;
    const scanResult = { files: [], totalFiles: 0, stats: { byLanguage: {} } };
    const batches = { batches: [] };
    const assembled = { nodes: [], edges: [] };
    const fs: Record<string, string> = {
      "/repo/.understand-anything/intermediate/scan-result.json": JSON.stringify(scanResult),
      "/repo/.understand-anything/intermediate/batches.json": JSON.stringify(batches),
      "/repo/.understand-anything/intermediate/assembled-graph.json": JSON.stringify(assembled),
    };
    await expect(
      runFullBuild(
        { core, skillDir: "/skill", projectRoot: "/repo", log: () => {} },
        {
          execFileSync: vi.fn() as any,
          ensureDirs: () => {},
          resolveGitHash: () => "x",
          createRegistry: async () => ({ resolveImports: () => [] }),
          existsSync: () => true,
          readFileSync: (p) => {
            const c = fs[p];
            if (c === undefined) throw new Error(`missing ${p}`);
            return c;
          },
          writeFileSync: () => {},
        },
      ),
    ).rejects.toThrow(/graph validation failed: bad graph/);
  });

  it("uses a distinct scanRoot and symlink farm for compute-batches", async () => {
    const { core } = makeCore();
    const scanResult = {
      files: [{ path: "src/a.ts", fileCategory: "code", language: "ts" }],
      totalFiles: 1,
      stats: { byLanguage: { ts: 1 } },
    };
    const batches = {
      batches: [{ batchIndex: 1, files: scanResult.files, batchImportData: {} }],
    };
    const assembled = { nodes: [{ id: "src/a.ts", filePath: "src/a.ts" }], edges: [] };
    const fs: Record<string, string> = {
      "/state/.understand-anything/intermediate/scan-result.json": JSON.stringify(scanResult),
      "/state/.understand-anything/intermediate/batches.json": JSON.stringify(batches),
      "/state/.understand-anything/intermediate/assembled-graph.json": JSON.stringify(assembled),
      "/mirror/src/a.ts": "source",
    };
    const writes: Record<string, string> = {};
    const execFileSync = vi.fn();
    const symlinkSync = vi.fn();
    const readdirSync = vi.fn().mockReturnValue([
      { name: ".understand-anything" },
      { name: "dashboard-dist" },
      { name: "src" },
    ]);

    await runFullBuild(
      {
        core,
        skillDir: "/skill",
        projectRoot: "/repo",
        analysisRoot: "/state",
        scanRoot: "/mirror",
        outputLanguage: "en",
        log: () => {},
      } as any,
      {
        execFileSync: execFileSync as any,
        ensureDirs: () => {},
        resolveGitHash: () => "abc",
        createRegistry: async () => ({
          resolveImports: () => [],
          analyzeFile: () => ({ functions: [], classes: [] }),
          extractCallGraph: () => [],
        }),
        existsSync: (p: string) => p in fs || p in writes,
        readFileSync: (p: string) => {
          const c = writes[p] ?? fs[p];
          if (c === undefined) throw new Error(`missing ${p}`);
          return c;
        },
        writeFileSync: (p: string, d: string) => { writes[p] = d; },
        mkdirSync: vi.fn(),
        rmSync: vi.fn(),
        readdirSync: readdirSync as any,
        symlinkSync: symlinkSync as any,
      } as any,
    );

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      ["/skill/scan-project.mjs", "/mirror", "/state/.understand-anything/intermediate/scan-result.json"],
      expect.anything(),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      ["/skill/compute-batches.mjs", "/state/.understand-anything/tmp/compute-batches-root"],
      expect.anything(),
    );
    expect(symlinkSync).toHaveBeenCalledWith("/state/.understand-anything", "/state/.understand-anything/tmp/compute-batches-root/.understand-anything", "dir");
    expect(symlinkSync).toHaveBeenCalledWith("/mirror/src", "/state/.understand-anything/tmp/compute-batches-root/src");
  });

  it("resume validates checkpoint before reusing existing scan/batches", async () => {
    const { core } = makeCore();
    const runFull = vi.fn();
    const runResume = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: "/repo" },
    });

    const result = await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "resume", log: () => {} },
      {
        runFullBuild: runFull as any,
        runResumeBuild: runResume as any,
        validateCheckpoint: () => ({ manifest: {} as any, batches: [], batchIndexes: [] }),
      } as any,
    );

    expect(result.mode).toBe("resume");
    expect(runResume).toHaveBeenCalledOnce();
    expect(runFull).not.toHaveBeenCalled();
  });

  it("resume passes git and build settings into checkpoint validation", async () => {
    const { core } = makeCore();
    const validateCheckpoint = vi.fn().mockReturnValue({ manifest: {} as any, batches: [], batchIndexes: [] });
    const fs: Record<string, string> = {
      "/repo/.understand-anything/intermediate/scan-result.json": JSON.stringify({ files: [], totalFiles: 0 }),
      "/repo/.understand-anything/intermediate/assembled-graph.json": JSON.stringify({ nodes: [], edges: [] }),
    };
    const writes: Record<string, string> = {};

    await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "resume", outputLanguage: "zh", excludeTests: true, log: () => {} },
      {
        existsSync: (p: string) => p in fs || p in writes,
        readFileSync: (p: string) => {
          const c = writes[p] ?? fs[p];
          if (c === undefined) throw new Error(`missing ${p}`);
          return c;
        },
        writeFileSync: (p: string, d: string) => { writes[p] = d; },
        ensureDirs: () => {},
        execFileSync: vi.fn() as any,
        resolveGitHash: () => "head123",
        resolveGitDirty: () => true,
        createRegistry: async () => ({
          resolveImports: () => [],
          analyzeFile: () => ({ functions: [], classes: [] }),
          extractCallGraph: () => [],
        }),
        validateCheckpoint,
      } as any,
    );

    expect(validateCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      expected: {
        sourceGitCommit: "head123",
        sourceDirty: true,
        outputLanguage: "zh",
        excludeTests: true,
      },
    }));
  });

  it("resume replays incremental batches and merges only changed files", async () => {
    const { core } = makeCore();
    const fs: Record<string, string> = {
      "/repo/.understand-anything/intermediate/scan-result.json": JSON.stringify({ files: [], totalFiles: 0 }),
      "/repo/.understand-anything/intermediate/batch-1.json": JSON.stringify({
        nodes: [{ id: "new", filePath: "src/a.ts" }],
        edges: [{ from: "new", to: "dep", type: "imports" }],
      }),
      "/repo/.understand-anything/knowledge-graph.json": JSON.stringify({
        nodes: [{ id: "old", filePath: "src/b.ts" }],
        edges: [],
        project: { gitCommitHash: "base123" },
      }),
      "/repo/.understand-anything/meta.json": JSON.stringify({ gitCommitHash: "base123" }),
    };
    const writes: Record<string, string> = {};

    const result = await runResumeBuild(
      { core, skillDir: "/skill", projectRoot: "/repo", log: () => {} },
      {
        existsSync: (p: string) => p in fs || p in writes,
        readFileSync: (p: string) => {
          const c = writes[p] ?? fs[p];
          if (c === undefined) throw new Error(`missing ${p}`);
          return c;
        },
        writeFileSync: (p: string, d: string) => { writes[p] = d; },
        ensureDirs: () => {},
        execFileSync: vi.fn() as any,
        resolveGitHash: () => "head999",
        resolveGitDirty: () => false,
        createRegistry: async () => ({
          resolveImports: () => [],
          analyzeFile: () => ({ functions: [], classes: [] }),
          extractCallGraph: () => [],
        }),
        validateCheckpoint: () => ({
          manifest: { buildKind: "incremental", baseGraphCommit: "base123", changedFiles: ["src/a.ts"] } as any,
          batches: [{ batchIndex: 1, files: [{ path: "src/a.ts" }] }],
          batchIndexes: [1],
        }),
      } as any,
    );

    expect(result.updatedFiles).toEqual(["src/a.ts"]);
    expect(result.analyzedFiles).toBe(1);
  });

  it("incremental fails when existing graph is missing", async () => {
    const { core } = makeCore();
    const runFull = vi.fn();

    await expect(
      runBuildMode(
        { core, skillDir: "/skill", projectRoot: "/repo", mode: "incremental", log: () => {} },
        { runFullBuild: runFull as any, existsSync: () => false } as any,
      ),
    ).rejects.toThrow(/run full build explicitly/);

    expect(runFull).not.toHaveBeenCalled();
  });

  it("incremental aborts when existing graph.version != current GRAPH_VERSION", async () => {
    // P1-6 contract: an incompatible graph format must abort, NOT silently
    // fall through into mergeGraphPartialUpdate (which would produce a dirty
    // graph). The operator is told to run a full build to regenerate.
    const { core } = makeCore();
    const getChangedFiles = vi.fn().mockReturnValue(["src/a.ts"]);
    (core as any).getChangedFiles = getChangedFiles;
    const fs: Record<string, string> = {
      "/repo/.understand-anything/knowledge-graph.json": JSON.stringify({
        version: "understand-local-batched-0",  // stale format
        project: { gitCommitHash: "base123" },
        nodes: [],
        edges: [],
      }),
    };

    await expect(
      runBuildMode(
        { core, skillDir: "/skill", projectRoot: "/repo", mode: "incremental", log: () => {} },
        {
          existsSync: (p: string) => p in fs,
          readFileSync: (p: string) => {
            const c = fs[p];
            if (c === undefined) throw new Error(`missing ${p}`);
            return c;
          },
          writeFileSync: () => {},
          execFileSync: vi.fn() as any,
          resolveGitHash: () => "head456",
        } as any,
      ),
    ).rejects.toThrow(/existing graph version 'understand-local-batched-0'.*GRAPH_VERSION 'understand-local-batched-1'.*Run a full build/);

    // Confirms the abort happens before getChangedFiles / batch logic runs.
    expect(getChangedFiles).not.toHaveBeenCalled();
  });

  it("incremental runs partial update without calling full build", async () => {
    const { core } = makeCore();
    const runFull = vi.fn();
    const runPartial = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 1,
      paths: { stateRoot: "/repo" },
      updatedFiles: ["src/a.ts"],
    });

    const result = await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "incremental", log: () => {} },
      { runFullBuild: runFull as any, runPartialUpdate: runPartial as any, existsSync: () => true } as any,
    );

    expect(result.mode).toBe("incremental");
    expect(result.updatedFiles).toEqual(["src/a.ts"]);
    expect(runFull).not.toHaveBeenCalled();
  });

  it("backfill without include paths still runs partial update", async () => {
    const { core } = makeCore();
    const runFull = vi.fn();
    const runPartial = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 1,
      paths: { stateRoot: "/repo" },
      updatedFiles: ["src/new.ts"],
    });

    const result = await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "backfill", includePaths: [], log: () => {} },
      { runFullBuild: runFull as any, runPartialUpdate: runPartial as any, existsSync: () => true } as any,
    );

    expect(result.mode).toBe("backfill");
    expect(result.updatedFiles).toEqual(["src/new.ts"]);
    expect(runFull).not.toHaveBeenCalled();
  });

  it("backfill runs partial update without calling full build", async () => {
    const { core } = makeCore();
    const runFull = vi.fn();
    const runPartial = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 1,
      paths: { stateRoot: "/repo" },
      updatedFiles: ["src/a.ts"],
    });

    const result = await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "backfill", includePaths: ["src/a.ts"], log: () => {} },
      { runFullBuild: runFull as any, runPartialUpdate: runPartial as any, existsSync: () => true } as any,
    );

    expect(result.mode).toBe("backfill");
    expect(runFull).not.toHaveBeenCalled();
  });

  it("incremental uses upstream getChangedFiles from the existing graph commit", async () => {
    const { core, saved } = makeCore();
    const getChangedFiles = vi.fn().mockReturnValue(["src/a.ts"]);
    (core as any).getChangedFiles = getChangedFiles;
    const fs: Record<string, string> = {
      "/repo/.understand-anything/knowledge-graph.json": JSON.stringify({
        project: { gitCommitHash: "base123" },
        nodes: [
          { id: "src/a.ts", type: "file", filePath: "src/a.ts" },
          { id: "src/b.ts", type: "file", filePath: "src/b.ts" },
        ],
        edges: [],
      }),
      "/repo/.understand-anything/intermediate/scan-result.json": JSON.stringify({
        files: [{ path: "src/a.ts" }],
        totalFiles: 1,
      }),
      "/repo/.understand-anything/intermediate/batches.json": JSON.stringify({
        batches: [{ batchIndex: 1, files: [{ path: "src/a.ts" }] }],
      }),
      "/repo/.understand-anything/intermediate/phase2-input-manifest.json": JSON.stringify({
        batchesSha256: "skip",
        batchCount: 1,
      }),
      "/repo/.understand-anything/intermediate/batch-1.json": JSON.stringify({
        nodes: [{ id: "src/a.ts", type: "file", filePath: "src/a.ts" }],
        edges: [],
      }),
      "/repo/src/a.ts": "source",
    };
    const writes: Record<string, string> = {};
    const execFileSync = vi.fn();

    const result = await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "incremental", log: () => {} },
      {
        existsSync: (p: string) => p in fs || p in writes,
        readFileSync: (p: string) => {
          const c = writes[p] ?? fs[p];
          if (c === undefined) throw new Error(`missing ${p}`);
          return c;
        },
        writeFileSync: (p: string, d: string) => { writes[p] = d; },
        execFileSync: execFileSync as any,
        resolveGitHash: () => "head456",
        createRegistry: async () => ({
          resolveImports: () => [],
          analyzeFile: () => ({ functions: [], classes: [] }),
          extractCallGraph: () => [],
        }),
        validateCheckpoint: () => ({
          manifest: {} as any,
          batches: [{ batchIndex: 1, files: [{ path: "src/a.ts" }] }],
          batchIndexes: [1],
        }),
      } as any,
    );

    expect(getChangedFiles).toHaveBeenCalledWith("/repo", "base123");
    expect(execFileSync).not.toHaveBeenCalledWith("git", ["diff", "--name-only", "HEAD"], expect.anything());
    expect(result.updatedFiles).toEqual(["src/a.ts"]);
    expect(saved.meta.m.gitCommitHash).toBe("head456");
  });

  it("incremental handles deletion-only changes by merging an empty update graph", async () => {
    const { core, saved } = makeCore();
    (core as any).getChangedFiles = vi.fn().mockReturnValue(["src/deleted.ts"]);
    const fs: Record<string, string> = {
      "/repo/.understand-anything/knowledge-graph.json": JSON.stringify({
        project: { gitCommitHash: "base123" },
        nodes: [
          { id: "src/deleted.ts", type: "file", filePath: "src/deleted.ts" },
          { id: "src/deleted.ts#fn", type: "function", filePath: "src/deleted.ts" },
          { id: "src/kept.ts", type: "file", filePath: "src/kept.ts" },
        ],
        edges: [
          { type: "contains", source: "src/deleted.ts", target: "src/deleted.ts#fn" },
          { type: "imports", source: "src/kept.ts", target: "src/deleted.ts" },
        ],
      }),
      "/repo/.understand-anything/intermediate/batches.json": JSON.stringify({
        batches: [{ batchIndex: 1, files: [{ path: "src/kept.ts" }] }],
      }),
      "/repo/.understand-anything/intermediate/phase2-input-manifest.json": JSON.stringify({
        batchesSha256: "skip",
        batchCount: 1,
      }),
      "/repo/src/kept.ts": "source",
    };
    const writes: Record<string, string> = {};
    const execFileSync = vi.fn();

    const result = await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "incremental", log: () => {} },
      {
        existsSync: (p: string) => p in fs || p in writes,
        readFileSync: (p: string) => {
          const c = writes[p] ?? fs[p];
          if (c === undefined) throw new Error(`missing ${p}`);
          return c;
        },
        writeFileSync: (p: string, d: string) => { writes[p] = d; },
        execFileSync: execFileSync as any,
        resolveGitHash: () => "head456",
        createRegistry: async () => {
          throw new Error("deletion-only incremental should not analyze batches");
        },
        validateCheckpoint: () => ({
          manifest: {} as any,
          batches: [{ batchIndex: 1, files: [{ path: "src/kept.ts" }] }],
          batchIndexes: [1],
        }),
      } as any,
    );

    expect(result.updatedFiles).toEqual(["src/deleted.ts"]);
    expect(saved.graph.g.nodes.map((node: any) => node.id)).toEqual(["src/kept.ts"]);
    expect(saved.graph.g.edges).toEqual([]);
    expect(saved.meta.m.gitCommitHash).toBe("head456");
  });

  it("backfill auto-detects missing code files in an isolated workspace", async () => {
    const { core, saved } = makeCore();
    const fs: Record<string, string> = {
      "/repo/.understand-anything/knowledge-graph.json": JSON.stringify({
        project: { gitCommitHash: "base123" },
        nodes: [
          { id: "src/old.ts", type: "file", filePath: "src/old.ts" },
        ],
        edges: [],
      }),
      "/repo/src/old.ts": "export const oldValue = 1;\n",
      "/repo/src/new.ts": "export const newValue = 2;\n",
      "/tmp/ua-backfill-1/workspace/src/old.ts": "export const oldValue = 1;\n",
      "/tmp/ua-backfill-1/workspace/src/new.ts": "export const newValue = 2;\n",
    };
    const writes: Record<string, string> = {};
    const cpSync = vi.fn();
    const rmSync = vi.fn();
    const execFileSync = vi.fn((cmd: string, args: string[]) => {
      const script = args[0] ?? "";
      const root = args[1] ?? "";
      if (script.endsWith("scan-project.mjs")) {
        writes[`${root}/.understand-anything/intermediate/scan-result.json`] = JSON.stringify({
          files: [
            { path: "src/old.ts", fileCategory: "code", language: "ts" },
            { path: "src/new.ts", fileCategory: "code", language: "ts" },
            { path: "README.md", fileCategory: "document", language: "md" },
          ],
          totalFiles: 3,
          stats: { byLanguage: { ts: 2, md: 1 } },
        });
        return Buffer.from("");
      }
      if (script.endsWith("compute-batches.mjs")) {
        writes[`${root}/.understand-anything/intermediate/batches.json`] = JSON.stringify({
          batches: [
            {
              batchIndex: 1,
              files: [
                { path: "src/old.ts", fileCategory: "code", language: "ts" },
                { path: "README.md", fileCategory: "document", language: "md" },
              ],
            },
            { batchIndex: 2, files: [{ path: "src/new.ts", fileCategory: "code", language: "ts" }] },
          ],
        });
        return Buffer.from("");
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    });

    const result = await runBuildMode(
      { core, skillDir: "/skill", projectRoot: "/repo", mode: "backfill", includePaths: [], log: () => {} },
      {
        existsSync: (p: string) => p in fs || p in writes || p === "/tmp/ua-backfill-1",
        readFileSync: (p: string) => {
          const c = writes[p] ?? fs[p];
          if (c === undefined) throw new Error(`missing ${p}`);
          return c;
        },
        writeFileSync: (p: string, d: string) => { writes[p] = d; },
        execFileSync: execFileSync as any,
        resolveGitHash: () => "head456",
        createRegistry: async () => ({
          resolveImports: () => [],
          analyzeFile: () => ({ functions: [], classes: [] }),
          extractCallGraph: () => [],
        }),
        mkdirSync: () => {},
        mkdtempSync: () => "/tmp/ua-backfill-1",
        cpSync: cpSync as any,
        rmSync: rmSync as any,
        tmpdir: () => "/tmp",
      } as any,
    );

    expect(cpSync).toHaveBeenCalledWith("/repo", "/tmp/ua-backfill-1/workspace", expect.objectContaining({
      recursive: true,
      dereference: false,
    }));
    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      ["/skill/scan-project.mjs", "/tmp/ua-backfill-1/workspace", "/tmp/ua-backfill-1/workspace/.understand-anything/intermediate/scan-result.json"],
      expect.anything(),
    );
    expect(result.updatedFiles).toEqual(["src/new.ts"]);
    expect(saved.graph.g.nodes.map((node: any) => node.id)).toEqual(expect.arrayContaining(["src/old.ts", "src/new.ts"]));
    expect(rmSync).toHaveBeenCalledWith("/tmp/ua-backfill-1", { recursive: true, force: true });
  });
});
