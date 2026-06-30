/**
 * Dashboard pid file persistence — shared between dashboard-prod (daemon) and
 * dashboard-dev (foreground, optional). Stored at
 * `<stateRoot>/.understand-anything/dashboard.pid` so each project gets its own
 * single-instance lock.
 *
 * Pure side-effect-bearing wrappers around fs + process.kill, with everything
 * mutable injected so tests stay deterministic.
 */

import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { resolve } from "node:path";

export interface DashboardPidInfo {
  pid: number;
  host: string;
  port: number;
  /** Runtime token gating the data API + static. */
  token: string;
  /** Absolute path to the dashboard-dist that this process serves. */
  distDir: string;
  /** Absolute path to the state root (echoes the location). */
  stateRoot: string;
  /** Public access URL including ?token=. */
  url: string;
  /** ISO timestamp the daemon was launched. */
  startedAt: string;
  /** Spawn-time options that affect daemon routing/behavior. */
  metadata?: {
    serveProfile?: string | null;
    portal?: boolean;
    projectRoute?: boolean;
    registryPath?: string | null;
    configPath?: string | null;
    /** Two-tier portal convention: `<projectsRoot>/gateway/portal-assets/`. */
    portalAssetsRoot?: string | null;
    /** Two-tier portal convention: `<projectsRoot>/gateway/config/projects.json`. */
    projectsConfigPath?: string | null;
  };
}

export interface PidStoreDeps {
  existsSync?: (path: string) => boolean;
  mkdirSync?: (path: string, options: { recursive: boolean }) => void;
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
  rmSync?: (path: string, options: { force: boolean }) => void;
  /** `process.kill(pid, 0)` style probe; returns true if the pid is alive. */
  isPidAlive?: (pid: number) => boolean;
}

export const DASHBOARD_PID_FILENAME = "dashboard.pid";
export const UA_DIR_NAME = ".understand-anything";

export function dashboardPidPath(stateRoot: string): string {
  return resolve(stateRoot, UA_DIR_NAME, DASHBOARD_PID_FILENAME);
}

export function writeDashboardPid(
  stateRoot: string,
  info: DashboardPidInfo,
  deps: PidStoreDeps = {},
): void {
  const mkdir = deps.mkdirSync ?? ((p, o) => { nodeMkdirSync(p, o); });
  const write = deps.writeFileSync ?? ((p, d, e) => { nodeWriteFileSync(p, d, e); });
  const path = dashboardPidPath(stateRoot);
  mkdir(resolve(stateRoot, UA_DIR_NAME), { recursive: true });
  write(path, `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export function readDashboardPid(stateRoot: string, deps: PidStoreDeps = {}): DashboardPidInfo | null {
  const exists = deps.existsSync ?? nodeExistsSync;
  const read = deps.readFileSync ?? ((p, e) => nodeReadFileSync(p, e));
  const path = dashboardPidPath(stateRoot);
  if (!exists(path)) return null;
  try {
    const parsed = JSON.parse(read(path, "utf8")) as DashboardPidInfo;
    if (typeof parsed?.pid !== "number" || typeof parsed?.url !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removeDashboardPid(stateRoot: string, deps: PidStoreDeps = {}): void {
  const exists = deps.existsSync ?? nodeExistsSync;
  const rm = deps.rmSync ?? ((p, o) => { nodeRmSync(p, o); });
  const path = dashboardPidPath(stateRoot);
  if (exists(path)) rm(path, { force: true });
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we can't signal — still alive.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function isPidAlive(pid: number, deps: PidStoreDeps = {}): boolean {
  const probe = deps.isPidAlive ?? defaultIsPidAlive;
  return probe(pid);
}
