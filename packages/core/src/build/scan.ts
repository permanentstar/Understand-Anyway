/**
 * Phase 1 scan delegates to upstream `scan-project.mjs` via `execFileSync`.
 *
 * **Intentional skip:** upstream `core.createIgnoreFilter` /
 * `DEFAULT_IGNORE_PATTERNS` are NOT used at this layer — the scan child
 * process owns its own `.gitignore` / `.understandignore` resolution. We only
 * apply two **post-scan** filters here:
 * - `system-filter.ts`: drops vendored/build/VCS dirs (node_modules, dist,
 *   .next, .gradle, ...). Semantically disjoint from .gitignore.
 * - `test-filter.ts`: drops test/spec files when `--exclude-tests` is set.
 *   Prefers upstream language config's `filePatterns.tests`, falls back to
 *   common conventions.
 *
 * Decision context: E1 audit 2026-06-23, decision matrix B6.
 */

import { execFileSync as nodeExecFileSync } from "node:child_process";
import { readFileSync as nodeReadFileSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { join } from "node:path";
import { applySystemPathFilterToScan } from "./system-filter.js";
import { applyTestFileFilterToScan } from "./test-filter.js";

export type BuildLog = (message: string) => void;

export interface ScanFsDeps {
  execFileSync?: typeof nodeExecFileSync;
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
}

function withScanDefaults(deps: ScanFsDeps): Required<ScanFsDeps> {
  return {
    execFileSync: deps.execFileSync ?? nodeExecFileSync,
    readFileSync: deps.readFileSync ?? ((p, e) => nodeReadFileSync(p, e)),
    writeFileSync: deps.writeFileSync ?? ((p, d, e) => nodeWriteFileSync(p, d, e)),
  };
}

export interface RunScanOptions {
  skillDir: string;
  scanInputRoot: string;
  scanPath: string;
  excludeTests: boolean;
  core: any;
  log: BuildLog;
}

function applyConfiguredScanFilters(
  scan: Record<string, unknown>,
  scanPath: string,
  excludeTests: boolean,
  core: any,
  log: BuildLog,
  write: Required<ScanFsDeps>["writeFileSync"],
): Record<string, unknown> {
  const system = applySystemPathFilterToScan(scan);
  let filtered = system.scan;
  if (system.removedPaths.length > 0) {
    write(scanPath, JSON.stringify(filtered, null, 2), "utf8");
    log(`system path filter removed ${system.removedPaths.length} files`);
  }
  if (!excludeTests) return filtered;
  const tests = applyTestFileFilterToScan(filtered, core);
  if (tests.removedPaths.length > 0) {
    filtered = tests.scan;
    write(scanPath, JSON.stringify(filtered, null, 2), "utf8");
    log(`test file filter removed ${tests.removedPaths.length} files`);
  }
  return filtered;
}

export function runScanPhase(options: RunScanOptions, deps: ScanFsDeps = {}): Record<string, unknown> {
  const d = withScanDefaults(deps);
  const { skillDir, scanInputRoot, scanPath, excludeTests, core, log } = options;
  log("phase 1/4 scan-project");
  d.execFileSync(process.execPath, [join(skillDir, "scan-project.mjs"), scanInputRoot, scanPath], {
    stdio: "inherit",
  });
  let scan = JSON.parse(d.readFileSync(scanPath, "utf8")) as Record<string, unknown>;
  scan = applyConfiguredScanFilters(scan, scanPath, excludeTests, core, log, d.writeFileSync);
  const total = (scan.totalFiles as number) || (Array.isArray(scan.files) ? scan.files.length : 0);
  log(`scanned ${total} files`);
  return scan;
}
