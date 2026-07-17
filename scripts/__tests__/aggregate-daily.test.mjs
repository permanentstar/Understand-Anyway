#!/usr/bin/env node
// scripts/__tests__/aggregate-daily.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "aggregate-daily.mjs");

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
  return mkdtempSync(resolve(tmpdir(), "ua-d8-daily-"));
}

function writeNightlyAggregate(projectsRoot, runId, payload) {
  const dir = resolve(projectsRoot, "gateway", "operations", "nightly-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "result.json"), JSON.stringify(payload));
}

function writeNightlyLatest(projectsRoot, payload) {
  const dir = resolve(projectsRoot, "gateway", "operations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "nightly-latest.json"), JSON.stringify(payload));
}

function runScript(args) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

// --- Test 1: nightly+refresh both 0 → success; daily/nightly logs paths captured ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const runId = "rid";
    writeNightlyAggregate(projectsRoot, runId, {
      runId,
      projectCount: 2,
      successCount: 2,
      skippedCount: 0,
      failedCount: 0,
      missingCount: 0,
      overallStatus: "success",
    });
    const logPath = resolve(work, "daily-update.log");
    writeFileSync(logPath, "log content");

    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", runId,
      "--root-dir", "/repo",
      "--self-update-status", "0",
      "--deploy-head-before", "abc123",
      "--deploy-head-after", "def456",
      "--gateway-published", "true",
      "--gateway-publish-reason", "code changed abc->def",
      "--nightly-status", "0",
      "--refresh-status", "0",
      "--log-path", logPath,
    ]);
    check("happy: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const aggregatePath = resolve(projectsRoot, "gateway", "operations", "daily-runs", runId, "result.json");
    const latestPath = resolve(projectsRoot, "gateway", "operations", "daily-latest.json");
    check("happy: aggregate run file written", existsSync(aggregatePath), aggregatePath);
    check("happy: aggregate latest written", existsSync(latestPath), latestPath);
    const payload = JSON.parse(readFileSync(latestPath, "utf8"));
    check("happy: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
    check("happy: selfUpdate.changed=true", payload.selfUpdate?.changed === true, JSON.stringify(payload));
    check("happy: gateway.published=true", payload.gateway?.published === true, JSON.stringify(payload));
    check("happy: nightly.summary.successCount=2", payload.nightly?.summary?.successCount === 2, JSON.stringify(payload));
    check("happy: refresh.status=0", payload.refresh?.status === 0, JSON.stringify(payload));
    check("happy: logs.daily captured", payload.logs?.daily === logPath, JSON.stringify(payload.logs));
    check("happy: startedAt uses local timezone offset", /^[0-9T:.+-]+[+-]\d{2}:\d{2}$/.test(payload.startedAt), payload.startedAt);
    check("happy: finishedAt uses local timezone offset", /^[0-9T:.+-]+[+-]\d{2}:\d{2}$/.test(payload.finishedAt), payload.finishedAt);
    check("happy: stdout reports overallStatus", result.stdout.trim() === "success", result.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 2: nightly != 0 → partial_success ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const runId = "rid2";
    writeNightlyAggregate(projectsRoot, runId, {
      projectCount: 2, successCount: 1, skippedCount: 0, failedCount: 1, missingCount: 0,
      overallStatus: "partial_success",
    });

    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", runId,
      "--nightly-status", "1",
      "--refresh-status", "0",
    ]);
    check("nightly-fail: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check("nightly-fail: overallStatus=partial_success", payload.overallStatus === "partial_success", JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 2a: nightly exit 0 but aggregate partial_success must stay partial_success ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const runId = "rid2a";
    writeNightlyAggregate(projectsRoot, runId, {
      projectCount: 3,
      successCount: 1,
      skippedCount: 1,
      failedCount: 1,
      missingCount: 0,
      overallStatus: "partial_success",
    });

    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", runId,
      "--nightly-status", "0",
      "--refresh-status", "0",
    ]);
    check("nightly-aggregate-partial: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check(
      "nightly-aggregate-partial: overallStatus=partial_success",
      payload.overallStatus === "partial_success",
      JSON.stringify(payload),
    );
    check(
      "nightly-aggregate-partial: nightly summary preserved",
      payload.nightly?.summary?.failedCount === 1 && payload.nightly?.summary?.overallStatus === "partial_success",
      JSON.stringify(payload.nightly),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 2b: daily run id may differ from nightly run id; fallback to nightly-latest ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    writeNightlyLatest(projectsRoot, {
      runId: "nightly-rid",
      projectCount: 3,
      successCount: 2,
      skippedCount: 1,
      failedCount: 0,
      missingCount: 0,
      overallStatus: "success",
    });

    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", "daily-rid",
      "--nightly-status", "0",
      "--refresh-status", "0",
    ]);
    check("nightly-latest-fallback: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check(
      "nightly-latest-fallback: summary read from latest",
      payload.nightly?.summary?.projectCount === 3 && payload.nightly?.aggregatePath.endsWith("nightly-latest.json"),
      JSON.stringify(payload.nightly),
    );
    check("nightly-latest-fallback: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3: refresh != 0 → failed (regardless of nightly) ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const runId = "rid3";

    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", runId,
      "--nightly-status", "0",
      "--refresh-status", "2",
    ]);
    check("refresh-fail: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check("refresh-fail: overallStatus=failed", payload.overallStatus === "failed", JSON.stringify(payload));
    check("refresh-fail: nightly.summary=null when no aggregate", payload.nightly?.summary === null, JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3a: gateway publish failure degrades overallStatus to failed ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", "rid3a",
      "--nightly-status", "0",
      "--refresh-status", "0",
      "--gateway-published", "false",
      "--gateway-publish-reason", "publish failed",
    ]);
    check("gateway-fail: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check("gateway-fail: overallStatus=failed", payload.overallStatus === "failed", JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3b: gateway publish skipped does not degrade an otherwise successful run ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", "rid3b",
      "--nightly-status", "0",
      "--refresh-status", "0",
      "--gateway-published", "skipped",
    ]);
    check("gateway-skip: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check("gateway-skip: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
    check("gateway-skip: gateway.published=skipped", payload.gateway?.published === "skipped", JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 4: missing required args → error ---
{
  const result = runScript([]);
  check("missing-required: exit non-zero", result.status !== 0, `${result.status}\n${result.stderr}`);
  check("missing-required: stderr mentions --projects-root", result.stderr.includes("--projects-root"), result.stderr);
}

// --- Test 5: bad bool / int rejected ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const r1 = runScript([
      "--projects-root", projectsRoot, "--run-id", "x",
      "--gateway-published", "yes",
    ]);
    check("bad-bool: exit non-zero", r1.status !== 0, `${r1.status}\n${r1.stderr}`);
    const r2 = runScript([
      "--projects-root", projectsRoot, "--run-id", "x",
      "--nightly-status", "abc",
    ]);
    check("bad-int: exit non-zero", r2.status !== 0, `${r2.status}\n${r2.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 6: --self-update-skipped ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", "rid-skip",
      "--self-update-skipped",
      "--nightly-status", "0",
      "--refresh-status", "0",
    ]);
    check("skip: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check("skip: selfUpdate.skipped=true", payload.selfUpdate?.skipped === true, JSON.stringify(payload));
    check("skip: selfUpdate.status=null", payload.selfUpdate?.status === null, JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 6a: self-update failure is recorded ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", "rid-self-fail",
      "--self-update-status", "1",
      "--nightly-status", "0",
      "--refresh-status", "0",
    ]);
    check("self-fail: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check("self-fail: selfUpdate.status=1", payload.selfUpdate?.status === 1, JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 7: repeated --stage-duration flags are captured in output ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    const result = runScript([
      "--projects-root", projectsRoot,
      "--run-id", "rid-stage",
      "--nightly-status", "0",
      "--refresh-status", "0",
      "--stage-duration", "self-update=2",
      "--stage-duration", "nightly-project-sync=5",
      "--stage-duration", "refresh-prod-server=3",
    ]);
    check("stage: exit 0", result.status === 0, result.stderr);
    const payload = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "operations", "daily-latest.json"), "utf8"));
    check("stage: self-update captured", payload.stageDurations?.["self-update"] === 2, JSON.stringify(payload));
    check("stage: nightly-project-sync captured", payload.stageDurations?.["nightly-project-sync"] === 5, JSON.stringify(payload));
    check("stage: refresh-prod-server captured", payload.stageDurations?.["refresh-prod-server"] === 3, JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall tests passed\n");
