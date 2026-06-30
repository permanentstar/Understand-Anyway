/**
 * Phase 1.2 — import map. Resolves each code/script file's imports via the
 * upstream registry, maps them to internal source files (including Java/Scala
 * FQN resolution), and writes `scan.importMap` back to disk. Ported verbatim
 * from deploy `augmentScanResultWithImportMap`.
 */

import { readFileSync as nodeReadFileSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildQualifiedSourceIndex,
  resolveInternalImportTarget,
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
      const internal = resolveInternalImportTarget(
        projectRoot,
        analysisRoot,
        entry.resolvedPath || entry.source,
        qualifiedSourceIndex,
        deps,
      );
      if (internal && internal !== file.path) {
        targets.push(internal);
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
