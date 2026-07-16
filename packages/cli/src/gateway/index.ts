/**
 * Gateway subcommand dispatcher. Translates {@link GatewayArgs} into calls
 * against `@understand-anyway/gateway`'s versioning API.
 *
 * Output shape: human-readable for `list` (or `--json` for machine), one-line
 * confirmation for publish / set-stable / rollback / gc.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGatewayReleaseDistPath,
  buildGatewayReleasePath,
  buildGatewayReleaseManifestPath,
  cleanupGatewayReleases,
  createVersionId,
  listGatewayReleases,
  publishGatewayVersion,
  rollbackGatewayToStable,
  setStableGatewayVersion,
  type GatewayReleaseInfo,
  type GatewayVersioningDeps,
} from "@understand-anyway/gateway";
import type { GatewayArgs } from "../args.js";
import { CLI_ENTRY } from "../cli-entry.js";
import {
  buildDeployConfigPath,
  buildGatewayRegistryPath,
  buildGatewayRoot,
  buildPortalAssetsRoot,
  buildProjectsConfigPath,
} from "../projects-config.js";
import { runDashboardStart, type DashboardStartDeps } from "../dashboard-prod/dashboard-start.js";
import { runDashboardStop, type DashboardStopDeps } from "../dashboard-prod/dashboard-stop.js";

export interface RunGatewayDeps {
  versioningDeps?: GatewayVersioningDeps;
  startDeps?: Partial<DashboardStartDeps>;
  stopDeps?: DashboardStopDeps;
  cliEntry?: string;
  log?: (message: string) => void;
}

function resolveCliDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (here.endsWith("/dist")) return here;
  return resolve(here, "..", "..", "dist");
}

function readUpstreamVersion(pluginRoot: string | null): string | null {
  if (!pluginRoot) return null;
  try {
    const pkg = JSON.parse(readFileSync(resolve(pluginRoot, "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function createUniqueGatewayReleaseId(projectsRoot: string): string {
  const base = createVersionId();
  if (!existsSync(buildGatewayReleasePath(base, projectsRoot))) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(buildGatewayReleasePath(candidate, projectsRoot))) return candidate;
  }
  throw new Error(`gateway publish rejected: could not allocate a unique release id for ${base}`);
}

function writeGatewayReleaseManifest(
  manifestPath: string,
  payload: Record<string, unknown>,
): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      builtAt: new Date().toISOString(),
      ...payload,
    }, null, 2),
    "utf8",
  );
}

export function copyInstalledCliPackageRelease(
  packageRoot: string,
  releaseRoot: string,
): void {
  const resolvedPackageRoot = (() => {
    try {
      return realpathSync(packageRoot);
    } catch {
      return packageRoot;
    }
  })();
  const packageJsonPath = resolve(resolvedPackageRoot, "package.json");
  const sameRealpath = (left: string, right: string): boolean => {
    try {
      return realpathSync(left) === realpathSync(right);
    } catch {
      return false;
    }
  };
  if (!existsSync(packageJsonPath)) {
    throw new Error(`gateway publish rejected: installed CLI package root is missing ${packageJsonPath}`);
  }
  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(dirname(releaseRoot), { recursive: true });
  const alreadyPackagedGatewayRelease = existsSync(resolve(resolvedPackageRoot, "manifest.json"));
  cpSync(resolvedPackageRoot, releaseRoot, {
    recursive: true,
    force: true,
    dereference: !alreadyPackagedGatewayRelease,
  });

  let current = resolvedPackageRoot;
  let installedNodeModulesRoot: string | null = null;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    if (basename(parent) === ".pnpm") {
      installedNodeModulesRoot = dirname(parent);
      break;
    }
    current = parent;
  }

  // npm/yarn flat layout: no `.pnpm` store. The CLI package lives at
  // <root>/node_modules/@understand-anyway/cli and its @understand-anyway/*
  // dependencies are hoisted as siblings under the same node_modules root.
  // Copy that whole flat node_modules into the release so the runtime cli.js
  // can resolve its dependencies without the install prefix.
  if (!installedNodeModulesRoot) {
    const flatNodeModulesRoot = dirname(dirname(resolvedPackageRoot));
    if (basename(flatNodeModulesRoot) === "node_modules" && existsSync(flatNodeModulesRoot)) {
      const releaseNodeModules = resolve(releaseRoot, "node_modules");
      rmSync(releaseNodeModules, { recursive: true, force: true });
      cpSync(flatNodeModulesRoot, releaseNodeModules, {
        recursive: true,
        force: true,
        dereference: true,
      });
    }
    return;
  }

  if (!existsSync(resolve(installedNodeModulesRoot, ".pnpm"))) return;

  const releaseNodeModules = resolve(releaseRoot, "node_modules");
  rmSync(releaseNodeModules, { recursive: true, force: true });
  cpSync(installedNodeModulesRoot, releaseNodeModules, {
    recursive: true,
    force: true,
    dereference: false,
  });

  const packageScopedNodeModulesRoot = dirname(dirname(resolvedPackageRoot));
  if (!existsSync(packageScopedNodeModulesRoot)) return;

  for (const entry of readdirSync(packageScopedNodeModulesRoot, { withFileTypes: true })) {
    const name = entry.name;
    if (name === ".bin") continue;
    const sourcePath = resolve(packageScopedNodeModulesRoot, name);
    const targetPath = resolve(releaseNodeModules, name);
    if (entry.isDirectory() && name.startsWith("@")) {
      mkdirSync(targetPath, { recursive: true });
      for (const scopedEntry of readdirSync(sourcePath, { withFileTypes: true })) {
        const scopedSourcePath = resolve(sourcePath, scopedEntry.name);
        const scopedTargetPath = resolve(targetPath, scopedEntry.name);
        if (sameRealpath(scopedSourcePath, scopedTargetPath)) continue;
        cpSync(
          scopedSourcePath,
          scopedTargetPath,
          { recursive: true, force: true, dereference: false },
        );
      }
      continue;
    }
    cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: false });
  }
}

function packageCurrentGatewayRelease(
  projectsRoot: string,
  pluginRoot: string | null,
): string {
  const versionId = createUniqueGatewayReleaseId(projectsRoot);
  const cliDist = resolveCliDistDir();
  const packageRoot = resolve(cliDist, "..");
  const repoRoot = resolve(cliDist, "..", "..", "..");
  const cliEntrypoint = resolve(cliDist, "cli.js");
  if (!existsSync(cliEntrypoint)) {
    throw new Error(`gateway publish rejected: current CLI dist is missing ${cliEntrypoint}; run 'pnpm build' first`);
  }
  const releaseRoot = buildGatewayReleasePath(versionId, projectsRoot);
  const manifestPath = buildGatewayReleaseManifestPath(versionId, projectsRoot);
  if (!existsSync(resolve(repoRoot, "pnpm-workspace.yaml"))) {
    copyInstalledCliPackageRelease(packageRoot, releaseRoot);
    writeGatewayReleaseManifest(manifestPath, {
      versionId,
      nodeVersion: process.version,
      upstreamVersion: readUpstreamVersion(pluginRoot),
      source: "installed-cli-package",
    });
    return versionId;
  }
  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(dirname(releaseRoot), { recursive: true });
  const deploy = spawnSync(
    "pnpm",
    ["--filter", "@understand-anyway/cli", "deploy", "--prod", releaseRoot],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (deploy.error || deploy.status !== 0) {
    const detail = deploy.error
      ? deploy.error.message
      : String(deploy.stderr || deploy.stdout || "").slice(-2000);
    throw new Error(`gateway publish rejected: pnpm deploy failed: ${detail}`);
  }
  writeGatewayReleaseManifest(manifestPath, {
    versionId,
    nodeVersion: process.version,
    upstreamVersion: readUpstreamVersion(pluginRoot),
    source: "current-cli-dist",
  });
  return versionId;
}

function ensureSharedGatewayDist(gatewayRoot: string): string {
  const distDir = resolve(gatewayRoot, "shared-placeholder-dist");
  mkdirSync(distDir, { recursive: true });
  const indexPath = resolve(distDir, "index.html");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, "<!doctype html><html><body>shared gateway placeholder</body></html>\n", "utf8");
  }
  return distDir;
}

export async function runGateway(args: GatewayArgs, deps: RunGatewayDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const projectsRoot = resolve(args.projectsRoot);
  const vd = deps.versioningDeps;

  if (args.action === "start") {
    const gatewayRoot = buildGatewayRoot(projectsRoot);
    const distDir = ensureSharedGatewayDist(gatewayRoot);
    await runDashboardStart({
      stateDir: gatewayRoot,
      distDir,
      projectRoot: null,
      host: args.host,
      port: args.port,
      token: null,
      noOpen: args.noOpen,
      config: args.config ? resolve(args.config) : buildDeployConfigPath(projectsRoot),
      configExplicit: Boolean(args.config),
      serveProfile: args.serveProfile,
      portal: true,
      projectRoute: true,
      registryPath: buildGatewayRegistryPath(projectsRoot),
      portalAssetsRoot: buildPortalAssetsRoot(projectsRoot),
      projectsConfigPath: buildProjectsConfigPath(projectsRoot),
      pluginRoot: null,
      rebuildDashboard: false,
    }, {
      cliEntry: deps.cliEntry ?? CLI_ENTRY,
      log,
      ...(deps.startDeps ?? {}),
    });
    return;
  }
  if (args.action === "stop") {
    await runDashboardStop(buildGatewayRoot(projectsRoot), { log, ...(deps.stopDeps ?? {}) });
    return;
  }
  if (args.action === "publish") {
    const versionId = args.versionId ?? packageCurrentGatewayRelease(
      projectsRoot,
      args.pluginRoot ? resolve(args.pluginRoot) : null,
    );
    const state = publishGatewayVersion(versionId, projectsRoot, {
      stable: args.stable,
      reason: args.reason ?? undefined,
      retentionMaxVersions: args.retain ?? undefined,
    }, vd);
    log(
      `gateway: published ${state.currentVersion}` +
        (state.stableVersion === state.currentVersion ? " [stable]" : "") +
        (state.stablePendingForCurrent ? " (stable still pending — review with `gateway set-stable`)" : ""),
    );
    return;
  }
  if (args.action === "set-stable") {
    const state = setStableGatewayVersion(args.versionId, projectsRoot, vd);
    log(`gateway: stable=${state.stableVersion}`);
    return;
  }
  if (args.action === "rollback") {
    const state = rollbackGatewayToStable(projectsRoot, vd);
    log(`gateway: rolled back; current=${state.currentVersion}`);
    return;
  }
  if (args.action === "list") {
    const releases = listGatewayReleases(projectsRoot, vd);
    if (args.json) {
      log(JSON.stringify(releases, null, 2));
      return;
    }
    if (releases.length === 0) {
      log("no gateway releases");
      return;
    }
    for (const r of releases) renderReleaseLine(r, log);
    return;
  }
  if (args.action === "gc") {
    const deleted = cleanupGatewayReleases(
      projectsRoot,
      args.retain === null ? {} : { retentionMaxVersions: args.retain },
      vd,
    );
    log(deleted.length === 0 ? "gateway: gc — nothing to delete" : `gateway: gc deleted ${deleted.length} release(s): ${deleted.join(", ")}`);
    return;
  }
  // exhaustiveness guard
  const _exhaustive: never = args;
  throw new Error(`unknown gateway action: ${(args as { action: string }).action}`);
}

function renderReleaseLine(r: GatewayReleaseInfo, log: (m: string) => void): void {
  const flags: string[] = [];
  if (r.current) flags.push("current");
  if (r.stable) flags.push("stable");
  const marker = flags.length === 0 ? " " : `[${flags.join(",")}]`;
  log(`${marker.padEnd(20)} ${r.versionId}`);
}
