import { describe, expect, it, vi } from "vitest";
import { runNotify } from "./index.js";
import type { NotifyArgs } from "../args.js";

function baseArgs(overrides: Partial<NotifyArgs> = {}): NotifyArgs {
  return {
    command: "notify",
    action: "nightly",
    report: "/projects/aggregate/nightly-latest.json",
    provider: null,
    config: null,
    bestEffort: false,
    dryRun: false,
    ...overrides,
  };
}

function captureExit(): { exit: (code: number) => void; status: { code: number | null } } {
  const status: { code: number | null } = { code: null };
  const exit = (code: number) => {
    if (status.code === null) status.code = code;
  };
  return { exit, status };
}

const sampleReport = {
  runId: "20260623-100000",
  overallStatus: "success",
  generatedAt: "2026-06-23T10:00:00.000Z",
  projectsRoot: "/projects",
  success: ["alpha"],
  skipped: [],
  failed: [],
  totals: { success: 1, skipped: 0, failed: 0 },
};

describe("runNotify", () => {
  it("loads the default LocalFileNotifyProvider, persists the report, exits 0", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const readReport = vi.fn().mockResolvedValue(sampleReport);
    const { exit, status } = captureExit();
    const logs: string[] = [];

    await runNotify(baseArgs(), {
      loadConfig: () => ({}),
      readReport,
      fsDeps: { writeFile, mkdir, now: () => new Date("2026-06-23T10:00:00.000Z") },
      log: (m) => logs.push(m),
      exit,
    });

    expect(readReport).toHaveBeenCalledWith("/projects/aggregate/nightly-latest.json");
    expect(mkdir).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledOnce();
    const [path, data] = writeFile.mock.calls[0]!;
    expect(path).toBe("/projects/notifications/20260623-100000.json");
    expect(JSON.parse(data as string)).toEqual(sampleReport);
    expect(status.code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      provider: "local-file",
      delivered: true,
      target: "/projects/notifications/20260623-100000.json",
    });
  });

  it("uses dryRun without invoking writeFile", async () => {
    const writeFile = vi.fn();
    const mkdir = vi.fn();
    const readReport = vi.fn().mockResolvedValue(sampleReport);
    const { exit, status } = captureExit();
    const logs: string[] = [];

    await runNotify(baseArgs({ dryRun: true }), {
      loadConfig: () => ({}),
      readReport,
      fsDeps: { writeFile, mkdir },
      log: (m) => logs.push(m),
      exit,
    });

    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(status.code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ delivered: false, skipped: true });
  });

  it("loads an external NotifyProvider package when --notify-provider is set", async () => {
    const customProvider = {
      name: "custom",
      sendNightlySummary: vi.fn().mockResolvedValue({ delivered: true, target: "im://room/1" }),
    };
    const factory = vi.fn().mockReturnValue(customProvider);
    const importModule = vi.fn().mockResolvedValue({ createNotifyProvider: factory });
    const { exit, status } = captureExit();
    const logs: string[] = [];

    await runNotify(baseArgs({ provider: "@example/lark-im-notify" }), {
      loadConfig: () => ({ providers: { notify: { package: "@example/lark-im-notify", config: { token: "x" } } } }),
      readReport: () => Promise.resolve(sampleReport),
      importModule: importModule as any,
      log: (m) => logs.push(m),
      exit,
    });

    expect(importModule).toHaveBeenCalledWith("@example/lark-im-notify");
    expect(factory).toHaveBeenCalledWith({ token: "x" });
    expect(customProvider.sendNightlySummary).toHaveBeenCalledWith(sampleReport, { dryRun: false });
    expect(status.code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ provider: "custom", delivered: true, target: "im://room/1" });
  });

  it("exits 1 when delivery throws", async () => {
    const failing = {
      name: "im",
      sendNightlySummary: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const importModule = vi.fn().mockResolvedValue({ createNotifyProvider: () => failing });
    const { exit, status } = captureExit();
    const logs: string[] = [];

    await runNotify(baseArgs({ provider: "@example/lark-im-notify" }), {
      loadConfig: () => ({}),
      readReport: () => Promise.resolve(sampleReport),
      importModule: importModule as any,
      log: (m) => logs.push(m),
      exit,
    });

    expect(status.code).toBe(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ delivered: false, error: expect.stringContaining("network down") });
  });

  it("--best-effort never escalates a delivery failure", async () => {
    const failing = {
      name: "im",
      sendNightlySummary: vi.fn().mockRejectedValue(new Error("transient")),
    };
    const importModule = vi.fn().mockResolvedValue({ createNotifyProvider: () => failing });
    const { exit, status } = captureExit();
    const logs: string[] = [];

    await runNotify(baseArgs({ provider: "@example/lark-im-notify", bestEffort: true }), {
      loadConfig: () => ({}),
      readReport: () => Promise.resolve(sampleReport),
      importModule: importModule as any,
      log: (m) => logs.push(m),
      exit,
    });

    expect(status.code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ delivered: false, error: expect.stringContaining("transient") });
  });

  it("rejects an external provider package missing the factory export", async () => {
    const importModule = vi.fn().mockResolvedValue({ somethingElse: () => ({}) });
    const { exit, status } = captureExit();

    await expect(
      runNotify(baseArgs({ provider: "@example/lark-im-notify" }), {
        loadConfig: () => ({}),
        readReport: () => Promise.resolve(sampleReport),
        importModule: importModule as any,
        log: () => {},
        exit,
      }),
    ).rejects.toThrow(/createNotifyProvider/);
  });
});
