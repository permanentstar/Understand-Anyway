import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerArgs, runBatchMapperWorker } from "./batch-mapper-worker.js";

let workdir: string | null = null;

afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = null;
});

describe("parseWorkerArgs", () => {
  const minimum = [
    "--state-dir", "/state",
    "--project-root", "/repo",
    "--output-language", "en",
    "--indexes-file", "/state/.understand-anything/intermediate/batch-indexes-1-2.txt",
  ];

  it("parses the minimum required argv", () => {
    expect(parseWorkerArgs(minimum)).toEqual({
      stateDir: "/state",
      projectRoot: "/repo",
      outputLanguage: "en",
      indexesFile: "/state/.understand-anything/intermediate/batch-indexes-1-2.txt",
      includePathsFile: null,
        config: null,
      pluginRoot: null,
      llmAnalysis: false,
      llmProvider: null,
      llmModelCandidates: [],
      llmRequired: false,
      llmTimeoutMs: null,
      llmRetryPolicy: {},
      globalLlmConcurrency: null,
      llmQpmLimit: null,
    });
  });

  it("parses optional include-paths-file + plugin-root", () => {
      const parsed = parseWorkerArgs([
        ...minimum,
        "--include-paths-file", "/inc.txt",
        "--config", "/cfg/deploy.yaml",
        "--plugin-root", "/plugin",
      ]);
    expect(parsed.includePathsFile).toBe("/inc.txt");
      expect(parsed.config).toBe("/cfg/deploy.yaml");
    expect(parsed.pluginRoot).toBe("/plugin");
  });

  it("parses the full LLM-enabled argv shape including retry knobs", () => {
    const parsed = parseWorkerArgs([
      ...minimum,
      "--llm-analysis",
      "--llm-provider", "@pkg/llm",
      "--llm-model-candidates", "small,large",
      "--llm-required",
      "--llm-timeout", "30000",
      "--llm-retry-max-attempts", "5",
      "--llm-retry-initial-backoff", "100",
      "--llm-retry-max-backoff", "2000",
      "--llm-retry-backoff-multiplier", "3",
      "--llm-retry-jitter-ratio", "0.1",
      "--global-llm-concurrency", "2",
      "--llm-qpm-limit", "4",
    ]);
    expect(parsed.llmAnalysis).toBe(true);
    expect(parsed.llmProvider).toBe("@pkg/llm");
    expect(parsed.llmModelCandidates).toEqual(["small", "large"]);
    expect(parsed.llmRequired).toBe(true);
    expect(parsed.llmTimeoutMs).toBe(30000);
    expect(parsed.llmRetryPolicy).toEqual({
      maxAttempts: 5,
      initialBackoffMs: 100,
      maxBackoffMs: 2000,
      backoffMultiplier: 3,
      jitterRatio: 0.1,
    });
    expect(parsed.globalLlmConcurrency).toBe(2);
    expect(parsed.llmQpmLimit).toBe(4);
  });

  it("rejects unknown options", () => {
    expect(() => parseWorkerArgs([...minimum, "--turbo"])).toThrow(/unknown worker option/);
  });

  it("rejects missing required flags", () => {
    expect(() => parseWorkerArgs([])).toThrow(/missing required worker option/);
  });

  it("rejects invalid numeric worker options before running LLM work", () => {
    expect(() => parseWorkerArgs([...minimum, "--llm-retry-max-attempts", "nope"])).toThrow(/--llm-retry-max-attempts/);
    expect(() => parseWorkerArgs([...minimum, "--llm-retry-jitter-ratio", "1.5"])).toThrow(/--llm-retry-jitter-ratio/);
    expect(() => parseWorkerArgs([...minimum, "--global-llm-concurrency", "0"])).toThrow(/--global-llm-concurrency/);
    expect(() => parseWorkerArgs([...minimum, "--llm-timeout", "--llm-provider"])).toThrow(/--llm-timeout/);
  });

  it("runs upstream LLM contract preflight before loading the provider", async () => {
    workdir = mkdtempSync(join(tmpdir(), "ua-worker-"));
    const stateDir = join(workdir, "state");
    const intermediateDir = join(stateDir, ".understand-anything", "intermediate");
    mkdirSync(intermediateDir, { recursive: true });
    writeFileSync(
      join(intermediateDir, "batches.json"),
      JSON.stringify({
        batches: [{ batchIndex: 1, files: [{ path: "src/a.ts" }] }],
      }),
    );
    writeFileSync(join(intermediateDir, "batch-indexes-1-1.txt"), "1\n");
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;\n");

    const args = parseWorkerArgs([
      "--state-dir", stateDir,
      "--project-root", workdir,
      "--output-language", "en",
      "--indexes-file", join(intermediateDir, "batch-indexes-1-1.txt"),
        "--config", join(workdir, "deploy.yaml"),
      "--llm-analysis",
      "--llm-provider", "@pkg/llm",
    ]);

    const assertLlmContract = vi.fn();
    const loadLlmProvider = vi.fn().mockResolvedValue({ name: "fake", complete: async () => ({ text: "ok" }) });

    await runBatchMapperWorker(args, () => {}, {
      bootstrap: async () => ({
        pluginRoot: workdir!,
        skillDir: workdir!,
        core: {},
        resolvedRoot: { source: "explicit", path: workdir!, packageJsonPath: join(workdir!, "package.json"), candidates: [] },
        coreModule: { strategy: "package-export", modulePath: join(workdir!, "index.js") },
      }),
      assertLlmContract,
      createRegistry: async () => ({}),
      loadLlmProvider,
      resolveGitHash: () => "git-hash",
      runLlm: vi.fn(async () => ({
        analyses: new Map(),
        stats: { enabled: true, requested: 1, analyzed: 0, failed: 0, skipped: 0, failures: [] },
      })),
      analyzeBatch: vi.fn(() => ({
        batchIndex: 1,
        analyzed: 1,
        artifact: { nodes: [], edges: [] },
      })),
      writeBatchFile: vi.fn(),
      readFileSync: (path) => {
        if (path === join(workdir!, "src", "a.ts")) return "export const a = 1;\n";
        return readFileSync(path, "utf8");
      },
    });

    expect(assertLlmContract).toHaveBeenCalledWith({}, workdir);
      expect(loadLlmProvider).toHaveBeenCalledWith("@pkg/llm", join(workdir, "deploy.yaml"));
  });

  it("forwards split llm budget into runLlmFileAnalysis", async () => {
    workdir = mkdtempSync(join(tmpdir(), "ua-worker-"));
    const stateDir = join(workdir, "state");
    const intermediateDir = join(stateDir, ".understand-anything", "intermediate");
    mkdirSync(intermediateDir, { recursive: true });
    writeFileSync(
      join(intermediateDir, "batches.json"),
      JSON.stringify({
        batches: [{ batchIndex: 1, files: [{ path: "src/a.ts" }] }],
      }),
    );
    writeFileSync(join(intermediateDir, "batch-indexes-1-1.txt"), "1\n");
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;\n");

    const args = parseWorkerArgs([
      "--state-dir", stateDir,
      "--project-root", workdir,
      "--output-language", "en",
      "--indexes-file", join(intermediateDir, "batch-indexes-1-1.txt"),
      "--llm-analysis",
      "--llm-provider", "@pkg/llm",
      "--global-llm-concurrency", "2",
      "--llm-qpm-limit", "4",
    ]);

    const runLlm = vi.fn(async () => ({
      analyses: new Map(),
      stats: { enabled: true, requested: 1, analyzed: 0, failed: 0, skipped: 0, failures: [] },
    }));
    const assertLlmContract = vi.fn();
    const writeBatchFile = vi.fn();

    await runBatchMapperWorker(args, () => {}, {
      bootstrap: async () => ({
        pluginRoot: workdir!,
        skillDir: workdir!,
        core: {},
        resolvedRoot: { source: "explicit", path: workdir!, packageJsonPath: join(workdir!, "package.json"), candidates: [] },
        coreModule: { strategy: "package-export", modulePath: join(workdir!, "index.js") },
      }),
      assertLlmContract,
      createRegistry: async () => ({}),
      loadLlmProvider: async () => ({ name: "fake", complete: async () => ({ text: "ok" }) }),
      resolveGitHash: () => "git-hash",
      runLlm,
      analyzeBatch: vi.fn(() => ({
        batchIndex: 1,
        analyzed: 1,
        artifact: { nodes: [], edges: [] },
      })),
      writeBatchFile,
      readFileSync: (path) => {
        if (path === join(workdir!, "src", "a.ts")) return "export const a = 1;\n";
        return readFileSync(path, "utf8");
      },
    });

    expect(runLlm).toHaveBeenCalledTimes(1);
    const firstCall = (runLlm.mock.calls[0] as [any] | undefined)?.[0];
    expect(firstCall).toMatchObject({
      qpmLimit: 4,
      globalConcurrency: 2,
      files: [{ path: "src/a.ts" }],
    });
    expect(writeBatchFile).toHaveBeenCalledTimes(1);
    const written = (writeBatchFile.mock.calls[0] as [string, { artifact: Record<string, unknown> }] | undefined)?.[1];
    expect(written?.artifact.llmEnriched).toBe(true);
  });
});
