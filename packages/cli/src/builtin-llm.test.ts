import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  CliSpawnLlmProvider,
  MockLlmProvider,
  OpenAiCompatibleLlmProvider,
  killSpawnedProcessGroup,
} from "./builtin-llm.js";

describe("MockLlmProvider", () => {
  it("returns deterministic JSON text", async () => {
    const provider = new MockLlmProvider({ model: "mock-v1" });
    const response = await provider.complete({ prompt: "analyze src/a.ts", model: "mock-v1" });
    const parsed = JSON.parse(response.text);
    expect(parsed.results[0].response.fileSummary).toContain("Mock summary");
  });
});

describe("OpenAiCompatibleLlmProvider", () => {
  it("parses chat completions into raw text", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));
    const provider = new OpenAiCompatibleLlmProvider({
      model: "gpt-x",
      apiBase: "https://example.test/v1",
      apiKey: "secret",
      fetchImpl: fetchImpl as never,
    });
    const response = await provider.complete({ prompt: "hello", timeoutMs: 1000 });
    expect(response.text).toBe("{\"ok\":true}");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("killSpawnedProcessGroup", () => {
  it("kills the whole process group on posix", () => {
    const kill = vi.fn();
    killSpawnedProcessGroup({ pid: 123 } as ChildProcess, "SIGTERM", {
      platform: "darwin",
      killProcess: kill,
    });
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
  });
});

describe("CliSpawnLlmProvider", () => {
  it("uses the spawned stdout as completion text", async () => {
    const spawnImpl = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => {
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, "pid", { value: 321 });
      child.stdout = new EventEmitter() as any;
      child.stderr = new EventEmitter() as any;
      (child.stdout as any).setEncoding = vi.fn();
      (child.stderr as any).setEncoding = vi.fn();
      child.stdin = { end: vi.fn() } as any;
      queueMicrotask(() => {
        child.stdout?.emit("data", "{\"ok\":true}");
        child.emit("exit", 0, null);
      });
      return child;
    });
    const provider = new CliSpawnLlmProvider({
      model: "cli-spawn-default",
      command: "llm",
      args: ["--output-format", "text"],
      promptMode: "stdin",
      spawnImpl: spawnImpl as never,
    });
    const response = await provider.complete({ prompt: "hello", timeoutMs: 1000 });
    expect(response.text).toBe("{\"ok\":true}");
    expect(spawnImpl).toHaveBeenCalledOnce();
  });
});
