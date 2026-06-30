import { describe, expect, it } from "vitest";
import {
  defaultMapperBatchCountForHost,
  defaultMapperConcurrencyForHost,
  readHostMetrics,
} from "./mapper-host-defaults.js";

const GB = 1024 * 1024 * 1024;

describe("readHostMetrics", () => {
  it("derives metrics from injected cpus/totalmem", () => {
    const metrics = readHostMetrics({
      cpus: () => new Array(16),
      totalmem: () => 64 * GB,
    });
    expect(metrics).toEqual({ cpuCount: 16, memoryGb: 64 });
  });

  it("guarantees cpuCount >= 1 even when cpus() returns empty", () => {
    const metrics = readHostMetrics({ cpus: () => [], totalmem: () => 1 * GB });
    expect(metrics.cpuCount).toBe(1);
  });
});

describe("defaultMapperConcurrencyForHost tiers", () => {
  it("returns 4 for big hosts (cpu>=16 && mem>=64)", () => {
    expect(defaultMapperConcurrencyForHost({ cpuCount: 16, memoryGb: 64 })).toBe(4);
    expect(defaultMapperConcurrencyForHost({ cpuCount: 32, memoryGb: 128 })).toBe(4);
  });

  it("returns 2 for medium hosts (cpu>=8 && mem>=32)", () => {
    expect(defaultMapperConcurrencyForHost({ cpuCount: 8, memoryGb: 32 })).toBe(2);
    expect(defaultMapperConcurrencyForHost({ cpuCount: 12, memoryGb: 48 })).toBe(2);
  });

  it("returns 1 below medium tier", () => {
    expect(defaultMapperConcurrencyForHost({ cpuCount: 7, memoryGb: 64 })).toBe(1);
    expect(defaultMapperConcurrencyForHost({ cpuCount: 16, memoryGb: 31 })).toBe(1);
    expect(defaultMapperConcurrencyForHost({ cpuCount: 1, memoryGb: 1 })).toBe(1);
  });
});

describe("defaultMapperBatchCountForHost tiers", () => {
  it("returns 100 for big hosts", () => {
    expect(defaultMapperBatchCountForHost({ cpuCount: 16, memoryGb: 64 })).toBe(100);
  });

  it("returns 50 otherwise", () => {
    expect(defaultMapperBatchCountForHost({ cpuCount: 16, memoryGb: 63 })).toBe(50);
    expect(defaultMapperBatchCountForHost({ cpuCount: 15, memoryGb: 64 })).toBe(50);
    expect(defaultMapperBatchCountForHost({ cpuCount: 1, memoryGb: 1 })).toBe(50);
  });
});
