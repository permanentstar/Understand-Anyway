import { describe, expect, it, vi } from "vitest";
import {
  assertUpstreamContract,
  assertUpstreamLlmContract,
  bootstrapUpstream,
  CORE_LOAD_STRATEGIES,
  listPluginRootCandidates,
  PLUGIN_ROOT_SOURCES,
  REQUIRED_LLM_CORE_EXPORTS,
  resolveCoreModule,
  resolvePluginRoot,
  resolveSkillDir,
  REQUIRED_CORE_EXPORTS,
  REQUIRED_UPSTREAM_SCRIPTS,
  type UpstreamDeps,
} from "./upstream.js";

const HOME = "/home/u";

function makeCore(): Record<string, unknown> {
  return Object.fromEntries(REQUIRED_CORE_EXPORTS.map((name) => [name, () => undefined]));
}

function depsWith(existing: Set<string>, overrides: Partial<UpstreamDeps> = {}): UpstreamDeps {
  return {
    env: {},
    homedir: () => HOME,
    existsSync: (p: string) => existing.has(p),
    realpathSync: (p: string) => p,
    ...overrides,
  };
}

describe("listPluginRootCandidates", () => {
  it("orders explicit > env > home > install and dedupes", () => {
    const candidates = listPluginRootCandidates("/explicit", {
      env: { UA_PLUGIN_ROOT: "/env" },
      homedir: () => HOME,
      existsSync: () => false,
    });
    expect(candidates.map((c) => c.source)).toEqual([
      PLUGIN_ROOT_SOURCES.EXPLICIT,
      PLUGIN_ROOT_SOURCES.ENV_UA_PLUGIN_ROOT,
      PLUGIN_ROOT_SOURCES.HOME_PLUGIN_DIR,
      PLUGIN_ROOT_SOURCES.INSTALL_REPO_DIR,
    ]);
    expect(candidates[2]?.resolvedPath).toBe(`${HOME}/.understand-anything-plugin`);
  });

  it("skips empty candidates and dedupes identical paths", () => {
    const candidates = listPluginRootCandidates(null, {
      env: { UA_PLUGIN_ROOT: `${HOME}/.understand-anything-plugin` },
      homedir: () => HOME,
      existsSync: () => false,
    });
    const homePaths = candidates.filter((c) => c.resolvedPath === `${HOME}/.understand-anything-plugin`);
    expect(homePaths).toHaveLength(1);
  });
});

describe("resolvePluginRoot", () => {
  it("returns first existing candidate with package.json", () => {
    const existing = new Set([`${HOME}/.understand-anything-plugin`, `${HOME}/.understand-anything-plugin/package.json`]);
    const resolved = resolvePluginRoot(null, depsWith(existing));
    expect(resolved.source).toBe(PLUGIN_ROOT_SOURCES.HOME_PLUGIN_DIR);
    expect(resolved.path).toBe(`${HOME}/.understand-anything-plugin`);
  });

  it("env override wins over home", () => {
    const existing = new Set(["/env", "/env/package.json", `${HOME}/.understand-anything-plugin`]);
    const resolved = resolvePluginRoot(null, depsWith(existing, { env: { UA_PLUGIN_ROOT: "/env" } }));
    expect(resolved.source).toBe(PLUGIN_ROOT_SOURCES.ENV_UA_PLUGIN_ROOT);
    expect(resolved.path).toBe("/env");
  });

  it("throws actionable error when no candidate exists", () => {
    expect(() => resolvePluginRoot(null, depsWith(new Set()))).toThrow(/unable to locate the upstream/);
  });

  it("throws when plugin root exists but package.json missing", () => {
    const existing = new Set([`${HOME}/.understand-anything-plugin`]);
    expect(() => resolvePluginRoot(null, depsWith(existing))).toThrow(/missing package.json/);
  });
});

describe("resolveSkillDir", () => {
  it("returns skill dir when present", () => {
    const existing = new Set(["/root/skills/understand"]);
    expect(resolveSkillDir("/root", {}, depsWith(existing))).toBe("/root/skills/understand");
  });

  it("throws when required skill dir missing", () => {
    expect(() => resolveSkillDir("/root", {}, depsWith(new Set()))).toThrow(/skill directory not found/);
  });

  it("skips existence check when requireExists false", () => {
    expect(resolveSkillDir("/root", { requireExists: false }, depsWith(new Set()))).toBe("/root/skills/understand");
  });
});

