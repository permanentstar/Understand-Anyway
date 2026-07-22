import { describe, expect, it } from "vitest";
import { mergeGraphPartialUpdate } from "./graph-update.js";

describe("mergeGraphPartialUpdate", () => {
  it("replaces affected file-owned nodes and their attached edges", () => {
    const existing = {
      nodes: [
        { id: "src/a.ts", type: "file", filePath: "src/a.ts" },
        { id: "src/a.ts#old", type: "function", filePath: "src/a.ts" },
        { id: "src/b.ts", type: "file", filePath: "src/b.ts" },
      ],
      edges: [
        { type: "contains", source: "src/a.ts", target: "src/a.ts#old" },
        { type: "imports", source: "src/b.ts", target: "src/a.ts" },
      ],
    };
    const update = {
      nodes: [
        { id: "src/a.ts", type: "file", filePath: "src/a.ts" },
        { id: "src/a.ts#new", type: "function", filePath: "src/a.ts" },
      ],
      edges: [{ type: "contains", source: "src/a.ts", target: "src/a.ts#new" }],
    };

    const merged = mergeGraphPartialUpdate(existing, update, ["src/a.ts"]);

    expect(merged.nodes.map((n: any) => n.id).sort()).toEqual(["src/a.ts", "src/a.ts#new", "src/b.ts"]);
    expect(merged.edges).toEqual([{ type: "contains", source: "src/a.ts", target: "src/a.ts#new" }]);
  });

  it("dedupes re-emitted unchanged nodes while preserving edges from untouched files", () => {
    const existing = {
      nodes: [
        { id: "src/changed.ts", type: "file", filePath: "src/changed.ts" },
        { id: "src/changed.ts#old", type: "function", filePath: "src/changed.ts" },
        { id: "src/unchanged.ts", type: "file", filePath: "src/unchanged.ts" },
        { id: "class:src/unchanged.ts:Keep", type: "class", filePath: "src/unchanged.ts" },
        { id: "src/outside.ts", type: "file", filePath: "src/outside.ts" },
      ],
      edges: [
        { type: "contains", source: "src/changed.ts", target: "src/changed.ts#old" },
        { type: "contains", source: "src/unchanged.ts", target: "class:src/unchanged.ts:Keep" },
        { type: "imports", source: "src/outside.ts", target: "src/unchanged.ts" },
      ],
    };
    const update = {
      nodes: [
        { id: "src/changed.ts", type: "file", filePath: "src/changed.ts" },
        { id: "src/changed.ts#new", type: "function", filePath: "src/changed.ts" },
        { id: "src/unchanged.ts", type: "file", filePath: "src/unchanged.ts", summary: "fresh summary" },
        { id: "class:src/unchanged.ts:Keep", type: "class", filePath: "src/unchanged.ts", summary: "fresh class summary" },
      ],
      edges: [
        { type: "contains", source: "src/changed.ts", target: "src/changed.ts#new" },
        { type: "contains", source: "src/unchanged.ts", target: "class:src/unchanged.ts:Keep" },
      ],
    };

    const merged = mergeGraphPartialUpdate(existing, update, ["src/changed.ts"]);
    const ids = merged.nodes.map((node: any) => node.id);

    expect(ids.filter((id: string) => id === "src/changed.ts")).toHaveLength(1);
    expect(ids.filter((id: string) => id === "src/unchanged.ts")).toHaveLength(1);
    expect(ids.filter((id: string) => id === "class:src/unchanged.ts:Keep")).toHaveLength(1);
    expect(ids).not.toContain("src/changed.ts#old");
    expect(ids).toContain("src/changed.ts#new");
    expect(merged.edges).toEqual(expect.arrayContaining([
      { type: "imports", source: "src/outside.ts", target: "src/unchanged.ts" },
      { type: "contains", source: "src/changed.ts", target: "src/changed.ts#new" },
    ]));
  });

  it("dedupes historical existing nodes even when the update does not re-emit them", () => {
    const existing = {
      nodes: [
        { id: "src/changed.ts", type: "file", filePath: "src/changed.ts" },
        { id: "src/changed.ts#old", type: "function", filePath: "src/changed.ts" },
        { id: "src/historical.ts", type: "file", filePath: "src/historical.ts", summary: "old" },
        { id: "src/historical.ts", type: "file", filePath: "src/historical.ts", summary: "newer" },
        { id: "src/outside.ts", type: "file", filePath: "src/outside.ts" },
      ],
      edges: [
        { type: "imports", source: "src/outside.ts", target: "src/historical.ts" },
      ],
    };
    const update = {
      nodes: [
        { id: "src/changed.ts", type: "file", filePath: "src/changed.ts" },
        { id: "src/changed.ts#new", type: "function", filePath: "src/changed.ts" },
      ],
      edges: [
        { type: "contains", source: "src/changed.ts", target: "src/changed.ts#new" },
      ],
    };

    const merged = mergeGraphPartialUpdate(existing, update, ["src/changed.ts"]);
    const historicalNodes = merged.nodes.filter((node: any) => node.id === "src/historical.ts");

    expect(historicalNodes).toHaveLength(1);
    expect(historicalNodes[0]!.summary).toBe("newer");
    expect(merged.edges).toEqual(expect.arrayContaining([
      { type: "imports", source: "src/outside.ts", target: "src/historical.ts" },
    ]));
  });

  it("dedupes retained and update edges", () => {
    const merged = mergeGraphPartialUpdate(
      { nodes: [{ id: "a" }, { id: "b" }], edges: [{ type: "related", source: "a", target: "b" }] },
      { nodes: [], edges: [{ type: "related", source: "a", target: "b" }] },
      [],
    );
    expect(merged.edges).toHaveLength(1);
  });
});
