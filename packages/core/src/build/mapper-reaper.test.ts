import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  createReaperRegistry,
  installParentSignalReaper,
  removeTrackedChild,
  trackChildProcess,
  type TrackableChild,
} from "./mapper-reaper.js";

interface FakeChild extends TrackableChild {
  emit(event: string, ...args: unknown[]): void;
}

function fakeChild(pid: number): FakeChild {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
    },
    emit(event, ...args) {
      for (const fn of listeners[event] ?? []) fn(...args);
    },
  };
}

describe("reaper registry", () => {
  it("tracks and removes children, and auto-removes on exit/close", () => {
    const registry = createReaperRegistry();
    const a = fakeChild(101);
    const b = fakeChild(102);
    trackChildProcess(a, registry);
    trackChildProcess(b, registry);
    expect(registry.size).toBe(2);

    a.emit("exit", 0, null);
    expect(registry.size).toBe(1);

    removeTrackedChild(b, registry);
    expect(registry.size).toBe(0);
  });
});

describe("installParentSignalReaper", () => {
  function harness(escalationMs = 250) {
    const registry = createReaperRegistry();
    const proc = new EventEmitter() as EventEmitter & { exit: ReturnType<typeof vi.fn> };
    proc.exit = vi.fn();
    const killed: Array<[number, NodeJS.Signals | number]> = [];
    let scheduled: { handler: () => void; ms: number } | null = null;
    const env = {
      kill: (pid: number, sig: NodeJS.Signals | number) => {
        killed.push([pid, sig]);
      },
      setTimeout: (handler: () => void, ms: number) => {
        scheduled = { handler, ms };
        return 0 as unknown;
      },
      process: proc,
    };
    const handle = installParentSignalReaper({ registry, escalationMs, env });
    return {
      registry,
      proc,
      killed,
      runEscalation: () => scheduled?.handler(),
      scheduledMs: () => scheduled?.ms ?? -1,
      dispose: () => handle.dispose(),
    };
  }

  it("on SIGINT: sends SIGTERM to all, escalates SIGKILL after the configured delay, then exits 130", () => {
    const h = harness(123);
    const a = fakeChild(201);
    const b = fakeChild(202);
    trackChildProcess(a, h.registry);
    trackChildProcess(b, h.registry);

    h.proc.emit("SIGINT");

    expect(h.killed).toEqual([
      [201, "SIGTERM"],
      [202, "SIGTERM"],
    ]);
    expect(h.scheduledMs()).toBe(123);
    expect(h.proc.exit).not.toHaveBeenCalled();

    // After escalation, the survivors get SIGKILL.
    h.runEscalation();
    expect(h.killed).toEqual([
      [201, "SIGTERM"],
      [202, "SIGTERM"],
      [201, "SIGKILL"],
      [202, "SIGKILL"],
    ]);
    expect(h.proc.exit).toHaveBeenCalledWith(130);
    h.dispose();
  });

  it("skips SIGKILL for children that already exited between SIGTERM and escalation", () => {
    const h = harness();
    const a = fakeChild(301);
    const b = fakeChild(302);
    trackChildProcess(a, h.registry);
    trackChildProcess(b, h.registry);

    h.proc.emit("SIGINT");
    // b dies quickly; a hangs.
    b.exitCode = 0;
    h.runEscalation();
    expect(h.killed).toEqual([
      [301, "SIGTERM"],
      [302, "SIGTERM"],
      [301, "SIGKILL"],
    ]);
    h.dispose();
  });

  it("on SIGTERM exits with 143 after escalation", () => {
    const h = harness();
    trackChildProcess(fakeChild(401), h.registry);
    h.proc.emit("SIGTERM");
    h.runEscalation();
    expect(h.proc.exit).toHaveBeenCalledWith(143);
    h.dispose();
  });

  it("on plain exit fires SIGTERM synchronously without scheduling escalation", () => {
    const h = harness();
    trackChildProcess(fakeChild(501), h.registry);
    h.proc.emit("exit");
    expect(h.killed).toEqual([[501, "SIGTERM"]]);
    expect(h.scheduledMs()).toBe(-1);
    h.dispose();
  });

  it("dispose removes all listeners so re-installing is safe", () => {
    const h = harness();
    expect(h.proc.listenerCount("SIGINT")).toBe(1);
    h.dispose();
    expect(h.proc.listenerCount("SIGINT")).toBe(0);
    expect(h.proc.listenerCount("SIGTERM")).toBe(0);
    expect(h.proc.listenerCount("exit")).toBe(0);
  });

  it("ignores dead pids (already exited / negative pid) without throwing", () => {
    const h = harness();
    trackChildProcess({ pid: -1 }, h.registry);
    trackChildProcess({ pid: 601, exitCode: 0 }, h.registry);
    trackChildProcess({ pid: 602, signalCode: "SIGKILL" }, h.registry);
    h.proc.emit("SIGINT");
    expect(h.killed).toEqual([]);
    h.dispose();
  });
});

// Integration test: real child processes, real kill. Kept tiny so the suite
// stays in the main gate.
describe("installParentSignalReaper (real child process integration)", () => {
  it("escalates a SIGTERM-ignoring child to SIGKILL within escalationMs", async () => {
    const registry = createReaperRegistry();
    const proc = new EventEmitter() as EventEmitter & { exit: ReturnType<typeof vi.fn> };
    proc.exit = vi.fn();
    const handle = installParentSignalReaper({ registry, escalationMs: 200, env: { process: proc } });

    // Child catches SIGTERM and keeps running; the reaper must escalate.
    // It announces "ready" on stdout *after* the SIGTERM handler is in place
    // so the parent never races the handler installation.
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready\\n');",
    ]);
    try {
      await new Promise<void>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          if (chunk.toString().includes("ready")) {
            child.stdout?.off("data", onData);
            resolve();
          }
        };
        child.stdout?.on("data", onData);
        child.on("exit", () => reject(new Error("child exited before becoming ready")));
        setTimeout(() => reject(new Error("child never reported ready")), 2000);
      });

      trackChildProcess(child, registry);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });

      proc.emit("SIGINT");
      const result = await exited;
      expect(result.signal).toBe("SIGKILL");
    } finally {
      handle.dispose();
      if (!child.killed) child.kill("SIGKILL");
    }
  }, 5000);
});
