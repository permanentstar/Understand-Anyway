import { describe, expect, it } from "vitest";
import { NoopNotifyProvider, type NightlyReport } from "./notify.js";

function makeReport(): NightlyReport {
  return {
    runId: "20260623-100000",
    overallStatus: "partial_success",
    generatedAt: "2026-06-23T10:00:00.000+08:00",
    projectsRoot: "/p",
    success: ["a", "b"],
    skipped: ["c"],
    failed: [{ project: "d", reason: "build-failed", logPath: "/p/d/log" }],
    totals: { success: 2, skipped: 1, failed: 1 },
    extras: { reportPath: "/p/aggregate/nightly-latest.json" },
  };
}

describe("NoopNotifyProvider", () => {
  it("name is 'noop' and send resolves with skipped", async () => {
    const p = new NoopNotifyProvider();
    expect(p.name).toBe("noop");
    const r = await p.sendNightlySummary(makeReport());
    expect(r).toEqual({ delivered: false, skipped: true });
  });
});
