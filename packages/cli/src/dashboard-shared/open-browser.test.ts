import { describe, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { openBrowser, pickBrowserLauncher } from "./open-browser.js";

function fakeChild(): ChildProcess {
  // Minimal ChildProcess stub with unref(); spawn return value is otherwise opaque.
  return { unref: vi.fn() } as unknown as ChildProcess;
}

describe("pickBrowserLauncher", () => {
  it("uses `open` on darwin", () => {
    expect(pickBrowserLauncher("darwin", "http://x")).toEqual({ command: "open", args: ["http://x"] });
  });

  it("uses `xdg-open` on linux", () => {
    expect(pickBrowserLauncher("linux", "http://x")).toEqual({ command: "xdg-open", args: ["http://x"] });
  });

  it("uses `cmd /c start` on win32", () => {
    expect(pickBrowserLauncher("win32", "http://x")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://x"],
    });
  });

  it("falls back to xdg-open for unknown platforms", () => {
    expect(pickBrowserLauncher("freebsd" as NodeJS.Platform, "http://x")).toEqual({
      command: "xdg-open",
      args: ["http://x"],
    });
  });
});

describe("openBrowser", () => {
  it("spawns the picked command with detached + stdio:ignore", () => {
    const spawn = vi.fn((..._args: unknown[]) => fakeChild()) as unknown as (
      command: string,
      args: string[],
      options: SpawnOptions,
    ) => ChildProcess;
    const result = openBrowser("http://x", { platform: "darwin", spawn });
    expect(result).toEqual({ command: "open", args: ["http://x"] });
    expect(spawn).toHaveBeenCalledTimes(1);
    const call = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[0]).toBe("open");
    expect(call?.[1]).toEqual(["http://x"]);
    expect((call?.[2] as SpawnOptions)?.detached).toBe(true);
    expect((call?.[2] as SpawnOptions)?.stdio).toBe("ignore");
  });

  it("calls unref so the parent doesn't block on the launcher", () => {
    const child = fakeChild();
    const spawn = (() => child) as unknown as (
      command: string,
      args: string[],
      options: SpawnOptions,
    ) => ChildProcess;
    openBrowser("http://x", { platform: "linux", spawn });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("invokes the log sink when provided", () => {
    const log = vi.fn();
    openBrowser("http://x", {
      platform: "darwin",
      spawn: (() => fakeChild()) as never,
      log,
    });
    expect(log).toHaveBeenCalledWith("opening browser: open http://x");
  });

  it("uses live platform when not overridden (smoke)", () => {
    // Don't actually launch a browser; inject a no-op spawn.
    const spawn = (() => fakeChild()) as never;
    const result = openBrowser("http://x", { spawn });
    expect(result.args).toContain("http://x");
  });
});
