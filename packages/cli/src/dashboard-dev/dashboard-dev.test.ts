import { describe, expect, it, vi } from "vitest";
import type { ViteDevHandle } from "./spawn-vite.js";
import { runDashboardDev, type RunDashboardDevDeps } from "./dashboard-dev.js";

interface FakeHandle extends ViteDevHandle {
  closeCalls: number;
  resolveWait: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

function fakeHandle(url = "http://127.0.0.1:5173/", pid = 9001): FakeHandle {
  let resolveWait!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveWait = res;
  });
  let closeCalls = 0;
  return {
    pid,
    url,
    close() {
      closeCalls += 1;
    },
    wait: () => waitPromise,
    get closeCalls() {
      return closeCalls;
    },
    resolveWait,
  } as FakeHandle;
}

function makeDeps(): {
  deps: RunDashboardDevDeps;
  events: string[];
  prepareCalls: Array<{ pluginRoot: string; stateRoot: string }>;
  spawnCalls: Array<{ dashboardDir: string; host: string; port: number; noOpen: boolean }>;
  openCalls: string[];
  signalHandlers: Map<NodeJS.Signals, () => void>;
  handle: FakeHandle;
} {
  const events: string[] = [];
  const prepareCalls: Array<{ pluginRoot: string; stateRoot: string }> = [];
  const spawnCalls: Array<{ dashboardDir: string; host: string; port: number; noOpen: boolean }> = [];
  const openCalls: string[] = [];
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const handle = fakeHandle();
  return {
    deps: {
      preparePatched: (pluginRoot, stateRoot) => {
        prepareCalls.push({ pluginRoot, stateRoot });
        events.push("prepare");
        return {
          pluginRoot,
          dashboardDir: "/patched/packages/dashboard",
          metadataPath: "/state/.understand-anything/upstream-plugin-patch.json",
          patchId: "dashboard-viewport-v2",
          upstreamVersion: "1.2.3",
        };
      },
      spawnVite: (args) => {
        spawnCalls.push({ dashboardDir: args.dashboardDir, host: args.host, port: args.port, noOpen: false });
        events.push("spawn");
        return handle;
      },
      openBrowser: (url) => {
        openCalls.push(url);
        events.push("open");
        return { command: "fake-open", args: [url] };
      },
      onSignal: (signal, handler) => {
        signalHandlers.set(signal, handler);
        return () => signalHandlers.delete(signal);
      },
      log: () => {},
    },
    events,
    prepareCalls,
    spawnCalls,
    openCalls,
    signalHandlers,
    handle,
  };
}

describe("runDashboardDev", () => {
  it("prepares the patched workspace, spawns vite, opens the browser, and resolves on child exit", async () => {
    const { deps, events, prepareCalls, spawnCalls, openCalls, handle } = makeDeps();

    const pending = runDashboardDev(
      {
        command: "dashboard",
        action: "dev",
        stateDir: "/state",
        pluginRoot: "/plugin",
        host: "127.0.0.1",
        port: 5173,
        noOpen: false,
      },
      deps,
    );

    // Yield once so the async function reaches the wait() point.
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["prepare", "spawn", "open"]);
    expect(prepareCalls).toEqual([{ pluginRoot: "/plugin", stateRoot: "/state" }]);
    expect(spawnCalls[0]?.dashboardDir).toBe("/patched/packages/dashboard");
    expect(spawnCalls[0]?.host).toBe("127.0.0.1");
    expect(spawnCalls[0]?.port).toBe(5173);
    expect(openCalls).toEqual(["http://127.0.0.1:5173/"]);

    handle.resolveWait({ code: 0, signal: null });
    await expect(pending).resolves.toEqual({ code: 0, signal: null });
  });

  it("skips opening the browser when --no-open is set", async () => {
    const { deps, events, openCalls, handle } = makeDeps();

    const pending = runDashboardDev(
      {
        command: "dashboard",
        action: "dev",
        stateDir: "/state",
        pluginRoot: "/plugin",
        host: "127.0.0.1",
        port: 5173,
        noOpen: true,
      },
      deps,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["prepare", "spawn"]);
    expect(openCalls).toEqual([]);

    handle.resolveWait({ code: 0, signal: null });
    await pending;
  });

  it("registers SIGINT/SIGTERM handlers that close the vite handle", async () => {
    const { deps, signalHandlers, handle } = makeDeps();
    const pending = runDashboardDev(
      {
        command: "dashboard",
        action: "dev",
        stateDir: "/s",
        pluginRoot: "/p",
        host: "127.0.0.1",
        port: 5173,
        noOpen: true,
      },
      deps,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    signalHandlers.get("SIGINT")!();
    expect(handle.closeCalls).toBe(1);

    handle.resolveWait({ code: null, signal: "SIGINT" });
    await expect(pending).resolves.toEqual({ code: null, signal: "SIGINT" });
  });

  it("normalizes 0.0.0.0 to localhost when surfacing the URL to the browser", async () => {
    const { deps, openCalls, handle } = makeDeps();
    const pending = runDashboardDev(
      {
        command: "dashboard",
        action: "dev",
        stateDir: "/s",
        pluginRoot: "/p",
        host: "0.0.0.0",
        port: 5173,
        noOpen: false,
      },
      deps,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(openCalls).toEqual(["http://127.0.0.1:5173/"]);
    handle.resolveWait({ code: 0, signal: null });
    await pending;
  });

  it("throws if preparePatched fails", async () => {
    const deps: RunDashboardDevDeps = {
      preparePatched: () => {
        throw new Error("anchor not found");
      },
      spawnVite: vi.fn() as never,
      openBrowser: vi.fn() as never,
      onSignal: () => () => {},
      log: () => {},
    };

    await expect(
      runDashboardDev(
        {
          command: "dashboard",
          action: "dev",
          stateDir: "/s",
          pluginRoot: "/p",
          host: "127.0.0.1",
          port: 5173,
          noOpen: true,
        },
        deps,
      ),
    ).rejects.toThrow(/anchor not found/);
  });
});
