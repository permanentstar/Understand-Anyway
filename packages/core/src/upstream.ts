/**
 * Upstream runtime binding for Understand-Anyway.
 *
 * Understand-Anyway depends on the upstream Understand-Anything plugin at
 * runtime but never bundles it (see ROADMAP "Upstream coupling"). This module
 * locates the installed plugin, dynamically imports its `@understand-anything/core`
 * module, and asserts the deterministic-build contract is present — failing fast
 * with an actionable error when the plugin is missing or has drifted.
 *
 * All fs/env/require/import access is injectable so the resolution logic can be
 * unit-tested without a real upstream installation (CI main gate has none).
 */

import { createRequire as nodeCreateRequire } from "node:module";
import { existsSync as nodeExistsSync, realpathSync as nodeRealpathSync } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UPSTREAM_SKILL_DIR = "skills/understand";
const UPSTREAM_PACKAGE_JSON = "package.json";
const UPSTREAM_CORE_PACKAGE = "@understand-anything/core";
const UPSTREAM_DIST_CORE_ENTRY = "packages/core/dist/index.js";

/** Deterministic-build scripts that must exist under the upstream skill dir. */
export const REQUIRED_UPSTREAM_SCRIPTS = [
  "scan-project.mjs",
  "compute-batches.mjs",
  "merge-batch-graphs.py",
] as const;

/** Core exports the deterministic build pipeline relies on. */
export const REQUIRED_CORE_EXPORTS = [
  "TreeSitterPlugin",
  "PluginRegistry",
  "builtinLanguageConfigs",
  "registerAllParsers",
  "GraphBuilder",
  "validateGraph",
  "getChangedFiles",
  "buildLayerDetectionPrompt",
  "parseLayerDetectionResponse",
  "applyLLMLayers",
  "buildProjectSummaryPrompt",
  "parseProjectSummaryResponse",
  "buildTourGenerationPrompt",
  "parseTourGenerationResponse",
] as const;

export const REQUIRED_LLM_CORE_EXPORTS = [
  "buildLayerDetectionPrompt",
  "parseLayerDetectionResponse",
  "applyLLMLayers",
  "buildProjectSummaryPrompt",
  "parseProjectSummaryResponse",
  "buildTourGenerationPrompt",
  "parseTourGenerationResponse",
] as const;

export const REQUIRED_LLM_UPSTREAM_SCRIPTS = REQUIRED_UPSTREAM_SCRIPTS;

export const PLUGIN_ROOT_SOURCES = {
  EXPLICIT: "explicit",
  ENV_UA_PLUGIN_ROOT: "env:UA_PLUGIN_ROOT",
  HOME_PLUGIN_DIR: "home:.understand-anything-plugin",
  INSTALL_REPO_DIR: "install:.understand-anything/repo/understand-anything-plugin",
} as const;

export type PluginRootSource = (typeof PLUGIN_ROOT_SOURCES)[keyof typeof PLUGIN_ROOT_SOURCES];

export const CORE_LOAD_STRATEGIES = {
  PACKAGE_EXPORT: "package-export",
  DIST_FALLBACK: "dist-fallback",
} as const;

export type CoreLoadStrategy = (typeof CORE_LOAD_STRATEGIES)[keyof typeof CORE_LOAD_STRATEGIES];

export interface PluginRootCandidate {
  source: PluginRootSource;
  inputPath: string;
  resolvedPath: string;
  exists: boolean;
}

export interface ResolvedPluginRoot {
  source: PluginRootSource;
  path: string;
  packageJsonPath: string;
  candidates: PluginRootCandidate[];
}

export interface CoreModuleResolution {
  strategy: CoreLoadStrategy;
  modulePath: string;
}

export interface UpstreamRuntime {
  pluginRoot: string;
  skillDir: string;
  core: any;
  resolvedRoot: ResolvedPluginRoot;
  coreModule: CoreModuleResolution;
}

export interface UpstreamDeps {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  realpathSync?: (path: string) => string;
  homedir?: () => string;
  createRequire?: typeof nodeCreateRequire;
  importModule?: (specifier: string) => Promise<any>;
}

const defaultImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<any>;

function withDefaults(deps: UpstreamDeps = {}): Required<UpstreamDeps> {
  return {
    env: deps.env ?? process.env,
    existsSync: deps.existsSync ?? nodeExistsSync,
    realpathSync: deps.realpathSync ?? nodeRealpathSync,
    homedir: deps.homedir ?? nodeHomedir,
    createRequire: deps.createRequire ?? nodeCreateRequire,
    importModule: deps.importModule ?? defaultImport,
  };
}

export function listPluginRootCandidates(
  explicitPluginRoot: string | null = null,
  deps: UpstreamDeps = {},
): PluginRootCandidate[] {
  const d = withDefaults(deps);
  const home = d.homedir();
  const raw: Array<{ source: PluginRootSource; path: string | null | undefined }> = [
    { source: PLUGIN_ROOT_SOURCES.EXPLICIT, path: explicitPluginRoot },
    { source: PLUGIN_ROOT_SOURCES.ENV_UA_PLUGIN_ROOT, path: d.env.UA_PLUGIN_ROOT },
    { source: PLUGIN_ROOT_SOURCES.HOME_PLUGIN_DIR, path: resolve(home, ".understand-anything-plugin") },
    { source: PLUGIN_ROOT_SOURCES.INSTALL_REPO_DIR, path: resolve(home, ".understand-anything/repo/understand-anything-plugin") },
  ];

  const candidates: PluginRootCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (!candidate.path) continue;
    const resolvedPath = resolve(candidate.path);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    candidates.push({
      source: candidate.source,
      inputPath: candidate.path,
      resolvedPath,
      exists: d.existsSync(resolvedPath),
    });
  }
  return candidates;
}

