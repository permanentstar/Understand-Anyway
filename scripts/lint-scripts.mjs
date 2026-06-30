#!/usr/bin/env node
// scripts/lint-scripts.mjs
//
// Static checks for shell scripts under scripts/:
//   1. `bash -n` syntax check on every *.sh
//   2. `shellcheck` if available (best-effort; skipped silently when missing)
//
// Run: `pnpm lint:scripts`. Used by CI; fails the job on any *.sh syntax
// error or any non-info shellcheck finding.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function listShellScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...listShellScripts(full));
    } else if (st.isFile() && (entry.endsWith(".sh") || entry === "common.sh")) {
      out.push(full);
    }
  }
  return out;
}

const targets = listShellScripts(resolve(REPO_ROOT, "scripts"));
if (targets.length === 0) {
  process.stdout.write("[lint-scripts] no shell scripts under scripts/; nothing to do\n");
  process.exit(0);
}

let failures = 0;

// 1. bash -n syntax check (mandatory; bash always present in CI/dev shells).
for (const file of targets) {
  const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failures += 1;
    process.stderr.write(`  FAIL bash -n ${file}\n${r.stderr}\n`);
  } else {
    process.stdout.write(`  ok   bash -n ${file}\n`);
  }
}

// 2. shellcheck (best-effort — many CI images don't preinstall it).
const haveShellcheck = spawnSync("shellcheck", ["--version"], { encoding: "utf8" }).status === 0;
if (!haveShellcheck) {
  process.stdout.write("[lint-scripts] shellcheck not installed; skipping\n");
} else {
  for (const file of targets) {
    const r = spawnSync(
      "shellcheck",
      ["--severity=warning", "--exclude=SC1091", file],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      failures += 1;
      process.stderr.write(`  FAIL shellcheck ${file}\n${r.stdout}${r.stderr}\n`);
    } else {
      process.stdout.write(`  ok   shellcheck ${file}\n`);
    }
  }
}

if (failures > 0) {
  process.stdout.write(`\n${failures} lint failure(s)\n`);
  process.exit(1);
}
process.stdout.write("\nall script lint checks passed\n");
