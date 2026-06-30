import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGatewayReleaseDistPath,
  createEmptyGatewayState,
  readGatewayCurrentLinkTarget,
  readGatewayReleaseManifest,
  readGatewayState,
  writeGatewayState,
} from "@understand-anyway/gateway";
import { runGateway } from "./index.js";

function repoRoot(): string {
  return process.cwd().endsWith("/packages/cli") ? resolve(process.cwd(), "..", "..") : process.cwd();
}

describe("runGateway publish", () => {
  let projectsRoot: string | null = null;

  afterEach(() => {
    if (projectsRoot) rmSync(projectsRoot, { recursive: true, force: true });
    projectsRoot = null;
  });

  it("auto-packages a runnable self-contained release", async () => {
    projectsRoot = mkdtempSync(resolve(tmpdir(), "ua-gateway-publish-"));
    const pluginRoot = resolve(projectsRoot, "plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(resolve(pluginRoot, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");

    const logs: string[] = [];
    await runGateway({
      command: "gateway",
      action: "publish",
      projectsRoot,
      versionId: null,
      stable: false,
      retain: null,
      reason: null,
      gc: true,
      pluginRoot,
    }, {
      log: (message) => logs.push(message),
    });

    const currentLink = readGatewayCurrentLinkTarget(projectsRoot);
    expect(currentLink).toBeTruthy();
    const releaseRoot = currentLink!;
    const manifest = readGatewayReleaseManifest(logs[0]!.match(/published ([^ ]+)/)?.[1] ?? "", projectsRoot);
    expect(manifest?.upstreamVersion).toBe("9.9.9");

    const cliPath = resolve(releaseRoot, "dist", "cli.js");
    const nodeModulesPath = resolve(releaseRoot, "node_modules");
    expect(readFileSync(cliPath, "utf8")).toContain("@understand-anyway/core");
    expect(lstatSync(nodeModulesPath).isSymbolicLink()).toBe(false);
    expect(realpathSync(resolve(nodeModulesPath, "@understand-anyway/core"))).not.toBe(
      realpathSync(resolve(repoRoot(), "packages/core")),
    );

    const helpRun = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
    expect(helpRun.status).toBe(0);

      const firstReleaseRoot = releaseRoot;
      const nestedPublish = spawnSync(
      process.execPath,
      [cliPath, "gateway", "publish", "--projects-root", projectsRoot],
      { encoding: "utf8" },
    );
      expect(nestedPublish.status, nestedPublish.stderr || nestedPublish.stdout).toBe(0);
      const nextLink = readGatewayCurrentLinkTarget(projectsRoot);
      expect(nextLink).toBeTruthy();
      expect(nextLink).not.toBe(firstReleaseRoot);
      const nestedCliPath = resolve(nextLink!, "dist", "cli.js");
      const nestedHelp = spawnSync(process.execPath, [nestedCliPath, "--help"], { encoding: "utf8" });
      expect(nestedHelp.status).toBe(0);
  });
});

describe("runGateway gc", () => {
  let projectsRoot: string | null = null;

  afterEach(() => {
    if (projectsRoot) rmSync(projectsRoot, { recursive: true, force: true });
    projectsRoot = null;
  });

  function makeRelease(versionId: string): void {
    const distDir = buildGatewayReleaseDistPath(versionId, projectsRoot!);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, "cli.js"), "// fake\n", "utf8");
  }

  it("persists --retain for standalone gc", async () => {
    projectsRoot = mkdtempSync(resolve(tmpdir(), "ua-gateway-gc-"));
    makeRelease("v1");
    makeRelease("v2");
    makeRelease("v3");
    const state = createEmptyGatewayState();
    state.currentVersion = "v1";
    writeGatewayState(state, projectsRoot);

    const logs: string[] = [];
    await runGateway({
      command: "gateway",
      action: "gc",
      projectsRoot,
      retain: 2,
    }, {
      log: (message) => logs.push(message),
    });

    expect(readGatewayState(projectsRoot).retention.maxVersions).toBe(2);
    expect(logs[0]).not.toContain("advisory");
  });
});
