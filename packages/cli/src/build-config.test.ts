import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_POLICY } from "@understand-anyway/core";
import type { BuildArgs } from "./args.js";
import { resolveBuildConfig } from "./build-config.js";

function args(overrides: Partial<BuildArgs> = {}): BuildArgs {
  return {
    command: "build",
    projectId: "x",
    excludeTests: null,
    pluginRoot: null,
    outputLanguage: null,
    mode: "full",
    includePaths: [],
    config: null,
    profile: null,
    llmAnalysis: null,
    llmProvider: null,
    embeddingProvider: null,
    llmRequired: null,
    llmModelCandidates: [],
    llmRetry: {
      maxAttempts: null,
      initialBackoffMs: null,
      maxBackoffMs: null,
    },
    batchMode: "auto",
    mapperBatchCount: null,
    mapperConcurrency: null,
    ...overrides,
  };
}

describe("resolveBuildConfig", () => {
  const tinyHostDeps = {
    hostMetrics: {
      cpus: () => new Array(1),
      totalmem: () => 1024 * 1024 * 1024, // 1 GB
    },
  };
  const bigHostDeps = {
    hostMetrics: {
      cpus: () => new Array(32),
      totalmem: () => 128 * 1024 * 1024 * 1024,
    },
  };

  it("uses defaults when no config is present", () => {
    const resolved = resolveBuildConfig(args(), {}, { env: {}, ...tinyHostDeps });
    expect(resolved).toEqual({
      mode: "full",
      includePaths: [],
      excludeTests: true,
      pluginRoot: null,
      outputLanguage: "en",
      llmAnalysis: false,
      llmRequired: false,
      llmModelCandidates: [],
      llmRetryPolicy: DEFAULT_RETRY_POLICY,
      batchMode: "auto",
      mapperBatchCount: 50,
      mapperConcurrency: 1,
    });
  });

  it("uses profile build defaults for stable template parameters", () => {
    const resolved = resolveBuildConfig(args({ profile: "nightly" }), {
      profiles: {
        nightly: {
          build: {
            mode: "incremental",
            outputLanguage: "zh",
            excludeTests: true,
          },
        },
      },
    });
    expect(resolved.mode).toBe("incremental");
    expect(resolved.outputLanguage).toBe("zh");
    expect(resolved.excludeTests).toBe(true);
  });

  it("lets YAML include test files when CLI does not set the test filter", () => {
    const resolved = resolveBuildConfig(args({ profile: "with-tests" }), {
      profiles: {
        "with-tests": {
          build: {
            excludeTests: false,
          },
        },
      },
    });
    expect(resolved.excludeTests).toBe(false);
  });

  it("lets CLI intent and include paths override profile intent", () => {
    const resolved = resolveBuildConfig(args({ mode: "backfill", includePaths: ["src/a.ts"], profile: "nightly" }), {
      profiles: { nightly: { build: { mode: "incremental" } } },
    });
    expect(resolved.mode).toBe("backfill");
    expect(resolved.includePaths).toEqual(["src/a.ts"]);
  });

  it("lets UA_BUILD_MODE_OVERRIDE force a full bootstrap over profile incremental defaults", () => {
    const resolved = resolveBuildConfig(args({ profile: "nightly" }), {
      profiles: { nightly: { build: { mode: "incremental" } } },
    }, {
      env: { UA_BUILD_MODE_OVERRIDE: "full" },
    });
    expect(resolved.mode).toBe("full");
  });

  it("does not read occasional include targets from deploy YAML", () => {
    const resolved = resolveBuildConfig(args({ profile: "repair" }), {
      profiles: { repair: { build: { mode: "backfill" }, include: ["src/a.ts"] } },
    });
    expect(resolved.mode).toBe("backfill");
    expect(resolved.includePaths).toEqual([]);
  });

  it("throws when the selected profile does not exist", () => {
    expect(() => resolveBuildConfig(args({ profile: "missing" }), { profiles: {} })).toThrow(/unknown --profile/);
  });

  it("resolves llm flags from profile build defaults", () => {
    const resolved = resolveBuildConfig(args({ profile: "llm-nightly" }), {
      profiles: { "llm-nightly": { build: { llmAnalysis: true, llmRequired: false, llmModelCandidates: ["small", "large"] } } },
    });
    expect(resolved.llmAnalysis).toBe(true);
    expect(resolved.llmRequired).toBe(false);
    expect(resolved.llmModelCandidates).toEqual(["small", "large"]);
  });

  it("lets CLI llm flags override config", () => {
    const resolved = resolveBuildConfig(args({ llmAnalysis: true, llmRequired: true }), {
      deploy: { build: { llmAnalysis: false, llmRequired: false } },
    });
    expect(resolved.llmAnalysis).toBe(true);
    expect(resolved.llmRequired).toBe(true);
  });

  it("falls back to DEFAULT_RETRY_POLICY when nothing is configured", () => {
    const resolved = resolveBuildConfig(args(), {}, { env: {} });
    expect(resolved.llmRetryPolicy).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("reads llmRetry from profile build defaults", () => {
    const resolved = resolveBuildConfig(args({ profile: "nightly" }), {
      profiles: {
        nightly: {
          build: {
            llmRetry: {
              maxAttempts: 4,
              initialBackoffMs: 250,
              maxBackoffMs: 5000,
              backoffMultiplier: 3,
              jitterRatio: 0.1,
            },
          },
        },
      },
    }, { env: {} });
    expect(resolved.llmRetryPolicy).toEqual({
      maxAttempts: 4,
      initialBackoffMs: 250,
      maxBackoffMs: 5000,
      backoffMultiplier: 3,
      jitterRatio: 0.1,
    });
  });

  it("UA_LLM_RETRY_* env overrides YAML profile but loses to CLI flags", () => {
    const resolved = resolveBuildConfig(
      args({
        profile: "nightly",
        llmRetry: { maxAttempts: 7, initialBackoffMs: null, maxBackoffMs: null },
      }),
      {
        profiles: {
          nightly: { build: { llmRetry: { maxAttempts: 5, initialBackoffMs: 100, maxBackoffMs: 200 } } },
        },
      },
      {
        env: {
          UA_LLM_RETRY_MAX_ATTEMPTS: "6",
          UA_LLM_RETRY_INITIAL_BACKOFF_MS: "300",
          UA_LLM_RETRY_MAX_BACKOFF_MS: "400",
        },
      },
    );
    expect(resolved.llmRetryPolicy.maxAttempts).toBe(7); // CLI wins
    expect(resolved.llmRetryPolicy.initialBackoffMs).toBe(300); // env > profile
    expect(resolved.llmRetryPolicy.maxBackoffMs).toBe(400); // env > profile
  });

  it("rejects invalid llmRetry YAML values", () => {
    expect(() =>
      resolveBuildConfig(args({ profile: "bad" }), {
        profiles: { bad: { build: { llmRetry: { maxAttempts: 0 } } } },
      }, { env: {} }),
    ).toThrow(/llmRetry.maxAttempts/);
    expect(() =>
      resolveBuildConfig(args({ profile: "bad" }), {
        profiles: { bad: { build: { llmRetry: { jitterRatio: 1.5 } } } },
      }, { env: {} }),
    ).toThrow(/llmRetry.jitterRatio/);
  });

  it("rejects invalid UA_LLM_RETRY_* env values", () => {
    expect(() =>
      resolveBuildConfig(args(), {}, { env: { UA_LLM_RETRY_MAX_ATTEMPTS: "0" } }),
    ).toThrow(/UA_LLM_RETRY_MAX_ATTEMPTS/);
    expect(() =>
      resolveBuildConfig(args(), {}, { env: { UA_LLM_RETRY_INITIAL_BACKOFF_MS: "-1" } }),
    ).toThrow(/UA_LLM_RETRY_INITIAL_BACKOFF_MS/);
  });

  it("auto-defaults mapper sizes from host tier (small host -> 50/1)", () => {
    const resolved = resolveBuildConfig(args(), {}, { env: {}, ...tinyHostDeps });
    expect(resolved.mapperBatchCount).toBe(50);
    expect(resolved.mapperConcurrency).toBe(1);
  });

  it("auto-defaults mapper sizes from host tier (big host -> 100/4)", () => {
    const resolved = resolveBuildConfig(args(), {}, { env: {}, ...bigHostDeps });
    expect(resolved.mapperBatchCount).toBe(100);
    expect(resolved.mapperConcurrency).toBe(4);
  });

  it("CLI batch-mode tuning overrides config and host defaults", () => {
    const resolved = resolveBuildConfig(
      args({ batchMode: "segmented", mapperBatchCount: 7, mapperConcurrency: 3 }),
      {
        profiles: { nightly: { build: { batchMode: "full", mapperBatchCount: 20, mapperConcurrency: 2 } } },
      },
      { env: {}, ...bigHostDeps },
    );
    expect(resolved.batchMode).toBe("segmented");
    expect(resolved.mapperBatchCount).toBe(7);
    expect(resolved.mapperConcurrency).toBe(3);
  });

  it("UA_MAPPER_* env overrides YAML but loses to CLI flags", () => {
    const resolved = resolveBuildConfig(
      args({ profile: "nightly", mapperBatchCount: 9, mapperConcurrency: null }),
      {
        profiles: { nightly: { build: { mapperBatchCount: 25, mapperConcurrency: 2 } } },
      },
      {
        env: { UA_MAPPER_BATCH_COUNT: "11", UA_MAPPER_CONCURRENCY: "5" },
        ...tinyHostDeps,
      },
    );
    expect(resolved.mapperBatchCount).toBe(9); // CLI wins
    expect(resolved.mapperConcurrency).toBe(5); // env > YAML
  });

  it("YAML profile batchMode/mapper sizes are picked up when CLI is unset", () => {
    const resolved = resolveBuildConfig(args({ profile: "nightly" }), {
      profiles: { nightly: { build: { batchMode: "segmented", mapperBatchCount: 16, mapperConcurrency: 2 } } },
    }, { env: {}, ...tinyHostDeps });
    expect(resolved.batchMode).toBe("segmented");
    expect(resolved.mapperBatchCount).toBe(16);
    expect(resolved.mapperConcurrency).toBe(2);
  });

  it("rejects invalid mapper YAML values", () => {
    expect(() =>
      resolveBuildConfig(args({ profile: "bad" }), {
        profiles: { bad: { build: { mapperBatchCount: 0 } } },
      }, { env: {}, ...tinyHostDeps }),
    ).toThrow(/mapperBatchCount/);
    expect(() =>
      resolveBuildConfig(args({ profile: "bad" }), {
        profiles: { bad: { build: { batchMode: "turbo" as unknown as "auto" } } },
      }, { env: {}, ...tinyHostDeps }),
    ).toThrow(/batchMode/);
  });
});
