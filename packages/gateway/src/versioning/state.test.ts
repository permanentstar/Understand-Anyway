import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendGatewayAudit,
  buildGatewayAuditPath,
  buildGatewayCurrentLinkPath,
  buildGatewayReleaseDistPath,
  buildGatewayReleasePath,
  buildGatewayReleasesPath,
  buildGatewayStatePath,
  cleanupGatewayReleases,
  createEmptyGatewayState,
  createVersionId,
  isGatewayReleaseReady,
  listGatewayReleaseIds,
  listGatewayReleases,
  normalizeVersionId,
  pointGatewayCurrent,
  publishGatewayVersion,
  readGatewayCurrentLinkTarget,
  readGatewayState,
  rollbackGatewayToStable,
  setStableGatewayVersion,
  writeGatewayState,
} from "./state.js";

let projectsRoot: string;

beforeEach(() => {
  projectsRoot = mkdtempSync(resolve(tmpdir(), "ua-gw-vers-"));
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
});

function makeRelease(versionId: string, manifest: Record<string, unknown> = {}): void {
  const distDir = buildGatewayReleaseDistPath(versionId, projectsRoot);
  mkdirSync(distDir, { recursive: true });
  writeFileSync(resolve(distDir, "cli.js"), "// fake entry\n");
  const manifestPath = resolve(buildGatewayReleasePath(versionId, projectsRoot), "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function makeIncompleteRelease(versionId: string): void {
  // Release dir exists but no dist/cli.js → not ready.
  mkdirSync(buildGatewayReleasePath(versionId, projectsRoot), { recursive: true });
}

describe("normalizeVersionId / createVersionId", () => {
  it("normalizes empty / null / whitespace to empty string", () => {
    expect(normalizeVersionId(null)).toBe("");
    expect(normalizeVersionId(undefined)).toBe("");
    expect(normalizeVersionId("  ")).toBe("");
    expect(normalizeVersionId(" v1 ")).toBe("v1");
  });

  it("rejects path segment aliases as version ids", () => {
    expect(normalizeVersionId(".")).toBe("");
    expect(normalizeVersionId("..")).toBe("");
    expect(normalizeVersionId("../v1")).toBe("");
    expect(normalizeVersionId("v1/../v2")).toBe("");
  });

  it("createVersionId formats yyyymmddhhmmss", () => {
    const id = createVersionId(new Date("2026-06-23T10:11:12.000Z"));
    // Year/month/day are local — assert structural form.
    expect(id).toMatch(/^\d{14}$/);
  });
});

describe("readGatewayState / writeGatewayState (round-trip)", () => {
  it("returns empty state when state.json is missing", () => {
    expect(readGatewayState(projectsRoot)).toEqual(createEmptyGatewayState());
  });

  it("round-trips state across read/write", () => {
    const state = createEmptyGatewayState();
    state.currentVersion = "20260101000000";
    state.stableVersion = "20260101000000";
    writeGatewayState(state, projectsRoot, { now: () => new Date("2026-06-23T00:00:00Z") });
    const got = readGatewayState(projectsRoot);
    expect(got.currentVersion).toBe("20260101000000");
    expect(got.stableVersion).toBe("20260101000000");
    expect(got.updatedAt).toBe("2026-06-23T00:00:00.000Z");
  });

  it("clamps retention.maxVersions to >= 1", () => {
    const state = createEmptyGatewayState();
    state.retention.maxVersions = 0;
    writeGatewayState(state, projectsRoot);
    expect(readGatewayState(projectsRoot).retention.maxVersions).toBe(1);
  });
});

describe("isGatewayReleaseReady / listGatewayReleaseIds", () => {
  it("ready when dist/cli.js exists, not ready otherwise", () => {
    makeRelease("v-ready");
    expect(isGatewayReleaseReady("v-ready", projectsRoot)).toBe(true);
    makeIncompleteRelease("v-bad");
    expect(isGatewayReleaseReady("v-bad", projectsRoot)).toBe(false);
  });

  it("supports an injected requiredDistEntry path", () => {
    const distDir = buildGatewayReleaseDistPath("v-custom", projectsRoot);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, "alt.js"), "");
    expect(isGatewayReleaseReady("v-custom", projectsRoot)).toBe(false);
    expect(isGatewayReleaseReady("v-custom", projectsRoot, { requiredDistEntry: "alt.js" })).toBe(true);
  });

  it("listGatewayReleaseIds is descending lex order", () => {
    makeRelease("20260101000000");
    makeRelease("20260301000000");
    makeRelease("20260201000000");
    expect(listGatewayReleaseIds(projectsRoot)).toEqual([
      "20260301000000",
      "20260201000000",
      "20260101000000",
    ]);
  });
});

