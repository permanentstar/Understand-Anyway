import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { spawnViteDev, type SpawnViteDeps } from "./spawn-vite.js";

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

function fakeSpawn(): {
  spawn: SpawnViteDeps["spawn"] & ReturnType<typeof vi.fn>;
  child: FakeChild;
} {
  const child = new FakeChild();
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  return { spawn: spawn as never, child };
}

describe("spawnViteDev", () => {
  it("invokes pnpm exec vite with --host/--port and the dashboard directory", async () => {
    const { spawn, child } = fakeSpawn();
    const handle = spawnViteDev(
      { dashboardDir: "/patched/packages/dashboard", host: "0.0.0.0", port: 5174 },
      { spawn, pnpmBin: "fake-pnpm", log: () => {} },
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawn.mock.calls[0]!;
    expect(cmd).toBe("fake-pnpm");
    expect(args).toEqual([
      "-C",
      "/patched/packages/dashboard",
      "exec",
      "vite",
      "--host",
      "0.0.0.0",
      "--port",
      "5174",
    ]);
    expect((options as { stdio?: unknown }).stdio).toBe("inherit");

    expect(handle.url).toBe("http://0.0.0.0:5174/");
    expect(handle.pid).toBe(4242);

    // Trigger a clean exit so the wait() promise resolves.
    queueMicrotask(() => child.emit("close", 0, null));
    await expect(handle.wait()).resolves.toEqual({ code: 0, signal: null });
  });

  it("normalizes 0.0.0.0 to localhost in the URL surfaced to the browser opener", () => {
    const { spawn } = fakeSpawn();
    const handle = spawnViteDev(
      { dashboardDir: "/p/d", host: "0.0.0.0", port: 5173, urlHost: "127.0.0.1" },
      { spawn, log: () => {} },
    );
    expect(handle.url).toBe("http://127.0.0.1:5173/");
  });

  it("close() sends SIGINT to the child and resolves wait() with the signal", async () => {
    const { spawn, child } = fakeSpawn();
    const handle = spawnViteDev(
      { dashboardDir: "/p/d", host: "127.0.0.1", port: 5173 },
      { spawn, log: () => {} },
    );

    handle.close();
    expect(child.killed).toBe(true);
    await expect(handle.wait()).resolves.toEqual({ code: null, signal: "SIGINT" });
  });

  it("rejects wait() when the child errors", async () => {
    const { spawn, child } = fakeSpawn();
    const handle = spawnViteDev(
      { dashboardDir: "/p/d", host: "127.0.0.1", port: 5173 },
      { spawn, log: () => {} },
    );
    queueMicrotask(() => child.emit("error", new Error("ENOENT pnpm")));
    await expect(handle.wait()).rejects.toThrow(/ENOENT pnpm/);
  });

  it("forwards extra env entries when provided", () => {
    const { spawn } = fakeSpawn();
    spawnViteDev(
      { dashboardDir: "/p/d", host: "127.0.0.1", port: 5173, env: { CUSTOM: "1" } },
      { spawn, log: () => {} },
    );
    const [, , options] = spawn.mock.calls[0]!;
    const env = (options as { env?: Record<string, string> }).env ?? {};
    expect(env.CUSTOM).toBe("1");
    // Inherits process.env as well so npm-style PATH lookups still work.
    expect(env.PATH).toBe(process.env.PATH);
  });
});
