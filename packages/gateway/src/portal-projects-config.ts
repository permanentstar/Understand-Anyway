/**
 * Reader half of `<projectsRoot>/gateway/config/projects.json`, the OSS projects
 * metadata file the portal renders alongside the registry.
 *
 * The schema is the source of truth — the CLI's `projects-config.ts` re-uses
 * these types and primitives, so writer and reader cannot drift. Gateway-side
 * we only ever *read*; first-class write semantics (upsert/lock/template
 * expansion) live with the CLI.
 */

import { existsSync, readFileSync } from "node:fs";

export interface ProjectsConfigEntry {
  /** Stable project id, required. */
  projectId: string;
  /** Optional repo path template. Defaults to "${projectBaseDir}/${projectId}". */
  repoPath?: string;
  /** Display name; falls back to projectId. */
  name?: string;
  /** Display version (manually maintained). Decoupled from build version. */
  version?: string;
  /** Ascending sort order in the portal listing. */
  sortOrder?: number;
  /** When false, the portal hides the project card. Defaults to true. */
  visible?: boolean;
  /** Optional description string surfaced in tooltips/cards. */
  description?: string;
  /** Filter test files out of the graph by default. */
  excludeTests?: boolean;
}

export interface ProjectsConfig {
  version: number;
  /** Template for repo discovery, relative to the config file. Default "..". */
  projectBaseDir?: string;
  projects: ProjectsConfigEntry[];
}

export function createEmptyProjectsConfig(): ProjectsConfig {
  return { version: 1, projects: [] };
}

function isValidEntry(value: unknown): value is ProjectsConfigEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as ProjectsConfigEntry;
  return typeof entry.projectId === "string" && entry.projectId.trim().length > 0;
}

/**
 * Tolerant read of `projects.json`. ENOENT / JSON-parse failures / non-object
 * payloads yield an empty config so callers never have to special-case fresh
 * deploys.
 */
export function readProjectsConfig(configPath: string): ProjectsConfig {
  if (!existsSync(configPath)) return createEmptyProjectsConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return createEmptyProjectsConfig();
  }
  if (!parsed || typeof parsed !== "object") return createEmptyProjectsConfig();
  const obj = parsed as Partial<ProjectsConfig>;
  const projects = Array.isArray(obj.projects) ? obj.projects.filter(isValidEntry) : [];
  return {
    version: typeof obj.version === "number" ? obj.version : 1,
    projectBaseDir: typeof obj.projectBaseDir === "string" ? obj.projectBaseDir : undefined,
    projects,
  };
}