describe("publishGatewayVersion / setStableGatewayVersion / rollback", () => {
  it("publish points current and (with --stable) stable", () => {
    makeRelease("v1");
    const state = publishGatewayVersion("v1", projectsRoot, { stable: true });
    expect(state.currentVersion).toBe("v1");
    expect(state.stableVersion).toBe("v1");
    // current symlink set
    const target = readGatewayCurrentLinkTarget(projectsRoot);
    expect(target).toBe(buildGatewayReleasePath("v1", projectsRoot));
  });

  it("publish without --stable creates a stablePending action when stable!=current", () => {
    makeRelease("v1");
    publishGatewayVersion("v1", projectsRoot, { stable: true });
    makeRelease("v2");
    const state = publishGatewayVersion("v2", projectsRoot);
    expect(state.currentVersion).toBe("v2");
    expect(state.stableVersion).toBe("v1");
    expect(state.stablePendingForCurrent).toBe(true);
    expect(state.pendingActions.some((a) => a.type === "set-stable" && a.version === "v2")).toBe(true);
  });

  it("publish rejects an incomplete release", () => {
    makeIncompleteRelease("bad");
    expect(() => publishGatewayVersion("bad", projectsRoot)).toThrow(/incomplete/);
  });

  it("set-stable rejects when no current release", () => {
    expect(() => setStableGatewayVersion(null, projectsRoot)).toThrow(/no current release/);
  });

  it("set-stable promotes the currently-published release (default arg)", () => {
    makeRelease("v1");
    publishGatewayVersion("v1", projectsRoot);
    const state = setStableGatewayVersion(undefined, projectsRoot);
    expect(state.stableVersion).toBe("v1");
    expect(state.stablePendingForCurrent).toBe(false);
  });

  it("rollback flips current back to stable", () => {
    makeRelease("v1");
    makeRelease("v2");
    publishGatewayVersion("v1", projectsRoot, { stable: true });
    publishGatewayVersion("v2", projectsRoot);
    expect(readGatewayState(projectsRoot).currentVersion).toBe("v2");
    const state = rollbackGatewayToStable(projectsRoot);
    expect(state.currentVersion).toBe("v1");
    const target = readGatewayCurrentLinkTarget(projectsRoot);
    expect(target).toBe(buildGatewayReleasePath("v1", projectsRoot));
  });

  it("rollback rejects when no stable version", () => {
    makeRelease("v1");
    publishGatewayVersion("v1", projectsRoot); // no stable flag
    // override stable to null to force the no-stable branch
    const state = readGatewayState(projectsRoot);
    state.stableVersion = null;
    writeGatewayState(state, projectsRoot);
    expect(() => rollbackGatewayToStable(projectsRoot)).toThrow(/no stable release/);
  });

    it("publish link-swap failure leaves state and current link unchanged", () => {
      makeRelease("v1");
      makeRelease("v2");
      publishGatewayVersion("v1", projectsRoot, { stable: true });
      expect(() => publishGatewayVersion("v2", projectsRoot, {}, {
        renameSync: (from, to) => {
          if (String(to).endsWith("/current")) throw new Error("link swap failed");
          return renameSync(from, to);
        },
      })).toThrow(/link swap failed/);
      expect(readGatewayState(projectsRoot).currentVersion).toBe("v1");
      expect(readGatewayCurrentLinkTarget(projectsRoot)).toBe(buildGatewayReleasePath("v1", projectsRoot));
    });

    it("rollback link-swap failure leaves state and current link unchanged", () => {
      makeRelease("v1");
      makeRelease("v2");
      publishGatewayVersion("v1", projectsRoot, { stable: true });
      publishGatewayVersion("v2", projectsRoot);
      expect(() => rollbackGatewayToStable(projectsRoot, {
        renameSync: (from, to) => {
          if (String(to).endsWith("/current")) throw new Error("rollback link swap failed");
          return renameSync(from, to);
        },
      })).toThrow(/rollback link swap failed/);
      expect(readGatewayState(projectsRoot).currentVersion).toBe("v2");
      expect(readGatewayCurrentLinkTarget(projectsRoot)).toBe(buildGatewayReleasePath("v2", projectsRoot));
    });
});

