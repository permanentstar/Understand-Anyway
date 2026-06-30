import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runDashboardStatus,
  runDashboardStop,
  runDashboardStopAll,
  type DashboardStatusEntry,
} from "./dashboard-stop.js";
import { writeDashboardPid } from "../dashboard-shared/pid-store.js";

let projectsRoot: string;
let stateRootA: string;
let stateRootB: string;

beforeEach(() => {
  projectsRoot = mkdtempSync(resolve(tmpdir(), "ua-dash-stop-"));
  stateRootA = resolve(projectsRoot, "projects", "alpha");
  stateRootB = resolve(projectsRoot, "projects", "beta");
  mkdirSync(stateRootA, { recursive: true });
  mkdirSync(stateRootB, { recursive: true });
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
});

function writeAlive(stateRoot: string, pid = 4242, token = "t") {
  writeDashboardPid(stateRoot, {
    pid,
    host: "127.0.0.1",
    port: 9999,
    token,
    distDir: "/tmp/dist",
    stateRoot,
    url: `http://127.0.0.1:9999/?token=${token}`,
    startedAt: "2026-06-23T00:00:00Z",
  });
}

describe("runDashboardStop", () => {
  it("missing — returns missing outcome with no kill", async () => {
    const kill = vi.fn();
    const result = await runDashboardStop(stateRootA, { kill, log: vi.fn() });
    expect(result.outcome).toBe("missing");
    expect(kill).not.toHaveBeenCalled();
  });

  it("already-dead — cleans pid file, no kill", async () => {
    writeAlive(stateRootA, 1);
    const kill = vi.fn();
    const result = await runDashboardStop(stateRootA, {
      kill,
      isPidAlive: () => false,
      log: vi.fn(),
    });
    expect(result.outcome).toBe("already-dead");
    expect(kill).not.toHaveBeenCalled();
  });

  it("graceful — SIGTERM then probe-dead before SIGKILL", async () => {
    writeAlive(stateRootA, 100);
    let killCount = 0;
    const kill = vi.fn(() => { killCount += 1; return true; });
    let alive = true;
    const probe = vi.fn(() => alive);
    const sleep = vi.fn(async () => { alive = false; });
    const result = await runDashboardStop(stateRootA, {
      kill,
      isPidAlive: probe,
      sleep: sleep as never,
      log: vi.fn(),
      graceMs: 1000,
      pollMs: 10,
    });
    expect(result.outcome).toBe("stopped-graceful");
    expect(kill).toHaveBeenCalledWith(100, "SIGTERM");
    expect(killCount).toBe(1);
  });

  it("kill — escalates to SIGKILL after grace expires", async () => {
    writeAlive(stateRootA, 200);
    const calls: NodeJS.Signals[] = [];
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => { calls.push(signal); return true; });
    const result = await runDashboardStop(stateRootA, {
      kill,
      isPidAlive: () => true, // never dies
      sleep: async () => {},  // tight loop
      log: vi.fn(),
      graceMs: 5,
      pollMs: 1,
    });
    expect(result.outcome).toBe("stopped-killed");
    expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("runDashboardStopAll", () => {
  it("scans projectsRoot and stops each daemon found", async () => {
    writeAlive(stateRootA, 100);
    writeAlive(stateRootB, 101);
    const kill = vi.fn();
    const { results } = await runDashboardStopAll(projectsRoot, {
      kill,
      isPidAlive: () => false,
      log: vi.fn(),
    });
    expect(results.length).toBe(2);
    for (const r of results) expect(r.outcome).toBe("already-dead");
  });

  it("ignores subdirs without a dashboard pid", async () => {
    writeAlive(stateRootA, 100);
    // beta/ has no pid file
    const { results } = await runDashboardStopAll(projectsRoot, {
      kill: vi.fn(),
      isPidAlive: () => false,
      log: vi.fn(),
    });
    expect(results.length).toBe(1);
    expect(results[0]!.stateRoot).toBe(stateRootA);
  });

  it("returns empty when projectsRoot is missing", async () => {
    const missing = resolve(projectsRoot, "does-not-exist");
    const { results } = await runDashboardStopAll(missing, { log: vi.fn() });
    expect(results).toEqual([]);
  });
});

describe("runDashboardStatus", () => {
  it("single — alive when probe says so", () => {
    writeAlive(stateRootA, 1);
    const out = runDashboardStatus({ stateRoot: stateRootA }, { isPidAlive: () => true });
    expect(out.length).toBe(1);
    expect(out[0]!.status).toBe("alive");
  });

  it("single — dead when probe says so", () => {
    writeAlive(stateRootA, 1);
    const out = runDashboardStatus({ stateRoot: stateRootA }, { isPidAlive: () => false });
    expect(out[0]!.status).toBe("dead");
  });

  it("single — missing when no pid file", () => {
    const out = runDashboardStatus({ stateRoot: stateRootA });
    expect(out[0]!.status).toBe("missing");
  });

  it("scan — only returns dirs that have a pid file", () => {
    writeAlive(stateRootA, 1);
    const out = runDashboardStatus({ projectsRoot }, { isPidAlive: () => true });
    const stateRoots: string[] = out.map((e: DashboardStatusEntry) => e.stateRoot);
    expect(stateRoots).toEqual([stateRootA]);
  });

  it("scan — empty when projectsRoot is missing", () => {
    const out = runDashboardStatus({ projectsRoot: resolve(projectsRoot, "missing") });
    expect(out).toEqual([]);
  });
});
