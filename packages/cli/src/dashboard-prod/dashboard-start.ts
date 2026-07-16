/**
 * `dashboard start` — single-instance daemon launcher.
 *
 * Ensures one running gateway daemon per project (keyed by stateRoot). When a
 * matching live daemon already exists (same stateRoot + distDir), reuse it and
 * print the URL; otherwise spawn the hidden `dashboard-server` subcommand,
 * await an IPC `ready` signal, and persist its pid file.
 *
 * Optionally opens the resulting URL in the default browser. Both browser
 * opening and the spawn primitive are injectable so tests stay deterministic.
 *
 * Isolation: this module lives under `dashboard-prod/**` and may import the
 * shared primitives (`dashboard-shared/**`). The lint:isolation guard prevents
 * the main pipeline (`build.ts` / `serve.ts` / `gateway/src/**`) from importing
 * back into here.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { existsSync as nodeExistsSync, openSync as nodeOpenSync, mkdirSync as nodeMkdirSync } from "node:fs";
import {
  isPidAlive,
  readDashboardPid,
  removeDashboardPid,
  writeDashboardPid,
  type DashboardPidInfo,
} from "../dashboard-shared/pid-store.js";
import { openBrowser, type OpenBrowserDeps } from "../dashboard-shared/open-browser.js";
import { redactTokenInUrl, urlHostFor } from "../dashboard-shared/url.js";
import {
  buildDashboardDist,
  type BuildDashboardDistDeps,
  type BuildDashboardDistResult,
} from "./build-dashboard-dist.js";

/** Subcommand name used to dispatch the daemon body inside the same CLI binary. */
export const DASHBOARD_SERVER_SUBCOMMAND = "dashboard-server";
/** IPC message the daemon sends once the gateway is listening. */
export interface DashboardReadyMessage {
  type: "dashboard-ready";
  host: string;
  port: number;
  url: string;
}
/** IPC message the daemon sends when startup fails. */
export interface DashboardFailedMessage {
  type: "dashboard-failed";
  reason: string;
}

export type DashboardDaemonMessage = DashboardReadyMessage | DashboardFailedMessage;

export interface DashboardStartArgs {
  /** Project state root (where .understand-anything/ lives). */
  stateDir: string;
  /** Pre-built dashboard-dist directory served as static. */
  distDir: string;
  /** Source repo root (used to relativize served graph paths). */
  projectRoot: string | null;
  host: string;
  port: number;
  /** Pre-supplied runtime token; auto-generated when omitted. */
  token: string | null;
  /** When true, do not open the default browser. */
  noOpen: boolean;
  /** Forwarded to the daemon for record-provider wiring (passed through to serve). */
  config: string | null;
  /** True only when config came from a user-supplied --config flag. Derived default paths stay optional. */
  configExplicit?: boolean;
  serveProfile: string | null;
  /** Forwarded to `serve` so a shared daemon can serve the portal landing page. */
  portal?: boolean;
  /** Forwarded to `serve` so a shared daemon can serve `/project/<id>/...`. */
  projectRoute?: boolean;
  /** Shared registry path used by portal/project-route. */
  registryPath?: string | null;
  /**
   * Two-tier convention: when supplied, the spawned daemon honors this value
   * via the `UA_PORTAL_ASSETS_ROOT` env var instead of re-deriving from
   * `UA_PROJECTS_ROOT`. Pre-resolved in the dispatcher so a single source of
   * truth crosses the IPC boundary.
   */
  portalAssetsRoot?: string | null;
  /** Optional relative subdir under `<projectsRoot>/gateway/portal-assets/`. */
  portalAssetsSubdir?: string | null;
  /** Two-tier convention: pre-resolved `<projectsRoot>/gateway/config/projects.json`. */
  projectsConfigPath?: string | null;
  /** When set, ensure dashboard-dist/ exists by patching + building from this upstream plugin root. */
  pluginRoot?: string | null;
  /** When true, force-rebuild dashboard-dist/ even if it already exists. */
  rebuildDashboard?: boolean;
}

export interface DashboardStartDeps {
  /** Override `child_process.spawn` (tests). */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Resolved absolute path of the CLI entry; the daemon dispatches via this. */
  cliEntry: string;
  /** Override Node executable used to host the daemon. Defaults to `process.execPath`. */
  nodeBin?: string;
  /** Override the runtime-token generator (tests). */
  generateToken?: () => string;
  /** Override the wall clock used for `startedAt`. */
  now?: () => Date;
  /** Open-browser helpers (tests). */
  openBrowser?: typeof openBrowser;
  openBrowserDeps?: OpenBrowserDeps;
  /** Where logs are written (defaults to <stateRoot>/.understand-anything/dashboard.log). */
  log?: (message: string) => void;
  /** Fail fast after N ms waiting for `dashboard-ready`. Default 30_000. */
  readyTimeoutMs?: number;
  /** Override the dashboard-dist builder (tests). */
  buildDashboardDist?: typeof buildDashboardDist;
  /** Forwarded to {@link buildDashboardDist}. */
  buildDashboardDistDeps?: BuildDashboardDistDeps;
}

