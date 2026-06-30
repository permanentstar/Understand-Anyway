/**
 * Project-level versioned state.
 *
 * Layout under one project state root:
 *   - versioned-state.json
 *   - versions/<versionId>/.understand-anything/
 *   - source-mirror/<versionId>/
 *   - current -> versions/<currentVersion>
 *   - stable  -> versions/<stableVersion>
 *   - audit.ndjson           append-only audit trail (publish/set-stable/rollback/ttl-cleanup)
 *
 * This module owns filesystem primitives only. CLI exposure is tracked
 * separately by G27, and graph-health pointer resolution by G20.
 */

import {
  cpSync as nodeCpSync,
  existsSync as nodeExistsSync,
  lstatSync as nodeLstatSync,
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  readlinkSync as nodeReadlinkSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  symlinkSync as nodeSymlinkSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeVersionId } from "./state.js";

export interface ProjectVersionRetentionConfig {
  maxVersions: number;
}

export interface ProjectVersionStateRecord {
  version: number;
  currentVersion: string | null;
  stableVersion: string | null;
  retention: ProjectVersionRetentionConfig;
  updatedAt: string | null;
}

export interface SeedProjectVersionOptions {
  stable?: boolean;
  sourceRoot?: string;
  retentionMaxVersions?: number;
  now?: () => Date;
}

export interface CleanupProjectVersionsOptions {
  retentionMaxVersions?: number;
}

export interface ProjectVersioningDeps {
  cpSync?: typeof nodeCpSync;
  existsSync?: typeof nodeExistsSync;
  lstatSync?: typeof nodeLstatSync;
  mkdirSync?: typeof nodeMkdirSync;
  readdirSync?: typeof nodeReaddirSync;
  readFileSync?: typeof nodeReadFileSync;
  readlinkSync?: typeof nodeReadlinkSync;
  renameSync?: typeof nodeRenameSync;
  rmSync?: typeof nodeRmSync;
  symlinkSync?: typeof nodeSymlinkSync;
  unlinkSync?: typeof nodeUnlinkSync;
  writeFileSync?: typeof nodeWriteFileSync;
  now?: () => Date;
  pid?: number;
}

const DEFAULT_RETENTION = 1;

function getDeps(deps?: ProjectVersioningDeps) {
  return {
    cpSync: deps?.cpSync ?? nodeCpSync,
    existsSync: deps?.existsSync ?? nodeExistsSync,
    lstatSync: deps?.lstatSync ?? nodeLstatSync,
    mkdirSync: deps?.mkdirSync ?? nodeMkdirSync,
    readdirSync: deps?.readdirSync ?? nodeReaddirSync,
    readFileSync: deps?.readFileSync ?? nodeReadFileSync,
    readlinkSync: deps?.readlinkSync ?? nodeReadlinkSync,
    renameSync: deps?.renameSync ?? nodeRenameSync,
    rmSync: deps?.rmSync ?? nodeRmSync,
    symlinkSync: deps?.symlinkSync ?? nodeSymlinkSync,
    unlinkSync: deps?.unlinkSync ?? nodeUnlinkSync,
    writeFileSync: deps?.writeFileSync ?? nodeWriteFileSync,
    now: deps?.now ?? (() => new Date()),
    pid: deps?.pid ?? process.pid,
  };
}

export function buildProjectVersionStatePath(stateRoot: string): string {
  return resolve(stateRoot, "versioned-state.json");
}

export function buildProjectVersionsPath(stateRoot: string): string {
  return resolve(stateRoot, "versions");
}

export function buildProjectVersionPath(versionId: string, stateRoot: string): string {
  return resolve(buildProjectVersionsPath(stateRoot), normalizeVersionId(versionId));
}

export function buildProjectVersionGraphRoot(versionId: string, stateRoot: string): string {
  return resolve(buildProjectVersionPath(versionId, stateRoot), ".understand-anything");
}

export function buildProjectVersionDashboardDistPath(versionId: string, stateRoot: string): string {
  return resolve(buildProjectVersionPath(versionId, stateRoot), "dashboard-dist");
}

