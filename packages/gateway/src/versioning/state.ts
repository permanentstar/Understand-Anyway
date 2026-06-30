/**
 * Gateway versioning state — immutable releases + current/stable pointers +
 * rollback + GC + audit ndjson.
 *
 * Layout under <projectsRoot>/gateway/runtime/:
 *   - state.json                JSON state record (currentVersion, stableVersion, ...)
 *   - releases/<versionId>/     immutable release: dist/ + manifest.json
 *   - current                   atomic symlink → releases/<currentVersion>/
 *   - audit.ndjson              ndjson audit trail of publish/set-stable/rollback/gc
 *
 * Atomic symlink swap: write `current.tmp-<pid>` then rename it over `current`
 * so concurrent readers never see the link missing.
 *
 * Release readiness probe: a release is "ready" only when its `dist/cli.js`
 * exists. Tests can override the entrypoint to suit alternative layouts.
 *
 * All side effects go through {@link GatewayVersioningDeps} so unit tests can
 * exercise the state machine without a real filesystem.
 */

import {
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

export interface GatewayPendingAction {
  type: string;
  version: string;
  message: string;
  createdAt: string;
}

export interface GatewayRetentionConfig {
  /**
   * Number of non-protected releases to keep. current + stable are always
   * retained on top of this. Default 1 → total retained = current + stable + 1.
   */
  maxVersions: number;
}

export interface GatewayStateRecord {
  version: number;
  currentVersion: string | null;
  stableVersion: string | null;
  stablePendingForCurrent: boolean;
  pendingActions: GatewayPendingAction[];
  retention: GatewayRetentionConfig;
  updatedAt: string | null;
}

export interface GatewayReleaseInfo {
  versionId: string;
  current: boolean;
  stable: boolean;
  manifest: Record<string, unknown> | null;
}

export interface GatewayVersioningDeps {
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
  /** Override the wall clock used in updatedAt + audit timestamps. */
  now?: () => Date;
  /** Override `process.pid` used in temp filenames. */
  pid?: number;
  /**
   * Relative path inside a release's dist/ that must exist for the release to
   * be considered usable. Default `"cli.js"` (matches OSS); injectable so a
   * downstream consumer (or test) can require a different entrypoint.
   */
  requiredDistEntry?: string;
}

const GATEWAY_DEFAULT_RETENTION = 1;
const DEFAULT_REQUIRED_DIST_ENTRY = "cli.js";

function getDeps(deps?: GatewayVersioningDeps) {
  return {
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
    requiredDistEntry: deps?.requiredDistEntry ?? DEFAULT_REQUIRED_DIST_ENTRY,
  };
}

export function buildGatewayRuntimePath(projectsRoot: string): string {
  return resolve(projectsRoot, "gateway", "runtime");
}

export function buildGatewayStatePath(projectsRoot: string): string {
  return resolve(buildGatewayRuntimePath(projectsRoot), "state.json");
}

export function buildGatewayReleasesPath(projectsRoot: string): string {
  return resolve(buildGatewayRuntimePath(projectsRoot), "releases");
}

export function buildGatewayReleasePath(versionId: string, projectsRoot: string): string {
  return resolve(buildGatewayReleasesPath(projectsRoot), normalizeVersionId(versionId));
}

export function buildGatewayReleaseDistPath(versionId: string, projectsRoot: string): string {
  return resolve(buildGatewayReleasePath(versionId, projectsRoot), "dist");
}

export function buildGatewayReleaseManifestPath(versionId: string, projectsRoot: string): string {
  return resolve(buildGatewayReleasePath(versionId, projectsRoot), "manifest.json");
}

export function buildGatewayCurrentLinkPath(projectsRoot: string): string {
  return resolve(buildGatewayRuntimePath(projectsRoot), "current");
}

export function buildGatewayAuditPath(projectsRoot: string): string {
  return resolve(buildGatewayRuntimePath(projectsRoot), "audit.ndjson");
}

export function normalizeVersionId(value: string | null | undefined): string {
  const versionId = String(value || "").trim();
  if (versionId === "." || versionId === "..") return "";
  return /^[A-Za-z0-9._-]+$/.test(versionId) ? versionId : "";
}

export function createVersionId(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

export function createEmptyGatewayState(): GatewayStateRecord {
  return {
    version: 1,
    currentVersion: null,
    stableVersion: null,
    stablePendingForCurrent: false,
    pendingActions: [],
    retention: { maxVersions: GATEWAY_DEFAULT_RETENTION },
    updatedAt: null,
  };
}

function writeJsonAtomic(filePath: string, payload: unknown, deps: ReturnType<typeof getDeps>): void {
  deps.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${deps.pid}.tmp`;
  deps.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  deps.renameSync(tmpPath, filePath);
}

function readJsonObjectIfExists<T>(filePath: string, deps: ReturnType<typeof getDeps>): T | null {
  if (!deps.existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = deps.readFileSync(filePath, "utf8") as unknown as string;
  } catch (err) {
    throw new Error(
      `gateway state read failed at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Refuse to silently reset to an empty state — that would lose
    // `stableVersion` and let the next publish overwrite a recoverable
    // record. Surface the corruption so an operator can restore from
    // audit.ndjson or back up the file before deleting it.
    throw new Error(
      `gateway state corrupt at ${filePath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Inspect the file and restore from audit.ndjson, or remove it after backing up to reset.`,
    );
  }
}

export function readGatewayState(projectsRoot: string, depsIn?: GatewayVersioningDeps): GatewayStateRecord {
  const deps = getDeps(depsIn);
  const payload = readJsonObjectIfExists<GatewayStateRecord>(buildGatewayStatePath(projectsRoot), deps);
  if (!payload || typeof payload !== "object") return createEmptyGatewayState();
  return {
    ...createEmptyGatewayState(),
    ...payload,
    pendingActions: Array.isArray(payload.pendingActions) ? payload.pendingActions : [],
    retention: {
      maxVersions: Math.max(1, Number(payload.retention?.maxVersions) || GATEWAY_DEFAULT_RETENTION),
    },
  };
}

export function writeGatewayState(state: GatewayStateRecord, projectsRoot: string, depsIn?: GatewayVersioningDeps): void {
  const deps = getDeps(depsIn);
  const nextState: GatewayStateRecord = {
    ...createEmptyGatewayState(),
    ...state,
    updatedAt: deps.now().toISOString(),
    retention: {
      maxVersions: Math.max(1, Number(state?.retention?.maxVersions) || GATEWAY_DEFAULT_RETENTION),
    },
    pendingActions: Array.isArray(state.pendingActions) ? state.pendingActions : [],
  };
  writeJsonAtomic(buildGatewayStatePath(projectsRoot), nextState, deps);
}

export function listGatewayReleaseIds(projectsRoot: string, depsIn?: GatewayVersioningDeps): string[] {
  const deps = getDeps(depsIn);
  const releasesRoot = buildGatewayReleasesPath(projectsRoot);
  if (!deps.existsSync(releasesRoot)) return [];
  return deps.readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => typeof entry === "object" && "isDirectory" in entry && entry.isDirectory())
    .map((entry) => (typeof entry === "string" ? entry : entry.name))
    .sort((left: string, right: string) => right.localeCompare(left));
}

