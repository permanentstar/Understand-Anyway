/**
 * Resolve a `projectId` into the per-project filesystem coordinates every
 * command needs (`repoPath`, `stateRoot`, etc.). This is the central place
 * the CLI agrees that:
 *
 * - The user's only knob is `UA_PROJECTS_ROOT` (or `--projects-root` on the
 *   handful of commands that already accept it). `<projectsRoot>` is then the
 *   anchor for every other path: `<projectsRoot>/gateway/config/projects.json`,
 *   `<projectsRoot>/gateway/portal-assets/`, `<projectsRoot>/projects/<projectId>/`.
 * - `stateDir` is never a free parameter — it is always
 *   `<projectsRoot>/projects/<projectId>`. Older entries' `stateDir` field is ignored.
 * - `repoPath` defaults to `${projectBaseDir}/${projectId}` and supports
 *   template strings (same syntax as scripts/lib/discover-projects.mjs).
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ArgsError } from "./args.js";
import {
  buildDeployConfigPath,
  buildPortalAssetsRoot,
  buildProjectStateRoot,
  buildProjectsConfigPath,
  readProjectsConfig,
  resolveTemplatePath,
  resolveTemplateVars,
  type ProjectsConfig,
  type ProjectsConfigEntry,
} from "./projects-config.js";

export interface ProjectContext {
  projectId: string;
  /** Resolved repo source path (where the code lives). */
  repoPath: string;
  /** Project state root: always `<projectsRoot>/projects/<projectId>`. */
  stateRoot: string;
  /** Root container, anchor for every other path. */
  projectsRoot: string;
  /** Conventional `<projectsRoot>/gateway/portal-assets/`. */
  portalAssetsRoot: string;
  /** Conventional `<projectsRoot>/gateway/config/projects.json`. */
  projectsConfigPath: string;
  /** Conventional `<projectsRoot>/gateway/config/deploy.yaml`. */
  deployConfigPath: string;
  /** Raw entry from projects.json (or null when unregistered). */
  entry: ProjectsConfigEntry | null;
}

export interface ResolveProjectsRootOptions {
  /** Explicit override (e.g. from a CLI flag); takes precedence over env. */
  explicit?: string | null;
  /** Override process.env for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the project root container. Precedence:
 *   1. Explicit override (e.g. `--projects-root` on gateway/dashboard).
 *   2. `UA_PROJECTS_ROOT` env.
 *   3. `$HOME/understand-projects`.
 *   4. Literal "understand-projects" (when no HOME is available).
 */
export function resolveProjectsRoot(options: ResolveProjectsRootOptions = {}): string {
  if (options.explicit && options.explicit.trim().length > 0) {
    return resolve(options.explicit.trim());
  }
  const env = options.env ?? process.env;
  const fromEnv = env.UA_PROJECTS_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  const home = env.HOME || env.USERPROFILE || "";
  return home ? resolve(home, "understand-projects") : "understand-projects";
}

export interface ResolveProjectContextOptions extends ResolveProjectsRootOptions {
  /** Pre-loaded config (avoids re-reading projects.json). */
  config?: ProjectsConfig;
}

/**
 * Look up `projectId` in `<projectsRoot>/gateway/config/projects.json` and resolve
 * all derived paths. Throws an `ArgsError` (caught by the CLI dispatcher)
 * when the project is not registered.
 */
export function resolveProjectContext(
  projectId: string,
  options: ResolveProjectContextOptions = {},
): ProjectContext {
  const id = (projectId ?? "").trim();
  if (!id) throw new ArgsError("missing required --project <id>");
  const projectsRoot = resolveProjectsRoot(options);
  const projectsConfigPath = buildProjectsConfigPath(projectsRoot);
  const deployConfigPath = buildDeployConfigPath(projectsRoot);
  const portalAssetsRoot = buildPortalAssetsRoot(projectsRoot);
  const config = options.config ?? readProjectsConfig(projectsConfigPath);
  const entry = config.projects.find((candidate) => candidate.projectId === id) ?? null;
  if (!entry) {
    const legacyConfigPath = resolve(projectsRoot, "config", "projects.json");
    if (!options.config && existsSync(legacyConfigPath) && !existsSync(projectsConfigPath)) {
      throw new ArgsError(
        `legacy projects config found at ${legacyConfigPath}; move it to ${projectsConfigPath} or run: understand-anyway init <repo>`,
      );
    }
    throw new ArgsError(
      `project '${id}' is not registered; run: understand-anyway init <repo>`,
    );
  }
  const env = options.env ?? process.env;
  const vars = resolveTemplateVars(projectsRoot, id, config.projectBaseDir, env);
  const repoTemplate = entry.repoPath || "${projectBaseDir}/${projectId}";
  const repoPath = resolveTemplatePath(repoTemplate, vars.projectBaseDir, vars, env);
  const stateRoot = buildProjectStateRoot(projectsRoot, id);
  return {
    projectId: id,
    repoPath,
    stateRoot,
    projectsRoot,
    portalAssetsRoot,
    projectsConfigPath,
    deployConfigPath,
    entry,
  };
}

/**
 * Resolve `<stateRoot>/dashboard-dist`, preferring the versioned-state link
 * (`<stateRoot>/current/dashboard-dist`) when present so the gateway always
 * serves the active release.
 */
export function resolveProjectDistDir(stateRoot: string): string {
  const versioned = resolve(stateRoot, "current", "dashboard-dist");
  if (existsSync(versioned)) return versioned;
  return resolve(stateRoot, "dashboard-dist");
}
