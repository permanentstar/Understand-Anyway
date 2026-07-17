import { describe, expect, it } from "vitest";
import { LlmError } from "@understand-anyway/plugin-api";
import { applyLanguageDirective, runLlmFileAnalysis, runLlmGraphEnhancement } from "./llm.js";

const noopRetryDeps = {
  sleep: async () => {},
  random: () => 0.5,
  now: () => 0,
};

const noRetryPolicy = {
  maxAttempts: 1,
  initialBackoffMs: 0,
  backoffMultiplier: 1,
  maxBackoffMs: 0,
  jitterRatio: 0,
};

const aggressiveRetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 0,
  backoffMultiplier: 1,
  maxBackoffMs: 0,
  jitterRatio: 0,
};

const fakeCore = {
  buildFileAnalysisPrompt: (path: string, content: string, ctx: string) => `${path}:${content}:${ctx}`,
  parseFileAnalysisResponse: (text: string) =>
    text === "ok"
      ? {
          fileSummary: "LLM summary",
          tags: ["llm"],
          complexity: "moderate",
          functionSummaries: {},
          classSummaries: {},
        }
      : null,
};

describe("runLlmFileAnalysis", () => {
  it("returns empty stats when disabled", async () => {
    const result = await runLlmFileAnalysis({
      enabled: false,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      core: {},
    });
    expect(result.analyses.size).toBe(0);
    expect(result.stats.enabled).toBe(false);
  });

  it("calls upstream prompt/parser through the provider", async () => {
    const prompts: string[] = [];
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          return { text: "ok" };
        },
      },
      core: {
        buildFileAnalysisPrompt: (path: string, content: string, ctx: string) => `${path}:${content}:${ctx}`,
        parseFileAnalysisResponse: () => ({
          fileSummary: "LLM summary",
          tags: ["llm"],
          complexity: "moderate",
          functionSummaries: {},
          classSummaries: {},
        }),
      },
    });
    expect(prompts).toEqual(["src/a.ts:source:repo"]);
    expect(result.analyses.get("src/a.ts")?.fileSummary).toBe("LLM summary");
    expect(result.stats.analyzed).toBe(1);
    expect(result.stats.providerName).toBe("fake");
  });

  it("throws when enabled without a provider", async () => {
    await expect(runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      core: {},
    })).rejects.toThrow(/build: no LLM provider configured/);
  });

  it("records failure and continues when not required", async () => {
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: { name: "fake", complete: async () => ({ text: "bad" }) },
      core: {
        buildFileAnalysisPrompt: () => "prompt",
        parseFileAnalysisResponse: () => null,
      },
    });
    expect(result.analyses.size).toBe(0);
    expect(result.stats.failed).toBe(1);
    expect(result.stats.failures[0]?.filePath).toBe("src/a.ts");
  });

  it("throws on parse failure when required", async () => {
    await expect(runLlmFileAnalysis({
      enabled: true,
      required: true,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: { name: "fake", complete: async () => ({ text: "bad" }) },
      core: {
        buildFileAnalysisPrompt: () => "prompt",
        parseFileAnalysisResponse: () => null,
      },
    })).rejects.toThrow(/LLM parse failed/);
  });

  it("retries on transient LlmError and succeeds; counts transient hits", async () => {
    let calls = 0;
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => {
          calls += 1;
          if (calls < 3) throw new LlmError("rate-limit", `attempt ${calls}`);
          return { text: "ok" };
        },
      },
      core: fakeCore,
      retryPolicy: aggressiveRetryPolicy,
      retryDeps: noopRetryDeps,
    });
    expect(calls).toBe(3);
    expect(result.analyses.size).toBe(1);
    expect(result.stats.analyzed).toBe(1);
    expect(result.stats.failed).toBe(0);
    expect(result.stats.retries).toEqual({ transientHits: 2, totalAttempts: 3 });
  });

  it("does not retry terminal LlmError and records kind on failure", async () => {
    let calls = 0;
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => {
          calls += 1;
          throw new LlmError("auth", "401 unauthorized");
        },
      },
      core: fakeCore,
      retryPolicy: aggressiveRetryPolicy,
      retryDeps: noopRetryDeps,
    });
    expect(calls).toBe(1);
    expect(result.stats.failed).toBe(1);
    expect(result.stats.failures[0]?.kind).toBe("auth");
    expect(result.stats.failures[0]?.attempts).toHaveLength(1);
    expect(result.stats.retries).toEqual({ transientHits: 0, totalAttempts: 1 });
  });

  it("treats bare Error as unknown (no retry)", async () => {
    let calls = 0;
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => {
          calls += 1;
          throw new Error("bare error");
        },
      },
      core: fakeCore,
      retryPolicy: aggressiveRetryPolicy,
      retryDeps: noopRetryDeps,
    });
    expect(calls).toBe(1);
    expect(result.stats.failed).toBe(1);
    expect(result.stats.failures[0]?.kind).toBeUndefined();
    expect(result.stats.retries?.totalAttempts).toBe(1);
  });

  it("exhausts retries on persistent transient failure", async () => {
    let calls = 0;
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => {
          calls += 1;
          throw new LlmError("overload", "503");
        },
      },
      core: fakeCore,
      retryPolicy: aggressiveRetryPolicy,
      retryDeps: noopRetryDeps,
    });
    expect(calls).toBe(3);
    expect(result.stats.failed).toBe(1);
    expect(result.stats.failures[0]?.kind).toBe("overload");
    expect(result.stats.retries).toEqual({ transientHits: 2, totalAttempts: 3 });
  });

  it("rethrows in required mode even after retries are exhausted", async () => {
    let calls = 0;
    await expect(runLlmFileAnalysis({
      enabled: true,
      required: true,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => {
          calls += 1;
          throw new LlmError("timeout", "slow");
        },
      },
      core: fakeCore,
      retryPolicy: aggressiveRetryPolicy,
      retryDeps: noopRetryDeps,
    })).rejects.toBeInstanceOf(LlmError);
    expect(calls).toBe(3);
  });

  it("throttles sequential file calls when qpmLimit is configured", async () => {
    const sleeps: number[] = [];
    const prompts: string[] = [];
    await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: (absPath) => absPath,
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          return { text: "ok" };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      qpmLimit: 60,
      taskFileCount: 1,
      retryDeps: {
        ...noopRetryDeps,
        sleep: async (ms) => { sleeps.push(ms); },
      },
    });

    expect(prompts).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("runs multiple file tasks concurrently up to globalConcurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const run = runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gate;
          inFlight -= 1;
          return { text: "ok" };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      globalConcurrency: 2,
      taskFileCount: 1,
      retryDeps: noopRetryDeps,
    });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(maxInFlight).toBe(2);
    releaseGate();
    const result = await run;
    expect(result.stats.analyzed).toBe(3);
  });

  it("uses one batch wrapper provider call for multiple files", async () => {
    const prompts: string[] = [];
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: (absPath) => `content:${absPath}`,
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          return {
            text: JSON.stringify({
              results: [
                { filePath: "src/a.ts", response: { fileSummary: "A", tags: ["a"], complexity: "simple", functionSummaries: {}, classSummaries: {} } },
                { filePath: "src/b.ts", response: { fileSummary: "B", tags: ["b"], complexity: "moderate", functionSummaries: {}, classSummaries: {} } },
              ],
            }),
          };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("The response shape must be:");
    expect(prompts[0]).toContain("filePath: src/a.ts");
    expect(prompts[0]).toContain("filePath: src/b.ts");
    expect(result.analyses.get("src/a.ts")?.fileSummary).toBe("A");
    expect(result.analyses.get("src/b.ts")?.fileSummary).toBe("B");
    expect(result.stats).toMatchObject({ requested: 2, analyzed: 2, failed: 0 });
    expect(result.stats.tasks).toBe(1);
  });

  it("accepts a strict batch JSON object followed by extra provider output", async () => {
    const response = [
      JSON.stringify({
        results: [
          { filePath: "src/a.ts", response: { fileSummary: "A", tags: ["a"], complexity: "simple", functionSummaries: {}, classSummaries: {} } },
          { filePath: "src/b.ts", response: { fileSummary: "B", tags: ["b"], complexity: "moderate", functionSummaries: {}, classSummaries: {} } },
        ],
      }),
      JSON.stringify({ debug: "trailing object from provider wrapper" }),
    ].join("\n");

    const result = await runLlmFileAnalysis({
      enabled: true,
      required: true,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: { name: "fake", complete: async () => ({ text: response }) },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });

    expect(result.analyses.get("src/a.ts")?.fileSummary).toBe("A");
    expect(result.analyses.get("src/b.ts")?.fileSummary).toBe("B");
    expect(result.stats).toMatchObject({ requested: 2, analyzed: 2, failed: 0 });
  });

  it("recovers complete batch result entries when a fenced results array omits commas", async () => {
    const response = [
      "```json",
      "{\"results\":[",
      "{\"filePath\":\"src/a.ts\",\"response\":{\"fileSummary\":\"A\",\"tags\":[\"a\"],\"complexity\":\"simple\",\"functionSummaries\":{},\"classSummaries\":{}}}",
      "{\"filePath\":\"src/b.ts\",\"response\":{\"fileSummary\":\"B\",\"tags\":[\"b\"],\"complexity\":\"moderate\",\"functionSummaries\":{},\"classSummaries\":{}}}",
      "]}",
      "```",
    ].join("\n");

    const result = await runLlmFileAnalysis({
      enabled: true,
      required: true,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: { name: "fake", complete: async () => ({ text: response }) },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });

    expect(result.analyses.get("src/a.ts")?.fileSummary).toBe("A");
    expect(result.analyses.get("src/b.ts")?.fileSummary).toBe("B");
    expect(result.stats).toMatchObject({ requested: 2, analyzed: 2, failed: 0 });
  });

  it("throws in required mode when batch missing fallback also fails", async () => {
    await expect(runLlmFileAnalysis({
      enabled: true,
      required: true,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => ({
          text: JSON.stringify({
            results: [
              { filePath: "src/a.ts", response: { fileSummary: "A", tags: ["a"], complexity: "simple", functionSummaries: {}, classSummaries: {} } },
            ],
          }),
        }),
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    })).rejects.toThrow(/LLM fallback file analysis failed: src\/b\.ts: LLM parse failed for src\/b\.ts/);
  });

  it("falls back to single-file analysis when a batch response omits a file", async () => {
    const prompts: string[] = [];
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: true,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          if (request.prompt.includes("Analyze each source file independently")) {
            return {
              text: JSON.stringify({
                results: [
                  { filePath: "src/a.ts", response: { fileSummary: "A", tags: ["a"], complexity: "simple", functionSummaries: {}, classSummaries: {} } },
                ],
              }),
            };
          }
          return { text: "ok" };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });

    expect(prompts).toHaveLength(2);
    expect(result.analyses.get("src/a.ts")?.fileSummary).toBe("A");
    expect(result.analyses.get("src/b.ts")?.fileSummary).toBe("LLM summary");
    expect(result.stats).toMatchObject({ requested: 2, analyzed: 2, failed: 0 });
    expect(result.artifacts?.attemptJournal.at(-1)).toMatchObject({
      operation: "file-analysis-batch",
      status: "partial",
      reason: "LLM batch response missing file result: src/b.ts",
    });
  });

  it("trips breaker after consecutive retryable task failures and skips the rest", async () => {
    let calls = 0;
    const files = Array.from({ length: 7 }, (_, index) => ({ path: `src/${index}.ts` }));
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files,
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async () => {
          calls += 1;
          throw new LlmError("overload", "overloaded");
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
      taskFileCount: 1,
    });

    expect(calls).toBe(5);
    expect(result.stats.breakerTripped).toBe(true);
    expect(result.stats.failed).toBe(5);
    expect(result.stats.skipped).toBe(2);
    expect(result.stats.failures.map((f) => f.filePath)).toEqual([
      "src/0.ts",
      "src/1.ts",
      "src/2.ts",
      "src/3.ts",
      "src/4.ts",
    ]);
  });

  it("switches to the next model candidate after a retryable task failure", async () => {
    const models: Array<string | undefined> = [];
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async (request) => {
          models.push(request.model);
          if (request.model === "small") throw new LlmError("overload", "small overloaded");
          return { text: "ok" };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
      taskFileCount: 1,
      modelCandidates: ["small", "large"],
    });

    expect(models).toEqual(["small", "large"]);
    expect(result.stats.failed).toBe(1);
    expect(result.stats.analyzed).toBe(1);
    expect(result.stats.modelSwitches).toBe(1);
    expect(result.stats.activeModel).toBe("large");
  });

  it("records a model guard cooldown event after a retryable model failure", async () => {
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async (request) => {
          if (request.model === "small") throw new LlmError("overload", "small overloaded");
          return { text: "ok" };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: { ...noopRetryDeps, now: () => 100 },
      taskFileCount: 1,
      modelCandidates: ["small", "large"],
      modelCooldownMs: 5000,
    });

    expect(result.stats.modelGuards).toEqual([
      {
        model: "small",
        action: "cooldown",
        kind: "overload",
        reason: "small overloaded",
        cooldownUntil: 5100,
      },
    ]);
    expect(result.stats.activeModel).toBe("large");
  });

  it("waits for the earliest cooled model when every candidate is cooled", async () => {
    let now = 0;
    const models: Array<string | undefined> = [];
    const sleeps: number[] = [];
    const result = await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      provider: {
        name: "fake",
        complete: async (request) => {
          models.push(request.model);
          if (now < 1000) throw new LlmError("overload", `${request.model} overloaded`);
          return { text: "ok" };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: {
        ...noopRetryDeps,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
      taskFileCount: 1,
      modelCandidates: ["small", "large"],
      modelCooldownMs: 1000,
    });

    expect(models).toEqual(["small", "large", "small"]);
    expect(sleeps).toEqual([1000]);
    expect(result.stats.failed).toBe(2);
    expect(result.stats.analyzed).toBe(1);
    expect(result.stats.modelGuards?.map((event) => event.model)).toEqual(["small", "large"]);
  });
});

