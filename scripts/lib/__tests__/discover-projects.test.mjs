#!/usr/bin/env node
// scripts/lib/__tests__/discover-projects.test.mjs
//
// Run with: node scripts/lib/__tests__/discover-projects.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "discover-projects.mjs",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n`);
    if (detail) process.stdout.write(`    ${detail}\n`);
  }
}

function makeTmp() {
  return mkdtempSync(resolve(tmpdir(), "ua-d4-discover-"));
}

function runDiscover(args, env = {}) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return result;
}

function parseNdjson(stdout) {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- Test 1: visible filtering ---
{
  const root = makeTmp();
  try {
    const cfgDir = resolve(root, "gateway", "config");
    mkdirSync(cfgDir, { recursive: true });
    const projectBase = resolve(root, "src");
    mkdirSync(projectBase, { recursive: true });
    writeFileSync(
      resolve(cfgDir, "projects.json"),
      JSON.stringify({
        projectBaseDir: "src",
        projects: [
          { projectId: "alpha", repoPath: "${projectBaseDir}/alpha" },
          { projectId: "beta", repoPath: "${projectBaseDir}/beta", visible: false },
          { projectId: "gamma", repoPath: "${projectBaseDir}/gamma", visible: true },
        ],
      }),
    );

    const result = runDiscover(["--projects-root", root]);
    check("visible filter: exit 0", result.status === 0, result.stderr);
    const records = parseNdjson(result.stdout);
    check("visible filter: 2 projects", records.length === 2, JSON.stringify(records));
    check(
      "visible filter: alpha first",
      records[0]?.projectId === "alpha" && records[1]?.projectId === "gamma",
      JSON.stringify(records),
    );
    check(
      "visible filter: repoPath expanded",
      records[0]?.repoPath === resolve(projectBase, "alpha"),
      records[0]?.repoPath,
    );
    check(
      "visible filter: stateDir defaults",
      records[0]?.stateDir === resolve(root, "projects", "alpha"),
      records[0]?.stateDir,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- Test 2: --filter single project ---
{
  const root = makeTmp();
  try {
    const cfgDir = resolve(root, "gateway", "config");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      resolve(cfgDir, "projects.json"),
      JSON.stringify({
        projectBaseDir: ".",
        projects: [
          { projectId: "one" },
          { projectId: "two" },
        ],
      }),
    );

    const result = runDiscover(["--projects-root", root, "--filter", "two"]);
    check("filter: exit 0", result.status === 0, result.stderr);
    const records = parseNdjson(result.stdout);
    check("filter: 1 record", records.length === 1, JSON.stringify(records));
    check("filter: matched two", records[0]?.projectId === "two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- Test 3: stateDir ignores legacy templates and stays conventional ---
{
  const root = makeTmp();
  try {
    const cfgDir = resolve(root, "gateway", "config");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      resolve(cfgDir, "projects.json"),
      JSON.stringify({
        projectBaseDir: ".",
        projects: [
          {
            projectId: "tpl",
            repoPath: "${HOME}/repos/${projectId}",
            stateDir: "${projectsRoot}/state/${projectId}",
          },
        ],
      }),
    );

    const result = runDiscover(["--projects-root", root]);
    check("template: exit 0", result.status === 0, result.stderr);
    const records = parseNdjson(result.stdout);
    check("template: 1 record", records.length === 1);
    check(
      "template: stateDir expanded",
      records[0]?.stateDir === resolve(root, "projects", "tpl"),
      records[0]?.stateDir,
    );
    check(
      "template: repoPath expanded with HOME",
      records[0]?.repoPath?.endsWith("/repos/tpl"),
      records[0]?.repoPath,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- Test 4: legacy `<repoRoot>/projects.json` is rejected with migration hint ---
// The CLI only reads `<projectsRoot>/gateway/config/projects.json`, so a stray
// repo-root projects.json must NOT be silently honored by cron scripts — the
// two would drift. We require operators to move it.
{
  const root = makeTmp();
  const repoRoot = makeTmp();
  try {
    writeFileSync(
      resolve(repoRoot, "projects.json"),
      JSON.stringify({
        projectBaseDir: ".",
        projects: [{ projectId: "fallback" }],
      }),
    );

    const result = runDiscover([
      "--projects-root",
      root,
      "--repo-root",
      repoRoot,
    ]);
    check("legacy repo-root: exit 1", result.status === 1, `status=${result.status}`);
    check(
      "legacy repo-root: stderr mentions the legacy path",
      result.stderr.includes(resolve(repoRoot, "projects.json")),
      result.stderr,
    );
    check(
      "legacy repo-root: stderr mentions the expected path",
      result.stderr.includes("gateway/config/projects.json"),
      result.stderr,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// --- Test 5: missing config exits 1 ---
{
  const root = makeTmp();
  const repoRoot = makeTmp();
  try {
    const result = runDiscover([
      "--projects-root",
      root,
      "--repo-root",
      repoRoot,
    ]);
    check("missing: exit 1", result.status === 1, `status=${result.status}`);
    check(
      "missing: stderr mentions projects.json",
      result.stderr.includes("projects.json"),
      result.stderr,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// --- Test 6: legacy config path exits 1 with migration hint ---
{
  const root = makeTmp();
  try {
    const legacyCfgDir = resolve(root, "config");
    mkdirSync(legacyCfgDir, { recursive: true });
    writeFileSync(
      resolve(legacyCfgDir, "projects.json"),
      JSON.stringify({ version: 1, projects: [{ projectId: "legacy" }] }),
    );

    const result = runDiscover(["--projects-root", root]);
    check("legacy: exit 1", result.status === 1, `status=${result.status}`);
    check(
      "legacy: stderr mentions gateway/config",
      result.stderr.includes("gateway/config/projects.json"),
      result.stderr,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- Test 7: malformed json exits 1 ---
{
  const root = makeTmp();
  try {
    const cfgDir = resolve(root, "gateway", "config");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(resolve(cfgDir, "projects.json"), "{not json");

    const result = runDiscover(["--projects-root", root]);
    check("bad json: exit 1", result.status === 1, `status=${result.status}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall tests passed\n");
