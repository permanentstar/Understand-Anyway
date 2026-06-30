import { describe, expect, it } from "vitest";
import { normalizeIncludePaths, parseChangedFiles, selectBatchesForFiles } from "./selection.js";

const batches = [
  { batchIndex: 1, files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
  { batchIndex: 2, files: [{ path: "README.md" }] },
];

describe("build selection", () => {
  it("normalizes include paths relative to the project root", () => {
    expect(normalizeIncludePaths(["/repo/src/a.ts", "README.md"], "/repo")).toEqual(["src/a.ts", "README.md"]);
  });

  it("drops paths outside the project root", () => {
    expect(normalizeIncludePaths(["/other/src/a.ts", "/repo/src/b.ts"], "/repo")).toEqual(["src/b.ts"]);
  });

  it("parses git diff --name-only output", () => {
    expect(parseChangedFiles("src/a.ts\n\nREADME.md\n")).toEqual(["src/a.ts", "README.md"]);
  });

  it("selects only batches that contain affected files", () => {
    expect(selectBatchesForFiles(batches, ["src/a.ts"]).map((b) => b.batchIndex)).toEqual([1]);
  });
});
