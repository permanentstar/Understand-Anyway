import { describe, expect, it, vi } from "vitest";
import { runProjectState } from "./project-state.js";
import type { ProjectContext } from "../project-context.js";

function fakeCtx(stateRoot = "/state"): ProjectContext {
  return {
    projectId: "alpha",
    repoPath: "/repo",
    stateRoot,
    projectsRoot: "/projects",
    portalAssetsRoot: "/projects/gateway/portal-assets",
    projectsConfigPath: "/projects/gateway/config/projects.json",
    deployConfigPath: "/projects/gateway/config/deploy.yaml",
    entry: { projectId: "alpha" },
  };
}

describe("runProjectState", () => {
  it("dispatches publish to project versioning state", async () => {
    const deps = {
      seedProjectVersion: vi.fn().mockReturnValue({ currentVersion: "v1", stableVersion: "v1" }),
      setStableProjectVersion: vi.fn(),
      listProjectVersionIds: vi.fn(),
      cleanupProjectVersions: vi.fn(),
      resolveProjectContext: () => fakeCtx("/state"),
    };
    const logs: string[] = [];
    await runProjectState({
      command: "project-state",
      action: "publish",
      projectId: "alpha",
      versionId: "v1",
      sourceRoot: "/repo",
      stable: true,
      retain: 2,
    }, { ...deps, log: (line: string) => logs.push(line) } as any);

    expect(deps.seedProjectVersion).toHaveBeenCalledWith("v1", "/state", {
      stable: true,
      sourceRoot: "/repo",
      retentionMaxVersions: 2,
    }, undefined);
    expect(logs[0]).toContain("project-state: published v1");
  });

  it("forwards retain to gc cleanup", async () => {
    const deps = {
      seedProjectVersion: vi.fn(),
      setStableProjectVersion: vi.fn(),
      listProjectVersionIds: vi.fn(),
      cleanupProjectVersions: vi.fn().mockReturnValue([]),
      resolveProjectContext: () => fakeCtx("/state"),
    };
    await runProjectState({
      command: "project-state",
      action: "gc",
      projectId: "alpha",
      retain: 3,
    }, deps as any);

    expect(deps.cleanupProjectVersions).toHaveBeenCalledWith("/state", { retentionMaxVersions: 3 }, undefined);
  });

  it("dispatches rollback to rollbackProjectToStable and prints the resulting pointers", async () => {
    const deps = {
      seedProjectVersion: vi.fn(),
      setStableProjectVersion: vi.fn(),
      rollbackProjectToStable: vi.fn().mockReturnValue({ currentVersion: "v1", stableVersion: "v1" }),
      listProjectVersionIds: vi.fn(),
      cleanupProjectVersions: vi.fn(),
      resolveProjectContext: () => fakeCtx("/state"),
    };
    const logs: string[] = [];
    await runProjectState({
      command: "project-state",
      action: "rollback",
      projectId: "alpha",
    }, { ...deps, log: (line: string) => logs.push(line) } as any);

    expect(deps.rollbackProjectToStable).toHaveBeenCalledWith("/state", undefined);
    expect(logs[0]).toContain("project-state: rolled back to stable=v1");
    expect(logs[0]).toContain("current=v1");
  });
});
