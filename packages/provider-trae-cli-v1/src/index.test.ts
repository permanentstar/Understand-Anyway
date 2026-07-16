import { describe, expect, it } from "vitest";
import { LlmError } from "@understand-anyway/plugin-api";
import {
  TraeCliV1LlmProvider,
  createLlmProvider,
  type TraeCliV1RunResult,
  type TraeCliV1RunSpec,
} from "./index.js";

function ok(stdout: string): TraeCliV1RunResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false };
}

function fail(stderr: string, exitCode = 1): TraeCliV1RunResult {
  return { stdout: "", stderr, exitCode, signal: null, timedOut: false };
}

function provider(
  opts: {
    config?: Record<string, unknown>;
    available?: boolean;
    result?: TraeCliV1RunResult;
    onSpec?: (spec: TraeCliV1RunSpec) => void;
  } = {},
) {
  const specs: TraeCliV1RunSpec[] = [];
  const p = new TraeCliV1LlmProvider({
    ...(opts.config ?? {}),
    deps: {
      isAvailable: () => opts.available ?? true,
      run: async (spec) => {
        specs.push(spec);
        opts.onSpec?.(spec);
        return opts.result ?? ok("hello");
      },
    },
  });
  return { p, specs };
}

describe("TraeCliV1LlmProvider", () => {
  it("passes the prompt as an arg and returns trimmed stdout", async () => {
    const { p, specs } = provider({ result: ok("  summary text \n") });
    const res = await p.complete({ prompt: "explain this", timeoutMs: 5000 });
    expect(res.text).toBe("summary text");
    expect(specs[0]?.args).toContain("explain this");
    expect(specs[0]?.input).toBeUndefined();
    expect(specs[0]?.args.slice(0, 3)).toEqual(["-p", "--output-format", "text"]);
    expect(specs[0]?.args).toContain("--query-timeout");
  });

  it("passes the prompt on stdin when configured", async () => {
    const { p, specs } = provider({ config: { promptMode: "stdin" } });
    await p.complete({ prompt: "on stdin", timeoutMs: 5000 });
    expect(specs[0]?.input).toBe("on stdin");
    expect(specs[0]?.args).not.toContain("on stdin");
  });

  it("injects default_model for a non-default model", async () => {
    const { p, specs } = provider({ config: { model: "gpt-x" } });
    await p.complete({ prompt: "x", timeoutMs: 1000 });
    const i = specs[0]?.args.indexOf("-c") ?? -1;
    expect(specs[0]?.args[i + 1]).toBe("default_model=gpt-x");
  });
});

describe("createLlmProvider", () => {
  it("returns a trae-cli-v1 provider instance", async () => {
    const provider = await createLlmProvider({});
    expect(provider.name).toBe("trae-cli-v1");
  });
});

describe("LlmError classification", () => {
  it("availability failure -> kind=unknown, retryable=false", async () => {
    const { p } = provider({ available: false });
    const err = await p.complete({ prompt: "x" }).catch((error) => error);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("HTTP 429 rate limit -> kind=rate-limit, retryable=true", async () => {
    const { p } = provider({ result: fail("HTTP 429 rate limit hit") });
    const err = await p.complete({ prompt: "x" }).catch((error) => error);
    expect(err.kind).toBe("rate-limit");
    expect(err.retryable).toBe(true);
  });

  it("server overload / 503 -> kind=overload, retryable=true", async () => {
    const { p } = provider({ result: fail("server overloaded, 503 Service Unavailable") });
    const err = await p.complete({ prompt: "x" }).catch((error) => error);
    expect(err.kind).toBe("overload");
    expect(err.retryable).toBe(true);
  });

  it("stderr 'request timed out' -> kind=timeout, retryable=true", async () => {
    const { p } = provider({ result: fail("request timed out after 30s") });
    const err = await p.complete({ prompt: "x" }).catch((error) => error);
    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("ENOTFOUND -> kind=network, retryable=true", async () => {
    const { p } = provider({ result: fail("getaddrinfo ENOTFOUND example.invalid") });
    const err = await p.complete({ prompt: "x" }).catch((error) => error);
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("401 unauthorized -> kind=auth, retryable=false", async () => {
    const { p } = provider({ result: fail("401 unauthorized") });
    const err = await p.complete({ prompt: "x" }).catch((error) => error);
    expect(err.kind).toBe("auth");
    expect(err.retryable).toBe(false);
  });

  it("400 bad request -> kind=bad-request, retryable=false", async () => {
    const { p } = provider({ result: fail("400 bad request: invalid prompt") });
    const err = await p.complete({ prompt: "x" }).catch((error) => error);
    expect(err.kind).toBe("bad-request");
    expect(err.retryable).toBe(false);
  });
});
