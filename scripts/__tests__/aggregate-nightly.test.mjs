#!/usr/bin/env node
// scripts/__tests__/aggregate-nightly.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "aggregate-nightly.mjs");

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
  return mkdtempSync(resolve(tmpdir(), "ua-d8-agg-"));
}

function writePerProject(projectsRoot, projectId, runId, payload) {
  const dir = resolve(projectsRoot, "projects", projectId, ".understand-anything", "nightly-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "result.json"), JSON.stringify(payload));
}

function runScript(args) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

// --- Test 1: 3 success + 1 failed + 1 missing → partial_success ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const runId = "run-1";
    const success = (id) => ({
      projectName: id,
      overallStatus: "success",
      build: { status: "success" },
      gate: { approved: true, issues: [], warnings: [], stats: {} },
    });
    writePerProject(projectsRoot, "alpha", runId, success("alpha"));
    writePerProject(projectsRoot, "beta", runId, success("beta"));
    writePerProject(projectsRoot, "gamma", runId, success("gamma"));
    writePerProject(projectsRoot, "delta", runId, {
      projectName: "delta",
      overallStatus: "failed",
      build: { status: "success" },
      gate: { approved: false, issues: ["x"], warnings: [], stats: {} },
    });
    // epsilon: no result.json on disk

    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", runId,
      "--project", "alpha",
      "--project", "beta",
      "--project", "gamma",
      "--project", "delta",
      "--project", "epsilon",
    ]);
    check("partial: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const aggregatePath = resolve(projectsRoot, "gateway", "operations", "nightly-runs", runId, "result.json");
    const latestPath = resolve(projectsRoot, "gateway", "operations", "nightly-latest.json");
    check("partial: aggregate run file written", existsSync(aggregatePath), aggregatePath);
    check("partial: aggregate latest written", existsSync(latestPath), latestPath);
    if (existsSync(aggregatePath)) {
      const payload = JSON.parse(readFileSync(aggregatePath, "utf8"));
      check("partial: projectCount=5", payload.projectCount === 5, JSON.stringify(payload));
      check("partial: successCount=3", payload.successCount === 3, JSON.stringify(payload));
      check("partial: failedCount=1", payload.failedCount === 1, JSON.stringify(payload));
      check("partial: missingCount=1", payload.missingCount === 1, JSON.stringify(payload));
      check("partial: overallStatus=partial_success", payload.overallStatus === "partial_success", JSON.stringify(payload));
        check("partial: projectsRoot included for notify", payload.projectsRoot === projectsRoot, JSON.stringify(payload));
        check("partial: generatedAt included for notify", typeof payload.generatedAt === "string" && payload.generatedAt.length > 0, JSON.stringify(payload));
        check("partial: notify success list", Array.isArray(payload.success) && payload.success.length === 3, JSON.stringify(payload));
        check("partial: notify failed list includes failed+missing", Array.isArray(payload.failed) && payload.failed.length === 2, JSON.stringify(payload));
        check("partial: notify totals include missing as failed", payload.totals?.failed === 2, JSON.stringify(payload));
      const epsilon = payload.projects.find((p) => p.projectName === "epsilon");
      check("partial: epsilon placeholder status=missing", epsilon?.overallStatus === "missing", JSON.stringify(epsilon));
      check("partial: epsilon placeholder no build/gate", !epsilon?.build && !epsilon?.gate, JSON.stringify(epsilon));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 2: all success → overallStatus=success ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const runId = "run-2";
    writePerProject(projectsRoot, "alpha", runId, {
      projectName: "alpha",
      overallStatus: "success",
      build: { status: "success" },
      gate: { approved: true, issues: [], warnings: [], stats: {} },
    });

    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", runId,
      "--project", "alpha",
    ]);
    check("all-success: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "nightly-latest.json"), "utf8"));
    check("all-success: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
    check("all-success: missingCount=0", payload.missingCount === 0, JSON.stringify(payload));
    check("all-success: stdout reports overallStatus", result.stdout.trim() === "success", result.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3: empty project list → projectCount=0 + overallStatus=success ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", "run-3",
    ]);
    check("empty: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "nightly-latest.json"), "utf8"));
    check("empty: projectCount=0", payload.projectCount === 0, JSON.stringify(payload));
    check("empty: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
    check("empty: projects=[]", Array.isArray(payload.projects) && payload.projects.length === 0, JSON.stringify(payload));
    check("empty: startedAt uses local timezone offset", /^[0-9T:.+-]+[+-]\d{2}:\d{2}$/.test(payload.startedAt), payload.startedAt);
    check("empty: finishedAt uses local timezone offset", /^[0-9T:.+-]+[+-]\d{2}:\d{2}$/.test(payload.finishedAt), payload.finishedAt);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 4: missing required args rejected ---
{
  const result = runScript([]);
  check("missing-required: exit non-zero", result.status !== 0, `${result.status}\n${result.stderr}`);
  check("missing-required: stderr mentions --projects-root", result.stderr.includes("--projects-root"), result.stderr);
}

// --- Test 5: --help works ---
{
  const result = runScript(["--help"]);
  check("help: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
  check("help: stdout has Usage", result.stdout.includes("Usage:"), result.stdout);
}

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall tests passed\n");
