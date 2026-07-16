import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { killSpawnedProcessGroup, runCliCommand } from "./index.js";

function makeSpawnMock(options: { stdout?: string; stderr?: string; exitCode?: number | null } = {}) {
  return vi.fn((_command: string, _args: string[], _spawnOptions: SpawnOptions): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 321 });
    child.stdout = new EventEmitter() as ChildProcess["stdout"];
    child.stderr = new EventEmitter() as ChildProcess["stderr"];
    child.stdin = { end: vi.fn() } as unknown as ChildProcess["stdin"];
    (child.stdout as { setEncoding?: (encoding: string) => void }).setEncoding = vi.fn();
    (child.stderr as { setEncoding?: (encoding: string) => void }).setEncoding = vi.fn();
    queueMicrotask(() => {
      child.stdout?.emit("data", options.stdout ?? "stdout");
      child.stderr?.emit("data", options.stderr ?? "");
      child.emit("close", options.exitCode ?? 0, null);
    });
    return child;
  });
}

describe("killSpawnedProcessGroup", () => {
  it("kills the whole process group on posix", () => {
    const killProcess = vi.fn();
    killSpawnedProcessGroup({ pid: 123 } as ChildProcess, "SIGTERM", {
      platform: "darwin",
      killProcess,
    });
    expect(killProcess).toHaveBeenCalledWith(-123, "SIGTERM");
  });
});

describe("runCliCommand", () => {
  it("passes the prompt as an argv entry in arg mode", async () => {
    const spawnImpl = makeSpawnMock({ stdout: "hello\n" });
    const result = await runCliCommand(
      {
        command: "llm",
        args: ["-p", "--output-format", "text", "summarize"],
        timeoutMs: 1000,
      },
      { spawnImpl: spawnImpl as never },
    );

    expect(result).toMatchObject({ stdout: "hello\n", stderr: "", exitCode: 0, timedOut: false });
    expect(spawnImpl).toHaveBeenCalledWith(
      "llm",
      ["-p", "--output-format", "text", "summarize"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("passes the prompt on stdin in stdin mode", async () => {
    const spawnImpl = makeSpawnMock({ stdout: "pong" });
    const result = await runCliCommand(
      {
        command: "llm",
        args: ["--output-format", "text"],
        input: "summarize",
        timeoutMs: 1000,
      },
      { spawnImpl: spawnImpl as never },
    );

    expect(result.stdout).toBe("pong");
    const child = spawnImpl.mock.results[0]?.value as ChildProcess;
    expect(child.stdin?.end).toHaveBeenCalledWith("summarize");
  });
});