export function isGatewayReleaseReady(versionId: string, projectsRoot: string, depsIn?: GatewayVersioningDeps): boolean {
  const deps = getDeps(depsIn);
  const normalized = normalizeVersionId(versionId);
  if (!normalized) return false;
  const releaseRoot = buildGatewayReleasePath(normalized, projectsRoot);
  if (!deps.existsSync(releaseRoot)) return false;
  return deps.existsSync(resolve(buildGatewayReleaseDistPath(normalized, projectsRoot), deps.requiredDistEntry));
}

export function readGatewayReleaseManifest(versionId: string, projectsRoot: string, depsIn?: GatewayVersioningDeps): Record<string, unknown> | null {
  const deps = getDeps(depsIn);
  return readJsonObjectIfExists<Record<string, unknown>>(buildGatewayReleaseManifestPath(versionId, projectsRoot), deps);
}

export function listGatewayReleases(projectsRoot: string, depsIn?: GatewayVersioningDeps): GatewayReleaseInfo[] {
  const state = readGatewayState(projectsRoot, depsIn);
  const current = normalizeVersionId(state.currentVersion);
  const stable = normalizeVersionId(state.stableVersion);
  return listGatewayReleaseIds(projectsRoot, depsIn).map((versionId) => ({
    versionId,
    current: versionId === current,
    stable: versionId === stable,
    manifest: readGatewayReleaseManifest(versionId, projectsRoot, depsIn),
  }));
}

