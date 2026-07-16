import { describe, expect, it, vi } from "vitest";
import type { NightlyReport } from "@understand-anyway/plugin-api";
import { createNotifyProvider, LarkImNotifyProvider } from "./index.js";

const report: NightlyReport = {
  runId: "20260625-120000",
  overallStatus: "partial_success",
  generatedAt: "2026-06-25T12:00:00.000Z",
  projectsRoot: "/projects",
  success: ["alpha"],
  skipped: ["beta"],
  failed: [{ project: "gamma", reason: "gate_rejected", logPath: "/log/gamma" }],
  totals: { success: 1, skipped: 1, failed: 1 },
};

describe("LarkImNotifyProvider", () => {
  it("sends an interactive card through lark-cli", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const provider = new LarkImNotifyProvider({ recipient: "ou_test" }, { run });

    const result = await provider.sendNightlySummary(report);

    expect(result).toMatchObject({ delivered: true, target: "open_id:ou_test" });
    expect(run).toHaveBeenCalledOnce();
    const [command, args] = run.mock.calls[0]!;
    expect(command).toBe("lark-cli");
    expect(args).toEqual(expect.arrayContaining([
      "im",
      "send",
      "--receive-id-type",
      "open_id",
      "--receive-id",
      "ou_test",
      "--msg-type",
      "interactive",
    ]));
    const contentIndex = args.indexOf("--content");
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    const card = JSON.parse(args[contentIndex + 1]!);
    expect(card.header.title.content).toContain("partial_success");
  });

  it("dry-run skips delivery but keeps target", async () => {
    const run = vi.fn();
    const provider = new LarkImNotifyProvider({ recipient: "ou_test" }, { run });

    const result = await provider.sendNightlySummary(report, { dryRun: true });

    expect(result).toEqual({ delivered: false, skipped: true, target: "open_id:ou_test" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns skipped when recipient is missing", async () => {
    const run = vi.fn();
    const provider = new LarkImNotifyProvider({}, { run });

    const result = await provider.sendNightlySummary(report);

    expect(result.delivered).toBe(false);
    expect(result.skipped).toBe(true);
    expect(String(result.error)).toContain("missing notify recipient");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("createNotifyProvider", () => {
  it("returns a notify provider instance", async () => {
    const provider = await createNotifyProvider({ recipient: "ou_x" });
    expect(provider.name).toBe("lark-im-notify");
  });
});
