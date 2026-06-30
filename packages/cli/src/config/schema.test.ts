import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { formatSchemaErrors, validateDeployConfig } from "./schema.js";

function valid(): Record<string, unknown> {
  return {
    version: 1,
    deploy: { host: "0.0.0.0", port: 18666, outputLanguage: "en" },
    providers: {
      auth: { package: "@example/auth", config: { appId: "x" } },
      llm: { package: "@example/llm", config: {} },
    },
    record: { providers: ["local"], config: {} },
    profiles: {
      "sso-portal": {
        portal: true,
        projectRoute: true,
        use: ["auth"],
        registry: "/r/registry.json",
        build: { mode: "incremental", llmAnalysis: true, llmRequired: false },
      },
    },
  };
}

function profile(cfg: Record<string, unknown>): Record<string, unknown> {
  return (cfg.profiles as Record<string, Record<string, unknown>>)["sso-portal"]!;
}

describe("validateDeployConfig", () => {
  it("accepts a fully valid config", () => {
    expect(validateDeployConfig(valid())).toEqual({ valid: true, errors: [] });
  });

  it("requires version", () => {
    const cfg = valid();
    delete cfg.version;
    const result = validateDeployConfig(cfg);
    expect(result.valid).toBe(false);
  });

  it("rejects a non-integer port", () => {
    const cfg = valid();
    (cfg.deploy as Record<string, unknown>).port = "18666";
    const result = validateDeployConfig(cfg);
    expect(result.valid).toBe(false);
    expect(formatSchemaErrors(result.errors)).toMatch(/port/);
  });

  it("rejects an unknown build mode", () => {
    const cfg = valid();
    (profile(cfg).build as Record<string, unknown>).mode = "turbo";
    const result = validateDeployConfig(cfg);
    expect(result.valid).toBe(false);
    expect(formatSchemaErrors(result.errors)).toMatch(/mode/);
  });

  it("rejects an unknown provider key (closed set)", () => {
    const cfg = valid();
    (cfg.providers as Record<string, unknown>).atuh = { package: "@typo/auth" };
    const result = validateDeployConfig(cfg);
    expect(result.valid).toBe(false);
    expect(formatSchemaErrors(result.errors)).toMatch(/atuh|additional/i);
  });

  it("requires a package name for a provider entry", () => {
    const cfg = valid();
    (cfg.providers as Record<string, unknown>).auth = { config: {} };
    expect(validateDeployConfig(cfg).valid).toBe(false);
  });

  it("passes unknown fields through on deploy (portal display passthrough)", () => {
    const cfg = valid();
    (cfg.deploy as Record<string, unknown>).title = "My Portal";
    (cfg.deploy as Record<string, unknown>).links = [{ label: "Docs", href: "/d" }];
    expect(validateDeployConfig(cfg).valid).toBe(true);
  });

  it("passes unknown fields through on a profile section", () => {
    const cfg = valid();
    profile(cfg).lang = "zh";
    profile(cfg).wordmarkAlt = "Alt";
    expect(validateDeployConfig(cfg).valid).toBe(true);
  });

  it("rejects an unknown key on a closed build section", () => {
    const cfg = valid();
    (profile(cfg).build as Record<string, unknown>).qpm = 10;
    expect(validateDeployConfig(cfg).valid).toBe(false);
  });

  it("validates the shipped deploy.example.yaml against the schema", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const exampleText = readFileSync(resolve(here, "../../deploy.example.yaml"), "utf8");
    const parsed = parseYaml(exampleText) as unknown;
    const result = validateDeployConfig(parsed);
    expect(formatSchemaErrors(result.errors)).toBe("");
    expect(result.valid).toBe(true);
  });

  it("accepts a complete llmRetry block", () => {
    const cfg = valid();
    (profile(cfg).build as Record<string, unknown>).llmRetry = {
      maxAttempts: 3,
      initialBackoffMs: 500,
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
      jitterRatio: 0.2,
    };
    expect(validateDeployConfig(cfg).valid).toBe(true);
  });

  it("accepts llmModelCandidates", () => {
    const cfg = valid();
    (profile(cfg).build as Record<string, unknown>).llmModelCandidates = ["small", "large"];
    expect(validateDeployConfig(cfg).valid).toBe(true);
  });

  it("accepts a notify provider block", () => {
    const cfg = valid();
    (cfg.providers as Record<string, unknown>).notify = {
      package: "@example/notify",
      config: { channel: "ops" },
    };
    expect(validateDeployConfig(cfg).valid).toBe(true);
  });

  it("rejects out-of-range llmRetry values", () => {
    const cfg = valid();
    (profile(cfg).build as Record<string, unknown>).llmRetry = { maxAttempts: 0 };
    expect(validateDeployConfig(cfg).valid).toBe(false);
    const cfg2 = valid();
    (profile(cfg2).build as Record<string, unknown>).llmRetry = { jitterRatio: 1.5 };
    expect(validateDeployConfig(cfg2).valid).toBe(false);
    const cfg3 = valid();
    (profile(cfg3).build as Record<string, unknown>).llmRetry = { backoffMultiplier: 0.5 };
    expect(validateDeployConfig(cfg3).valid).toBe(false);
  });

  it("rejects unknown keys inside llmRetry", () => {
    const cfg = valid();
    (profile(cfg).build as Record<string, unknown>).llmRetry = { circuitBreaker: true };
    expect(validateDeployConfig(cfg).valid).toBe(false);
  });

  it("accepts C7 batchMode/mapper tuning fields", () => {
    const cfg = valid();
    Object.assign(profile(cfg).build as Record<string, unknown>, {
      batchMode: "segmented",
      mapperBatchCount: 25,
      mapperConcurrency: 4,
    });
    expect(validateDeployConfig(cfg).valid).toBe(true);
  });

  it("rejects invalid C7 batchMode/mapper values", () => {
    const cfg = valid();
    (profile(cfg).build as Record<string, unknown>).batchMode = "turbo";
    expect(validateDeployConfig(cfg).valid).toBe(false);
    const cfg2 = valid();
    (profile(cfg2).build as Record<string, unknown>).mapperBatchCount = 0;
    expect(validateDeployConfig(cfg2).valid).toBe(false);
  });
});
