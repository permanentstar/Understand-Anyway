import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildProjectAuditPath,
  buildProjectCurrentLinkPath,
  buildProjectSourceMirrorPath,
  buildProjectStableLinkPath,
  buildProjectVersionDashboardDistPath,
  buildProjectVersionGraphRoot,
  buildProjectVersionPath,
  buildProjectVersionStatePath,
  cleanupProjectVersions,
  listProjectVersionIds,
  readProjectCurrentLinkTarget,
  readProjectStableLinkTarget,
  readProjectVersionState,
  rollbackProjectToStable,
  seedProjectVersion,
  setStableProjectVersion,
} from "./project-state.js";

let stateRoot: string;
let sourceRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(resolve(tmpdir(), "ua-project-vers-state-"));
  sourceRoot = mkdtempSync(resolve(tmpdir(), "ua-project-vers-source-"));
  mkdirSync(resolve(stateRoot, ".understand-anything"), { recursive: true });
  writeFileSync(resolve(stateRoot, ".understand-anything", "knowledge-graph.json"), JSON.stringify({ project: "demo" }));
  mkdirSync(resolve(sourceRoot, "src"), { recursive: true });
  writeFileSync(resolve(sourceRoot, "src", "index.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("project versioned state", () => {
  it("seeds an immutable version from current graph state and source mirror", () => {
    const state = seedProjectVersion("v1", stateRoot, {
      stable: true,
      sourceRoot,
      now: () => new Date("2026-06-25T00:00:00Z"),
    });

    expect(state.currentVersion).toBe("v1");
    expect(state.stableVersion).toBe("v1");
    expect(readProjectCurrentLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v1", stateRoot));
    expect(readProjectStableLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v1", stateRoot));
    expect(readFileSync(resolve(buildProjectVersionGraphRoot("v1", stateRoot), "knowledge-graph.json"), "utf8"))
      .toContain("demo");
    expect(readFileSync(resolve(buildProjectSourceMirrorPath("v1", stateRoot), "src", "index.ts"), "utf8"))
      .toContain("export const x");
  });

  it("hoists an existing flat dashboard-dist into versions/<vid>/dashboard-dist on publish", () => {
    mkdirSync(resolve(stateRoot, "dashboard-dist", "assets"), { recursive: true });
    writeFileSync(resolve(stateRoot, "dashboard-dist", "index.html"), "<!doctype html><html></html>");
    writeFileSync(resolve(stateRoot, "dashboard-dist", "assets", "app.js"), "console.log(1)");

    seedProjectVersion("v1", stateRoot);

    const versionDist = buildProjectVersionDashboardDistPath("v1", stateRoot);
    expect(readFileSync(resolve(versionDist, "index.html"), "utf8")).toContain("doctype html");
    expect(readFileSync(resolve(versionDist, "assets", "app.js"), "utf8")).toContain("console.log");
  });

  it("setStableProjectVersion points stable at an existing ready version", () => {
    seedProjectVersion("v1", stateRoot);
    seedProjectVersion("v2", stateRoot);
    const state = setStableProjectVersion("v1", stateRoot);

    expect(state.currentVersion).toBe("v2");
    expect(state.stableVersion).toBe("v1");
    expect(readProjectStableLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v1", stateRoot));
  });

  it("setStableProjectVersion leaves state unchanged when stable link swap fails", () => {
    seedProjectVersion("v1", stateRoot, { stable: true });
    seedProjectVersion("v2", stateRoot);

    expect(() => setStableProjectVersion("v2", stateRoot, {
      renameSync: (oldPath, newPath) => {
        if (String(newPath) === buildProjectStableLinkPath(stateRoot)) {
          throw new Error("stable link swap failed");
        }
        return renameSync(oldPath, newPath);
      },
    })).toThrow(/stable link swap failed/);

    expect(readProjectVersionState(stateRoot).stableVersion).toBe("v1");
    expect(readProjectStableLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v1", stateRoot));
  });

  it("seedProjectVersion leaves state unchanged when current link swap fails", () => {
    seedProjectVersion("v1", stateRoot, { stable: true });

    expect(() => seedProjectVersion("v2", stateRoot, {}, {
      renameSync: (oldPath, newPath) => {
        if (String(newPath) === buildProjectCurrentLinkPath(stateRoot)) {
          throw new Error("current link swap failed");
        }
        return renameSync(oldPath, newPath);
      },
    })).toThrow(/current link swap failed/);

    expect(readProjectVersionState(stateRoot).currentVersion).toBe("v1");
    expect(readProjectCurrentLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v1", stateRoot));
  });

  it("seedProjectVersion restores current link when state write fails", () => {
    seedProjectVersion("v1", stateRoot, { stable: true });

    expect(() => seedProjectVersion("v2", stateRoot, {}, {
      renameSync: (oldPath, newPath) => {
        if (String(newPath) === buildProjectVersionStatePath(stateRoot)) {
          throw new Error("state write failed");
        }
        return renameSync(oldPath, newPath);
      },
    })).toThrow(/state write failed/);

    expect(readProjectVersionState(stateRoot).currentVersion).toBe("v1");
    expect(readProjectCurrentLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v1", stateRoot));
  });

  it("retention cleanup protects current and stable while deleting older extras", () => {
    seedProjectVersion("v1", stateRoot, { stable: true, retentionMaxVersions: 1 });
    seedProjectVersion("v2", stateRoot, { retentionMaxVersions: 1 });
    seedProjectVersion("v3", stateRoot, { retentionMaxVersions: 1 });
    seedProjectVersion("v4", stateRoot, { retentionMaxVersions: 1 });

    const ids = listProjectVersionIds(stateRoot);
    expect(ids).toContain("v4");
    expect(ids).toContain("v1");
    expect(ids).toContain("v3");
    expect(ids).not.toContain("v2");
  });

  it("retention cleanup removes source mirrors for deleted versions", () => {
    seedProjectVersion("v1", stateRoot, { stable: true, sourceRoot, retentionMaxVersions: 1 });
    seedProjectVersion("v2", stateRoot, { sourceRoot, retentionMaxVersions: 1 });
    seedProjectVersion("v3", stateRoot, { sourceRoot, retentionMaxVersions: 1 });
    seedProjectVersion("v4", stateRoot, { sourceRoot, retentionMaxVersions: 1 });

    expect(readdirSync(resolve(stateRoot, "source-mirror")).sort()).toEqual(["v1", "v3", "v4"]);
    expect(cleanupProjectVersions(stateRoot)).toEqual([]);
  });

  it("readProjectVersionState returns an empty state when missing", () => {
    expect(readProjectVersionState(stateRoot)).toMatchObject({
      currentVersion: null,
      stableVersion: null,
      retention: { maxVersions: 1 },
    });
  });

  it("exposes stable path helpers", () => {
    expect(buildProjectCurrentLinkPath(stateRoot)).toBe(resolve(stateRoot, "current"));
    expect(buildProjectStableLinkPath(stateRoot)).toBe(resolve(stateRoot, "stable"));
  });

  it("readProjectVersionState throws (not silently resets) when versioned-state.json is unparseable", () => {
    // Pre-fix behavior caught JSON.parse and returned createEmptyProjectVersionState(),
    // which loses stableVersion on the next publish. Now we surface the corruption
    // so an operator can recover the previous pointer before resetting.
    writeFileSync(resolve(stateRoot, "versioned-state.json"), "{not-valid-json", "utf8");
    expect(() => readProjectVersionState(stateRoot)).toThrow(/project version-state corrupt/);
  });

  it("rollbackProjectToStable flips current back to the recorded stable version", () => {
    seedProjectVersion("v1", stateRoot, { stable: true });
    seedProjectVersion("v2", stateRoot);
    expect(readProjectVersionState(stateRoot).currentVersion).toBe("v2");

    const state = rollbackProjectToStable(stateRoot);

    expect(state.currentVersion).toBe("v1");
    expect(state.stableVersion).toBe("v1");
    expect(readProjectCurrentLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v1", stateRoot));
  });

  it("rollbackProjectToStable leaves state unchanged when current link swap fails", () => {
    seedProjectVersion("v1", stateRoot, { stable: true });
    seedProjectVersion("v2", stateRoot);

    expect(() => rollbackProjectToStable(stateRoot, {
      renameSync: (oldPath, newPath) => {
        if (String(newPath) === buildProjectCurrentLinkPath(stateRoot)) {
          throw new Error("link swap failed");
        }
        return renameSync(oldPath, newPath);
      },
    })).toThrow(/link swap failed/);

    expect(readProjectVersionState(stateRoot).currentVersion).toBe("v2");
    expect(readProjectCurrentLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v2", stateRoot));
  });

  it("rollbackProjectToStable restores the previous current link when state write fails", () => {
    seedProjectVersion("v1", stateRoot, { stable: true });
    seedProjectVersion("v2", stateRoot);

    expect(() => rollbackProjectToStable(stateRoot, {
      renameSync: (oldPath, newPath) => {
        if (String(newPath) === buildProjectVersionStatePath(stateRoot)) {
          throw new Error("state write failed");
        }
        return renameSync(oldPath, newPath);
      },
    })).toThrow(/state write failed/);

    expect(readProjectVersionState(stateRoot).currentVersion).toBe("v2");
    expect(readProjectCurrentLinkTarget(stateRoot)).toBe(buildProjectVersionPath("v2", stateRoot));
  });

  it("rollbackProjectToStable rejects when there is no stable version", () => {
    seedProjectVersion("v1", stateRoot);
    expect(() => rollbackProjectToStable(stateRoot)).toThrow(/no stable version/);
  });

  it("publish / set-stable / rollback / ttl-cleanup emit audit ndjson entries", () => {
    seedProjectVersion("v1", stateRoot, { stable: true });
    seedProjectVersion("v2", stateRoot);
    setStableProjectVersion("v2", stateRoot);
    rollbackProjectToStable(stateRoot);

    // Trigger a ttl-cleanup by overflowing past retention.maxVersions (=1 default).
    seedProjectVersion("v3", stateRoot);
    seedProjectVersion("v4", stateRoot);

    const lines = readFileSync(buildProjectAuditPath(stateRoot), "utf8").trim().split("\n");
    const actions = lines.map((l) => JSON.parse(l).action as string);
    expect(actions).toContain("publish");
    expect(actions).toContain("set-stable");
    expect(actions).toContain("rollback");
    expect(actions).toContain("ttl-cleanup");

    // Every audit line carries a stable timestamp field.
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.at).toBe("string");
      expect(parsed.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
