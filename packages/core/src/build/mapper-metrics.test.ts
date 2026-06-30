import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  appendMetricsEvent,
  batchOutputIsValid,
  BATCH_MAPPER_METRICS_FILE,
  BATCH_OUTPUT_METRICS_FILE,
  listValidBatchOutputs,
  resetMetricsFile,
} from "./mapper-metrics.js";

describe("mapper-metrics on a real intermediate dir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "ua-metrics-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resetMetricsFile creates an empty file and appendMetricsEvent appends a line", () => {
    resetMetricsFile(dir, BATCH_MAPPER_METRICS_FILE);
    appendMetricsEvent(dir, BATCH_MAPPER_METRICS_FILE, { type: "mapper-segment", segmentStart: 1, segmentEnd: 5 });
    appendMetricsEvent(dir, BATCH_MAPPER_METRICS_FILE, { type: "mapper-segment", segmentStart: 6, segmentEnd: 10 });
    const raw = readFileSync(resolve(dir, BATCH_MAPPER_METRICS_FILE), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.segmentStart).toBe(1);
    expect(first.segmentEnd).toBe(5);
    expect(first.type).toBe("mapper-segment");
    expect(typeof first.ts).toBe("string");
  });

  it("resetMetricsFile clears prior content on a second reset", () => {
    resetMetricsFile(dir, BATCH_OUTPUT_METRICS_FILE);
    appendMetricsEvent(dir, BATCH_OUTPUT_METRICS_FILE, { type: "output", index: 1 });
    resetMetricsFile(dir, BATCH_OUTPUT_METRICS_FILE);
    expect(readFileSync(resolve(dir, BATCH_OUTPUT_METRICS_FILE), "utf8")).toBe("");
  });

  it("appendMetricsEvent does not throw when the directory cannot be created", () => {
    expect(() =>
      appendMetricsEvent("/proc/cannot-create", BATCH_MAPPER_METRICS_FILE, { type: "x" }),
    ).not.toThrow();
  });

  it("batchOutputIsValid: missing file -> false", () => {
    expect(batchOutputIsValid(dir, 1)).toBe(false);
  });

  it("batchOutputIsValid: non-JSON file -> false", () => {
    writeFileSync(resolve(dir, "batch-2.json"), "not-json", "utf8");
    expect(batchOutputIsValid(dir, 2)).toBe(false);
  });

  it("batchOutputIsValid: JSON without nodes array -> false", () => {
    writeFileSync(resolve(dir, "batch-3.json"), JSON.stringify({ edges: [] }), "utf8");
    expect(batchOutputIsValid(dir, 3)).toBe(false);
  });

  it("batchOutputIsValid: JSON with nodes array -> true", () => {
    writeFileSync(resolve(dir, "batch-4.json"), JSON.stringify({ nodes: [{ id: "x" }] }), "utf8");
    expect(batchOutputIsValid(dir, 4)).toBe(true);
  });

  it("batchOutputIsValid with llmEnabled requires the llmEnriched marker", () => {
    writeFileSync(resolve(dir, "batch-5.json"), JSON.stringify({ nodes: [{ id: "x" }] }), "utf8");
    expect(batchOutputIsValid(dir, 5, { llmEnabled: true })).toBe(false);
    writeFileSync(resolve(dir, "batch-5.json"), JSON.stringify({ nodes: [{ id: "x" }], llmEnriched: true }), "utf8");
    expect(batchOutputIsValid(dir, 5, { llmEnabled: true })).toBe(true);
  });

  it("listValidBatchOutputs filters per index using on-disk truth", () => {
    writeFileSync(resolve(dir, "batch-1.json"), JSON.stringify({ nodes: [{ id: "a" }] }), "utf8");
    writeFileSync(resolve(dir, "batch-2.json"), "{}", "utf8");
    writeFileSync(resolve(dir, "batch-3.json"), JSON.stringify({ nodes: [] }), "utf8");
    expect(listValidBatchOutputs(dir, [1, 2, 3, 4])).toEqual([1, 3]);
  });
});
