import { describe, expect, it } from "vitest";
import { applyTestFileFilterToScan, isTestFilePath } from "./test-filter.js";

// Minimal core stub with no language registry — exercises the default
// path/basename fallbacks only.
const bareCore = {};

describe("isTestFilePath (fallback patterns)", () => {
  it("matches common test directories", () => {
    expect(isTestFilePath("src/__tests__/a.ts", bareCore)).toBe(true);
    expect(isTestFilePath("pkg/test/a.go", bareCore)).toBe(true);
    expect(isTestFilePath("a/spec/b.rb", bareCore)).toBe(true);
  });

  it("matches common test basenames", () => {
    expect(isTestFilePath("src/a.test.ts", bareCore)).toBe(true);
    expect(isTestFilePath("src/a.spec.js", bareCore)).toBe(true);
    expect(isTestFilePath("src/a_test.go", bareCore)).toBe(true);
    expect(isTestFilePath("src/test_a.py", bareCore)).toBe(true);
    expect(isTestFilePath("src/FooTest.java", bareCore)).toBe(true);
    expect(isTestFilePath("conftest.py", bareCore)).toBe(true);
  });

  it("does not match production files", () => {
    expect(isTestFilePath("src/index.ts", bareCore)).toBe(false);
    expect(isTestFilePath("src/contest.ts", bareCore)).toBe(false);
  });

  it("respects case sensitivity for *Test.* style", () => {
    expect(isTestFilePath("src/footest.java", bareCore)).toBe(false);
    expect(isTestFilePath("src/FooTest.java", bareCore)).toBe(true);
  });
});

describe("applyTestFileFilterToScan", () => {
  it("removes test files, rebuilds stats, and prunes importMap", () => {
    const scan = {
      files: [
        { path: "src/a.ts", fileCategory: "code", language: "ts" },
        { path: "src/a.test.ts", fileCategory: "code", language: "ts" },
      ],
      totalFiles: 2,
      importMap: {
        "src/a.ts": ["src/a.test.ts"],
        "src/a.test.ts": ["src/a.ts"],
      },
    };
    const { scan: filtered, removedPaths } = applyTestFileFilterToScan(scan, bareCore);
    expect(removedPaths).toEqual(["src/a.test.ts"]);
    expect((filtered.files as unknown[]).length).toBe(1);
    expect(filtered.totalFiles).toBe(1);
    expect(filtered.importMap).toEqual({ "src/a.ts": [] });
  });

  it("returns the original scan untouched when nothing matches", () => {
    const scan = { files: [{ path: "src/a.ts" }], totalFiles: 1 };
    const result = applyTestFileFilterToScan(scan, bareCore);
    expect(result.removedPaths).toEqual([]);
    expect(result.scan).toBe(scan);
  });
});
