/**
 * Single source of truth for the projectsRoot directory contract.
 *
 * The schema lives with the gateway's reader half
 * ({@link file:///./../../gateway/src/portal-projects-config.ts}); this module
 * adds the writer half — template expansion, atomic write with a mkdir-lock,
 * and the `init` upsert primitives. Schema/template semantics stay aligned
 * with {@link file:///./../../../scripts/lib/discover-projects.mjs} so bash
 * tooling and the CLI agree on what a registered project looks like.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import {
  readProjectsConfig as gatewayReadProjectsConfig,
  type ProjectsConfig,
  type ProjectsConfigEntry,
} from "@understand-anyway/gateway";

export type { ProjectsConfig, ProjectsConfigEntry };

export interface ProjectsConfigTemplateVars {
  projectBaseDir: string;
  projectsRoot: string;
  projectId: string;
  HOME: string;
}

export const PORTAL_ICON_EXTENSIONS = [".svg", ".png", ".webp", ".jpg", ".jpeg"] as const;
export type PortalIconExtension = (typeof PORTAL_ICON_EXTENSIONS)[number];

const PROJECTS_CONFIG_LOCK_TIMEOUT_MS = 10000;
const PROJECTS_CONFIG_LOCK_SLEEP_MS = 50;

/**
 * Compute `<projectsRoot>/gateway`. This is the control-plane/runtime root for
 * portal, shared gateway, registry, operations, and deployment config.
 */
export function buildGatewayRoot(projectsRoot: string): string {
  return resolve(projectsRoot, "gateway");
}

/**
 * Compute `<projectsRoot>/gateway/config/projects.json`. Two-tier convention only —
 * the CLI never accepts a separate `--projects-config` override.
 */
export function buildProjectsConfigPath(projectsRoot: string): string {
  return resolve(buildGatewayRoot(projectsRoot), "config", "projects.json");
}

/**
 * Compute `<projectsRoot>/gateway/config/deploy.yaml`.
 */
export function buildDeployConfigPath(projectsRoot: string): string {
  return resolve(buildGatewayRoot(projectsRoot), "config", "deploy.yaml");
}

/**
 * Compute `<projectsRoot>/gateway/portal-assets/`. Two-tier convention only — the CLI
 * never accepts a separate `--portal-assets-root` override.
 */
export function buildPortalAssetsRoot(projectsRoot: string): string {
  return resolve(buildGatewayRoot(projectsRoot), "portal-assets");
}

/**
 * Compute `<projectsRoot>/gateway/registry.json`.
 */
export function buildGatewayRegistryPath(projectsRoot: string): string {
  return resolve(buildGatewayRoot(projectsRoot), "registry.json");
}

/**
 * Compute `<projectsRoot>/gateway/operations/`.
 */
export function buildGatewayOperationsRoot(projectsRoot: string): string {
  return resolve(buildGatewayRoot(projectsRoot), "operations");
}

/**
 * Compute `<projectsRoot>/projects/<projectId>`.
 */
export function buildProjectStateRoot(projectsRoot: string, projectId: string): string {
  return resolve(projectsRoot, "projects", projectId);
}

/**
 * Compute `<portalAssetsRoot>/icons/<projectId><ext>`.
 */
export function buildPortalIconPath(
  portalAssetsRoot: string,
  projectId: string,
  ext: string,
): string {
  return resolve(portalAssetsRoot, "icons", `${projectId}${ext}`);
}

/**
 * Re-export the gateway's tolerant reader so the CLI can share one
 * implementation. Returns an empty config on ENOENT / parse failure.
 */
export const readProjectsConfig = gatewayReadProjectsConfig;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Atomically rewrite `<projectsRoot>/gateway/config/projects.json`. The write is
 * guarded by a `<path>.lock` mkdir-lock with a 10s deadline (same shape as
 * {@link import("@understand-anyway/gateway").ProjectRegistryStore}).
 */
export function writeProjectsConfigAtomic(
  configPath: string,
  config: ProjectsConfig,
): void {
  withProjectsConfigLock(configPath, () => {
    writeProjectsConfigUnlocked(configPath, config);
  });
}

/**
 * Write the config without acquiring the lock. Only safe to call from within
 * a `withProjectsConfigLock` callback that is doing a read-modify-write
 * sequence (so the outer scope already owns the lock).
 */
