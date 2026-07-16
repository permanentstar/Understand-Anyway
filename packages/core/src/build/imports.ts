/**
 * Internal import-target resolution, ported verbatim from deploy. This is the
 * in-house augmentation that maps a resolved import (relative path, alias, or
 * Java/Scala fully-qualified name like `org.apache.foo.Bar`) back to a real
 * source file inside the repo, so the graph gets `imports` edges that the bare
 * upstream scan would otherwise miss.
 *
 * fs access (`existsSync`/`lstatSync`) is injectable for unit testing.
 */

import { existsSync as nodeExistsSync, lstatSync as nodeLstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ImportFsDeps {
  existsSync?: (path: string) => boolean;
  lstatSync?: (path: string) => { isFile(): boolean };
}

export interface ResolveImportOptions {
  language?: string;
  importerPath?: string;
  specifiers?: string[];
  pythonPackageRootIndex?: Map<string, string[]>;
  fileSet?: Set<string>;
}

function existsFn(deps: ImportFsDeps): (path: string) => boolean {
  return deps.existsSync ?? nodeExistsSync;
}

function lstatFn(deps: ImportFsDeps): (path: string) => { isFile(): boolean } {
  return deps.lstatSync ?? nodeLstatSync;
}

export function normalizeInternalPath(rootPaths: string | string[], candidate: unknown): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  if (!isAbsolute(candidate)) return null;
  const roots = Array.isArray(rootPaths) ? rootPaths : [rootPaths];
  const abs = resolve(candidate);
  for (const rootPath of roots) {
    const root = resolve(rootPath);
    if (abs === root || abs.startsWith(root + "/")) {
      return relative(root, abs).replace(/\\/g, "/");
    }
  }
  return null;
}

export function resolveExistingProjectPath(
  rootPaths: string | string[],
  relPath: string | null | undefined,
  deps: ImportFsDeps = {},
): string | null {
  if (!relPath) return null;
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = [normalized];
  const hasExtension = /\.[^/]+$/.test(normalized);

  if (hasExtension) {
    candidates.push(normalized.replace(/\.(js|jsx|mjs|cjs)$/i, ".ts"));
    candidates.push(normalized.replace(/\.(js|jsx|mjs|cjs)$/i, ".tsx"));
  } else {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".go", ".rs", ".java", ".scala"]) {
      candidates.push(`${normalized}${ext}`);
      candidates.push(`${normalized}/index${ext}`);
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  const roots = Array.isArray(rootPaths) ? rootPaths : [rootPaths];
  const exists = existsFn(deps);
  const lstat = lstatFn(deps);
  for (const rootPath of roots) {
    for (const candidate of uniqueCandidates) {
      const absCandidate = join(rootPath, candidate);
      if (!exists(absCandidate)) continue;
      try {
        if (!lstat(absCandidate).isFile()) continue;
        return candidate;
      } catch {
        // ignore disappearing paths
      }
    }
  }
  return null;
}

export function buildQualifiedSourceIndex(files: Array<{ path?: string }>): Map<string, string> {
  const index = new Map<string, string>();
  const sourceRootPattern = /(?:^|\/)src\/(?:main|test)\/(?:java|scala)\/(.+)\.(java|scala)$/i;
  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.path) continue;
    const normalized = file.path.replace(/\\/g, "/");
    const match = normalized.match(sourceRootPattern);
    if (!match) continue;
    const logicalPath = match[1];
    if (logicalPath && !index.has(logicalPath)) {
      index.set(logicalPath, normalized);
    }
  }
  return index;
}

export function resolveQualifiedSourceImport(
  qualifiedSourceIndex: Map<string, string>,
  candidate: unknown,
): string | null {
  if (!candidate || typeof candidate !== "string" || !(qualifiedSourceIndex instanceof Map)) return null;
  let normalized = candidate.trim().replace(/\s+/g, "");
  if (!normalized) return null;
  if (normalized.startsWith("static.")) {
    normalized = normalized.slice("static.".length);
  }
  if (normalized.endsWith(".*")) {
    normalized = normalized.slice(0, -2);
  }
  if (!normalized.includes(".")) return null;

  const segments = normalized.split(".").filter(Boolean);
  while (segments.length >= 2) {
    const logicalPath = segments.join("/");
    const resolved = qualifiedSourceIndex.get(logicalPath);
    if (resolved) return resolved;
    segments.pop();
  }
  return null;
}