export interface DashboardStartResult {
  /** Whether an existing live daemon was reused (true) or a new one spawned (false). */
  reused: boolean;
  info: DashboardPidInfo;
}

function defaultGenerateToken(): string {
  return randomBytes(32).toString("hex");
}

function buildUrl(host: string, port: number, token: string): string {
  return `http://${urlHostFor(host)}:${port}/?token=${token}`;
}

function resolveOptionalPath(path: string | null | undefined): string | null {
  return path ? resolve(path) : null;
}

function normalizeOptionalSubdir(path: string | null | undefined): string | null {
  const normalized = String(path ?? "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return normalized || null;
}

function forwardedConfigPath(args: Pick<DashboardStartArgs, "config" | "configExplicit">): string | null {
  return args.config && args.configExplicit !== false ? args.config : null;
}

function optionalDerivedConfigPath(args: Pick<DashboardStartArgs, "config" | "configExplicit">): string | null {
  return args.config && args.configExplicit === false ? resolve(args.config) : null;
}

/**
 * Whether an existing pid file describes a live daemon serving the same
 * stateRoot/distDir we'd otherwise spawn — i.e. safe to reuse.
 */
export function shouldReuseDashboard(
  args: DashboardStartArgs,
  existing: DashboardPidInfo | null,
  deps: { isPidAlive?: (pid: number) => boolean } = {},
): existing is DashboardPidInfo {
  if (!existing) return false;
  const stateRoot = resolve(args.stateDir);
  const distDir = resolve(args.distDir);
  if (resolve(existing.stateRoot) !== stateRoot) return false;
  if (resolve(existing.distDir) !== distDir) return false;
  if (existing.host !== args.host) return false;
  if (args.port !== 0 && existing.port !== args.port) return false;
  if ((existing.metadata?.serveProfile ?? null) !== (args.serveProfile ?? null)) return false;
  if (Boolean(existing.metadata?.portal) !== Boolean(args.portal)) return false;
  if (Boolean(existing.metadata?.projectRoute) !== Boolean(args.projectRoute)) return false;
  if (resolveOptionalPath(existing.metadata?.registryPath) !== resolveOptionalPath(args.registryPath)) return false;
  if (resolveOptionalPath(existing.metadata?.configPath) !== resolveOptionalPath(forwardedConfigPath(args))) return false;
  if (resolveOptionalPath(existing.metadata?.portalAssetsRoot) !== resolveOptionalPath(args.portalAssetsRoot)) return false;
  if (normalizeOptionalSubdir(existing.metadata?.portalAssetsSubdir) !== normalizeOptionalSubdir(args.portalAssetsSubdir)) return false;
  if (resolveOptionalPath(existing.metadata?.projectsConfigPath) !== resolveOptionalPath(args.projectsConfigPath)) return false;
  return isPidAlive(existing.pid, { isPidAlive: deps.isPidAlive });
}

interface SpawnDaemonOptions {
  args: DashboardStartArgs;
  token: string;
  deps: DashboardStartDeps;
}

interface SpawnDaemonResult {
  child: ChildProcess;
  ready: DashboardReadyMessage;
}

/**
 * Spawn the daemon and resolve when it announces readiness via IPC. Rejects
 * on `dashboard-failed` IPC, premature close, or readiness timeout.
 */
function spawnDaemon(options: SpawnDaemonOptions): Promise<SpawnDaemonResult> {
  const { args, token, deps } = options;
  const spawn = deps.spawn ?? nodeSpawn;
  const nodeBin = deps.nodeBin ?? process.execPath;
  const stateRoot = resolve(args.stateDir);
  const distDir = resolve(args.distDir);

  const childArgs = [
    deps.cliEntry,
    DASHBOARD_SERVER_SUBCOMMAND,
    "--state-dir",
    stateRoot,
    "--dist-dir",
    distDir,
    "--token",
    token,
    "--host",
    args.host,
    "--port",
    String(args.port),
  ];
  if (args.projectRoot) childArgs.push("--project-root", resolve(args.projectRoot));
  const configPath = forwardedConfigPath(args);
  if (configPath) childArgs.push("--config", configPath);
  if (args.serveProfile) childArgs.push("--serve-profile", args.serveProfile);
  if (args.portal) childArgs.push("--portal");
  if (args.projectRoute) childArgs.push("--project-route");
  if (args.registryPath) childArgs.push("--registry", resolve(args.registryPath));

  // Daemon stdio: ignore stdin, append child stdout+stderr to dashboard.log so
  // tail -f works after the parent exits. fork's IPC channel comes from
  // `stdio: [...,'ipc']`.
  const logPath = resolve(stateRoot, ".understand-anything", "dashboard.log");
  // Ensure the dir exists before openSync.
  nodeMkdirSync(resolve(stateRoot, ".understand-anything"), { recursive: true });
  const outFd = nodeOpenSync(logPath, "a");
  // Pre-resolved two-tier convention paths cross the IPC boundary via env so
  // the daemon honors the dispatcher's view (instead of re-resolving from its
  // own `UA_PROJECTS_ROOT`, which may differ if the operator passed an
  // explicit override at the dispatcher level).
  const childEnv = { ...process.env };
  if (args.portalAssetsRoot) childEnv.UA_PORTAL_ASSETS_ROOT = resolve(args.portalAssetsRoot);
  if (normalizeOptionalSubdir(args.portalAssetsSubdir)) {
    childEnv.UA_PORTAL_ASSETS_SUBDIR = normalizeOptionalSubdir(args.portalAssetsSubdir) as string;
  }
  if (args.projectsConfigPath) childEnv.UA_PROJECTS_CONFIG_PATH = resolve(args.projectsConfigPath);
    const derivedConfigPath = optionalDerivedConfigPath(args);
    if (derivedConfigPath && !childEnv.UA_CONFIG && nodeExistsSync(derivedConfigPath)) {
      childEnv.UA_CONFIG = derivedConfigPath;
    }
  const child = spawn(nodeBin, childArgs, {
    detached: true,
    stdio: ["ignore", outFd, outFd, "ipc"],
    env: childEnv,
  });

  return new Promise<SpawnDaemonResult>((resolveReady, rejectReady) => {
    const timeoutMs = deps.readyTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      rejectReady(new Error(`dashboard daemon did not signal ready within ${timeoutMs}ms`));
      try { child.kill("SIGTERM"); } catch { /* best effort */ }
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };

    child.on("message", (raw: unknown) => {
      const msg = raw as DashboardDaemonMessage | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "dashboard-ready") {
        cleanup();
        // Detach IPC so the daemon doesn't depend on the parent.
        child.disconnect?.();
        child.unref?.();
        resolveReady({ child, ready: msg });
      } else if (msg.type === "dashboard-failed") {
        cleanup();
        try { child.kill("SIGTERM"); } catch { /* best effort */ }
        rejectReady(new Error(`dashboard daemon failed: ${msg.reason}`));
      }
    });
    child.on("error", (err) => {
      cleanup();
      rejectReady(err);
    });
    child.on("close", (code, signal) => {
      cleanup();
      rejectReady(new Error(`dashboard daemon exited prematurely (code=${code}, signal=${signal ?? "null"})`));
    });
  });
}

