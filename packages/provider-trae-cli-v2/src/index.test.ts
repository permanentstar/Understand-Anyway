import { describe, expect, it } from "vitest";
import {
  TraeCliV2LlmProvider,
  createLlmProvider,
  type TraeCliV2RunResult,
  type TraeCliV2RunSpec,
} from "./index.js";

function ok(stdout: string): TraeCliV2RunResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false };
}

function provider(
  opts: {
    config?: Record<string, unknown>;
    result?: TraeCliV2RunResult;
    onSpec?: (spec: TraeCliV2RunSpec) => void;
  } = {},
) {
  const specs: TraeCliV2RunSpec[] = [];
  const p = new TraeCliV2LlmProvider({
    ...(opts.config ?? {}),
    deps: {
      run: async (spec) => {
        specs.push(spec);
        opts.onSpec?.(spec);
        return opts.result ?? ok("hello");
      },
    },
  });
  return { p, specs };
}

describe("TraeCliV2LlmProvider", () => {
  it("uses stdout as completion text", async () => {
    const { p } = provider({ result: ok("  summary text \n") });
    const response = await p.complete({ prompt: "hello", timeoutMs: 1000 });
    expect(response.text).toBe("summary text");
    expect(response.meta?.provider).toBe("trae-cli-v2");
  });

  it("injects request.model via modelArg before the prompt", async () => {
    const { p, specs } = provider({
      config: { command: "traex", args: ["exec"], modelArg: "-m", promptMode: "arg" },
    });
    await p.complete({ prompt: "hi", model: "Qwen3.6-Plus", timeoutMs: 1000 });
    expect(specs[0]?.args).toEqual(["exec", "-m", "Qwen3.6-Plus", "hi"]);
  });

  it("passes the prompt on stdin when configured", async () => {
    const { p, specs } = provider({
      config: { command: "llm", args: ["-p"], promptMode: "stdin" },
    });
    await p.complete({ prompt: "hello", timeoutMs: 1000 });
    expect(specs[0]?.input).toBe("hello");
    expect(specs[0]?.args).toEqual(["-p"]);
  });
});

describe("createLlmProvider", () => {
  it("returns a trae-cli-v2 provider instance", async () => {
    const provider = await createLlmProvider({});
    expect(provider.name).toBe("trae-cli-v2");
  });
});
