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

function makeSpawnMock(stdout: string) {
  return vi.fn((_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 321 });
    child.stdout = new EventEmitter() as any;
    child.stderr = new EventEmitter() as any;
    (child.stdout as any).setEncoding = vi.fn();
    (child.stderr as any).setEncoding = vi.fn();
    child.stdin = { end: vi.fn() } as any;
    queueMicrotask(() => {
      child.stdout?.emit("data", stdout);
      child.emit("exit", 0, null);
    });
    return child;
  });
}

function argsOf(spawnImpl: ReturnType<typeof makeSpawnMock>): string[] {
  const call = spawnImpl.mock.calls[0];
  if (!call) throw new Error("spawn was not called");
  return call[1];
}

describe("CliSpawnLlmProvider", () => {
  it("uses the spawned stdout as completion text", async () => {
    const spawnImpl = makeSpawnMock("{\"ok\":true}");
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

  it("injects request.model on the command line via modelArg, before the prompt", async () => {
    const spawnImpl = makeSpawnMock("PONG");
    const provider = new CliSpawnLlmProvider({
      model: "config-default",
      command: "traex",
      args: ["exec"],
      modelArg: "-m",
      promptMode: "arg",
      spawnImpl: spawnImpl as never,
    });
    const response = await provider.complete({ prompt: "hi", model: "Qwen3.6-Plus", timeoutMs: 1000 });
    expect(response.text).toBe("PONG");
    const args = argsOf(spawnImpl);
    expect(args).toEqual(["exec", "-m", "Qwen3.6-Plus", "hi"]);
    expect(args.indexOf("Qwen3.6-Plus")).toBeLessThan(args.indexOf("hi"));
  });

  it("prefers request.model over the constructor model", async () => {
    const spawnImpl = makeSpawnMock("PONG");
    const provider = new CliSpawnLlmProvider({
      model: "config-default",
      command: "traex",
      args: ["exec"],
      modelArg: "-m",
      spawnImpl: spawnImpl as never,
    });
    const response = await provider.complete({ prompt: "hi", model: "GPT-5.4", timeoutMs: 1000 });
    const args = argsOf(spawnImpl);
    expect(args).toContain("GPT-5.4");
    expect(args).not.toContain("config-default");
    expect(response.meta?.model).toBe("GPT-5.4");
  });

  it("falls back to the constructor model when request omits one", async () => {
    const spawnImpl = makeSpawnMock("PONG");
    const provider = new CliSpawnLlmProvider({
      model: "Qwen3.6-Plus",
      command: "traex",
      args: ["exec"],
      modelArg: "-m",
      spawnImpl: spawnImpl as never,
    });
    await provider.complete({ prompt: "hi", timeoutMs: 1000 });
    const args = argsOf(spawnImpl);
    expect(args).toEqual(["exec", "-m", "Qwen3.6-Plus", "hi"]);
  });

  it("does not inject the placeholder default model", async () => {
    const spawnImpl = makeSpawnMock("PONG");
    const provider = new CliSpawnLlmProvider({
      command: "traex",
      args: ["exec"],
      modelArg: "-m",
      spawnImpl: spawnImpl as never,
    });
    await provider.complete({ prompt: "hi", timeoutMs: 1000 });
    const args = argsOf(spawnImpl);
    expect(args).toEqual(["exec", "hi"]);
    expect(args).not.toContain("-m");
  });

  it("is idempotent when modelArg already present in args", async () => {
    const spawnImpl = makeSpawnMock("PONG");
    const provider = new CliSpawnLlmProvider({
      model: "config-default",
      command: "traex",
      args: ["exec", "-m", "pinned-model"],
      modelArg: "-m",
      spawnImpl: spawnImpl as never,
    });
    await provider.complete({ prompt: "hi", model: "Qwen3.6-Plus", timeoutMs: 1000 });
    const args = argsOf(spawnImpl);
    expect(args).toEqual(["exec", "-m", "pinned-model", "hi"]);
  });

  it("does not inject a model when modelArg is not configured (regression)", async () => {
    const spawnImpl = makeSpawnMock("PONG");
    const provider = new CliSpawnLlmProvider({
      model: "config-default",
      command: "traex",
      args: ["exec"],
      spawnImpl: spawnImpl as never,
    });
    await provider.complete({ prompt: "hi", model: "Qwen3.6-Plus", timeoutMs: 1000 });
    const args = argsOf(spawnImpl);
    expect(args).toEqual(["exec", "hi"]);
  });
});
