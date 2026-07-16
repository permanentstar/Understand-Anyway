/**
 * Dashboard subcommand dispatcher. Owns the public surface
 *   `dashboard {start | build-dist | stop | stop-all | status}`
 * plus the hidden daemon entrypoint
 *   `dashboard-server` (used internally by `dashboard start`).
 *
 * Isolation: this module + `dashboard-prod/**` is the only OSS code allowed to
 * import the lifecycle daemon path; the main pipeline (build/serve/gateway)
 * never reaches into here. See §D-isolation in the master plan.
 */

import { resolve } from "node:path";
import type { DashboardArgs } from "../args.js";
import { CLI_ENTRY } from "../cli-entry.js";
import { loadResolvedConfig } from "../config/load.js";
import { resolveProjectContext, resolveProjectDistDir, resolveProjectsRoot } from "../project-context.js";
import { buildDashboardDist } from "./build-dashboard-dist.js";
import { runDashboardStart, type DashboardStartArgs, type DashboardStartDeps } from "./dashboard-start.js";
import {
  runDashboardStatus,
  runDashboardStop,
  runDashboardStopAll,
  type DashboardStopAllDeps,
  type DashboardStopDeps,
} from "./dashboard-stop.js";

export interface RunDashboardDeps {
  /** Override the CLI entry path used to spawn the hidden daemon. */
  cliEntry?: string;
  /** Forwarded to {@link runDashboardStart}. */
  startDeps?: Partial<DashboardStartDeps>;
  /** Forwarded to {@link runDashboardStop}. */
  stopDeps?: DashboardStopDeps;
  /** Forwarded to {@link runDashboardStopAll}. */
  stopAllDeps?: DashboardStopAllDeps;
  /** Logger; defaults to stdout. */
  log?: (message: string) => void;
}

export async function runDashboard(args: DashboardArgs, deps: RunDashboardDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));

  if (args.action === "start") {
    const ctx = resolveProjectContext(args.projectId);
    // When `--plugin-root` is supplied, `runDashboardStart` will invoke
    // buildDashboardDist which now (Method A) only ever writes to the flat
    // staging location. Point serve at the flat staging so the built-vs-served
    // consistency check inside `runDashboardStart` passes. Without --plugin-root,
    // no rebuild happens, so keep the versioned-current preference so callers
    // that have already published see the promoted dist.
    const distDir = args.pluginRoot
      ? resolve(ctx.stateRoot, "dashboard-dist")
      : resolveProjectDistDir(ctx.stateRoot);
    const configPath = args.config ? resolve(args.config) : ctx.deployConfigPath;
    const config = args.portal
      ? loadResolvedConfig({ config: configPath, configExplicit: Boolean(args.config) })
      : {};
    const startArgs: DashboardStartArgs = {
      stateDir: ctx.stateRoot,
      distDir,
      projectRoot: args.projectRoot ? resolve(args.projectRoot) : ctx.repoPath,
      host: args.host,
      port: args.port,
      token: args.token,
      noOpen: args.noOpen,
      config: configPath,
      configExplicit: Boolean(args.config),
      serveProfile: args.serveProfile,
      portal: args.portal,
      projectRoute: args.projectRoute,
      registryPath: args.registryPath ? resolve(args.registryPath) : null,
      portalAssetsRoot: ctx.portalAssetsRoot,
      portalAssetsSubdir: config.gateway?.portalAssetsSubdir ?? null,
      projectsConfigPath: ctx.projectsConfigPath,
      pluginRoot: args.pluginRoot ? resolve(args.pluginRoot) : null,
      rebuildDashboard: args.rebuildDashboard,
    };
    const cliEntry = deps.cliEntry ?? CLI_ENTRY;
    await runDashboardStart(startArgs, { cliEntry, log, ...(deps.startDeps ?? {}) });
    return;
  }
  if (args.action === "build-dist") {
    const ctx = resolveProjectContext(args.projectId);
    // Auto-resolve upstream plugin root when not supplied, matching the `build`
    // command so nightly/prod (where UA_PLUGIN_ROOT is unset) still works.
    const { bootstrapUpstream } = await import("@understand-anyway/core");
    const upstream = await bootstrapUpstream({
      pluginRoot: args.pluginRoot ?? null,
      requireSkillDir: true,
      assertContract: false,
    });
    log(`resolving upstream plugin${args.pluginRoot ? ` (--plugin-root ${args.pluginRoot})` : ""}`);
    log(`upstream plugin: ${upstream.pluginRoot}`);
    await buildDashboardDist(upstream.pluginRoot, ctx.stateRoot, {
      force: args.rebuildDashboard,
      log,
    });
    return;
  }
  if (args.action === "stop") {
    const ctx = resolveProjectContext(args.projectId);
    await runDashboardStop(ctx.stateRoot, { log, ...(deps.stopDeps ?? {}) });
    return;
  }
  if (args.action === "stop-all") {
    await runDashboardStopAll(resolve(args.projectsRoot), { log, ...(deps.stopAllDeps ?? {}) });
    return;
  }
  if (args.action === "status") {
    if (args.projectId) {
      const ctx = resolveProjectContext(args.projectId);
      const entries = runDashboardStatus({ stateRoot: ctx.stateRoot });
      printStatus(entries, log);
      return;
    }
    const projectsRoot = args.projectsRoot ? resolve(args.projectsRoot) : resolveProjectsRoot();
    const entries = runDashboardStatus({ projectsRoot });
    printStatus(entries, log);
    return;
  }
  if (args.action === "dev") {
    // D3-dev: dispatched from cli.ts via dynamic import to keep dashboard-dev/
    // physically isolated from dashboard-prod/ (see scripts/lint-isolation.mjs).
    // Reaching this branch means cli.ts forgot to intercept; surface loudly.
    throw new Error("dashboard: dev must be intercepted by cli.ts before runDashboard");
  }
  // exhaustiveness guard
  const _exhaustive: never = args;
  throw new Error(`dashboard: unknown action: ${(args as { action: string }).action}`);
}

function printStatus(entries: ReturnType<typeof runDashboardStatus>, log: (m: string) => void): void {
  if (entries.length === 0) {
    log("no dashboards");
    return;
  }
  for (const e of entries) {
    const head = `${e.status.padEnd(7)} ${e.stateRoot}`;
    if (e.info) log(`${head}  pid=${e.info.pid} url=${e.info.url}`);
    else log(head);
  }
}