export async function runDashboardStart(
  args: DashboardStartArgs,
  deps: DashboardStartDeps,
): Promise<DashboardStartResult> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const stateRoot = resolve(args.stateDir);
  const distDir = resolve(args.distDir);

  // Ensure dashboard-dist exists (patch + build) when an upstream pluginRoot
  // is supplied. Without pluginRoot, the caller is responsible for having
  // built dashboard-dist already (deploy callers, CI fixtures, etc.).
  if (args.pluginRoot) {
    const buildDist = deps.buildDashboardDist ?? buildDashboardDist;
    const built: BuildDashboardDistResult = await buildDist(args.pluginRoot, stateRoot, {
      ...(deps.buildDashboardDistDeps ?? {}),
      log,
      force: Boolean(args.rebuildDashboard),
    });
    if (resolve(built.distDir) !== distDir) {
      throw new Error(
        `--dist-dir (${distDir}) does not match the location buildDashboardDist produced (${built.distDir})`,
      );
    }
  }

  const existing = readDashboardPid(stateRoot);
  if (shouldReuseDashboard(args, existing, { isPidAlive: undefined })) {
    log(`dashboard already running: ${redactTokenInUrl(existing.url)}`);
    if (!args.noOpen) {
      const op = deps.openBrowser ?? openBrowser;
      op(existing.url, deps.openBrowserDeps);
    }
    return { reused: true, info: existing };
  }

  // Stale pid? Clean it up before spawning.
  if (existing) removeDashboardPid(stateRoot);

  const token = args.token ?? (deps.generateToken ?? defaultGenerateToken)();
  const { child, ready } = await spawnDaemon({ args, token, deps });
  if (!child.pid) {
    throw new Error("dashboard start: daemon spawned without a pid");
  }
  const startedAt = (deps.now ?? (() => new Date()))().toISOString();
  const info: DashboardPidInfo = {
    pid: child.pid,
    host: ready.host,
    port: ready.port,
    token,
    distDir,
    stateRoot,
    url: ready.url || buildUrl(ready.host, ready.port, token),
    startedAt,
    metadata: {
      serveProfile: args.serveProfile ?? null,
      portal: Boolean(args.portal),
      projectRoute: Boolean(args.projectRoute),
      registryPath: resolveOptionalPath(args.registryPath),
      configPath: resolveOptionalPath(forwardedConfigPath(args)),
      portalAssetsRoot: resolveOptionalPath(args.portalAssetsRoot),
      portalAssetsSubdir: normalizeOptionalSubdir(args.portalAssetsSubdir),
      projectsConfigPath: resolveOptionalPath(args.projectsConfigPath),
    },
  };
  writeDashboardPid(stateRoot, info);
  log(`dashboard started: ${redactTokenInUrl(info.url)}`);

  if (!args.noOpen) {
    const op = deps.openBrowser ?? openBrowser;
    op(info.url, deps.openBrowserDeps);
  }
  return { reused: false, info };
}