export function writeProjectsConfigUnlocked(
  configPath: string,
  config: ProjectsConfig,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const sortedProjects = [...config.projects].sort((a, b) =>
    String(a.projectId).localeCompare(String(b.projectId)),
  );
  const normalized: ProjectsConfig = {
    version: config.version || 1,
    ...(config.projectBaseDir ? { projectBaseDir: config.projectBaseDir } : {}),
    projects: sortedProjects.map(stripUndefined),
  };
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(tmpPath, configPath);
}

function stripUndefined(entry: ProjectsConfigEntry): ProjectsConfigEntry {
  const out: ProjectsConfigEntry = { projectId: entry.projectId };
  if (entry.repoPath !== undefined) out.repoPath = entry.repoPath;
  if (entry.name !== undefined) out.name = entry.name;
  if (entry.version !== undefined) out.version = entry.version;
  if (entry.sortOrder !== undefined) out.sortOrder = entry.sortOrder;
  if (entry.visible !== undefined) out.visible = entry.visible;
  if (entry.description !== undefined) out.description = entry.description;
  if (entry.excludeTests !== undefined) out.excludeTests = entry.excludeTests;
  return out;
}

export function withProjectsConfigLock<T>(configPath: string, callback: () => T): T {
  const lockDir = `${configPath}.lock`;
  const deadline = Date.now() + PROJECTS_CONFIG_LOCK_TIMEOUT_MS;
  mkdirSync(dirname(configPath), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`projects-config lock timeout: ${lockDir}`);
      }
      sleepSync(PROJECTS_CONFIG_LOCK_SLEEP_MS);
    }
  }
  try {
    return callback();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Expand `${...}` placeholders. Lookup order:
 *   1. The supplied vars table (`projectBaseDir`, `projectsRoot`, `projectId`,
 *      `HOME`).
 *   2. `process.env` for any other identifier.
 * Unknown identifiers expand to "" — matching
 * {@link file:///./../../../scripts/lib/discover-projects.mjs}.
 */
export function expandTemplate(
  value: string | undefined,
  vars: ProjectsConfigTemplateVars,
  envOverride?: NodeJS.ProcessEnv,
): string {
  const env = envOverride ?? process.env;
  const table: Record<string, string> = vars as unknown as Record<string, string>;
  return String(value || "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key) => {
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key] ?? "";
    return env[key] ?? "";
  });
}

export function resolveTemplatePath(
  template: string,
  anchor: string,
  vars: ProjectsConfigTemplateVars,
  envOverride?: NodeJS.ProcessEnv,
): string {
  const expanded = expandTemplate(template, vars, envOverride);
  if (!expanded) return "";
  return isAbsolute(expanded) ? resolve(expanded) : resolve(anchor, expanded);
}

export interface UpsertEntryResult {
  /** The final patched entry. */
  entry: ProjectsConfigEntry;
  /** True when the entry did not exist before. */
  created: boolean;
  /**
   * Fields where the existing entry's value differs from the requested patch.
   * Empty when nothing conflicts (including on creation).
   */
  conflicts: string[];
}

export interface UpsertEntryOptions {
  /** When true, conflicting fields are overwritten instead of reported. */
  force?: boolean;
}

/**
 * Fields whose change would silently re-target the project (rather than just
 * updating display metadata). Mutating any of these without `--force` produces
 * a conflict so the operator can review.
 */
const CONFLICT_TRACKED_FIELDS: ReadonlyArray<keyof ProjectsConfigEntry> = ["repoPath"];

/**
 * Apply `patch` on top of any pre-existing entry with the same `projectId`.
 * Only keys explicitly present on `patch` (non-undefined) are written;
 * unspecified fields are preserved. Mutating fields in
 * {@link CONFLICT_TRACKED_FIELDS} requires `--force`; routine display fields
 * (version/name/sortOrder/visible/description/excludeTests) overwrite freely
 * so `init` stays idempotent for the common case (e.g. version bumps).
 */
