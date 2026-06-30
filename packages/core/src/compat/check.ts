/**
 * Compat check orchestration.
 *
 * Loads the committed baseline (`compat.json`), bootstraps the installed
 * upstream plugin, extracts its current schema fingerprint, diffs it against the
 * baseline, and reports version drift. This is the full version of the section 8 drift
 * probe; C1's `assertUpstreamContract` remains the fast startup guard.
 *
 * Pure + injectable: fs/read/bootstrap are all overridable so the orchestration
 * is unit-testable without a real upstream installation (CI main gate has none).
 */

import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapUpstream,
  REQUIRED_CORE_EXPORTS,
  REQUIRED_UPSTREAM_SCRIPTS,
  type BootstrapUpstreamOptions,
  type UpstreamDeps,
} from "../upstream.js";
import { extractSchemaFingerprint, type SchemaFingerprint } from "./fingerprint.js";
import { diffFingerprint, type FingerprintDiff } from "./diff.js";

export interface CompatBaseline {
  verifiedUpstreamVersion: string;
  schemaFingerprint: SchemaFingerprint;
  requiredCoreExports: string[];
  requiredScripts: string[];
}

export interface CompatReport {
  ok: boolean;
  installedVersion: string | null;
  verifiedVersion: string;
  versionMatch: boolean;
  pluginRoot: string;
  diff: FingerprintDiff;
  current: SchemaFingerprint;
  baseline: SchemaFingerprint;
}

export class CompatError extends Error {}

type ReadTextFile = (path: string, encoding: "utf8") => string;
const defaultReadTextFile: ReadTextFile = (path, encoding) => nodeReadFileSync(path, encoding);

export interface CompatCheckOptions {
  pluginRoot?: string | null;
  /** Override the baseline path; defaults to the packaged `compat.json`. */
  baselinePath?: string;
}

export interface CompatCheckDeps {
  readFileSync?: ReadTextFile;
  bootstrap?: typeof bootstrapUpstream;
  upstreamDeps?: UpstreamDeps;
}

/**
 * Default packaged baseline: walk up from this module until a `compat.json` is
 * found. Works for both the bundled `dist/index.js` and the `src/compat/`
 * source layout (different nesting depths) without a hardcoded `../../..`.
 */
export function defaultBaselinePath(existsSync = nodeExistsSync): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, "compat.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CompatError("unable to locate packaged compat.json (searched ancestors of the compat module)");
}

export function loadBaseline(baselinePath: string, readFileSync: ReadTextFile = defaultReadTextFile): CompatBaseline {
  let raw: string;
  try {
    raw = readFileSync(baselinePath, "utf8");
  } catch (err) {
    throw new CompatError(`unable to read compat baseline at ${baselinePath}: ${(err as Error).message}`);
  }
  let parsed: CompatBaseline;
  try {
    parsed = JSON.parse(raw) as CompatBaseline;
  } catch (err) {
    throw new CompatError(`compat baseline at ${baselinePath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed.schemaFingerprint || !parsed.verifiedUpstreamVersion) {
    throw new CompatError(`compat baseline at ${baselinePath} is missing required fields`);
  }
  return parsed;
}

function readInstalledVersion(pluginRoot: string, readFileSync: ReadTextFile): string | null {
  try {
    const pkgRaw = readFileSync(resolve(pluginRoot, "packages/core/package.json"), "utf8");
    const version = (JSON.parse(pkgRaw) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function runCompatCheck(
  options: CompatCheckOptions = {},
  deps: CompatCheckDeps = {},
): Promise<CompatReport> {
  const readFileSync = deps.readFileSync ?? defaultReadTextFile;
  const bootstrap = deps.bootstrap ?? bootstrapUpstream;
  const baselinePath = options.baselinePath ?? defaultBaselinePath();

  const baseline = loadBaseline(baselinePath, readFileSync);

  const bootstrapOptions: BootstrapUpstreamOptions = { pluginRoot: options.pluginRoot ?? null };
  const upstream = await bootstrap(bootstrapOptions, deps.upstreamDeps ?? {});

  const current = extractSchemaFingerprint(upstream.core);
  const diff = diffFingerprint(baseline.schemaFingerprint, current);
  const installedVersion = readInstalledVersion(upstream.pluginRoot, readFileSync);
  const versionMatch = installedVersion === baseline.verifiedUpstreamVersion;

  return {
    ok: diff.ok,
    installedVersion,
    verifiedVersion: baseline.verifiedUpstreamVersion,
    versionMatch,
    pluginRoot: upstream.pluginRoot,
    diff,
    current,
    baseline: baseline.schemaFingerprint,
  };
}

/** Build a fresh baseline object from a live upstream (used by `compat --update`). */
export async function buildBaseline(
  options: CompatCheckOptions = {},
  deps: CompatCheckDeps = {},
): Promise<CompatBaseline> {
  const readFileSync = deps.readFileSync ?? defaultReadTextFile;
  const bootstrap = deps.bootstrap ?? bootstrapUpstream;
  const upstream = await bootstrap({ pluginRoot: options.pluginRoot ?? null }, deps.upstreamDeps ?? {});
  const schemaFingerprint = extractSchemaFingerprint(upstream.core);
  const installedVersion = readInstalledVersion(upstream.pluginRoot, readFileSync);
  return {
    verifiedUpstreamVersion: installedVersion ?? "unknown",
    schemaFingerprint,
    requiredCoreExports: [...REQUIRED_CORE_EXPORTS],
    requiredScripts: [...REQUIRED_UPSTREAM_SCRIPTS],
  };
}