function resolvePythonFallbackTargets(
  candidate: string,
  importerPath: string | undefined,
  specifiers: string[] | undefined,
  pythonPackageRootIndex: Map<string, string[]> | undefined,
  fileSet: Set<string> | undefined,
): string[] {
  if (!(fileSet instanceof Set)) return [];
  const trimmed = candidate.trim();
  if (!trimmed) return [];

  const probe = (basePath: string): string[] => {
    const matches: string[] = [];
    const add = (value: string) => {
      if (value && fileSet.has(value) && !matches.includes(value)) matches.push(value);
    };
    const moduleFile = `${basePath}.py`;
    const packageInit = `${basePath}/__init__.py`;
    if (fileSet.has(moduleFile)) {
      add(moduleFile);
      return matches;
    }
    if (fileSet.has(packageInit)) {
      add(packageInit);
      for (const spec of Array.isArray(specifiers) ? specifiers : []) {
        if (!spec || spec === "*" || spec.includes(".")) continue;
        add(`${basePath}/${spec}.py`);
        add(`${basePath}/${spec}/__init__.py`);
      }
    }
    return matches;
  };

  let dots = 0;
  while (dots < trimmed.length && trimmed.charCodeAt(dots) === 0x2e) dots += 1;
  const tail = trimmed.slice(dots);
  const tailSegments = tail ? tail.split(".").filter(Boolean) : [];
  if (dots > 0) {
    const normalizedImporterPath = String(importerPath || "").replace(/\\/g, "/");
    const importerDir = normalizedImporterPath ? dirname(normalizedImporterPath) : "";
    const importerParts = importerDir ? importerDir.split("/").filter(Boolean) : [];
    const dropLevels = dots - 1;
    if (dropLevels > importerParts.length) return [];
    const baseParts = importerParts.slice(0, importerParts.length - dropLevels);
    if (tailSegments.length === 0) {
      const matches: string[] = [];
      for (const spec of Array.isArray(specifiers) ? specifiers : []) {
        if (!spec || spec === "*" || spec.includes(".")) continue;
        matches.push(...probe([...baseParts, spec].join("/")));
      }
      return [...new Set(matches)];
    }
    return probe(baseParts.concat(tailSegments).join("/"));
  }

  const segments = trimmed.split(".").filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment) return [];
  const roots = pythonPackageRootIndex?.get(firstSegment) || [];
  const matches: string[] = [];
  for (const root of roots) {
    matches.push(...probe([root, ...segments.slice(1)].filter(Boolean).join("/")));
  }
  return [...new Set(matches)];
}

export function resolveInternalImportTargets(
  projectRoot: string,
  analysisRoot: string,
  candidate: unknown,
  qualifiedSourceIndex: Map<string, string>,
  deps: ImportFsDeps = {},
  options: ResolveImportOptions = {},
): string[] {
  if (!candidate || typeof candidate !== "string") return [];
  const roots = [analysisRoot, projectRoot];
  if (candidate.startsWith("node:")) return [];

  const direct = normalizeInternalPath(roots, candidate);
  if (direct) {
    return [resolveExistingProjectPath(roots, direct, deps) || direct].filter(Boolean);
  }

  let relCandidate = candidate.replace(/\\/g, "/");
  if (relCandidate.startsWith("@/")) {
    relCandidate = `src/${relCandidate.slice(2)}`;
  } else if (relCandidate.startsWith("/")) {
    relCandidate = relCandidate.slice(1);
  } else if (!relCandidate.includes("/")) {
    const resolvedQualified = resolveQualifiedSourceImport(qualifiedSourceIndex, relCandidate);
    if (resolvedQualified) return [resolvedQualified];
  }

  const resolvedDirect = resolveExistingProjectPath(roots, relCandidate, deps);
  if (resolvedDirect) return [resolvedDirect];

  const resolvedQualified = resolveQualifiedSourceImport(qualifiedSourceIndex, candidate);
  if (resolvedQualified) return [resolvedQualified];

  if (options.language === "python") {
    return resolvePythonFallbackTargets(
      candidate,
      options.importerPath,
      options.specifiers,
      options.pythonPackageRootIndex,
      options.fileSet,
    );
  }

  return [];
}

export function resolveInternalImportTarget(
  projectRoot: string,
  analysisRoot: string,
  candidate: unknown,
  qualifiedSourceIndex: Map<string, string>,
  deps: ImportFsDeps = {},
  options: ResolveImportOptions = {},
): string | null {
  return resolveInternalImportTargets(
    projectRoot,
    analysisRoot,
    candidate,
    qualifiedSourceIndex,
    deps,
    options,
  )[0] || null;
}
