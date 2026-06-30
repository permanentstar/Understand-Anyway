import { describe, expect, it } from "vitest";
import { writeBatchGraphFiles } from "./batch-graph.js";

class FakeBuilder {
  nodes: any[] = [];
  edges: any[] = [];
  fileAnalysisOptions: Record<string, any> = {};
  constructor(public project: string, public git: string) {}
  addFileWithAnalysis(path: string, _analysis: any, opts?: any) {
    this.nodes.push({ id: path, type: "file" });
    this.fileAnalysisOptions[path] = opts;
  }
  addFile(path: string) {
    this.nodes.push({ id: path, type: "file" });
  }
  addNonCodeFileWithAnalysis(path: string, opts: { nodeType: string }) {
    this.nodes.push({ id: path, type: opts.nodeType });
  }
  addCallEdge(sf: string, c: string, tf: string, ce: string) {
    this.edges.push({ type: "calls", source: `${sf}#${c}`, target: `${tf}#${ce}` });
  }
  addImportEdge(source: string, target: string) {
    this.edges.push({ type: "imports", source, target });
  }
  build() {
    return { nodes: this.nodes, edges: this.edges };
  }
}

const fakeCore = { GraphBuilder: FakeBuilder };

function fakeRegistry() {
  return {
    analyzeFile() {
      return { functions: [{ name: "f" }], classes: [] };
    },
    extractCallGraph() {
      return [{ caller: "f", callee: "f" }];
    },
  };
}

describe("writeBatchGraphFiles", () => {
  it("writes one artifact per non-empty batch with import + call edges", () => {
    const writes: Record<string, any> = {};
    const result = writeBatchGraphFiles(
      {
        core: fakeCore,
        registry: fakeRegistry(),
        analysisRoot: "/repo",
        intermediateDir: "/repo/.understand-anything/intermediate",
        batches: [
          {
            batchIndex: 1,
            files: [{ path: "src/a.ts", fileCategory: "code", language: "ts" }],
            batchImportData: { "src/a.ts": ["src/b.ts"] },
          },
        ],
        outputLanguage: "en",
        projectName: "p",
        gitHash: "abc",
        log: () => {},
      },
      {
        readFileSync: () => "content",
        writeFileSync: (p, d) => { writes[p] = JSON.parse(d); },
      },
    );

    expect(result).toEqual({ written: 1, analyzed: 1 });
    const artifact = writes["/repo/.understand-anything/intermediate/batch-1.json"];
    expect(artifact.nodes).toHaveLength(1);
    expect(artifact.edges).toEqual([
      { type: "calls", source: "src/a.ts#f", target: "src/a.ts#f" },
      { type: "imports", source: "src/a.ts", target: "src/b.ts" },
    ]);
  });

  it("skips batches where no file analyzes successfully", () => {
    const writes: Record<string, any> = {};
    const result = writeBatchGraphFiles(
      {
        core: fakeCore,
        registry: {
          analyzeFile() { throw new Error("boom"); },
        },
        analysisRoot: "/repo",
        intermediateDir: "/i",
        batches: [{ batchIndex: 2, files: [{ path: "x.ts", fileCategory: "code" }] }],
        outputLanguage: "en",
        projectName: "p",
        gitHash: "abc",
        log: () => {},
      },
      { readFileSync: () => "c", writeFileSync: (p, d) => { writes[p] = d; } },
    );
    expect(result).toEqual({ written: 0, analyzed: 0 });
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it("prefers LLM analysis over deterministic summaries without changing topology", () => {
    const builders: FakeBuilder[] = [];
    class CapturingBuilder extends FakeBuilder {
      constructor(project: string, git: string) {
        super(project, git);
        builders.push(this);
      }
    }
    const writes: Record<string, any> = {};
    const result = writeBatchGraphFiles(
      {
        core: { GraphBuilder: CapturingBuilder },
        registry: fakeRegistry(),
        analysisRoot: "/repo",
        intermediateDir: "/i",
        batches: [
          {
            batchIndex: 1,
            files: [{ path: "src/a.ts", fileCategory: "code", language: "ts" }],
            batchImportData: { "src/a.ts": ["src/b.ts"] },
          },
        ],
        outputLanguage: "en",
        projectName: "p",
        gitHash: "abc",
        log: () => {},
        llmAnalyses: new Map([
          ["src/a.ts", {
            fileSummary: "LLM summary",
            tags: ["llm"],
            complexity: "complex",
            functionSummaries: { f: "LLM f" },
            classSummaries: {},
          }],
        ]),
      },
      { readFileSync: () => "content", writeFileSync: (p, d) => { writes[p] = JSON.parse(d); } },
    );

    expect(result).toEqual({ written: 1, analyzed: 1 });
    const opts = builders[0]?.fileAnalysisOptions["src/a.ts"];
    expect(opts.fileSummary).toBe("LLM summary");
    expect(opts.summary).toBe("LLM summary");
    expect(opts.tags).toEqual(["llm"]);
    expect(opts.complexity).toBe("complex");
    expect(opts.summaries).toEqual({ f: "LLM f" });
    // Topology unchanged: same nodes/edges as the deterministic path.
    const artifact = writes["/i/batch-1.json"];
    expect(artifact.nodes).toHaveLength(1);
    expect(artifact.edges).toEqual([
      { type: "calls", source: "src/a.ts#f", target: "src/a.ts#f" },
      { type: "imports", source: "src/a.ts", target: "src/b.ts" },
    ]);
  });
});
