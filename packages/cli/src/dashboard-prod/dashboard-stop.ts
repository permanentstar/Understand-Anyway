/**
 * `dashboard stop` / `dashboard stop-all` / `dashboard status` —
 * lifecycle commands for daemons started by {@link runDashboardStart}.
 *
 * stop:      SIGTERM → poll alive → 5s grace → SIGKILL → remove pid file.
 * stop-all:  scan `<projects-root>/projects/<project>/.understand-anything/dashboard.pid`
 *            and run stop for each. The projects-root is purely a discovery
 *            convention — pass `--projects-root <dir>`. There is no implicit
 *            absolute path; the default callers wire is `~/understand-projects`.
 * status:    list all known daemons with alive/dead/missing classification.
 */

import { readdirSync as nodeReaddirSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultIsPidAlive,
  readDashboardPid,
  removeDashboardPid,
  type DashboardPidInfo,
} from "../dashboard-shared/pid-store.js";
import { buildProjectStateRoot } from "../projects-config.js";

export interface DashboardStopDeps {
  /** Inject `process.kill(pid, signal)` (returns true on success). */
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  /** Inject the alive probe used to confirm SIGTERM took effect. */
  isPidAlive?: (pid: number) => boolean;
  /** Inject sleep used between alive polls. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** SIGTERM grace period (ms). Default 5000. */
  graceMs?: number;
  /** Poll interval (ms) inside the grace period. Default 250. */
  pollMs?: number;
}

export type StopOutcome = "stopped-graceful" | "stopped-killed" | "missing" | "already-dead";

export interface StopResult {
  outcome: StopOutcome;
  pid: number | null;
  stateRoot: string;
}

function defaultKill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    return process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function runDashboardStop(
  stateRoot: string,
  deps: DashboardStopDeps = {},
): Promise<StopResult> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const kill = deps.kill ?? defaultKill;
  const probe = deps.isPidAlive ?? defaultIsPidAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const graceMs = deps.graceMs ?? 5000;
  const pollMs = deps.pollMs ?? 250;

  const info = readDashboardPid(stateRoot);
  if (!info) {
    log(`no dashboard pid for ${stateRoot}`);
    return { outcome: "missing", pid: null, stateRoot };
  }

  if (!probe(info.pid)) {
    removeDashboardPid(stateRoot);
    log(`dashboard already exited (pid=${info.pid}); cleaned pid file`);
    return { outcome: "already-dead", pid: info.pid, stateRoot };
  }

  kill(info.pid, "SIGTERM");
  log(`sent SIGTERM to dashboard pid=${info.pid}`);

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!probe(info.pid)) {
      removeDashboardPid(stateRoot);
      log(`dashboard stopped gracefully (pid=${info.pid})`);
      return { outcome: "stopped-graceful", pid: info.pid, stateRoot };
    }
    await sleep(pollMs);
  }

  kill(info.pid, "SIGKILL");
  removeDashboardPid(stateRoot);
  log(`dashboard hard-killed after ${graceMs}ms (pid=${info.pid})`);
  return { outcome: "stopped-killed", pid: info.pid, stateRoot };
}

export interface DashboardStopAllDeps extends DashboardStopDeps {
  /** Override fs.readdirSync (tests). */
  readdirSync?: (path: string, options?: { withFileTypes: true }) => string[] | { name: string; isDirectory(): boolean }[];
  /** Override pid-file existence probe (tests rarely need this). */
  hasDashboard?: (stateRoot: string) => boolean;
}

export interface DashboardStopAllResult {
  results: StopResult[];
}

/**
 * Scan `<projectsRoot>/projects/*` for `.understand-anything/dashboard.pid` files and
 * run stop for each. Subdirectories that don't have one are silently skipped.
 */
export async function runDashboardStopAll(
  projectsRoot: string,
  deps: DashboardStopAllDeps = {},
): Promise<DashboardStopAllResult> {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const readdir = deps.readdirSync ?? ((p, o) => nodeReaddirSync(p, o as { withFileTypes: true }));
  const hasDashboard = deps.hasDashboard ?? ((sr: string) => readDashboardPid(sr) !== null);

  let entries: { name: string; isDirectory(): boolean }[];
  const projectsDir = resolve(projectsRoot, "projects");
  try {
    const raw = readdir(projectsDir, { withFileTypes: true });
    entries = raw as { name: string; isDirectory(): boolean }[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log(`projects-root missing: ${projectsRoot}`);
      return { results: [] };
    }
    throw err;
  }

  const results: StopResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stateRoot = buildProjectStateRoot(projectsRoot, entry.name);
    if (!hasDashboard(stateRoot)) continue;
    results.push(await runDashboardStop(stateRoot, deps));
  }
  return { results };
}

export interface DashboardStatusEntry {
  stateRoot: string;
  /** "alive" / "dead" / "missing" — same projects-root scan classification. */
  status: "alive" | "dead" | "missing";
  info: DashboardPidInfo | null;
}

export interface DashboardStatusDeps {
  isPidAlive?: (pid: number) => boolean;
  readdirSync?: (path: string, options?: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[];
  log?: (message: string) => void;
}

/**
 * Status of a single project (`stateRoot`) or all projects under a
 * `projectsRoot`. Pure read; never touches pid files.
 */
export function runDashboardStatus(
  options: { stateRoot: string } | { projectsRoot: string },
  deps: DashboardStatusDeps = {},
): DashboardStatusEntry[] {
  const probe = deps.isPidAlive ?? defaultIsPidAlive;
  const readdir = deps.readdirSync ?? ((p, o) => nodeReaddirSync(p, o as { withFileTypes: true }) as { name: string; isDirectory(): boolean }[]);

  const classify = (sr: string): DashboardStatusEntry => {
    const info = readDashboardPid(sr);
    if (!info) return { stateRoot: sr, status: "missing", info: null };
    return { stateRoot: sr, status: probe(info.pid) ? "alive" : "dead", info };
  };

  if ("stateRoot" in options) return [classify(options.stateRoot)];

  let entries: { name: string; isDirectory(): boolean }[];
  const projectsDir = resolve(options.projectsRoot, "projects");
  try {
    entries = readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: DashboardStatusEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sr = buildProjectStateRoot(options.projectsRoot, entry.name);
    const e = classify(sr);
    if (e.status !== "missing") out.push(e);
  }
  return out;
}
