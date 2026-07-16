/**
 * Phase 1.2 — import map. Resolves each code/script file's imports via the
 * upstream registry, maps them to internal source files (including Java/Scala
 * FQN resolution), and writes `scan.importMap` back to disk. Ported verbatim
 * from deploy `augmentScanResultWithImportMap`.
 */

import { readFileSync as nodeReadFileSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  buildQualifiedSourceIndex,
  resolveInternalImportTargets,
  type ImportFsDeps,
} from "./imports.js";
import type { BuildLog } from "./scan.js";

export interface ImportMapFsDeps extends ImportFsDeps {
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
}

export interface AugmentImportMapOptions {
  registry: any;
  projectRoot: string;
  analysisRoot: string;
  scanPath: string;
  scan: Record<string, unknown>;
  log: BuildLog;
}

function addMultiMapValue(index: Map<string, string[]>, key: string, value: string): void {
  if (!key || !value) return;
  const existing = index.get(key);
  if (existing) {
    if (!existing.includes(value)) existing.push(value);
    return;
  }
  index.set(key, [value]);
}

function parseQuotedList(value: string): string[] {
  const out: string[] = [];
  const regex = /['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(String(value || "")))) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

function buildPythonPackageRootIndex(
  analysisRoot: string,
  files: Array<Record<string, any>>,
  read: (path: string, encoding: "utf8") => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const normalizedFiles = new Set(
    files
      .map((file) => String(file?.path || "").replace(/\\/g, "/"))
      .filter(Boolean),
  );
  const pyprojectPaths = [...normalizedFiles].filter((filePath) => /(?:^|\/)pyproject\.toml$/i.test(filePath));

  for (const pyprojectPath of pyprojectPaths) {
    const projectDir = dirname(pyprojectPath).replace(/\\/g, "/");
    try {
      const pyprojectContent = read(join(analysisRoot, pyprojectPath), "utf8");
      const packagesMatch = pyprojectContent.match(/\[tool\.hatch\.build\.targets\.wheel\][\s\S]*?packages\s*=\s*\[([\s\S]*?)\]/m);
      for (const pkg of parseQuotedList(packagesMatch?.[1] || "")) {
        const normalized = pkg.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+/g, "/");
        if (!normalized || normalized.includes("..")) continue;
        const packageRoot = projectDir === "." ? normalized : `${projectDir}/${normalized}`.replace(/\/+/g, "/");
        if (normalizedFiles.has(`${packageRoot}/__init__.py`)) {
          addMultiMapValue(index, basename(normalized), packageRoot);
        }
      }
    } catch {
      // best-effort only
    }

    for (const filePath of normalizedFiles) {
      if (!filePath.endsWith("/__init__.py")) continue;
      const packageRoot = dirname(filePath).replace(/\\/g, "/");
      if (projectDir && projectDir !== "." && !packageRoot.startsWith(`${projectDir}/`)) continue;
      const relativeToProject = projectDir && projectDir !== "."
        ? packageRoot.slice(projectDir.length + 1)
        : packageRoot;
      if (!relativeToProject || relativeToProject.includes("/")) continue;
      addMultiMapValue(index, basename(packageRoot), packageRoot);
    }
  }

  return index;
}

function parsePythonFallbackImports(content: string): Array<{ source: string; specifiers: string[] }> {
  const imports: Array<{ source: string; specifiers: string[] }> = [];
  const lines = String(content || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const fromMatch = line.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      const source = fromMatch[1]?.trim();
      if (!source || source === "__future__") continue;
      const specifiers = String(fromMatch[2] || "")
        .replace(/[()]/g, " ")
        .split(",")
        .map((entry) => entry.trim().split(/\s+as\s+/i)[0]?.trim())
        .filter(Boolean) as string[];
      imports.push({ source, specifiers });
      continue;
    }
    const importMatch = line.match(/^import\s+(.+)$/);
    if (importMatch) {
      const modules = String(importMatch[1] || "")
        .split(",")
        .map((entry) => entry.trim().split(/\s+as\s+/i)[0]?.trim())
        .filter(Boolean) as string[];
      for (const source of modules) {
        imports.push({ source, specifiers: [] });
      }
    }
  }
  return imports;
}

export function augmentScanResultWithImportMap(
  options: AugmentImportMapOptions,
  deps: ImportMapFsDeps = {},
): Record<string, unknown> {
  const { registry, projectRoot, analysisRoot, scanPath, scan, log } = options;
  const read = deps.readFileSync ?? ((p: string, e: "utf8") => nodeReadFileSync(p, e));
  const write = deps.writeFileSync ?? ((p: string, dt: string, e: "utf8") => nodeWriteFileSync(p, dt, e));

  const importMap: Record<string, string[]> = {};
  const files = Array.isArray(scan.files) ? (scan.files as Array<Record<string, any>>) : [];
  const qualifiedSourceIndex = buildQualifiedSourceIndex(files);
  const fileSet = new Set(files.map((file) => String(file?.path || "").replace(/\\/g, "/")).filter(Boolean));
  const pythonPackageRootIndex = buildPythonPackageRootIndex(analysisRoot, files, read);
  let importFiles = 0;

  for (const file of files) {
    if (file.fileCategory !== "code" && file.fileCategory !== "script") continue;
    const absPath = join(analysisRoot, file.path);
    let content: string;
    try {
      content = read(absPath, "utf8");
    } catch {
      importMap[file.path] = [];
      continue;
    }
    const resolved = typeof registry.resolveImports === "function"
      ? registry.resolveImports(absPath, content) || []
      : [];
    const targets: string[] = [];
    for (const entry of resolved) {
      const internalTargets = resolveInternalImportTargets(
        projectRoot,
        analysisRoot,
        entry.resolvedPath || entry.source,
        qualifiedSourceIndex,
        deps,
        {
          language: file.language,
          importerPath: file.path,
          specifiers: entry.specifiers || [],
          pythonPackageRootIndex,
          fileSet,
        },
      );
      for (const internal of internalTargets) {
        if (internal && internal !== file.path) {
          targets.push(internal);
        }
      }
    }
    if (file.language === "python") {
      for (const entry of parsePythonFallbackImports(content)) {
        const internalTargets = resolveInternalImportTargets(
          projectRoot,
          analysisRoot,
          entry.source,
          qualifiedSourceIndex,
          deps,
          {
            language: "python",
            importerPath: file.path,
            specifiers: entry.specifiers,
            pythonPackageRootIndex,
            fileSet,
          },
        );
        for (const internal of internalTargets) {
          if (internal && internal !== file.path) {
            targets.push(internal);
          }
        }
      }
    }
    importMap[file.path] = [...new Set(targets)].sort((a, b) => a.localeCompare(b));
    importFiles += 1;
  }

  scan.importMap = importMap;
  write(scanPath, JSON.stringify(scan, null, 2), "utf8");
  log(`scan importMap augmented for ${importFiles} code/script files`);
  return scan;
}