describe("runLlmGraphEnhancement", () => {
  it("calls upstream layer/project/tour prompt parsers and applies parsed graph updates", async () => {
    const prompts: string[] = [];
      let projectSummaryArgs: unknown[] | null = null;
    const graph = {
      project: { name: "repo", description: "deterministic", frameworks: [] },
        nodes: [{ id: "src/a.ts", type: "file", filePath: "src/a.ts" }],
      edges: [],
      layers: [{ id: "det", name: "deterministic" }],
      tour: [{ order: 1, title: "deterministic" }],
    };
    const result = await runLlmGraphEnhancement({
      enabled: true,
      required: false,
      graph,
      projectContext: "repo",
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          if (request.prompt === "layer-prompt") return { text: "layer-response" };
          if (request.prompt === "summary-prompt") return { text: "summary-response" };
          return { text: "tour-response" };
        },
      },
      core: {
        buildLayerDetectionPrompt: (g: any) => (g === graph ? "layer-prompt" : "bad"),
        parseLayerDetectionResponse: (text: string) => text === "layer-response" ? { layers: [{ id: "llm", name: "LLM", nodeIds: ["src/a.ts"] }] } : null,
        applyLLMLayers: (g: any, parsed: any) => ({ ...g, layers: parsed.layers }),
          buildProjectSummaryPrompt: (...args: unknown[]) => {
            projectSummaryArgs = args;
            return "summary-prompt";
          },
        parseProjectSummaryResponse: (text: string) => text === "summary-response" ? { summary: "LLM project", frameworks: ["vitest"] } : null,
        buildTourGenerationPrompt: (g: any) => (g.project?.summary === "LLM project" ? "tour-prompt" : "bad"),
        parseTourGenerationResponse: (text: string) => text === "tour-response" ? [{ order: 1, title: "LLM tour" }] : null,
      },
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });

    expect(prompts).toEqual(["layer-prompt", "summary-prompt", "tour-prompt"]);
      expect(projectSummaryArgs).toEqual([["src/a.ts"], []]);
    expect(result.graph.layers).toEqual([{ id: "llm", name: "LLM", nodeIds: ["src/a.ts"] }]);
    expect(result.graph.project.summary).toBe("LLM project");
    expect(result.graph.project.frameworks).toEqual(["vitest"]);
    expect(result.graph.tour).toEqual([{ order: 1, title: "LLM tour" }]);
    expect(result.stats).toMatchObject({ enabled: true, providerName: "fake", requested: 3, applied: 3, failed: 0 });
  });

  it("records graph-level parse failures when not required", async () => {
    const result = await runLlmGraphEnhancement({
      enabled: true,
      required: false,
      graph: { project: {}, nodes: [], edges: [], layers: [], tour: [] },
      projectContext: "repo",
      provider: { name: "fake", complete: async () => ({ text: "bad" }) },
      core: {
        buildLayerDetectionPrompt: () => "layer-prompt",
        parseLayerDetectionResponse: () => null,
      },
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });

    expect(result.stats.failed).toBe(1);
    expect(result.stats.failures[0]?.stage).toBe("layers");
    expect(result.graph.layers).toEqual([]);
  });
});

