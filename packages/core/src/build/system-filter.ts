/**
 * System-path scan filter — drops vendored / build / VCS directories from the
 * scan result before batching. Ported verbatim from the deploy implementation;
 * neutral, no in-house coupling.
 */

export const SYSTEM_EXCLUDED_DIRECTORY_NAMES = [
  ".understand-anything",
  "dashboard-dist",
  ".codebase",
  ".trae",
  ".husky",
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  "target",
  "out",
  ".gradle",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".parcel-cache",
  ".serverless",
  ".terraform",
] as const;

const SYSTEM_EXCLUDED_DIRECTORY_SET = new Set<string>(SYSTEM_EXCLUDED_DIRECTORY_NAMES);

export interface ScanFilterResult<T = unknown> {
  scan: T;
  removedPaths: string[];
}

function normalizeProjectPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function isSystemExcludedPath(filePath: string): boolean {
  const normalized = normalizeProjectPath(filePath);
  if (!normalized || normalized.startsWith("../") || normalized === "..") return true;
  return normalized.split("/").some((segment) => SYSTEM_EXCLUDED_DIRECTORY_SET.has(segment));
}

function entryPath(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    if (typeof record.path === "string") return record.path;
    if (typeof record.filePath === "string") return record.filePath;
  }
  return "";
}

function estimateComplexity(totalFiles: number): "small" | "moderate" | "large" | "very-large" {
  if (totalFiles <= 30) return "small";
  if (totalFiles <= 150) return "moderate";
  if (totalFiles <= 500) return "large";
  return "very-large";
}

function rebuildScanStats(files: unknown[]): Record<string, unknown> {
  const byCategory: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const record = file as Record<string, unknown>;
    const category = typeof record.fileCategory === "string" && record.fileCategory ? record.fileCategory : "unknown";
    const language = typeof record.language === "string" && record.language ? record.language : "unknown";
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    byLanguage[language] = (byLanguage[language] ?? 0) + 1;
  }
  return { filesScanned: files.length, byCategory, byLanguage };
}

export { entryPath, estimateComplexity, normalizeProjectPath, rebuildScanStats };

export function applySystemPathFilterToScan<T extends Record<string, unknown>>(scan: T): ScanFilterResult<T> {
  const originalFiles = Array.isArray(scan.files) ? scan.files : [];
  const keptFiles: unknown[] = [];
  const keptPaths = new Set<string>();
  const removedPaths: string[] = [];

  for (const file of originalFiles) {
    const path = entryPath(file);
    if (!path || isSystemExcludedPath(path)) {
      if (path) removedPaths.push(path);
      continue;
    }
    keptFiles.push(file);
    keptPaths.add(normalizeProjectPath(path));
  }

  const nextScan: Record<string, unknown> = {
    ...scan,
    files: keptFiles,
    totalFiles: keptFiles.length,
    estimatedComplexity: estimateComplexity(keptFiles.length),
    stats: rebuildScanStats(keptFiles),
  };

  if (scan.importMap && typeof scan.importMap === "object" && !Array.isArray(scan.importMap)) {
    const filteredImportMap: Record<string, string[]> = {};
    for (const [source, rawTargets] of Object.entries(scan.importMap as Record<string, unknown>)) {
      const normalizedSource = normalizeProjectPath(source);
      if (!keptPaths.has(normalizedSource) || isSystemExcludedPath(normalizedSource)) continue;
      const targets = Array.isArray(rawTargets) ? rawTargets : [];
      filteredImportMap[normalizedSource] = targets
        .filter((target): target is string => typeof target === "string")
        .map(normalizeProjectPath)
        .filter((target) => keptPaths.has(target) && !isSystemExcludedPath(target));
    }
    nextScan.importMap = filteredImportMap;
  }

  return { scan: nextScan as T, removedPaths };
}
