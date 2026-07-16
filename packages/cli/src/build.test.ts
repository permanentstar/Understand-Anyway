import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBuild } from "./build.js";
import type { BuildArgs } from "./args.js";
import type { ProjectContext } from "./project-context.js";

function baseArgs(overrides: Partial<BuildArgs> = {}): BuildArgs {
  return {
    command: "build",
    projectId: "alpha",
    excludeTests: null,
    pluginRoot: null,
    outputLanguage: null,
    mode: "full",
    includePaths: [],
    config: null,
    deployProfile: null,
    llmAnalysis: null,
    llmProvider: null,
    llmProfile: null,
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

function fakeCtx(repoPath: string, stateRoot: string): ProjectContext {
  return {
    projectId: "alpha",
    repoPath,
    stateRoot,
    projectsRoot: "/projects",
    portalAssetsRoot: "/projects/gateway/portal-assets",
    projectsConfigPath: "/projects/gateway/config/projects.json",
    deployConfigPath: "/projects/gateway/config/deploy.yaml",
    entry: { projectId: "alpha" },
  };
}

describe("runBuild", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), "ua-build-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("bootstraps upstream then runs the pipeline with resolved roots", async () => {
    const bootstrap = vi.fn().mockResolvedValue({
      pluginRoot: "/plugin",
      skillDir: "/plugin/skills/understand",
      core: { marker: true },
    });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [1, 2], edges: [1] },
      gitHash: "abc",
      analyzedFiles: 2,
      paths: { stateRoot: repo },
    });

    const result = await runBuild(baseArgs({ outputLanguage: "zh", excludeTests: false }), {
      log: () => {},
      deps: {
        bootstrap,
        runBuild: runBuildPipeline,
        loadConfig: () => ({}),
        resolveProjectContext: () => fakeCtx(repo, repo),
      },
    });

    expect(bootstrap).toHaveBeenCalledWith({ pluginRoot: null });
    const call = runBuildPipeline.mock.calls[0]![0];
    expect(call.core).toEqual({ marker: true });
    expect(call.skillDir).toBe("/plugin/skills/understand");
    expect(call.projectRoot).toBe(repo);
    expect(call.stateRoot).toBe(repo);
    expect(call.outputLanguage).toBe("zh");
    expect(call.excludeTests).toBe(false);
    expect(call.mode).toBe("full");
    expect(result.analyzedFiles).toBe(2);
  });

  it("uses the registered project stateRoot and forwards --plugin-root", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "",
      analyzedFiles: 0,
      paths: { stateRoot: "/state" },
    });

    await runBuild(baseArgs({ pluginRoot: "/custom-plugin" }), {
      log: () => {},
      deps: {
        bootstrap,
        runBuild: runBuildPipeline,
        loadConfig: () => ({}),
        resolveProjectContext: () => fakeCtx(repo, "/state"),
      },
    });

    expect(bootstrap).toHaveBeenCalledWith({ pluginRoot: "/custom-plugin" });
    expect(runBuildPipeline.mock.calls[0]![0].stateRoot).toBe("/state");
  });

  it("uses the current project source mirror as scanRoot when versioned state is present", async () => {
    const stateDir = resolve(repo, "state");
    mkdirSync(resolve(stateDir, "source-mirror", "v1"), { recursive: true });
    writeFileSync(resolve(stateDir, "versioned-state.json"), JSON.stringify({ currentVersion: "v1" }));

    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "",
      analyzedFiles: 0,
      paths: { stateRoot: stateDir },
    });

    await runBuild(baseArgs(), {
      log: () => {},
      deps: {
        bootstrap,
        runBuild: runBuildPipeline,
        loadConfig: () => ({}),
        resolveProjectContext: () => fakeCtx(repo, stateDir),
      },
    });

    expect(runBuildPipeline.mock.calls[0]![0].scanRoot).toBe(resolve(stateDir, "source-mirror", "v1"));
  });

  it("fails fast when the repo directory does not exist", async () => {
    const bootstrap = vi.fn();
    await expect(
      runBuild(baseArgs(), {
        log: () => {},
        deps: {
          bootstrap,
          resolveProjectContext: () => fakeCtx(resolve(repo, "missing"), repo),
        },
      }),
    ).rejects.toThrow(/repo is not a directory/);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("loads build deploy profile and calls runBuildMode", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      mode: "incremental",
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });

    await runBuild(baseArgs({ mode: "incremental", deployProfile: "prod" }), {
      log: () => {},
      deps: {
        bootstrap,
        runBuild: runBuildPipeline,
        loadConfig: () => ({ deployProfiles: { prod: { build: { outputLanguage: "zh" } } } }),
        resolveProjectContext: () => fakeCtx(repo, repo),
      },
    });

    expect(runBuildPipeline.mock.calls[0]![0]).toMatchObject({
      mode: "incremental",
      outputLanguage: "zh",
    });
    expect(runBuildPipeline.mock.calls[0]![0]).not.toHaveProperty("allowFullFallback");
  });

  it("does not build llm provider when llm analysis is disabled", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const buildLlm = vi.fn();

    await runBuild(baseArgs(), {
      log: () => {},
      deps: {
        bootstrap,
        runBuild: runBuildPipeline,
        loadConfig: () => ({}),
        buildLlmProvider: buildLlm,
        resolveProjectContext: () => fakeCtx(repo, repo),
      },
    });

    expect(buildLlm).not.toHaveBeenCalled();
    expect(runBuildPipeline.mock.calls[0]![0].llm).toMatchObject({ enabled: false });
  });

  it("loads llm provider and passes it to core when enabled", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const assertLlmContract = vi.fn();
    const provider = { name: "fake-llm", complete: vi.fn() };
    const buildLlm = vi.fn().mockResolvedValue(provider);

    await runBuild(baseArgs({ llmAnalysis: true, llmRequired: true }), {
      log: () => {},
      deps: {
        bootstrap,
        assertLlmContract,
        runBuild: runBuildPipeline,
        loadConfig: () => ({ providers: { llm: { package: "pkg-llm" } } }),
        buildLlmProvider: buildLlm,
        resolveProjectContext: () => fakeCtx(repo, repo),
      },
    });

    expect(buildLlm).toHaveBeenCalledOnce();
    expect(buildLlm.mock.calls[0]![0]).toMatchObject({ enabled: true, packageName: "pkg-llm" });
    expect(runBuildPipeline.mock.calls[0]![0].llm).toMatchObject({
      enabled: true,
      required: true,
      provider,
    });
  });

  it("loads embedding provider and passes it to core when configured", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const buildEmbedding = vi.fn().mockResolvedValue({ name: "fake-embedding", embed: vi.fn() });

    await runBuild(baseArgs({ embeddingProvider: "pkg-embedding" } as any), {
      log: () => {},
      deps: {
        bootstrap,
        runBuild: runBuildPipeline,
        loadConfig: () => ({ providers: { embedding: { package: "pkg-embedding" } } }),
        buildEmbeddingProvider: buildEmbedding as any,
        resolveProjectContext: () => fakeCtx(repo, repo),
      } as any,
    });

    expect(buildEmbedding).toHaveBeenCalledOnce();
    expect(runBuildPipeline.mock.calls[0]![0].embedding).toMatchObject({
      enabled: true,
      provider: { name: "fake-embedding", embed: expect.any(Function) },
    });
  });

  it("loads embedding provider from config even without CLI flag", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const buildEmbedding = vi.fn().mockResolvedValue({ name: "fake-embedding", embed: vi.fn() });

    await runBuild(baseArgs(), {
      log: () => {},
      deps: {
        bootstrap,
        runBuild: runBuildPipeline,
        loadConfig: () => ({ providers: { embedding: { package: "cfg-embedding" } } }),
        buildEmbeddingProvider: buildEmbedding as any,
        resolveProjectContext: () => fakeCtx(repo, repo),
      } as any,
    });

    expect(buildEmbedding).toHaveBeenCalledOnce();
    expect(buildEmbedding.mock.calls[0]![0]).toMatchObject({ enabled: true, packageName: "cfg-embedding" });
    expect(runBuildPipeline.mock.calls[0]![0].embedding).toMatchObject({
      enabled: true,
      provider: { name: "fake-embedding", embed: expect.any(Function) },
    });
  });

  it("runs upstream LLM contract preflight before loading the provider", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const assertLlmContract = vi.fn();
    const buildLlm = vi.fn().mockResolvedValue({ name: "fake-llm", complete: vi.fn() });

    await runBuild(baseArgs({ llmAnalysis: true }), {
      log: () => {},
      deps: {
        bootstrap,
        assertLlmContract,
        runBuild: runBuildPipeline,
        loadConfig: () => ({ providers: { llm: { package: "pkg-llm" } } }),
        buildLlmProvider: buildLlm,
        resolveProjectContext: () => fakeCtx(repo, repo),
      },
    });

    expect(assertLlmContract).toHaveBeenCalledWith({}, "/p/s");
    expect(buildLlm).toHaveBeenCalledOnce();
  });

  it("forwards the configured LLM provider package to segmented mapper workers", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const buildLlm = vi.fn().mockResolvedValue({ name: "fake-llm", complete: vi.fn() });
    const deployConfigPath = resolve(repo, "deploy.yaml");
    writeFileSync(deployConfigPath, "version: 1\n", "utf8");

    await runBuild(baseArgs({ llmAnalysis: true }), {
      log: () => {},
      deps: {
        bootstrap,
        assertLlmContract: vi.fn(),
        runBuild: runBuildPipeline,
        loadConfig: () => ({
          deploy: {
            build: {
              llmRetry: {
                maxAttempts: 5,
                initialBackoffMs: 100,
                maxBackoffMs: 2000,
                backoffMultiplier: 3,
                jitterRatio: 0.1,
              },
            },
          },
          providers: { llm: { package: "cfg-pkg" } },
        }),
        buildLlmProvider: buildLlm,
        resolveProjectContext: () => ({ ...fakeCtx(repo, repo), deployConfigPath }),
      },
    });

    expect(runBuildPipeline.mock.calls[0]![0].llmWorkerArgs).toEqual(
      expect.arrayContaining(["--llm-provider", "cfg-pkg"]),
    );
    expect(runBuildPipeline.mock.calls[0]![0].llmWorkerArgs).toEqual(
      expect.arrayContaining(["--config", deployConfigPath]),
    );
    expect(runBuildPipeline.mock.calls[0]![0].llmWorkerArgs).toEqual(
      expect.arrayContaining(["--llm-retry-backoff-multiplier", "3", "--llm-retry-jitter-ratio", "0.1"]),
    );
  });

  it("prefers the CLI --llm-provider over config package", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const assertLlmContract = vi.fn();
    const buildLlm = vi.fn().mockResolvedValue({ name: "fake-llm", complete: vi.fn() });

    await runBuild(baseArgs({ llmAnalysis: true, llmProvider: "cli-pkg" }), {
      log: () => {},
      deps: {
        bootstrap,
        assertLlmContract,
        runBuild: runBuildPipeline,
        loadConfig: () => ({ providers: { llm: { package: "cfg-pkg" } } }),
        buildLlmProvider: buildLlm,
        resolveProjectContext: () => fakeCtx(repo, repo),
      },
    });

    expect(buildLlm.mock.calls[0]![0].packageName).toBe("cli-pkg");
  });

  it("loads llm provider from --llm-profile and passes profile config", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ pluginRoot: "/p", skillDir: "/p/s", core: {} });
    const runBuildPipeline = vi.fn().mockResolvedValue({
      graph: { nodes: [], edges: [] },
      gitHash: "abc",
      analyzedFiles: 0,
      paths: { stateRoot: repo },
    });
    const assertLlmContract = vi.fn();
    const buildLlm = vi.fn().mockResolvedValue({ name: "fake-llm", complete: vi.fn() });

    await runBuild(baseArgs({ llmAnalysis: true, llmProfile: "traex" }), {
      log: () => {},
      deps: {
        bootstrap,
        assertLlmContract,
        runBuild: runBuildPipeline,
        loadConfig: () => ({
          llmProfiles: {
            traex: {
              package: "@understand-anyway/provider-trae-cli-v2",
              config: { command: "traex", modelArg: "-m" },
            },
          },
        }),
        buildLlmProvider: buildLlm,
        resolveProjectContext: () => fakeCtx(repo, repo),
      },
    });

    expect(buildLlm.mock.calls[0]![0]).toMatchObject({
      packageName: "@understand-anyway/provider-trae-cli-v2",
      config: {
        providers: {
          llm: {
            package: "@understand-anyway/provider-trae-cli-v2",
            config: { command: "traex", modelArg: "-m" },
          },
        },
      },
    });
  });
});
