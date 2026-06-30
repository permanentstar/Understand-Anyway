#!/usr/bin/env node
/**
 * Smoke test for scripts/lint-isolation.mjs.
 *
 * Spawns the lint script against this repo's real source tree (must pass)
 * and against synthetic fixture trees with deliberate violations
 * (must fail and name the violation).
 *
 * Run: `node scripts/lint-isolation.test.mjs`. Exits non-zero on failure.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const lintScript = resolve(here, "lint-isolation.mjs");

let failed = 0;

function assert(cond, label) {
  if (cond) {
    process.stdout.write(`  ok  ${label}\n`);
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed += 1;
  }
}

function runLintIn(cwd) {
  return spawnSync(process.execPath, [lintScript], {
    cwd,
    encoding: "utf8",
  });
}

// 1) Real repo passes.
{
  process.stdout.write("real repo:\n");
  const result = runLintIn(repoRoot);
  assert(result.status === 0, "exits 0 on the real repo");
  assert(/isolation lint: ok/.test(result.stdout), "prints ok summary");
}

// 2) Synthetic fixture: main pipeline imports dashboard-prod (forbidden).
{
  process.stdout.write("fixture: main → dashboard-prod (must fail):\n");
  const root = mkdtempSync(resolve(tmpdir(), "ua-isolation-fix-"));
  try {
    const pkgSrc = resolve(root, "packages/cli/src");
    mkdirSync(pkgSrc, { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "build.ts"),
      `import { x } from "./dashboard-prod/dashboard-start.js";\nexport const y = x;\n`,
      "utf8",
    );
    mkdirSync(resolve(pkgSrc, "dashboard-prod"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "dashboard-prod/dashboard-start.ts"),
      `export const x = 1;\n`,
      "utf8",
    );
    const fixtureScripts = resolve(root, "scripts");
    mkdirSync(fixtureScripts, { recursive: true });
    cpSync(lintScript, resolve(fixtureScripts, "lint-isolation.mjs"));
    const result = spawnSync(process.execPath, [resolve(fixtureScripts, "lint-isolation.mjs")], { encoding: "utf8" });
    assert(result.status !== 0, "exits non-zero on violation");
    assert(/main pipeline file imports dashboard-prod/.test(result.stderr), "names the violation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 3) Synthetic fixture: dashboard-dev → dashboard-prod (forbidden).
{
  process.stdout.write("fixture: dashboard-dev → dashboard-prod (must fail):\n");
  const root = mkdtempSync(resolve(tmpdir(), "ua-isolation-fix-"));
  try {
    const pkgSrc = resolve(root, "packages/cli/src");
    mkdirSync(resolve(pkgSrc, "dashboard-dev"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "dashboard-dev/index.ts"),
      `import { x } from "../dashboard-prod/dashboard-start.js";\nexport const y = x;\n`,
      "utf8",
    );
    mkdirSync(resolve(pkgSrc, "dashboard-prod"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "dashboard-prod/dashboard-start.ts"),
      `export const x = 1;\n`,
      "utf8",
    );
    const fixtureScripts = resolve(root, "scripts");
    mkdirSync(fixtureScripts, { recursive: true });
    cpSync(lintScript, resolve(fixtureScripts, "lint-isolation.mjs"));
    const result = spawnSync(process.execPath, [resolve(fixtureScripts, "lint-isolation.mjs")], { encoding: "utf8" });
    assert(result.status !== 0, "exits non-zero on violation");
    assert(/dashboard-dev imports dashboard-prod/.test(result.stderr), "names the violation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 4) Synthetic fixture: dashboard-prod → dashboard-shared is allowed.
{
  process.stdout.write("fixture: dashboard-prod → dashboard-shared (must pass):\n");
  const root = mkdtempSync(resolve(tmpdir(), "ua-isolation-fix-"));
  try {
    const pkgSrc = resolve(root, "packages/cli/src");
    mkdirSync(resolve(pkgSrc, "dashboard-prod"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "dashboard-prod/dashboard-start.ts"),
      `import { x } from "../dashboard-shared/pid-store.js";\nexport const y = x;\n`,
      "utf8",
    );
    mkdirSync(resolve(pkgSrc, "dashboard-shared"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "dashboard-shared/pid-store.ts"),
      `export const x = 1;\n`,
      "utf8",
    );
    const fixtureScripts = resolve(root, "scripts");
    mkdirSync(fixtureScripts, { recursive: true });
    cpSync(lintScript, resolve(fixtureScripts, "lint-isolation.mjs"));
    const result = spawnSync(process.execPath, [resolve(fixtureScripts, "lint-isolation.mjs")], { encoding: "utf8" });
    assert(result.status === 0, "exits 0 on shared-only import");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 5) Synthetic fixture: dispatcher whitelist — gateway/index.ts may import
// dashboard-prod (mirrors cli.ts exception). Verifies the whitelist hook
// still works after edits.
{
  process.stdout.write("fixture: dispatcher whitelist (gateway/index.ts → dashboard-prod):\n");
  const root = mkdtempSync(resolve(tmpdir(), "ua-isolation-fix-"));
  try {
    const pkgSrc = resolve(root, "packages/cli/src");
    mkdirSync(resolve(pkgSrc, "gateway"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "gateway/index.ts"),
      `import { x } from "../dashboard-prod/dashboard-start.js";\nexport const y = x;\n`,
      "utf8",
    );
    mkdirSync(resolve(pkgSrc, "dashboard-prod"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "dashboard-prod/dashboard-start.ts"),
      `export const x = 1;\n`,
      "utf8",
    );
    const fixtureScripts = resolve(root, "scripts");
    mkdirSync(fixtureScripts, { recursive: true });
    cpSync(lintScript, resolve(fixtureScripts, "lint-isolation.mjs"));
    const result = spawnSync(process.execPath, [resolve(fixtureScripts, "lint-isolation.mjs")], { encoding: "utf8" });
    assert(result.status === 0, "exits 0 when gateway/index.ts imports dashboard-prod");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 6) Negative companion: a sibling file inside the same gateway/ folder is
// NOT whitelisted — only the exact dispatcher path is.
{
  process.stdout.write("fixture: gateway/<other>.ts is NOT whitelisted (must fail):\n");
  const root = mkdtempSync(resolve(tmpdir(), "ua-isolation-fix-"));
  try {
    const pkgSrc = resolve(root, "packages/cli/src");
    mkdirSync(resolve(pkgSrc, "gateway"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "gateway/helpers.ts"),
      `import { x } from "../dashboard-prod/dashboard-start.js";\nexport const y = x;\n`,
      "utf8",
    );
    mkdirSync(resolve(pkgSrc, "dashboard-prod"), { recursive: true });
    writeFileSync(
      resolve(pkgSrc, "dashboard-prod/dashboard-start.ts"),
      `export const x = 1;\n`,
      "utf8",
    );
    const fixtureScripts = resolve(root, "scripts");
    mkdirSync(fixtureScripts, { recursive: true });
    cpSync(lintScript, resolve(fixtureScripts, "lint-isolation.mjs"));
    const result = spawnSync(process.execPath, [resolve(fixtureScripts, "lint-isolation.mjs")], { encoding: "utf8" });
    assert(result.status !== 0, "exits non-zero when a sibling file imports dashboard-prod");
    assert(/main pipeline file imports dashboard-prod/.test(result.stderr), "names the violation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  process.stderr.write(`\nlint-isolation.test.mjs: ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nlint-isolation.test.mjs: all checks passed\n");