describe("applyLanguageDirective", () => {
  it("prepends a Chinese directive for zh and keeps JSON structure guidance", () => {
    const out = applyLanguageDirective("PROMPT_BODY", "zh");
    expect(out).not.toBe("PROMPT_BODY");
    expect(out.endsWith("PROMPT_BODY")).toBe(true);
    expect(out).toContain("中文");
    expect(out).toContain("JSON");
  });

  it("prepends the directive for any zh-* variant", () => {
    const out = applyLanguageDirective("BODY", "zh-CN");
    expect(out.startsWith("BODY")).toBe(false);
    expect(out.endsWith("BODY")).toBe(true);
    expect(out).toContain("中文");
  });

  it("returns the prompt unchanged for en", () => {
    expect(applyLanguageDirective("BODY", "en")).toBe("BODY");
  });

  it("returns the prompt unchanged when language is undefined", () => {
    expect(applyLanguageDirective("BODY", undefined)).toBe("BODY");
  });
});

describe("outputLanguage wiring", () => {
  it("injects the zh directive into file-analysis prompts sent to the provider", async () => {
    const prompts: string[] = [];
    await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      outputLanguage: "zh",
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          return {
            text: JSON.stringify({
              results: [
                { filePath: "src/a.ts", response: { fileSummary: "A", tags: [], complexity: "simple", functionSummaries: {}, classSummaries: {} } },
              ],
            }),
          };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("中文");
    expect(prompts[0]).toContain("src/a.ts:source:repo");
    expect(prompts[0]!.endsWith("src/a.ts:source:repo")).toBe(true);
  });

  it("leaves file-analysis prompts unchanged for en", async () => {
    const prompts: string[] = [];
    await runLlmFileAnalysis({
      enabled: true,
      required: false,
      files: [{ path: "src/a.ts" }],
      analysisRoot: "/repo",
      projectContext: "repo",
      readFile: () => "source",
      outputLanguage: "en",
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          return {
            text: JSON.stringify({
              results: [
                { filePath: "src/a.ts", response: { fileSummary: "A", tags: [], complexity: "simple", functionSummaries: {}, classSummaries: {} } },
              ],
            }),
          };
        },
      },
      core: fakeCore,
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });
    expect(prompts[0]).not.toContain("中文");
  });

  it("injects the zh directive into graph-enhancement prompts", async () => {
    const prompts: string[] = [];
    const graph = {
      project: { name: "repo", description: "d", frameworks: [] },
      nodes: [{ id: "src/a.ts", type: "file", filePath: "src/a.ts" }],
      edges: [],
      layers: [],
      tour: [],
    };
    await runLlmGraphEnhancement({
      enabled: true,
      required: false,
      graph,
      projectContext: "repo",
      outputLanguage: "zh",
      provider: {
        name: "fake",
        complete: async (request) => {
          prompts.push(request.prompt);
          return { text: "bad" };
        },
      },
      core: {
        buildLayerDetectionPrompt: () => "layer-prompt",
        parseLayerDetectionResponse: () => null,
      },
      retryPolicy: noRetryPolicy,
      retryDeps: noopRetryDeps,
    });
    expect(prompts[0]).toContain("中文");
    expect(prompts[0]).toContain("layer-prompt");
  });
});
