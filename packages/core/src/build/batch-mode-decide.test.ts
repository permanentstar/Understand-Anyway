import { describe, expect, it } from "vitest";
import { decideBatchMode } from "./batch-mode-decide.js";

describe("decideBatchMode", () => {
  it("returns full when explicitly chosen, regardless of size", () => {
    expect(decideBatchMode({ mode: "full", batchCount: 10000, fileCount: 100000 }).mode).toBe("full");
  });

  it("returns segmented when explicitly chosen, regardless of size", () => {
    expect(decideBatchMode({ mode: "segmented", batchCount: 1, fileCount: 1 }).mode).toBe("segmented");
  });

  it("auto -> full at the fixture boundary (batches<=3 && files<=50)", () => {
    expect(decideBatchMode({ mode: "auto", batchCount: 3, fileCount: 50 }).mode).toBe("full");
    expect(decideBatchMode({ mode: "auto", batchCount: 1, fileCount: 1 }).mode).toBe("full");
  });

  it("auto -> segmented when either dimension exceeds the fixture threshold", () => {
    expect(decideBatchMode({ mode: "auto", batchCount: 4, fileCount: 50 }).mode).toBe("segmented");
    expect(decideBatchMode({ mode: "auto", batchCount: 3, fileCount: 51 }).mode).toBe("segmented");
    expect(decideBatchMode({ mode: "auto", batchCount: 1000, fileCount: 10000 }).mode).toBe("segmented");
  });

  it("includes batches/files in the auto reason for log clarity", () => {
    const decision = decideBatchMode({ mode: "auto", batchCount: 10, fileCount: 200 });
    expect(decision.reason).toMatch(/auto: segmented/);
    expect(decision.reason).toMatch(/batches=10/);
    expect(decision.reason).toMatch(/files=200/);
  });

  it("appends host metrics to the reason when provided (but does not alter the decision)", () => {
    const a = decideBatchMode({ mode: "auto", batchCount: 100, fileCount: 1000 });
    const b = decideBatchMode({ mode: "auto", batchCount: 100, fileCount: 1000, cpuCount: 16, memoryGb: 64 });
    expect(a.mode).toBe(b.mode);
    expect(b.reason).toMatch(/cpu=16/);
    expect(b.reason).toMatch(/memGb=64\.0/);
  });
});
