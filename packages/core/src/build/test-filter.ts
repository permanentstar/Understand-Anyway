/**
 * Test-file scan filter — drops test/spec files from the scan result when
 * `--exclude-tests` is set. Prefers the upstream language config's
 * `filePatterns.tests`, then falls back to the common test path/basename
 * conventions. Ported from the deploy implementation; neutral.
 */

import {
  type ScanFilterResult,
  entryPath,
  estimateComplexity,
  normalizeProjectPath,
  rebuildScanStats,
} from "./system-filter.js";

const DEFAULT_TEST_PATH_PATTERNS = [
  "**/__tests__/**",
  "**/__specs__/**",
  "**/test/**",
  "**/tests/**",
  "**/spec/**",
  "**/src/test/**",
  "**/src/tests/**",
] as const;

const DEFAULT_TEST_BASENAME_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.*",
  "*.test.*",
  "*.spec.*",
  "*_test.*",
  "test_*.*",
  "*Tests.*",
  "*Test.*",
  "*IT.*",
  "conftest.py",
] as const;

function basenameOfProjectPath(filePath: string): string {
  const normalized = normalizeProjectPath(filePath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function globToRegExp(pattern: string, caseSensitive = false): RegExp {
  const normalized = normalizeProjectPath(pattern);
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`, caseSensitive ? "" : "i");
}

function isCaseSensitiveBasenameTestPattern(pattern: string): boolean {
  return /^\*[^/]*(?:IT|Test|Tests)\.[^/]+$/.test(pattern);
}

function matchesBasenamePattern(filePath: string, pattern: string): boolean {
  const basename = basenameOfProjectPath(filePath);
  const caseSensitive = isCaseSensitiveBasenameTestPattern(pattern);
  return globToRegExp(pattern, caseSensitive).test(basename);
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalized = normalizeProjectPath(filePath);
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeProjectPath(pattern);
    if (normalizedPattern.includes("/")) {
      return globToRegExp(normalizedPattern).test(normalized) || globToRegExp(`**/${normalizedPattern}`).test(normalized);
    }
    return matchesBasenamePattern(normalized, normalizedPattern);
  });
}

function buildLanguageRegistry(core: any): any | null {
  const LanguageRegistry = core?.LanguageRegistry;
  if (!LanguageRegistry || typeof LanguageRegistry.createDefault !== "function") return null;
  try {
    return LanguageRegistry.createDefault();
  } catch {
    return null;
  }
}

function languageTestPatterns(core: any, registry: any, filePath: string): string[] {
  const languageConfig = typeof registry?.getForFile === "function" ? registry.getForFile(filePath) : null;
  const patterns = languageConfig?.filePatterns?.tests;
  if (Array.isArray(patterns)) {
    return patterns.filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  const language = String(core?.detectLanguage?.(filePath) || "").trim();
  if (language === "vue" || language === "svelte") {
    return ["*.spec.ts", "*.spec.js", "*.test.ts", "*.test.js", "*.spec.tsx", "*.test.tsx"];
  }
  return [];
}

export function isTestFilePath(filePath: string, core: any, registry?: any): boolean {
  const normalized = normalizeProjectPath(filePath);
  if (!normalized || normalized.startsWith("../") || normalized === "..") return false;
  const effectiveRegistry = registry || buildLanguageRegistry(core);
  const configuredPatterns = languageTestPatterns(core, effectiveRegistry, normalized);
  if (configuredPatterns.length > 0 && matchesAnyPattern(normalized, configuredPatterns)) return true;
  return matchesAnyPattern(normalized, [...DEFAULT_TEST_PATH_PATTERNS, ...DEFAULT_TEST_BASENAME_PATTERNS]);
}

export function applyTestFileFilterToScan<T extends Record<string, unknown>>(scan: T, core: any): ScanFilterResult<T> {
  const originalFiles = Array.isArray(scan.files) ? scan.files : [];
  const keptFiles: unknown[] = [];
  const keptPaths = new Set<string>();
  const removedPaths: string[] = [];
  const registry = buildLanguageRegistry(core);

  for (const file of originalFiles) {
    const path = entryPath(file);
    if (!path) continue;
    const normalizedPath = normalizeProjectPath(path);
    if (isTestFilePath(normalizedPath, core, registry)) {
      removedPaths.push(normalizedPath);
      continue;
    }
    keptFiles.push(file);
    keptPaths.add(normalizedPath);
  }

  if (removedPaths.length === 0) {
    return { scan, removedPaths };
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
      if (!keptPaths.has(normalizedSource)) continue;
      const targets = Array.isArray(rawTargets) ? rawTargets : [];
      filteredImportMap[normalizedSource] = targets
        .filter((target): target is string => typeof target === "string")
        .map((target) => normalizeProjectPath(target))
        .filter((target) => keptPaths.has(target));
    }
    nextScan.importMap = filteredImportMap;
  }

  return { scan: nextScan as T, removedPaths };
}