export function resolvePluginRoot(
  explicitPluginRoot: string | null = null,
  deps: UpstreamDeps = {},
): ResolvedPluginRoot {
  const d = withDefaults(deps);
  const candidates = listPluginRootCandidates(explicitPluginRoot, deps);
  for (const candidate of candidates) {
    if (!candidate.exists) continue;
    const pluginRoot = d.realpathSync(candidate.resolvedPath);
    const packageJsonPath = resolve(pluginRoot, UPSTREAM_PACKAGE_JSON);
    if (!d.existsSync(packageJsonPath)) {
      throw new Error(`upstream plugin root '${pluginRoot}' is missing ${UPSTREAM_PACKAGE_JSON}`);
    }
    return { source: candidate.source, path: pluginRoot, packageJsonPath, candidates };
  }

  const tried = candidates.map((c) => c.resolvedPath).join(", ") || "<none>";
  throw new Error(
    `unable to locate the upstream Understand-Anything plugin. Install it, or set UA_PLUGIN_ROOT / pass --plugin-root. Tried: ${tried}`,
  );
}

export function resolveSkillDir(
  pluginRoot: string,
  options: { requireExists?: boolean } = {},
  deps: UpstreamDeps = {},
): string {
  const d = withDefaults(deps);
  const skillDir = resolve(pluginRoot, UPSTREAM_SKILL_DIR);
  if (options.requireExists !== false && !d.existsSync(skillDir)) {
    throw new Error(`upstream skill directory not found: ${skillDir}`);
  }
  return skillDir;
}

export function resolveCoreModule(pluginRoot: string, deps: UpstreamDeps = {}): CoreModuleResolution {
  const d = withDefaults(deps);
  const requireFromPlugin = d.createRequire(resolve(pluginRoot, UPSTREAM_PACKAGE_JSON));
  try {
    return {
      strategy: CORE_LOAD_STRATEGIES.PACKAGE_EXPORT,
      modulePath: requireFromPlugin.resolve(UPSTREAM_CORE_PACKAGE),
    };
  } catch {
    const fallbackPath = resolve(pluginRoot, UPSTREAM_DIST_CORE_ENTRY);
    if (!d.existsSync(fallbackPath)) {
      throw new Error(
        `unable to resolve ${UPSTREAM_CORE_PACKAGE} from '${pluginRoot}' via package export or fallback '${fallbackPath}'`,
      );
    }
    return { strategy: CORE_LOAD_STRATEGIES.DIST_FALLBACK, modulePath: fallbackPath };
  }
}

export async function loadUpstreamCore(
  coreModule: CoreModuleResolution,
  deps: UpstreamDeps = {},
): Promise<any> {
  const d = withDefaults(deps);
  return d.importModule(pathToFileURL(coreModule.modulePath).href);
}

/**
 * Drift probe: fail fast if the deterministic-build
 * contract is incomplete — required core exports or upstream scripts missing.
 */
export function assertUpstreamContract(
  core: any,
  skillDir: string,
  deps: UpstreamDeps = {},
): void {
  const d = withDefaults(deps);
  const missingExports = REQUIRED_CORE_EXPORTS.filter((name) => core?.[name] === undefined);
  if (missingExports.length > 0) {
    throw new Error(
      `upstream core is missing required export(s): ${missingExports.join(", ")} (upstream version drift?)`,
    );
  }
  const missingScripts = REQUIRED_UPSTREAM_SCRIPTS.filter(
    (name) => !d.existsSync(resolve(skillDir, name)),
  );
  if (missingScripts.length > 0) {
    throw new Error(
      `upstream skill dir '${skillDir}' is missing required script(s): ${missingScripts.join(", ")}`,
    );
  }
}

export function assertUpstreamLlmContract(
  core: any,
  skillDir: string,
  deps: UpstreamDeps = {},
): void {
  const d = withDefaults(deps);
  const missingCoreExports = REQUIRED_LLM_CORE_EXPORTS.filter((name) => core?.[name] === undefined);
  if (missingCoreExports.length > 0) {
    throw new Error(`upstream LLM contract check failed: missing core export(s): ${missingCoreExports.join(", ")}`);
  }
  const missingScripts = REQUIRED_LLM_UPSTREAM_SCRIPTS.filter((name) => !d.existsSync(resolve(skillDir, name)));
  if (missingScripts.length > 0) {
    throw new Error(`upstream LLM contract check failed: missing skill script(s): ${missingScripts.join(", ")}`);
  }
}

export interface BootstrapUpstreamOptions {
  pluginRoot?: string | null;
  requireSkillDir?: boolean;
  assertContract?: boolean;
}

export async function bootstrapUpstream(
  options: BootstrapUpstreamOptions = {},
  deps: UpstreamDeps = {},
): Promise<UpstreamRuntime> {
  const resolvedRoot = resolvePluginRoot(options.pluginRoot ?? null, deps);
  const skillDir = resolveSkillDir(resolvedRoot.path, { requireExists: options.requireSkillDir }, deps);
  const coreModule = resolveCoreModule(resolvedRoot.path, deps);
  const core = await loadUpstreamCore(coreModule, deps);
  if (options.assertContract !== false) {
    assertUpstreamContract(core, skillDir, deps);
  }
  return { pluginRoot: resolvedRoot.path, skillDir, core, resolvedRoot, coreModule };
}
