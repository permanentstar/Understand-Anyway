#!/usr/bin/env node
/**
 * D-line isolation lint.
 *
 * Enforces a hard rule:
 *
 *   1. The main pipeline (build / serve / gateway / core) MUST NOT import any
 *      module under `packages/*\/src/dashboard-prod/**` or
 *      `packages/*\/src/dashboard-dev/**` (the latter doesn't exist yet but is
 *      reserved by D3-dev).
 *
 *   2. `dashboard-dev/**` MUST NOT import `dashboard-prod/**` or any
 *      runtime/registry/router-style module from the main pipeline.
 *
 *   3. `dashboard-prod/**` MAY import `dashboard-shared/**` (the shared
 *      primitives) and `runServe` from `serve.ts` (it's the daemon body).
 *
 * Implementation: walk packages/*\/src/**\/*.ts(x), regex-extract `import …`
 * statements, normalize relative paths, classify the source / target zones
 * against the rules above. Exits non-zero on any violation.
 *
 * No third-party deps; intentionally simple so it stays easy to audit.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const packagesRoot = resolve(repoRoot, "packages");

const ZONES = /** @type {const} */ ({
  DASHBOARD_PROD: "dashboard-prod",
  DASHBOARD_DEV: "dashboard-dev",
  DASHBOARD_SHARED: "dashboard-shared",
  MAIN: "main",
});

/** @typedef {keyof typeof ZONES extends infer K ? K extends keyof typeof ZONES ? typeof ZONES[K] : never : never} Zone */

/** @param {string} absPath @returns {string} */
function classifyZone(absPath) {
  if (absPath.includes("/dashboard-prod/")) return ZONES.DASHBOARD_PROD;
  if (absPath.includes("/dashboard-dev/")) return ZONES.DASHBOARD_DEV;
  if (absPath.includes("/dashboard-shared/")) return ZONES.DASHBOARD_SHARED;
  return ZONES.MAIN;
}

/** @param {string} dir @param {string[]} acc */
function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
}

/** @param {string} src @returns {string[]} */
function extractImportSpecifiers(src) {
  const out = [];
  // import ... from "..."  /  export ... from "..."  /  dynamic import("...")
  const re = /(?:\bimport\b[^'"]*from\s*|\bexport\b[^'"]*from\s*|\bimport\s*\(\s*)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(m[2]);
  }
  return out;
}

/**
 * Resolve a relative import like "../foo/bar.js" or "./baz.ts" against the
 * importer's directory; ignore bare specifiers (npm packages).
 */
function resolveImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  // Strip extension; we only care which zone the path falls into.
  const withoutExt = specifier.replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
  return resolve(dirname(importer), withoutExt);
}

/**
 * @param {string} importerAbs
 * @param {Zone} importerZone
 * @param {string} targetAbs
 * @param {Zone} targetZone
 * @param {string} specifier
 * @returns {string | null}
 */
function checkRule(importerAbs, importerZone, targetAbs, targetZone, specifier) {
  // Rule 1 — main → dashboard-* is forbidden.
  if (importerZone === ZONES.MAIN && (targetZone === ZONES.DASHBOARD_PROD || targetZone === ZONES.DASHBOARD_DEV)) {
    // Allowed exceptions: dispatcher files that route verb-families into the
    // dashboard daemon. Top-level `cli.ts` dispatches every command; the
    // `gateway/index.ts` sub-dispatcher routes `gateway start|stop` into
    // dashboard-prod by design. Both are routing layers, not main pipeline.
    if (/\/cli\.ts$/.test(importerAbs)) return null;
    if (/\/gateway\/index\.ts$/.test(importerAbs)) return null;
    return `main pipeline file imports ${targetZone}: ${specifier}`;
  }
  // Rule 2 — dashboard-dev → dashboard-prod / main is forbidden.
  if (importerZone === ZONES.DASHBOARD_DEV) {
    if (targetZone === ZONES.DASHBOARD_PROD) return `dashboard-dev imports dashboard-prod: ${specifier}`;
    if (targetZone === ZONES.MAIN) {
      // Allow main `serve.ts` if/when D3-dev needs it; explicit allowlist later.
      return `dashboard-dev imports main pipeline: ${specifier}`;
    }
  }
  // Rule 3 — dashboard-prod → dashboard-dev is forbidden too (they're peers).
  if (importerZone === ZONES.DASHBOARD_PROD && targetZone === ZONES.DASHBOARD_DEV) {
    return `dashboard-prod imports dashboard-dev: ${specifier}`;
  }
  return null;
}

function main() {
  /** @type {string[]} */
  const files = [];
  for (const pkgEntry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkgEntry.isDirectory()) continue;
    const srcDir = resolve(packagesRoot, pkgEntry.name, "src");
    try { statSync(srcDir); } catch { continue; }
    walk(srcDir, files);
  }

  const violations = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const importerZone = classifyZone(file);
    for (const spec of extractImportSpecifiers(src)) {
      const targetAbs = resolveImport(file, spec);
      if (!targetAbs) continue;
      const targetZone = classifyZone(targetAbs);
      const reason = checkRule(file, importerZone, targetAbs, targetZone, spec);
      if (reason) violations.push({ file: relative(repoRoot, file), reason });
    }
  }

  if (violations.length === 0) {
    process.stdout.write(`isolation lint: ok (${files.length} files scanned)\n`);
    return 0;
  }

  process.stderr.write(`isolation lint: ${violations.length} violation(s)\n`);
  for (const v of violations) process.stderr.write(`  ${v.file}: ${v.reason}\n`);
  return 1;
}

process.exitCode = main();