export function buildProjectSourceMirrorRoot(stateRoot: string): string {
  return resolve(stateRoot, "source-mirror");
}

export function buildProjectSourceMirrorPath(versionId: string, stateRoot: string): string {
  return resolve(buildProjectSourceMirrorRoot(stateRoot), normalizeVersionId(versionId));
}

export function buildProjectCurrentLinkPath(stateRoot: string): string {
  return resolve(stateRoot, "current");
}

export function buildProjectStableLinkPath(stateRoot: string): string {
  return resolve(stateRoot, "stable");
}

export function buildProjectAuditPath(stateRoot: string): string {
  return resolve(stateRoot, "audit.ndjson");
}

export function createEmptyProjectVersionState(): ProjectVersionStateRecord {
  return {
    version: 1,
    currentVersion: null,
    stableVersion: null,
    retention: { maxVersions: DEFAULT_RETENTION },
    updatedAt: null,
  };
}

function isSymlink(path: string, deps: ReturnType<typeof getDeps>): boolean {
  try {
    return deps.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readJsonObjectIfExists<T>(filePath: string, deps: ReturnType<typeof getDeps>): T | null {
  if (!deps.existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = deps.readFileSync(filePath, "utf8") as unknown as string;
  } catch (err) {
    throw new Error(
      `project version-state read failed at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Refuse to silently fall back to an empty state — losing `stableVersion`
    // would let the next publish overwrite a recoverable pointer. Make the
    // corruption an operator decision instead of a silent data loss.
    throw new Error(
      `project version-state corrupt at ${filePath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Inspect the file and recover the previous stableVersion, or remove it after backing up to reset.`,
    );
  }
}

function writeJsonAtomic(filePath: string, payload: unknown, deps: ReturnType<typeof getDeps>): void {
  deps.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${deps.pid}.tmp`;
  deps.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  deps.renameSync(tmpPath, filePath);
}

export function readProjectVersionState(stateRoot: string, depsIn?: ProjectVersioningDeps): ProjectVersionStateRecord {
  const deps = getDeps(depsIn);
  const payload = readJsonObjectIfExists<ProjectVersionStateRecord>(buildProjectVersionStatePath(stateRoot), deps);
  if (!payload || typeof payload !== "object") return createEmptyProjectVersionState();
  return {
    ...createEmptyProjectVersionState(),
    ...payload,
    retention: {
      maxVersions: Math.max(1, Number(payload.retention?.maxVersions) || DEFAULT_RETENTION),
    },
  };
}

export function writeProjectVersionState(
  state: ProjectVersionStateRecord,
  stateRoot: string,
  depsIn?: ProjectVersioningDeps,
): void {
  const deps = getDeps(depsIn);
  writeJsonAtomic(
    buildProjectVersionStatePath(stateRoot),
    {
      ...createEmptyProjectVersionState(),
      ...state,
      retention: {
        maxVersions: Math.max(1, Number(state.retention?.maxVersions) || DEFAULT_RETENTION),
      },
      updatedAt: deps.now().toISOString(),
    },
    deps,
  );
}

export function listProjectVersionIds(stateRoot: string, depsIn?: ProjectVersioningDeps): string[] {
  const deps = getDeps(depsIn);
  const versionsRoot = buildProjectVersionsPath(stateRoot);
  if (!deps.existsSync(versionsRoot)) return [];
  return deps.readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => typeof entry === "object" && "isDirectory" in entry && entry.isDirectory())
    .map((entry) => (typeof entry === "string" ? entry : entry.name))
    .sort((left: string, right: string) => right.localeCompare(left));
}

export function isProjectVersionReady(versionId: string, stateRoot: string, depsIn?: ProjectVersioningDeps): boolean {
  const deps = getDeps(depsIn);
  const graphRoot = buildProjectVersionGraphRoot(versionId, stateRoot);
  return Boolean(normalizeVersionId(versionId)) && deps.existsSync(resolve(graphRoot, "knowledge-graph.json"));
}

function assertProjectVersionReady(
  versionId: string,
  action: string,
  stateRoot: string,
  deps: ReturnType<typeof getDeps>,
): void {
  const normalized = normalizeVersionId(versionId);
  if (!normalized) throw new Error(`${action} rejected: missing project version id`);
  if (!deps.existsSync(buildProjectVersionPath(normalized, stateRoot))) {
    throw new Error(`${action} rejected: project version not found: ${normalized}`);
  }
  if (!isProjectVersionReady(normalized, stateRoot, deps)) {
    throw new Error(`${action} rejected: project version '${normalized}' is incomplete`);
  }
}

function pointLink(linkPath: string, targetPath: string, deps: ReturnType<typeof getDeps>): void {
  deps.mkdirSync(dirname(linkPath), { recursive: true });
  const tmpLink = `${linkPath}.tmp-${deps.pid}`;
  try {
    if (deps.existsSync(tmpLink) || isSymlink(tmpLink, deps)) deps.unlinkSync(tmpLink);
  } catch { /* ignore */ }
  deps.symlinkSync(targetPath, tmpLink);
  deps.renameSync(tmpLink, linkPath);
}

export function pointProjectCurrent(versionId: string, stateRoot: string, depsIn?: ProjectVersioningDeps): void {
  const deps = getDeps(depsIn);
  pointLink(buildProjectCurrentLinkPath(stateRoot), buildProjectVersionPath(versionId, stateRoot), deps);
}

export function pointProjectStable(versionId: string, stateRoot: string, depsIn?: ProjectVersioningDeps): void {
  const deps = getDeps(depsIn);
  pointLink(buildProjectStableLinkPath(stateRoot), buildProjectVersionPath(versionId, stateRoot), deps);
}

function readLinkTarget(path: string, deps: ReturnType<typeof getDeps>): string | null {
  if (!isSymlink(path, deps)) return null;
  try {
    return deps.readlinkSync(path);
  } catch {
    return null;
  }
}

export function readProjectCurrentLinkTarget(stateRoot: string, depsIn?: ProjectVersioningDeps): string | null {
  return readLinkTarget(buildProjectCurrentLinkPath(stateRoot), getDeps(depsIn));
}

export function readProjectStableLinkTarget(stateRoot: string, depsIn?: ProjectVersioningDeps): string | null {
  return readLinkTarget(buildProjectStableLinkPath(stateRoot), getDeps(depsIn));
}

function previousVersionLinkTarget(
  linkPath: string,
  previousVersion: string | null | undefined,
  stateRoot: string,
  deps: ReturnType<typeof getDeps>,
): string | null {
  const linked = readLinkTarget(linkPath, deps);
  if (linked) return linked;
  const normalized = normalizeVersionId(previousVersion);
  return normalized ? buildProjectVersionPath(normalized, stateRoot) : null;
}

function restoreVersionLink(
  linkPath: string,
  previousTarget: string | null,
  deps: ReturnType<typeof getDeps>,
): void {
  if (previousTarget) {
    pointLink(linkPath, previousTarget, deps);
    return;
  }
  if (deps.existsSync(linkPath) || isSymlink(linkPath, deps)) deps.unlinkSync(linkPath);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function replaceDir(source: string, target: string, deps: ReturnType<typeof getDeps>): void {
  deps.rmSync(target, { recursive: true, force: true });
  deps.mkdirSync(dirname(target), { recursive: true });
  deps.cpSync(source, target, { recursive: true, force: true, dereference: true });
}

export function appendProjectAudit(
  payload: Record<string, unknown>,
  stateRoot: string,
  depsIn?: ProjectVersioningDeps,
): void {
  const deps = getDeps(depsIn);
  const filePath = buildProjectAuditPath(stateRoot);
  deps.mkdirSync(dirname(filePath), { recursive: true });
  deps.writeFileSync(
    filePath,
    `${JSON.stringify({ ...payload, at: deps.now().toISOString() })}\n`,
    { flag: "a" },
  );
}

export function seedProjectVersion(
  versionId: string,
  stateRoot: string,
  options: SeedProjectVersionOptions = {},
  depsIn?: ProjectVersioningDeps,
): ProjectVersionStateRecord {
  const deps = getDeps({ ...depsIn, now: options.now ?? depsIn?.now });
  const normalized = normalizeVersionId(versionId);
  if (!normalized) throw new Error("seed rejected: missing project version id");
  const sourceGraphRoot = resolve(stateRoot, ".understand-anything");
  if (!deps.existsSync(resolve(sourceGraphRoot, "knowledge-graph.json"))) {
    throw new Error("seed rejected: current project state is missing .understand-anything/knowledge-graph.json");
  }
  replaceDir(sourceGraphRoot, buildProjectVersionGraphRoot(normalized, stateRoot), deps);
  const sourceDashboardDist = resolve(stateRoot, "dashboard-dist");
  if (deps.existsSync(sourceDashboardDist)) {
    replaceDir(sourceDashboardDist, buildProjectVersionDashboardDistPath(normalized, stateRoot), deps);
  }
  if (options.sourceRoot) {
    replaceDir(resolve(options.sourceRoot), buildProjectSourceMirrorPath(normalized, stateRoot), deps);
  }

  const state = readProjectVersionState(stateRoot, deps);
  const previousCurrentTarget = previousVersionLinkTarget(
    buildProjectCurrentLinkPath(stateRoot),
    state.currentVersion,
    stateRoot,
    deps,
  );
  const previousStableTarget = previousVersionLinkTarget(
    buildProjectStableLinkPath(stateRoot),
    state.stableVersion,
    stateRoot,
    deps,
  );
  const nextState = { ...state, currentVersion: normalized };
  const shouldPointStable = Boolean(options.stable);
  if (options.stable || normalizeVersionId(nextState.stableVersion) === normalized) {
    nextState.stableVersion = normalized;
  }
  if (Number.isInteger(options.retentionMaxVersions) && Number(options.retentionMaxVersions) > 0) {
    nextState.retention.maxVersions = Number(options.retentionMaxVersions);
  }
  let currentLinkSwapped = false;
  let stableLinkSwapped = false;
  try {
    pointProjectCurrent(normalized, stateRoot, deps);
    currentLinkSwapped = true;
    if (shouldPointStable) {
      pointProjectStable(normalized, stateRoot, deps);
      stableLinkSwapped = true;
    }
    writeProjectVersionState(nextState, stateRoot, deps);
  } catch (err) {
    const restoreErrors: string[] = [];
    if (stableLinkSwapped) {
      try { restoreVersionLink(buildProjectStableLinkPath(stateRoot), previousStableTarget, deps); } catch (restoreErr) {
        restoreErrors.push(`stable link: ${formatError(restoreErr)}`);
      }
    }
    if (currentLinkSwapped) {
      try { restoreVersionLink(buildProjectCurrentLinkPath(stateRoot), previousCurrentTarget, deps); } catch (restoreErr) {
        restoreErrors.push(`current link: ${formatError(restoreErr)}`);
      }
    }
    if (restoreErrors.length > 0) {
      throw new Error(`publish failed: ${formatError(err)}; failed to restore ${restoreErrors.join("; ")}`);
    }
    throw err;
  }
  cleanupProjectVersions(stateRoot, deps);
  appendProjectAudit(
    { action: "publish", versionId: normalized, stable: Boolean(options.stable) },
    stateRoot,
    deps,
  );
  return readProjectVersionState(stateRoot, deps);
}

export function setStableProjectVersion(
  versionId: string | null | undefined,
  stateRoot: string,
  depsIn?: ProjectVersioningDeps,
): ProjectVersionStateRecord {
  const deps = getDeps(depsIn);
  const state = readProjectVersionState(stateRoot, deps);
  const resolvedVersion = normalizeVersionId(versionId) || normalizeVersionId(state.currentVersion);
  assertProjectVersionReady(resolvedVersion, "set-stable", stateRoot, deps);
  const previousStableTarget = previousVersionLinkTarget(
    buildProjectStableLinkPath(stateRoot),
    state.stableVersion,
    stateRoot,
    deps,
  );
  const nextState = { ...state, stableVersion: resolvedVersion };
  let stableLinkSwapped = false;
  try {
    pointProjectStable(resolvedVersion, stateRoot, deps);
    stableLinkSwapped = true;
    writeProjectVersionState(nextState, stateRoot, deps);
  } catch (err) {
    if (stableLinkSwapped) {
      try {
        restoreVersionLink(buildProjectStableLinkPath(stateRoot), previousStableTarget, deps);
      } catch (restoreErr) {
        throw new Error(
          `set-stable failed: ${formatError(err)}; failed to restore stable link: ${formatError(restoreErr)}`,
        );
      }
    }
    throw err;
  }
  appendProjectAudit({ action: "set-stable", versionId: resolvedVersion }, stateRoot, deps);
  return readProjectVersionState(stateRoot, deps);
}

export function rollbackProjectToStable(
  stateRoot: string,
  depsIn?: ProjectVersioningDeps,
): ProjectVersionStateRecord {
  const deps = getDeps(depsIn);
  const state = readProjectVersionState(stateRoot, deps);
  const stableVersion = normalizeVersionId(state.stableVersion);
  if (!stableVersion) {
    throw new Error("rollback rejected: project has no stable version");
  }
  assertProjectVersionReady(stableVersion, "rollback", stateRoot, deps);
  const previousCurrentTarget = previousVersionLinkTarget(
    buildProjectCurrentLinkPath(stateRoot),
    state.currentVersion,
    stateRoot,
    deps,
  );
  const nextState = { ...state, currentVersion: stableVersion };
  let currentLinkSwapped = false;
  try {
    pointProjectCurrent(stableVersion, stateRoot, deps);
    currentLinkSwapped = true;
    writeProjectVersionState(nextState, stateRoot, deps);
  } catch (err) {
    if (currentLinkSwapped) {
      try {
        restoreVersionLink(buildProjectCurrentLinkPath(stateRoot), previousCurrentTarget, deps);
      } catch (restoreErr) {
        throw new Error(
          `rollback failed: ${formatError(err)}; failed to restore current link: ${formatError(restoreErr)}`,
        );
      }
    }
    throw err;
  }
  appendProjectAudit({ action: "rollback", versionId: stableVersion }, stateRoot, deps);
  return readProjectVersionState(stateRoot, deps);
}

export function cleanupProjectVersions(
  stateRoot: string,
  optionsOrDeps?: CleanupProjectVersionsOptions | ProjectVersioningDeps,
  depsIn?: ProjectVersioningDeps,
): string[] {
  const cleanupOptions =
    optionsOrDeps && "retentionMaxVersions" in optionsOrDeps ? optionsOrDeps as CleanupProjectVersionsOptions : {};
  const deps = getDeps(
    (optionsOrDeps && !("retentionMaxVersions" in optionsOrDeps) ? optionsOrDeps : depsIn) as ProjectVersioningDeps | undefined,
  );
  const state = readProjectVersionState(stateRoot, deps);
  if (Number.isInteger(cleanupOptions.retentionMaxVersions) && Number(cleanupOptions.retentionMaxVersions) > 0) {
    state.retention.maxVersions = Number(cleanupOptions.retentionMaxVersions);
    writeProjectVersionState(state, stateRoot, deps);
  }
  const protectedVersions = new Set<string>(
    [state.currentVersion, state.stableVersion]
      .map(normalizeVersionId)
      .filter((value): value is string => Boolean(value)),
  );
  const maxVersions = Math.max(1, Number(state.retention?.maxVersions) || DEFAULT_RETENTION);
  const deleted: string[] = [];
  let keptNonProtected = 0;
  for (const versionId of listProjectVersionIds(stateRoot, deps)) {
    if (protectedVersions.has(versionId)) continue;
    keptNonProtected += 1;
    if (keptNonProtected <= maxVersions) continue;
    deps.rmSync(buildProjectVersionPath(versionId, stateRoot), { recursive: true, force: true });
    deps.rmSync(buildProjectSourceMirrorPath(versionId, stateRoot), { recursive: true, force: true });
    deleted.push(versionId);
  }
  if (deleted.length > 0) {
    appendProjectAudit({ action: "ttl-cleanup", deletedVersions: deleted }, stateRoot, deps);
  }
  return deleted;
}
