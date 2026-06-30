import { describe, expect, it, vi } from "vitest";
import { runRepair } from "./index.js";
import type { RepairArgs } from "../args.js";
import type { ProjectContext } from "../project-context.js";

function baseArgs(overrides: Partial<RepairArgs> = {}): RepairArgs {
  return {
    command: "repair",
    action: "llm-failures",
    projectId: "alpha",
    pluginRoot: null,
    llmProvider: null,
    config: null,
    dryRun: false,
    maxTasks: null,
    noDashboard: true,
    ...overrides,
  };
}

function fakeCtx(repoPath = "/repo", stateRoot = "/state"): ProjectContext {
  return {
    projectId: "alpha",
    repoPath,
    stateRoot,
    projectsRoot: "/projects",
    portalAssetsRoot: "/projects/gateway/portal-assets",
    projectsConfigPath: "/projects/gateway/config/projects.json",
    deployConfigPath: "/projects/gateway/config/deploy.yaml",
    entry: { projectId: "alpha" },
  };
}

function captureExit(): { exit: (code: number) => void; status: { code: number | null } } {
  const status: { code: number | null } = { code: null };
  const exit = (code: number) => {
    if (status.code === null) status.code = code;
  };
  return { exit, status };
}

const bootstrap = () => Promise.resolve({ core: { marker: true } } as any);

describe("runRepair (llm-failures)", () => {
  it("bootstraps, loads provider, runs file repair, exits 0 when nothing still fails", async () => {
    const buildLlm = vi.fn().mockResolvedValue({ name: "fake-llm" });
    const repair = vi.fn().mockResolvedValue({
      command: "llm-failures",
      dryRun: false,
      requested: 2,
      attempted: 2,
      repaired: 2,
      stillFailed: 0,
      batchesPatched: [1, 2],
      reportPath: "/repo/.understand-anything/repair-runs/r/result.json",
    });
    const { exit, status } = captureExit();
    const logs: string[] = [];

    await runRepair(baseArgs({ llmProvider: "cli-pkg" }), {
      bootstrap,
      loadConfig: () => ({ providers: { llm: { package: "cfg-pkg" } } }),
      buildLlmProvider: buildLlm as any,
      repairLlmFailures: repair as any,
      resolveProjectContext: () => fakeCtx(),
      log: (m) => logs.push(m),
      exit,
    });

    expect(buildLlm).toHaveBeenCalledOnce();
    expect(buildLlm.mock.calls[0]![0]).toMatchObject({ enabled: true, packageName: "cli-pkg" });
    expect(repair).toHaveBeenCalledOnce();
    const opts = repair.mock.calls[0]![0];
    expect(opts.core).toEqual({ marker: true });
    expect(opts.dryRun).toBe(false);
    expect(opts.llm.provider).toEqual({ name: "fake-llm" });
    expect(status.code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ command: "llm-failures", repaired: 2, stillFailed: 0 });
  });

  it("exits 1 when some files still failed", async () => {
    const repair = vi.fn().mockResolvedValue({
      command: "llm-failures",
      dryRun: false,
      requested: 2,
      attempted: 2,
      repaired: 1,
      stillFailed: 1,
      batchesPatched: [1],
      reportPath: "/r.json",
    });
    const { exit, status } = captureExit();

    await runRepair(baseArgs(), {
      bootstrap,
      loadConfig: () => ({}),
      buildLlmProvider: vi.fn().mockResolvedValue({ name: "p" }) as any,
      repairLlmFailures: repair as any,
      resolveProjectContext: () => fakeCtx(),
      log: () => {},
      exit,
    });

    expect(status.code).toBe(1);
  });

  it("dry-run never loads a provider and passes dryRun through", async () => {
    const buildLlm = vi.fn();
    const repair = vi.fn().mockResolvedValue({
      command: "llm-failures",
      dryRun: true,
      requested: 3,
      attempted: 0,
      repaired: 0,
      stillFailed: 0,
      batchesPatched: [],
      reportPath: "/r.json",
    });
    const { exit, status } = captureExit();

    await runRepair(baseArgs({ dryRun: true }), {
      bootstrap,
      loadConfig: () => ({}),
      buildLlmProvider: buildLlm as any,
      repairLlmFailures: repair as any,
      resolveProjectContext: () => fakeCtx(),
      log: () => {},
      exit,
    });

    expect(buildLlm).not.toHaveBeenCalled();
    expect(repair.mock.calls[0]![0].dryRun).toBe(true);
    expect(repair.mock.calls[0]![0].llm.provider).toBeUndefined();
    expect(status.code).toBe(0);
  });

  it("propagates a provider load failure (fail-fast) without calling the engine", async () => {
    const buildLlm = vi.fn().mockRejectedValue(new Error("no provider package"));
    const repair = vi.fn();

    await expect(
      runRepair(baseArgs(), {
        bootstrap,
        loadConfig: () => ({}),
        buildLlmProvider: buildLlm as any,
        repairLlmFailures: repair as any,
        resolveProjectContext: () => fakeCtx(),
        log: () => {},
        exit: () => {},
      }),
    ).rejects.toThrow(/no provider package/);
    expect(repair).not.toHaveBeenCalled();
  });

  it("forwards --repair-max-tasks and resolved stateRoot from project context", async () => {
    const repair = vi.fn().mockResolvedValue({
      command: "llm-failures",
      dryRun: false,
      requested: 1,
      attempted: 1,
      repaired: 1,
      stillFailed: 0,
      batchesPatched: [1],
      reportPath: "/r.json",
    });

    await runRepair(baseArgs({ maxTasks: 1 }), {
      bootstrap,
      loadConfig: () => ({}),
      buildLlmProvider: vi.fn().mockResolvedValue({ name: "p" }) as any,
      repairLlmFailures: repair as any,
      resolveProjectContext: () => fakeCtx("/repo", "/state"),
      log: () => {},
      exit: () => {},
    });

    const opts = repair.mock.calls[0]![0];
    expect(opts.maxTasks).toBe(1);
    expect(opts.stateRoot).toBe("/state");
  });
});

describe("runRepair (llm-graph-failures)", () => {
  it("loads a provider, runs the graph repair, exits 0", async () => {
    const buildLlm = vi.fn().mockResolvedValue({ name: "p" });
    const repair = vi.fn().mockResolvedValue({
      command: "llm-graph-failures",
      status: "repaired",
      gaps: { nodesMissingSummary: 2, missingLayers: false, missingProjectSummary: true },
      stats: { applied: 2, failed: 0 },
      reportPath: "/r.json",
    });
    const { exit, status } = captureExit();
    const logs: string[] = [];

    await runRepair(baseArgs({ action: "llm-graph-failures" }), {
      bootstrap,
      loadConfig: () => ({}),
      buildLlmProvider: buildLlm as any,
      repairLlmGraphFailures: repair as any,
      resolveProjectContext: () => fakeCtx(),
      log: (m) => logs.push(m),
      exit,
    });

    expect(buildLlm).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    expect(status.code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ command: "llm-graph-failures", status: "repaired", applied: 2, nodesMissingSummary: 2 });
  });
});
