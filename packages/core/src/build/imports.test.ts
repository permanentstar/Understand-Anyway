import { describe, expect, it } from "vitest";
import {
  buildQualifiedSourceIndex,
  resolveQualifiedSourceImport,
  resolveExistingProjectPath,
  resolveInternalImportTarget,
  normalizeInternalPath,
} from "./imports.js";

describe("buildQualifiedSourceIndex", () => {
  it("maps java/scala logical paths to real files", () => {
    const index = buildQualifiedSourceIndex([
      { path: "src/main/java/org/apache/foo/Bar.java" },
      { path: "src/test/scala/com/x/Baz.scala" },
      { path: "src/index.ts" },
    ]);
    expect(index.get("org/apache/foo/Bar")).toBe("src/main/java/org/apache/foo/Bar.java");
    expect(index.get("com/x/Baz")).toBe("src/test/scala/com/x/Baz.scala");
    expect(index.size).toBe(2);
  });

  it("keeps the first occurrence of a duplicate logical path", () => {
    const index = buildQualifiedSourceIndex([
      { path: "a/src/main/java/org/x/A.java" },
      { path: "b/src/main/java/org/x/A.java" },
    ]);
    expect(index.get("org/x/A")).toBe("a/src/main/java/org/x/A.java");
  });
});

describe("resolveQualifiedSourceImport", () => {
  const index = buildQualifiedSourceIndex([
    { path: "src/main/java/org/apache/foo/Bar.java" },
  ]);

  it("resolves a fully-qualified import", () => {
    expect(resolveQualifiedSourceImport(index, "org.apache.foo.Bar")).toBe(
      "src/main/java/org/apache/foo/Bar.java",
    );
  });

  it("strips static. prefix and resolves the qualified type", () => {
    expect(resolveQualifiedSourceImport(index, "static.org.apache.foo.Bar")).toBe(
      "src/main/java/org/apache/foo/Bar.java",
    );
  });

  it("strips a .* wildcard but only resolves to a concrete file, not a package", () => {
    // `org.apache.foo.*` -> `org.apache.foo`, which is a package (no file), so null.
    expect(resolveQualifiedSourceImport(index, "org.apache.foo.*")).toBeNull();
    expect(resolveQualifiedSourceImport(index, "org.apache.foo.Bar.*")).toBe(
      "src/main/java/org/apache/foo/Bar.java",
    );
  });

  it("shortens segments to find a package match", () => {
    expect(resolveQualifiedSourceImport(index, "org.apache.foo.Bar.method")).toBe(
      "src/main/java/org/apache/foo/Bar.java",
    );
  });

  it("returns null for non-dotted or unknown imports", () => {
    expect(resolveQualifiedSourceImport(index, "Bar")).toBeNull();
    expect(resolveQualifiedSourceImport(index, "org.unknown.Type")).toBeNull();
  });
});

describe("normalizeInternalPath", () => {
  it("returns repo-relative path for absolute candidates under a root", () => {
    expect(normalizeInternalPath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  });
  it("returns null for paths outside all roots or non-absolute", () => {
    expect(normalizeInternalPath("/repo", "/other/a.ts")).toBeNull();
    expect(normalizeInternalPath("/repo", "src/a.ts")).toBeNull();
  });
});

describe("resolveExistingProjectPath", () => {
  const exists = (set: Set<string>) => ({
    existsSync: (p: string) => set.has(p),
    lstatSync: () => ({ isFile: () => true }),
  });

  it("probes ts/tsx for js imports", () => {
    const deps = exists(new Set(["/repo/src/a.ts"]));
    expect(resolveExistingProjectPath("/repo", "src/a.js", deps)).toBe("src/a.ts");
  });

  it("probes extension + index for extensionless imports", () => {
    const deps = exists(new Set(["/repo/src/mod/index.ts"]));
    expect(resolveExistingProjectPath("/repo", "src/mod", deps)).toBe("src/mod/index.ts");
  });

  it("returns null when nothing exists", () => {
    expect(resolveExistingProjectPath("/repo", "src/missing", exists(new Set()))).toBeNull();
  });
});

describe("resolveInternalImportTarget", () => {
  const qualifiedIndex = buildQualifiedSourceIndex([
    { path: "src/main/java/org/x/A.java" },
  ]);

  it("ignores node: builtins", () => {
    expect(resolveInternalImportTarget("/repo", "/repo", "node:fs", qualifiedIndex)).toBeNull();
  });

  it("resolves @/ alias to src", () => {
    const deps = { existsSync: (p: string) => p === "/repo/src/a.ts", lstatSync: () => ({ isFile: () => true }) };
    expect(resolveInternalImportTarget("/repo", "/repo", "@/a", qualifiedIndex, deps)).toBe("src/a.ts");
  });

  it("falls back to qualified-source resolution for bare dotted names", () => {
    expect(resolveInternalImportTarget("/repo", "/repo", "org.x.A", qualifiedIndex)).toBe(
      "src/main/java/org/x/A.java",
    );
  });
});
