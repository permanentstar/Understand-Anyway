import { describe, expect, it } from "vitest";
import { dedupeEdges, edgeKey } from "./graph-utils.js";

describe("edgeKey / dedupeEdges", () => {
  it("builds a type|source|target key", () => {
    expect(edgeKey({ type: "imports", source: "a", target: "b" })).toBe("imports|a|b");
  });

  it("drops duplicate edges keeping first occurrence", () => {
    const edges = [
      { type: "imports", source: "a", target: "b", n: 1 },
      { type: "imports", source: "a", target: "b", n: 2 },
      { type: "calls", source: "a", target: "b", n: 3 },
    ];
    const out = dedupeEdges(edges);
    expect(out).toHaveLength(2);
    expect(out[0]!.n).toBe(1);
    expect(out[1]!.type).toBe("calls");
  });
});