function assertGatewayReleaseReady(versionId: string, action: string, projectsRoot: string, deps: ReturnType<typeof getDeps>): void {
  const normalized = normalizeVersionId(versionId);
  if (!normalized) {
    throw new Error(`${action} rejected: missing gateway release id`);
  }
  if (!deps.existsSync(buildGatewayReleasePath(normalized, projectsRoot))) {
    throw new Error(`${action} rejected: gateway release not found: ${normalized}`);
  }
  if (!isGatewayReleaseReady(normalized, projectsRoot, deps)) {
    throw new Error(`${action} rejected: gateway release '${normalized}' is incomplete (missing dist entrypoint)`);
  }
}

function clearAllPendingStableActions(actions: GatewayPendingAction[]): GatewayPendingAction[] {
  return (Array.isArray(actions) ? actions : []).filter((item) => item?.type !== "set-stable");
}

function derivePendingStableState(
  currentVersion: string | null | undefined,
  stableVersion: string | null | undefined,
  existingActions: GatewayPendingAction[],
  deps: ReturnType<typeof getDeps>,
): { stablePendingForCurrent: boolean; pendingActions: GatewayPendingAction[] } {
  const current = normalizeVersionId(currentVersion);
  const stable = normalizeVersionId(stableVersion);
  const cleared = clearAllPendingStableActions(existingActions);
  const pending = Boolean(current) && current !== stable;
  if (!pending) return { stablePendingForCurrent: false, pendingActions: cleared };
  cleared.push({
    type: "set-stable",
    version: current,
    message: "current gateway release is not marked stable; review and run `gateway set-stable` if confirmed",
    createdAt: deps.now().toISOString(),
  });
  return { stablePendingForCurrent: true, pendingActions: cleared };
}

export function appendGatewayAudit(payload: Record<string, unknown>, projectsRoot: string, depsIn?: GatewayVersioningDeps): void {
  const deps = getDeps(depsIn);
  const filePath = buildGatewayAuditPath(projectsRoot);
  deps.mkdirSync(dirname(filePath), { recursive: true });
  deps.writeFileSync(filePath, `${JSON.stringify({ ...payload, at: deps.now().toISOString() })}\n`, { flag: "a" });
}

