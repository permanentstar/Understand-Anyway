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

  it("adds python package-root fallback imports for workspace packages", () => {
    const writes: Array<[string, string]> = [];
    const fileContents: Record<string, string> = {
      "/repo/backend/pyproject.toml": `[project]
name = "deer-flow"

[tool.uv.workspace]
members = ["packages/harness"]
`,
      "/repo/backend/app/__init__.py": "",
      "/repo/backend/app/gateway/__init__.py": "",
      "/repo/backend/app/gateway/authz.py": "def require_permission():\n    return True\n",
      "/repo/backend/app/gateway/routers/runs.py": "from app.gateway.authz import require_permission\n",
      "/repo/backend/packages/harness/pyproject.toml": `[project]
name = "deerflow-harness"

[tool.hatch.build.targets.wheel]
packages = ["deerflow"]
`,
      "/repo/backend/packages/harness/deerflow/__init__.py": "",
      "/repo/backend/packages/harness/deerflow/runtime/__init__.py": "",
      "/repo/backend/packages/harness/deerflow/runtime/events/__init__.py": "",
      "/repo/backend/packages/harness/deerflow/runtime/events/store/__init__.py": "",
      "/repo/backend/packages/harness/deerflow/runtime/events/store/base.py": "class RunEventStore:\n    pass\n",
      "/repo/backend/packages/harness/deerflow/runtime/events/store/memory.py":
        "from deerflow.runtime.events.store.base import RunEventStore\n",
    };

    const scan = {
      files: [
        { path: "backend/pyproject.toml", fileCategory: "config", language: "toml" },
        { path: "backend/app/__init__.py", fileCategory: "code", language: "python" },
        { path: "backend/app/gateway/__init__.py", fileCategory: "code", language: "python" },
        { path: "backend/app/gateway/authz.py", fileCategory: "code", language: "python" },
        { path: "backend/app/gateway/routers/runs.py", fileCategory: "code", language: "python" },
        { path: "backend/packages/harness/pyproject.toml", fileCategory: "config", language: "toml" },
        { path: "backend/packages/harness/deerflow/__init__.py", fileCategory: "code", language: "python" },
        { path: "backend/packages/harness/deerflow/runtime/__init__.py", fileCategory: "code", language: "python" },
        { path: "backend/packages/harness/deerflow/runtime/events/__init__.py", fileCategory: "code", language: "python" },
        { path: "backend/packages/harness/deerflow/runtime/events/store/__init__.py", fileCategory: "code", language: "python" },
        { path: "backend/packages/harness/deerflow/runtime/events/store/base.py", fileCategory: "code", language: "python" },
        { path: "backend/packages/harness/deerflow/runtime/events/store/memory.py", fileCategory: "code", language: "python" },
      ],
    };

    const out = augmentScanResultWithImportMap(
      { registry: fakeRegistry({}), projectRoot: "/repo", analysisRoot: "/repo", scanPath: "/repo/scan.json", scan, log: () => {} },
      {
        readFileSync: (p) => {
          const c = fileContents[p];
          if (c === undefined) throw new Error(`missing:${p}`);
          return c;
        },
        writeFileSync: (p, d) => { writes.push([p, d]); },
        existsSync: (p) => Object.prototype.hasOwnProperty.call(fileContents, p),
        lstatSync: () => ({ isFile: () => true }),
      },
    );

    expect(out.importMap).toMatchObject({
      "backend/app/gateway/routers/runs.py": ["backend/app/gateway/authz.py"],
      "backend/packages/harness/deerflow/runtime/events/store/memory.py": [
        "backend/packages/harness/deerflow/runtime/events/store/base.py",
      ],
    });
    expect(writes).toHaveLength(1);
  });
});