describe("cleanupGatewayReleases (GC)", () => {
  it("protects current + stable; deletes others past maxVersions", () => {
    // Build a stable v1 + extra non-protected releases, then publish v4 → cleanup
    // should keep current(v4) + stable(v1) + maxVersions(=1) others, deleting the rest.
    makeRelease("v1");
    publishGatewayVersion("v1", projectsRoot, { stable: true });
    // Add v2 and v3 by hand (no publish, so they remain non-protected on disk).
    makeRelease("v2");
    makeRelease("v3");
    makeRelease("v4");
    publishGatewayVersion("v4", projectsRoot);
    const ids = listGatewayReleaseIds(projectsRoot);
    // descending order: v4 (current), v3 (kept by retention=1), v2 (deleted), v1 (stable, protected)
    expect(ids).toContain("v4");
    expect(ids).toContain("v1");
    expect(ids).toContain("v3");
    expect(ids).not.toContain("v2");
  });

  it("respects retention bumped via publishGatewayVersion options", () => {
    makeRelease("v1");
    publishGatewayVersion("v1", projectsRoot, { stable: true });
    makeRelease("v2");
    makeRelease("v3");
    publishGatewayVersion("v3", projectsRoot, { retentionMaxVersions: 5 });
    cleanupGatewayReleases(projectsRoot);
    const ids = listGatewayReleaseIds(projectsRoot);
    expect(ids.sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("persists retention passed directly to cleanup", () => {
    makeRelease("v1");
    publishGatewayVersion("v1", projectsRoot, { stable: true });
    makeRelease("v2");
    makeRelease("v3");
    makeRelease("v4");
    cleanupGatewayReleases(projectsRoot, { retentionMaxVersions: 2 });
    expect(readGatewayState(projectsRoot).retention.maxVersions).toBe(2);
    const ids = listGatewayReleaseIds(projectsRoot);
    expect(ids.sort()).toEqual(["v1", "v3", "v4"]);
  });
});

describe("audit ndjson", () => {
  it("appendGatewayAudit appends one JSON line per call", () => {
    appendGatewayAudit({ action: "test1" }, projectsRoot, { now: () => new Date("2026-06-23T00:00:00Z") });
    appendGatewayAudit({ action: "test2" }, projectsRoot, { now: () => new Date("2026-06-23T00:00:01Z") });
    const lines = readFileSync(buildGatewayAuditPath(projectsRoot), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ action: "test1", at: "2026-06-23T00:00:00.000Z" });
    expect(JSON.parse(lines[1]!)).toEqual({ action: "test2", at: "2026-06-23T00:00:01.000Z" });
  });

  it("publish/set-stable/rollback emit audit entries", () => {
    makeRelease("v1");
    makeRelease("v2");
    publishGatewayVersion("v1", projectsRoot, { stable: true });
    publishGatewayVersion("v2", projectsRoot);
    setStableGatewayVersion("v2", projectsRoot);
    rollbackGatewayToStable(projectsRoot);
    const lines = readFileSync(buildGatewayAuditPath(projectsRoot), "utf8").trim().split("\n");
    const actions = lines.map((l) => JSON.parse(l).action as string);
    expect(actions).toContain("publish");
    expect(actions).toContain("set-stable");
    expect(actions).toContain("rollback");
  });
});

describe("listGatewayReleases", () => {
  it("annotates current + stable correctly", () => {
    makeRelease("v1");
    makeRelease("v2");
    publishGatewayVersion("v1", projectsRoot, { stable: true });
    publishGatewayVersion("v2", projectsRoot);
    const releases = listGatewayReleases(projectsRoot);
    const v1 = releases.find((r) => r.versionId === "v1")!;
    const v2 = releases.find((r) => r.versionId === "v2")!;
    expect(v1.stable).toBe(true);
    expect(v1.current).toBe(false);
    expect(v2.stable).toBe(false);
    expect(v2.current).toBe(true);
  });
});

describe("pointGatewayCurrent (atomic symlink)", () => {
  it("re-pointing replaces the link target without leaving tmp files", () => {
    makeRelease("v1");
    makeRelease("v2");
    pointGatewayCurrent("v1", projectsRoot);
    expect(readGatewayCurrentLinkTarget(projectsRoot)).toBe(buildGatewayReleasePath("v1", projectsRoot));
    pointGatewayCurrent("v2", projectsRoot);
    expect(readGatewayCurrentLinkTarget(projectsRoot)).toBe(buildGatewayReleasePath("v2", projectsRoot));
    const runtimeEntries = readdirSync(resolve(projectsRoot, "gateway/runtime"));
    expect(runtimeEntries.some((entry) => entry.includes(".tmp"))).toBe(false);
  });
});

describe("state.json corruption", () => {
  it("readGatewayState throws (not silently resets) when state.json is unparseable", () => {
    // Pre-fix behavior would catch JSON.parse and return createEmptyGatewayState(),
    // which loses stableVersion on the next publish. We now surface corruption so
    // an operator can recover from audit.ndjson.
    const statePath = buildGatewayStatePath(projectsRoot);
    mkdirSync(resolve(statePath, ".."), { recursive: true });
    writeFileSync(statePath, "{not-valid-json", "utf8");
    expect(() => readGatewayState(projectsRoot)).toThrow(/gateway state corrupt/);
  });
});
