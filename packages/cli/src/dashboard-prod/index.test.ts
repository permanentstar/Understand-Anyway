import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectsConfigPath } from "../projects-config.js";
import { runDashboard } from "./index.js";

let projectsRoot: string;

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

beforeEach(() => {
  projectsRoot = mkdtempSync(resolve(tmpdir(), "ua-dashboard-index-"));
  mkdirSync(resolve(projectsRoot, "src", "alpha"), { recursive: true });
  mkdirSync(resolve(projectsRoot, "projects", "alpha", "dashboard-dist"), { recursive: true });
  mkdirSync(resolve(projectsRoot, "gateway", "config"), { recursive: true });
  writeFileSync(
    buildProjectsConfigPath(projectsRoot),
    JSON.stringify({
      version: 1,
      projectBaseDir: resolve(projectsRoot, "src"),
      projects: [{ projectId: "alpha", repoPath: "${projectBaseDir}/${projectId}" }],
    }),
    "utf8",
  );
  vi.stubEnv("UA_PROJECTS_ROOT", projectsRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(projectsRoot, { recursive: true, force: true });
});

function fakeSpawnReady() {
  const child = new FakeChild();
  const spawn = vi.fn(() => {
    queueMicrotask(() => child.emit("message", {
      type: "dashboard-ready",
      host: "127.0.0.1",
      port: 9999,
      url: "http://127.0.0.1:9999/?token=t",
    }));
    return child as unknown as ChildProcess;
  });
  return spawn;
}

describe("runDashboard start", () => {
  it("does not forward derived default deploy config as explicit daemon --config", async () => {
    const spawn = fakeSpawnReady();
    await runDashboard({
      command: "dashboard",
      action: "start",
      projectId: "alpha",
      projectRoot: null,
      host: "127.0.0.1",
      port: 0,
      token: null,
      noOpen: true,
      config: null,
      serveProfile: null,
      portal: false,
      projectRoute: false,
      registryPath: null,
      pluginRoot: null,
      rebuildDashboard: false,
    }, {
      cliEntry: "/fake/cli.js",
      startDeps: {
        spawn: spawn as never,
        nodeBin: "/usr/bin/node",
        generateToken: () => "fixed-token",
        now: () => new Date("2026-06-23T00:00:00Z"),
        readyTimeoutMs: 1000,
      },
      log: () => {},
    });
    const childArgs = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(childArgs).not.toContain("--config");
  });
});
