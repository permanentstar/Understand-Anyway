import { describe, expect, it, vi } from "vitest";
import { GRAPH_VERSION, wrapAsKnowledgeGraph } from "./wrap.js";

describe("wrapAsKnowledgeGraph", () => {
  const base = {
    scan: { stats: { byLanguage: { ts: 3, "": 0 } }, totalFiles: 3 },
    assembled: {
      nodes: [{ id: "a" }],
      edges: [
        { type: "imports", source: "a", target: "b" },
        { type: "imports", source: "a", target: "b" },
      ],
    },
    projectName: "p",
    gitHash: "abc",
    outputLanguage: "en",
  };

  it("assembles the graph, dedupes edges, and applies deterministic phases", () => {
    const core = {
      detectLayers: vi.fn(() => [{ name: "L" }]),
      generateHeuristicTour: vi.fn(() => [{ order: 1 }]),
    };
    const graph = wrapAsKnowledgeGraph({ ...base, core });
    expect(graph.version).toBe(GRAPH_VERSION);
    expect(graph.kind).toBe("codebase");
    expect(graph.project.languages).toEqual(["ts"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.layers).toEqual([{ name: "L" }]);
    expect(graph.tour).toEqual([{ order: 1 }]);
    expect(core.detectLayers).toHaveBeenCalledOnce();
  });

  it("falls back to empty layers/tour when core lacks the functions", () => {
    const graph = wrapAsKnowledgeGraph({ ...base, core: {} });
    expect(graph.layers).toEqual([]);
    expect(graph.tour).toEqual([]);
  });

  it("falls back to empty arrays when a phase throws", () => {
    const core = {
      detectLayers: () => { throw new Error("x"); },
      generateHeuristicTour: () => { throw new Error("y"); },
    };
    const graph = wrapAsKnowledgeGraph({ ...base, core });
    expect(graph.layers).toEqual([]);
    expect(graph.tour).toEqual([]);
  });
});
