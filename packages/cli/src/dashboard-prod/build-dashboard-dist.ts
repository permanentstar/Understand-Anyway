/**
 * `dashboard-dist/` builder — wraps the upstream plugin build.
 *
 * Skips when `<stateRoot>/dashboard-dist/` already exists and is non-empty
 * unless `force` is true (`--rebuild-dashboard`). Otherwise:
 *
 *   1. preparePatchedUpstreamPluginRoot(...) (dashboard-shared) clones the
 *      upstream plugin workspace into a sibling dir under
 *      `<stateRoot>/.understand-anything/`, applies the patch.
 *   2. spawn `pnpm --filter @understand-anything/dashboard^... build` in the
 *      original plugin root so dashboard workspace deps have fresh dist output.
 *   3. spawn `pnpm -C <patched>/packages/dashboard build` (injectable).
 *   4. cp -r the resulting `dist/` into `<stateRoot>/dashboard-dist/`.
 *
 * Failure surfaces with the patchId + upstreamVersion so an upstream bump that
 * regresses the patch is loud, not silent. Implementation lives under
 * `dashboard-prod/`; isolation guard prevents the main pipeline from importing
 * back into here.
 */

import {
  cpSync as nodeCpSync,
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  rmSync as nodeRmSync,
} from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { preparePatchedUpstreamPluginRoot, type DashboardPatchDeps } from "../dashboard-shared/dashboard-patch.js";

export interface BuildDashboardDistDeps {
  /** Override fs.existsSync (tests). */
  existsSync?: typeof nodeExistsSync;
  /** Override fs.readdirSync (tests). */
  readdirSync?: typeof nodeReaddirSync;
  /** Override fs.cpSync used to copy the dist into place (tests). */
  cpSync?: typeof nodeCpSync;
  /** Override fs.rmSync (tests). */
  rmSync?: typeof nodeRmSync;
  /** Override `child_process.spawn` (tests). */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Override the package manager binary; default "pnpm". */
  pnpmBin?: string;
  /** Forwarded to {@link preparePatchedUpstreamPluginRoot}. */
  patchDeps?: DashboardPatchDeps;
  log?: (message: string) => void;
  /** When true, rebuild even if dashboard-dist/ already has content. */
  force?: boolean;
}

export interface BuildDashboardDistResult {
  /** Absolute path to the dashboard-dist directory now serving the gateway. */
  distDir: string;
  /** True when an existing non-empty dashboard-dist was reused. */
  reused: boolean;
  /** Empty when reused; otherwise the patch metadata. */
  patchId: string | null;
  upstreamVersion: string | null;
}

const DASHBOARD_DIST_DIRNAME = "dashboard-dist";

function resolveDashboardDistInstallDir(stateRoot: string, exists: typeof nodeExistsSync): string {
  const versionedCurrent = resolve(stateRoot, "current");
  if (exists(versionedCurrent)) return resolve(versionedCurrent, DASHBOARD_DIST_DIRNAME);
  return resolve(stateRoot, DASHBOARD_DIST_DIRNAME);
}

function distExistsAndPopulated(distDir: string, exists: typeof nodeExistsSync, readdir: typeof nodeReaddirSync): boolean {
  if (!exists(distDir)) return false;
  try {
    const entries = readdir(distDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function spawnBuild(
  pnpmBin: string,
  args: string[],
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess,
  log: (message: string) => void,
  cwd?: string,
  label = "dashboard build",
): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    log(`spawning ${pnpmBin} ${args.join(" ")}`);
    const child = spawn(pnpmBin, args, { cwd, stdio: "inherit" });
    child.on("error", (err) => rejectBuild(err));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveBuild();
      } else {
        rejectBuild(new Error(`${label} failed: code=${code}, signal=${signal ?? "null"}`));
      }
    });
  });
}

export async function buildDashboardDist(
  pluginRoot: string,
  stateRoot: string,
  deps: BuildDashboardDistDeps = {},
): Promise<BuildDashboardDistResult> {
  const exists = deps.existsSync ?? nodeExistsSync;
  const readdir = deps.readdirSync ?? nodeReaddirSync;
  const cp = deps.cpSync ?? nodeCpSync;
  const rm = deps.rmSync ?? nodeRmSync;
  const spawn = deps.spawn ?? nodeSpawn;
  const pnpmBin = deps.pnpmBin ?? "pnpm";
  const log = deps.log ?? (() => {});

  const distDir = resolveDashboardDistInstallDir(stateRoot, exists);

  if (!deps.force && distExistsAndPopulated(distDir, exists, readdir)) {
    log(`dashboard-dist exists at ${distDir}; skipping build (pass --rebuild-dashboard to force)`);
    return { distDir, reused: true, patchId: null, upstreamVersion: null };
  }

  // Patch upstream plugin workspace.
  const prepared = preparePatchedUpstreamPluginRoot(pluginRoot, stateRoot, { ...(deps.patchDeps ?? {}), log });

  // Upstream 2.8+ dashboard is part of a pnpm workspace and can resolve
  // sibling packages through package exports -> dist/*.
  await spawnBuild(
    pnpmBin,
    ["--filter", "@understand-anything/dashboard^...", "build"],
    spawn,
    log,
    pluginRoot,
    "dashboard workspace dependency build",
  );

  // Build the dashboard package inside the patched workspace.
  await spawnBuild(
    pnpmBin,
    ["-C", prepared.dashboardDir, "build"],
    spawn,
    log,
    undefined,
    "dashboard build",
  );

  // Copy the built dist into <stateRoot>/dashboard-dist/.
  const builtDist = resolve(prepared.dashboardDir, "dist");
  if (!exists(builtDist)) {
    throw new Error(`dashboard build-dist: build succeeded but produced no output at ${builtDist}`);
  }
  if (deps.force && exists(distDir)) rm(distDir, { recursive: true, force: true });
  cp(builtDist, distDir, { recursive: true, force: true });
  log(`dashboard-dist installed at ${distDir} (patchId=${prepared.patchId}, upstream=${prepared.upstreamVersion})`);

  return {
    distDir,
    reused: false,
    patchId: prepared.patchId,
    upstreamVersion: prepared.upstreamVersion,
  };
}
