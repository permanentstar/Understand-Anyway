import { describe, expect, it, vi } from "vitest";
import { augmentScanResultWithImportMap } from "./import-map.js";

function fakeRegistry(map: Record<string, Array<{ resolvedPath?: string; source?: string }>>) {
  return {
    resolveImports(absPath: string) {
      const rel = absPath.replace(/^\/repo\//, "");
      return map[rel] ?? [];
    },
  };
}

describe("augmentScanResultWithImportMap", () => {
  it("resolves internal imports, sorts/dedupes, and writes scan back", () => {
    const writes: Array<[string, string]> = [];
    const fileContents: Record<string, string> = {
      "/repo/src/a.ts": "import b",
      "/repo/src/b.ts": "",
    };
    const scan = {
      files: [
        { path: "src/a.ts", fileCategory: "code" },
        { path: "src/b.ts", fileCategory: "code" },
        { path: "README.md", fileCategory: "docs" },
      ],
    };
    const registry = fakeRegistry({
      "src/a.ts": [{ resolvedPath: "/repo/src/b.ts" }, { resolvedPath: "/repo/src/b.ts" }],
    });

    const out = augmentScanResultWithImportMap(
      { registry, projectRoot: "/repo", analysisRoot: "/repo", scanPath: "/repo/scan.json", scan, log: () => {} },
      {
        readFileSync: (p) => {
          const c = fileContents[p];
          if (c === undefined) throw new Error("missing");
          return c;
        },
        writeFileSync: (p, d) => { writes.push([p, d]); },
        existsSync: (p) => p === "/repo/src/b.ts",
        lstatSync: () => ({ isFile: () => true }),
      },
    );

    expect(out.importMap).toEqual({ "src/a.ts": ["src/b.ts"], "src/b.ts": [] });
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe("/repo/scan.json");
  });

  it("records empty targets when a file cannot be read", () => {
    const scan = { files: [{ path: "src/x.ts", fileCategory: "script" }] };
    const out = augmentScanResultWithImportMap(
      { registry: fakeRegistry({}), projectRoot: "/repo", analysisRoot: "/repo", scanPath: "/s", scan, log: () => {} },
      {
        readFileSync: () => { throw new Error("nope"); },
        writeFileSync: vi.fn(),
      },
    );
    expect(out.importMap).toEqual({ "src/x.ts": [] });
  });
});
