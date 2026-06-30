import { describe, expect, it } from "vitest";
import type { NightlyReport } from "@understand-anyway/plugin-api";
import { LocalFileNotifyProvider } from "./notify-local.js";

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

describe("LocalFileNotifyProvider", () => {
  it("writes the report to <projectsRoot>/notifications/<run-id>.json", async () => {
    const writes: Record<string, string> = {};
    const dirs: string[] = [];
    const p = new LocalFileNotifyProvider({
      writeFile: async (path, data) => { writes[path] = data; },
      mkdir: async (path) => { dirs.push(path); },
    });
    expect(p.name).toBe("local-file");
    const report = makeReport();
    const r = await p.sendNightlySummary(report);
    expect(r.delivered).toBe(true);
    expect(r.skipped).toBeFalsy();
    expect(r.target).toBe("/p/notifications/20260623-100000.json");
    expect(dirs).toEqual(["/p/notifications"]);
    expect(writes["/p/notifications/20260623-100000.json"]).toBeDefined();
    const parsed = JSON.parse(writes["/p/notifications/20260623-100000.json"]!);
    expect(parsed.runId).toBe("20260623-100000");
    expect(parsed.totals.failed).toBe(1);
  });

  it("falls back to a unix-ms run id when the report's runId is empty", async () => {
    const writes: Record<string, string> = {};
    const p = new LocalFileNotifyProvider({
      writeFile: async (path, data) => { writes[path] = data; },
      mkdir: async () => {},
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });
    const r = await p.sendNightlySummary({ ...makeReport(), runId: "" });
    expect(r.target).toMatch(/notifications\/notify-1782208800000\.json$/);
    expect(Object.keys(writes)[0]).toMatch(/notifications\/notify-1782208800000\.json$/);
  });

  it("dryRun returns delivered:false skipped:true and never writes", async () => {
    const writes: Record<string, string> = {};
    const p = new LocalFileNotifyProvider({
      writeFile: async (path, data) => { writes[path] = data; },
      mkdir: async () => {},
    });
    const r = await p.sendNightlySummary(makeReport(), { dryRun: true });
    expect(r.delivered).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.target).toBe("/p/notifications/20260623-100000.json");
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it("requires projectsRoot in the report", async () => {
    const p = new LocalFileNotifyProvider({
      writeFile: async () => {},
      mkdir: async () => {},
    });
    await expect(
      p.sendNightlySummary({ ...makeReport(), projectsRoot: "" }),
    ).rejects.toThrow(/projectsRoot/);
  });
});
