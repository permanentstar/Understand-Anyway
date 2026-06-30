import { describe, expect, it } from "vitest";
import {
  buildProjectDescription,
  complexityFromLines,
  fileSummary,
  nonCodeType,
  symbolSummary,
} from "./summaries.js";

describe("complexityFromLines", () => {
  it("buckets by line count", () => {
    expect(complexityFromLines(0)).toBe("simple");
    expect(complexityFromLines(120)).toBe("simple");
    expect(complexityFromLines(121)).toBe("moderate");
    expect(complexityFromLines(400)).toBe("moderate");
    expect(complexityFromLines(401)).toBe("complex");
  });
});

describe("fileSummary", () => {
  const analysis = { functions: [{ name: "f" }], classes: [{ name: "C" }] };
  it("renders zh and en variants", () => {
    expect(fileSummary("a.ts", "ts", analysis, "zh")).toContain("源文件");
    expect(fileSummary("a.ts", "ts", analysis, "en")).toContain("source file");
  });
  it("falls back to definitions / sections / plain", () => {
    expect(fileSummary("a.json", "json", { definitions: [1, 2] }, "en")).toContain("defines 2");
    expect(fileSummary("a.md", "md", { sections: [1] }, "en")).toContain("document with 1");
    expect(fileSummary("a.txt", "txt", {}, "en")).toBe("a.txt is a txt file.");
  });
});

describe("symbolSummary", () => {
  it("renders function/class for both languages", () => {
    expect(symbolSummary("function", "f", "a.ts", "zh")).toContain("函数 f");
    expect(symbolSummary("class", "C", "a.ts", "en")).toBe("Class C defined in a.ts.");
  });
});

describe("nonCodeType", () => {
  it("maps categories", () => {
    expect(nonCodeType("config")).toBe("config");
    expect(nonCodeType("infra")).toBe("resource");
    expect(nonCodeType("data")).toBe("schema");
    expect(nonCodeType("docs")).toBe("document");
    expect(nonCodeType("anything")).toBe("document");
  });
});

describe("buildProjectDescription", () => {
  it("renders incremental and full variants", () => {
    expect(buildProjectDescription("p", 5, "en")).toContain("generated from 5");
    expect(buildProjectDescription("p", 5, "en", true)).toContain("updated incrementally from 5");
    expect(buildProjectDescription("p", 5, "zh")).toContain("基于 5 个文件生成");
  });
});
