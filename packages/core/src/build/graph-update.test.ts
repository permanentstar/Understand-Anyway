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

  it("dedupes retained and update edges", () => {
    const merged = mergeGraphPartialUpdate(
      { nodes: [{ id: "a" }, { id: "b" }], edges: [{ type: "related", source: "a", target: "b" }] },
      { nodes: [], edges: [{ type: "related", source: "a", target: "b" }] },
      [],
    );
    expect(merged.edges).toHaveLength(1);
  });
});
