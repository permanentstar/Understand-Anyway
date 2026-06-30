import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runDashboardStart,
  shouldReuseDashboard,
  type DashboardStartArgs,
  type DashboardStartDeps,
} from "./dashboard-start.js";
import {
  dashboardPidPath,
  readDashboardPid,
  writeDashboardPid,
  type DashboardPidInfo,
} from "../dashboard-shared/pid-store.js";

let stateRoot: string;
let distDir: string;

beforeEach(() => {
  stateRoot = mkdtempSync(resolve(tmpdir(), "ua-dash-start-state-"));
  distDir = mkdtempSync(resolve(tmpdir(), "ua-dash-start-dist-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(distDir, { recursive: true, force: true });
});

function makeArgs(overrides: Partial<DashboardStartArgs> = {}): DashboardStartArgs {
  return {
    stateDir: stateRoot,
    distDir,
    projectRoot: null,
    host: "127.0.0.1",
    port: 0,
    token: null,
    noOpen: true,
    config: null,
    serveProfile: null,
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  pid = 4242;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  unref(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  disconnect(): void {}
  kill(): boolean {
    this.emit("close", 0, null);
    return true;
  }
}

function fakeSpawnReady(url = "http://127.0.0.1:9999/?token=t") {
  const child = new FakeChild();
  const spawn = vi.fn(() => {
    queueMicrotask(() => child.emit("message", { type: "dashboard-ready", host: "127.0.0.1", port: 9999, url }));
    return child as unknown as ChildProcess;
  });
  return { spawn, child };
}

function makeDeps(overrides: Partial<DashboardStartDeps> = {}): DashboardStartDeps {
  return {
    cliEntry: "/fake/cli.js",
    nodeBin: "/usr/bin/node",
    generateToken: () => "fixed-token",
    now: () => new Date("2026-06-23T00:00:00Z"),
    openBrowser: vi.fn() as never,
    log: vi.fn(),
    readyTimeoutMs: 1000,
    ...overrides,
  };
}

describe("shouldReuseDashboard", () => {
  const baseExisting: DashboardPidInfo = {
    pid: 1,
    host: "127.0.0.1",
    port: 9999,
    token: "t",
    distDir: "",
    stateRoot: "",
    url: "http://127.0.0.1:9999/?token=t",
    startedAt: "2026-06-23T00:00:00Z",
  };

  it("false when no existing pid", () => {
    expect(shouldReuseDashboard(makeArgs(), null)).toBe(false);
  });

  it("false when stateRoot mismatch", () => {
    const args = makeArgs();
    expect(
      shouldReuseDashboard(args, { ...baseExisting, stateRoot: "/other", distDir, pid: 1 }, { isPidAlive: () => true }),
    ).toBe(false);
  });

  it("false when distDir mismatch", () => {
    const args = makeArgs();
    expect(
      shouldReuseDashboard(args, { ...baseExisting, stateRoot, distDir: "/other", pid: 1 }, { isPidAlive: () => true }),
    ).toBe(false);
  });

  it("false when port mismatch", () => {
    const args = makeArgs({ port: 18666 });
    expect(
      shouldReuseDashboard(args, { ...baseExisting, stateRoot, distDir, port: 9999, pid: 1 }, { isPidAlive: () => true }),
    ).toBe(false);
  });

  it("false when serve profile mismatch", () => {
    const args = makeArgs({ serveProfile: "nightly" });
    expect(
      shouldReuseDashboard(
        args,
        { ...baseExisting, stateRoot, distDir, pid: 1, metadata: { serveProfile: "prod" } } as DashboardPidInfo,
        { isPidAlive: () => true },
      ),
    ).toBe(false);
  });

  it("false when portal/project-route/registry mismatch", () => {
    const args = makeArgs({ portal: true, projectRoute: true, registryPath: "/registry.json" });
    expect(
      shouldReuseDashboard(
        args,
        {
          ...baseExisting,
          stateRoot,
          distDir,
          pid: 1,
          metadata: { portal: false, projectRoute: true, registryPath: "/other.json" },
        } as DashboardPidInfo,
        { isPidAlive: () => true },
      ),
    ).toBe(false);
  });

  it("false when pid is dead", () => {
    const args = makeArgs();
    expect(
      shouldReuseDashboard(args, { ...baseExisting, stateRoot, distDir, pid: 1 }, { isPidAlive: () => false }),
    ).toBe(false);
  });

  it("true on full match + alive pid", () => {
    const args = makeArgs({ port: 9999 });
    expect(
      shouldReuseDashboard(
        args,
        {
          ...baseExisting,
          stateRoot,
          distDir,
          pid: 1,
          metadata: { serveProfile: null, portal: false, projectRoute: false, registryPath: null, configPath: null },
        },
        { isPidAlive: () => true },
      ),
    ).toBe(true);
  });

  it("true when requested port is auto-assigned and existing pid has actual port", () => {
    const args = makeArgs({ port: 0 });
    expect(
      shouldReuseDashboard(
        args,
        {
          ...baseExisting,
          stateRoot,
          distDir,
          port: 9999,
          pid: 1,
          metadata: { serveProfile: null, portal: false, projectRoute: false, registryPath: null, configPath: null },
        },
        { isPidAlive: () => true },
      ),
    ).toBe(true);
  });

  it("reuses when both starts carry only a derived optional config path", () => {
    const args = makeArgs({ config: "/projects/gateway/config/deploy.yaml", configExplicit: false, port: 9999 });
    expect(
      shouldReuseDashboard(
        args,
        {
          ...baseExisting,
          stateRoot,
          distDir,
          port: 9999,
          pid: 1,
          metadata: { serveProfile: null, portal: false, projectRoute: false, registryPath: null, configPath: null },
        },
        { isPidAlive: () => true },
      ),
    ).toBe(true);
  });
});

describe("runDashboardStart", () => {
  it("spawns the daemon and writes pid on first start", async () => {
    const { spawn } = fakeSpawnReady();
    const result = await runDashboardStart(makeArgs(), makeDeps({ spawn: spawn as never }));
    expect(result.reused).toBe(false);
    expect(result.info.pid).toBe(4242);
    expect(result.info.token).toBe("fixed-token");
    expect(spawn).toHaveBeenCalledTimes(1);
    const persisted = readDashboardPid(stateRoot);
    expect(persisted?.pid).toBe(4242);
  });

  it("does not forward derived default config paths as explicit daemon --config", async () => {
    const { spawn } = fakeSpawnReady();
    await runDashboardStart(
      makeArgs({ config: "/projects/gateway/config/deploy.yaml", configExplicit: false }),
      makeDeps({ spawn: spawn as never }),
    );
    const childArgs = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(childArgs).not.toContain("--config");
  });

  it("passes an existing derived default config path through optional UA_CONFIG", async () => {
    const configPath = resolve(stateRoot, "gateway/config/deploy.yaml");
    mkdirSync(resolve(stateRoot, "gateway/config"), { recursive: true });
    writeFileSync(configPath, "version: 1\n", "utf8");
    const { spawn } = fakeSpawnReady();
    await runDashboardStart(
      makeArgs({ config: configPath, configExplicit: false }),
      makeDeps({ spawn: spawn as never }),
    );
    const [, childArgs, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(childArgs).not.toContain("--config");
    expect(options.env.UA_CONFIG).toBe(configPath);
  });

  it("does not persist derived default config paths as active daemon config", async () => {
    const { spawn } = fakeSpawnReady();
    await runDashboardStart(
      makeArgs({ config: "/projects/gateway/config/deploy.yaml", configExplicit: false }),
      makeDeps({ spawn: spawn as never }),
    );
    const persisted = readDashboardPid(stateRoot);
    expect(persisted?.metadata?.configPath).toBeNull();
  });

  it("does not reuse a derived-config daemon for a later explicit --config start", async () => {
    writeDashboardPid(stateRoot, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 9999,
      token: "kept",
      distDir,
      stateRoot,
      url: "http://127.0.0.1:9999/?token=kept",
      startedAt: "2026-06-23T00:00:00Z",
      metadata: { serveProfile: null, portal: false, projectRoute: false, registryPath: null, configPath: null },
    });
    const { spawn } = fakeSpawnReady();
    const result = await runDashboardStart(
      makeArgs({ config: "/projects/gateway/config/deploy.yaml", configExplicit: true }),
      makeDeps({ spawn: spawn as never }),
    );
    expect(result.reused).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("forwards explicit daemon --config paths", async () => {
    const { spawn } = fakeSpawnReady();
    await runDashboardStart(
      makeArgs({ config: "/tmp/deploy.yaml", configExplicit: true }),
      makeDeps({ spawn: spawn as never }),
    );
    const childArgs = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(childArgs).toEqual(expect.arrayContaining(["--config", "/tmp/deploy.yaml"]));
  });

  it("redacts the runtime token from the 'dashboard started' log line", async () => {
    // The log goes to stdout which the daemon redirects into dashboard.log, so
    // the printed URL must not carry the raw token. The persisted pid file
    // (info.token / info.url) still contains the token unchanged — gateway
    // stop and reuse depend on it.
    const log = vi.fn();
    const { spawn } = fakeSpawnReady("http://127.0.0.1:9999/?token=raw-secret");
    const result = await runDashboardStart(
      makeArgs(),
      makeDeps({ spawn: spawn as never, log }),
    );
    expect(result.info.url).toContain("token=raw-secret");
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("token=***");
    expect(printed).not.toContain("raw-secret");
  });

  it("redacts the runtime token from the 'dashboard already running' log line", async () => {
    writeDashboardPid(stateRoot, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 9999,
      token: "kept-secret",
      distDir,
      stateRoot,
      url: "http://127.0.0.1:9999/?token=kept-secret",
      startedAt: "2026-06-23T00:00:00Z",
      metadata: { serveProfile: null, portal: false, projectRoute: false, registryPath: null, configPath: null },
    });
    const log = vi.fn();
    const spawn = vi.fn();
    const result = await runDashboardStart(makeArgs(), makeDeps({ spawn: spawn as never, log }));
    expect(result.reused).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("token=***");
    expect(printed).not.toContain("kept-secret");
  });

  it("forwards token / host / port / project-root through to the spawn args", async () => {
    const { spawn } = fakeSpawnReady();
    await runDashboardStart(
      makeArgs({ token: "preset", host: "0.0.0.0", port: 18000, projectRoot: "/repo" }),
      makeDeps({ spawn: spawn as never }),
    );
    const calls = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const callArgs = (calls[0]?.[1] as string[]) ?? [];
    expect(callArgs).toContain("--token");
    expect(callArgs[callArgs.indexOf("--token") + 1]).toBe("preset");
    expect(callArgs[callArgs.indexOf("--host") + 1]).toBe("0.0.0.0");
    expect(callArgs[callArgs.indexOf("--port") + 1]).toBe("18000");
    expect(callArgs[callArgs.indexOf("--project-root") + 1]).toBe("/repo");
  });

  it("reuses an existing live daemon (no spawn)", async () => {
    writeDashboardPid(stateRoot, {
      pid: process.pid,
      host: "127.0.0.1",
      port: 9999,
      token: "kept",
      distDir,
      stateRoot,
      url: "http://127.0.0.1:9999/?token=kept",
      startedAt: "2026-06-23T00:00:00Z",
      metadata: { serveProfile: null, portal: false, projectRoute: false, registryPath: null, configPath: null },
    });
    const spawn = vi.fn();
    const result = await runDashboardStart(makeArgs(), makeDeps({ spawn: spawn as never }));
    expect(result.reused).toBe(true);
    expect(result.info.token).toBe("kept");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("removes a stale pid file before spawning", async () => {
    writeDashboardPid(stateRoot, {
      pid: -1, // dead
      host: "127.0.0.1",
      port: 9999,
      token: "stale",
      distDir,
      stateRoot,
      url: "http://127.0.0.1:9999/?token=stale",
      startedAt: "2026-06-23T00:00:00Z",
    });
    const { spawn } = fakeSpawnReady();
    const result = await runDashboardStart(makeArgs(), makeDeps({ spawn: spawn as never }));
    expect(result.reused).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(readDashboardPid(stateRoot)?.token).toBe("fixed-token");
  });

  it("calls openBrowser unless --no-open", async () => {
    const open = vi.fn();
    const { spawn } = fakeSpawnReady();
    await runDashboardStart(
      makeArgs({ noOpen: false }),
      makeDeps({ spawn: spawn as never, openBrowser: open as never }),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("normalizes wildcard host before opening a fallback ready URL", async () => {
    const open = vi.fn();
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("message", {
        type: "dashboard-ready",
        host: "0.0.0.0",
        port: 18000,
        url: "",
      }));
      return child as unknown as ChildProcess;
    });
    await runDashboardStart(
      makeArgs({ noOpen: false, host: "0.0.0.0", port: 18000, token: "preset" }),
      makeDeps({ spawn: spawn as never, openBrowser: open as never }),
    );
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:18000/?token=preset", undefined);
  });

  it("skips openBrowser when --no-open", async () => {
    const open = vi.fn();
    const { spawn } = fakeSpawnReady();
    await runDashboardStart(
      makeArgs({ noOpen: true }),
      makeDeps({ spawn: spawn as never, openBrowser: open as never }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects when daemon signals failure", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("message", { type: "dashboard-failed", reason: "port in use" }));
      return child as unknown as ChildProcess;
    });
    await expect(
      runDashboardStart(makeArgs(), makeDeps({ spawn: spawn as never })),
    ).rejects.toThrow(/port in use/);
  });

  it("rejects when daemon exits before signaling ready", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 1, null));
      return child as unknown as ChildProcess;
    });
    await expect(
      runDashboardStart(makeArgs(), makeDeps({ spawn: spawn as never })),
    ).rejects.toThrow(/exited prematurely/);
  });

  it("rejects when readiness times out", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcess); // never emits message
    await expect(
      runDashboardStart(makeArgs(), makeDeps({ spawn: spawn as never, readyTimeoutMs: 20 })),
    ).rejects.toThrow(/did not signal ready/);
  });
});

describe("dashboard.pid is written under .understand-anything/", () => {
  it("path matches helper", () => {
    expect(dashboardPidPath(stateRoot)).toContain(".understand-anything/dashboard.pid");
  });
});