describe("resolveCoreModule", () => {
  it("uses package export when resolvable", () => {
    const createRequire = (() => ({ resolve: () => "/root/node_modules/@understand-anything/core/index.js" })) as any;
    const res = resolveCoreModule("/root", { createRequire });
    expect(res.strategy).toBe(CORE_LOAD_STRATEGIES.PACKAGE_EXPORT);
    expect(res.modulePath).toBe("/root/node_modules/@understand-anything/core/index.js");
  });

  it("falls back to dist entry when package export fails", () => {
    const createRequire = (() => ({ resolve: () => { throw new Error("not found"); } })) as any;
    const existing = new Set(["/root/packages/core/dist/index.js"]);
    const res = resolveCoreModule("/root", { createRequire, existsSync: (p) => existing.has(p) });
    expect(res.strategy).toBe(CORE_LOAD_STRATEGIES.DIST_FALLBACK);
    expect(res.modulePath).toBe("/root/packages/core/dist/index.js");
  });

  it("throws when neither package export nor fallback resolves", () => {
    const createRequire = (() => ({ resolve: () => { throw new Error("not found"); } })) as any;
    expect(() => resolveCoreModule("/root", { createRequire, existsSync: () => false })).toThrow(/unable to resolve/);
  });
});

describe("assertUpstreamContract", () => {
  it("requires getChangedFiles for incremental commit-range detection", () => {
    expect(REQUIRED_CORE_EXPORTS).toContain("getChangedFiles");
  });

  it("requires graph-level LLM prompt/parser exports for wrap enhancement", () => {
    expect(REQUIRED_CORE_EXPORTS).toEqual(expect.arrayContaining([
      "buildLayerDetectionPrompt",
      "parseLayerDetectionResponse",
      "applyLLMLayers",
      "buildProjectSummaryPrompt",
      "parseProjectSummaryResponse",
      "buildTourGenerationPrompt",
      "parseTourGenerationResponse",
    ]));
  });

  it("passes when all exports and scripts present", () => {
    const existing = new Set(REQUIRED_UPSTREAM_SCRIPTS.map((s) => `/skill/${s}`));
    expect(() => assertUpstreamContract(makeCore(), "/skill", depsWith(existing))).not.toThrow();
  });

  it("throws on missing core export", () => {
    const core = makeCore();
    delete core.GraphBuilder;
    const existing = new Set(REQUIRED_UPSTREAM_SCRIPTS.map((s) => `/skill/${s}`));
    expect(() => assertUpstreamContract(core, "/skill", depsWith(existing))).toThrow(/missing required export\(s\): GraphBuilder/);
  });

  it("throws on missing upstream script", () => {
    const existing = new Set(["/skill/scan-project.mjs"]);
    expect(() => assertUpstreamContract(makeCore(), "/skill", depsWith(existing))).toThrow(/missing required script\(s\)/);
  });
});

describe("assertUpstreamLlmContract", () => {
  it("requires the LLM prompt/parser exports", () => {
    expect(REQUIRED_LLM_CORE_EXPORTS).toEqual(expect.arrayContaining([
      "buildLayerDetectionPrompt",
      "parseLayerDetectionResponse",
      "applyLLMLayers",
      "buildProjectSummaryPrompt",
      "parseProjectSummaryResponse",
      "buildTourGenerationPrompt",
      "parseTourGenerationResponse",
    ]));
  });

  it("throws on missing LLM-specific core export", () => {
    const core = makeCore();
    delete core.buildLayerDetectionPrompt;
    const existing = new Set(REQUIRED_UPSTREAM_SCRIPTS.map((s) => `/skill/${s}`));
    expect(() => assertUpstreamLlmContract(core, "/skill", depsWith(existing))).toThrow(/missing core export\(s\): buildLayerDetectionPrompt/);
  });
});

describe("bootstrapUpstream", () => {
  it("wires plugin root, skill dir, core, and asserts contract", async () => {
    const existing = new Set([
      "/env",
      "/env/package.json",
      "/env/skills/understand",
      ...REQUIRED_UPSTREAM_SCRIPTS.map((s) => `/env/skills/understand/${s}`),
    ]);
    const importModule = vi.fn().mockResolvedValue(makeCore());
    const createRequire = (() => ({ resolve: () => "/env/core.js" })) as any;
    const runtime = await bootstrapUpstream(
      {},
      depsWith(existing, { env: { UA_PLUGIN_ROOT: "/env" }, importModule, createRequire }),
    );
    expect(runtime.pluginRoot).toBe("/env");
    expect(runtime.skillDir).toBe("/env/skills/understand");
    expect(runtime.coreModule.modulePath).toBe("/env/core.js");
    expect(importModule).toHaveBeenCalledOnce();
  });

  it("propagates contract failure", async () => {
    const existing = new Set(["/env", "/env/package.json", "/env/skills/understand"]);
    const importModule = vi.fn().mockResolvedValue(makeCore());
    const createRequire = (() => ({ resolve: () => "/env/core.js" })) as any;
    await expect(
      bootstrapUpstream({}, depsWith(existing, { env: { UA_PLUGIN_ROOT: "/env" }, importModule, createRequire })),
    ).rejects.toThrow(/missing required script/);
  });
});