function isSymlink(path: string, deps: ReturnType<typeof getDeps>): boolean {
  try {
    return deps.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Atomically point `current` at the given release. Writes a temp symlink and
 * renames it over the existing one so a concurrent reader never sees a missing
 * link. The previously-running gateway keeps using its already-loaded code; the
 * new link only affects the next process start / restart.
 */
export function pointGatewayCurrent(versionId: string, projectsRoot: string, depsIn?: GatewayVersioningDeps): void {
  const deps = getDeps(depsIn);
  const normalized = normalizeVersionId(versionId);
  pointGatewayCurrentTarget(resolve(buildGatewayReleasesPath(projectsRoot), normalized), projectsRoot, deps);
}

function pointGatewayCurrentTarget(targetPath: string, projectsRoot: string, deps: ReturnType<typeof getDeps>): void {
  const currentLink = buildGatewayCurrentLinkPath(projectsRoot);
  deps.mkdirSync(dirname(currentLink), { recursive: true });
  const tmpLink = `${currentLink}.tmp-${deps.pid}`;
  try {
    if (deps.existsSync(tmpLink) || isSymlink(tmpLink, deps)) deps.unlinkSync(tmpLink);
  } catch { /* ignore */ }
  deps.symlinkSync(targetPath, tmpLink);
  deps.renameSync(tmpLink, currentLink);
}

export function readGatewayCurrentLinkTarget(projectsRoot: string, depsIn?: GatewayVersioningDeps): string | null {
  const deps = getDeps(depsIn);
  const currentLink = buildGatewayCurrentLinkPath(projectsRoot);
  if (!isSymlink(currentLink, deps)) return null;
  try {
    return deps.readlinkSync(currentLink);
  } catch {
    return null;
  }
}

function previousGatewayCurrentTarget(
  state: GatewayStateRecord,
  projectsRoot: string,
  deps: ReturnType<typeof getDeps>,
): string | null {
  const linked = readGatewayCurrentLinkTarget(projectsRoot, deps);
  if (linked) return linked;
  const current = normalizeVersionId(state.currentVersion);
  return current ? buildGatewayReleasePath(current, projectsRoot) : null;
}

function restoreGatewayCurrentTarget(
  previousTarget: string | null,
  projectsRoot: string,
  deps: ReturnType<typeof getDeps>,
): void {
  const currentLink = buildGatewayCurrentLinkPath(projectsRoot);
  if (previousTarget) {
    pointGatewayCurrentTarget(previousTarget, projectsRoot, deps);
    return;
  }
  if (deps.existsSync(currentLink) || isSymlink(currentLink, deps)) deps.unlinkSync(currentLink);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface PublishGatewayOptions {
  stable?: boolean;
  reason?: string;
  retentionMaxVersions?: number;
}

export interface CleanupGatewayReleasesOptions {
  retentionMaxVersions?: number;
}

export function publishGatewayVersion(
  versionId: string,
  projectsRoot: string,
  options: PublishGatewayOptions = {},
  depsIn?: GatewayVersioningDeps,
): GatewayStateRecord {
  const deps = getDeps(depsIn);
  assertGatewayReleaseReady(versionId, "publish", projectsRoot, deps);
  const normalized = normalizeVersionId(versionId);
  const state = readGatewayState(projectsRoot, depsIn);
  const previousCurrentTarget = previousGatewayCurrentTarget(state, projectsRoot, deps);
  const nextState: GatewayStateRecord = {
    ...state,
    currentVersion: normalized,
    retention: { ...state.retention },
    pendingActions: [...state.pendingActions],
  };
  const isAlreadyStable = normalizeVersionId(nextState.stableVersion) === normalized;
  if (options.stable || isAlreadyStable) {
    nextState.stableVersion = normalized;
  }
  const derived = derivePendingStableState(nextState.currentVersion, nextState.stableVersion, nextState.pendingActions, deps);
  nextState.stablePendingForCurrent = derived.stablePendingForCurrent;
  nextState.pendingActions = derived.pendingActions;
  if (Number.isInteger(options.retentionMaxVersions) && Number(options.retentionMaxVersions) > 0) {
    nextState.retention.maxVersions = Number(options.retentionMaxVersions);
  }
  let currentLinkSwapped = false;
  try {
    pointGatewayCurrent(normalized, projectsRoot, depsIn);
    currentLinkSwapped = true;
    writeGatewayState(nextState, projectsRoot, depsIn);
  } catch (err) {
    if (currentLinkSwapped) {
      try {
        restoreGatewayCurrentTarget(previousCurrentTarget, projectsRoot, deps);
      } catch (restoreErr) {
        throw new Error(`publish failed: ${formatError(err)}; failed to restore current link: ${formatError(restoreErr)}`);
      }
    }
    throw err;
  }
  cleanupGatewayReleases(projectsRoot, depsIn);
  appendGatewayAudit({
    action: "publish",
    versionId: normalized,
    stable: Boolean(options.stable),
    reason: options.reason || null,
    stablePendingForCurrent: nextState.stablePendingForCurrent,
  }, projectsRoot, depsIn);
  return readGatewayState(projectsRoot, depsIn);
}

export function setStableGatewayVersion(
  versionId: string | null | undefined,
  projectsRoot: string,
  depsIn?: GatewayVersioningDeps,
): GatewayStateRecord {
  const deps = getDeps(depsIn);
  const state = readGatewayState(projectsRoot, depsIn);
  const resolvedVersion = normalizeVersionId(versionId) || normalizeVersionId(state.currentVersion);
  if (!resolvedVersion) {
    throw new Error("set-stable rejected: gateway has no current release");
  }
  assertGatewayReleaseReady(resolvedVersion, "set-stable", projectsRoot, deps);
  state.stableVersion = resolvedVersion;
  const derived = derivePendingStableState(state.currentVersion, state.stableVersion, state.pendingActions, deps);
  state.stablePendingForCurrent = derived.stablePendingForCurrent;
  state.pendingActions = derived.pendingActions;
  writeGatewayState(state, projectsRoot, depsIn);
  appendGatewayAudit({ action: "set-stable", versionId: resolvedVersion }, projectsRoot, depsIn);
  return readGatewayState(projectsRoot, depsIn);
}

export function rollbackGatewayToStable(projectsRoot: string, depsIn?: GatewayVersioningDeps): GatewayStateRecord {
  const deps = getDeps(depsIn);
  const state = readGatewayState(projectsRoot, depsIn);
  const stableVersion = normalizeVersionId(state.stableVersion);
  if (!stableVersion) {
    throw new Error("rollback rejected: gateway has no stable release");
  }
  assertGatewayReleaseReady(stableVersion, "rollback", projectsRoot, deps);
  const previousCurrentTarget = previousGatewayCurrentTarget(state, projectsRoot, deps);
  const nextState: GatewayStateRecord = {
    ...state,
    currentVersion: stableVersion,
    retention: { ...state.retention },
    pendingActions: [...state.pendingActions],
  };
  const derived = derivePendingStableState(nextState.currentVersion, nextState.stableVersion, nextState.pendingActions, deps);
  nextState.stablePendingForCurrent = derived.stablePendingForCurrent;
  nextState.pendingActions = derived.pendingActions;
  let currentLinkSwapped = false;
  try {
    pointGatewayCurrent(stableVersion, projectsRoot, depsIn);
    currentLinkSwapped = true;
    writeGatewayState(nextState, projectsRoot, depsIn);
  } catch (err) {
    if (currentLinkSwapped) {
      try {
        restoreGatewayCurrentTarget(previousCurrentTarget, projectsRoot, deps);
      } catch (restoreErr) {
        throw new Error(`rollback failed: ${formatError(err)}; failed to restore current link: ${formatError(restoreErr)}`);
      }
    }
    throw err;
  }
  cleanupGatewayReleases(projectsRoot, depsIn);
  appendGatewayAudit({ action: "rollback", versionId: stableVersion }, projectsRoot, depsIn);
  return readGatewayState(projectsRoot, depsIn);
}

export function cleanupGatewayReleases(
  projectsRoot: string,
  optionsOrDeps?: CleanupGatewayReleasesOptions | GatewayVersioningDeps,
  depsIn?: GatewayVersioningDeps,
): string[] {
  const cleanupOptions =
    optionsOrDeps && "retentionMaxVersions" in optionsOrDeps ? optionsOrDeps as CleanupGatewayReleasesOptions : {};
  const depsArg =
    optionsOrDeps && !("retentionMaxVersions" in optionsOrDeps)
      ? optionsOrDeps as GatewayVersioningDeps
      : depsIn;
  const deps = getDeps(depsArg);
  const state = readGatewayState(projectsRoot, depsArg);
  if (Number.isInteger(cleanupOptions.retentionMaxVersions) && Number(cleanupOptions.retentionMaxVersions) > 0) {
    state.retention.maxVersions = Number(cleanupOptions.retentionMaxVersions);
    writeGatewayState(state, projectsRoot, depsArg);
  }
  const protectedVersions = new Set<string>(
    [state.currentVersion, state.stableVersion]
      .map(normalizeVersionId)
      .filter((value): value is string => Boolean(value)),
  );
  const maxVersions = Math.max(1, Number(state.retention?.maxVersions) || GATEWAY_DEFAULT_RETENTION);
  const deleted: string[] = [];
  let keptNonProtected = 0;
  for (const versionId of listGatewayReleaseIds(projectsRoot, depsArg)) {
    if (protectedVersions.has(versionId)) continue;
    keptNonProtected += 1;
    if (keptNonProtected <= maxVersions) continue;
    deps.rmSync(buildGatewayReleasePath(versionId, projectsRoot), { recursive: true, force: true });
    deleted.push(versionId);
  }
  if (deleted.length > 0) {
    appendGatewayAudit({ action: "ttl-cleanup", deletedVersions: deleted }, projectsRoot, depsArg);
  }
  return deleted;
}