export function upsertEntry(
  config: ProjectsConfig,
  patch: ProjectsConfigEntry,
  options: UpsertEntryOptions = {},
): UpsertEntryResult {
  if (!patch.projectId || patch.projectId.trim().length === 0) {
    throw new Error("upsertEntry: projectId is required");
  }
  const projectId = patch.projectId.trim();
  const idx = config.projects.findIndex((entry) => entry.projectId === projectId);
  const previous = idx >= 0 ? config.projects[idx] : undefined;
  const conflicts: string[] = [];

  if (previous) {
    for (const key of CONFLICT_TRACKED_FIELDS) {
      const next = patch[key];
      if (next === undefined) continue;
      const current = previous[key];
      if (current !== undefined && current !== next) conflicts.push(String(key));
    }
  }

  if (!options.force && conflicts.length > 0 && previous) {
    return { entry: previous, created: false, conflicts };
  }

  const patchKeys = Object.keys(patch) as (keyof ProjectsConfigEntry)[];
  const merged: ProjectsConfigEntry = { ...(previous ?? { projectId }), projectId };
  for (const key of patchKeys) {
    if (key === "projectId") continue;
    const next = patch[key];
    if (next === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = next;
  }

  if (idx >= 0) {
    config.projects[idx] = merged;
  } else {
    config.projects.push(merged);
  }
  return { entry: merged, created: !previous, conflicts };
}

export interface CopyIconFileResult {
  destination: string;
  extension: PortalIconExtension;
}

export class IconExtensionError extends Error {}

/**
 * Copy a user-supplied icon file into `<portalAssetsRoot>/icons/<projectId><ext>`.
 *
 * The extension is preserved (lowercased) from the source file and must fall
 * within the {@link PORTAL_ICON_EXTENSIONS} whitelist; portal renderer Layer 1
 * scans for `${projectId}<ext>` by convention.
 *
 * Any existing icon for the project is overwritten (`force: true`).
 */
export function copyIconFile(
  sourcePath: string,
  portalAssetsRoot: string,
  projectId: string,
): CopyIconFileResult {
  if (!projectId || projectId.trim().length === 0) {
    throw new Error("copyIconFile: projectId is required");
  }
  const ext = extname(sourcePath).toLowerCase() as PortalIconExtension;
  if (!PORTAL_ICON_EXTENSIONS.includes(ext)) {
    throw new IconExtensionError(
      `unsupported icon extension: ${ext || "(none)"} (expected one of ${PORTAL_ICON_EXTENSIONS.join(", ")})`,
    );
  }
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`init: icon file not found: ${sourcePath}`);
  }
  const iconsDir = resolve(portalAssetsRoot, "icons");
  mkdirSync(iconsDir, { recursive: true });
  removeExistingIconVariants(iconsDir, projectId);
  const destination = buildPortalIconPath(portalAssetsRoot, projectId.trim(), ext);
  cpSync(sourcePath, destination, { force: true });
  return { destination, extension: ext };
}

function removeExistingIconVariants(iconsDir: string, projectId: string): void {
  if (!existsSync(iconsDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(iconsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (!PORTAL_ICON_EXTENSIONS.includes(ext as PortalIconExtension)) continue;
    if (entry.slice(0, entry.length - ext.length) !== projectId) continue;
    rmSync(resolve(iconsDir, entry), { force: true });
  }
}

/**
 * Resolve template vars for {@link expandTemplate}. The anchor for
 * `projectBaseDir` is `<projectsRoot>` itself — kept in lockstep with
 * scripts/lib/discover-projects.mjs.
 */
export function resolveTemplateVars(
  projectsRoot: string,
  projectId: string,
  projectBaseDir?: string,
  envOverride?: NodeJS.ProcessEnv,
): ProjectsConfigTemplateVars {
  const env = envOverride ?? process.env;
  const baseTemplate = projectBaseDir || "..";
  const resolvedBase = (() => {
    const expanded = String(baseTemplate).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key) => {
      if (key === "projectsRoot") return projectsRoot;
      if (key === "projectId") return projectId;
      if (key === "HOME") return env.HOME || homedir() || "";
      return env[key] ?? "";
    });
    if (!expanded) return projectsRoot;
    return isAbsolute(expanded) ? resolve(expanded) : resolve(projectsRoot, expanded);
  })();
  return {
    projectBaseDir: resolvedBase,
    projectsRoot,
    projectId,
    HOME: env.HOME || homedir() || "",
  };
}
