#!/usr/bin/env node
// scripts/aggregate-nightly.mjs
//
// Aggregate per-project nightly results into a single roll-up JSON.
//
// Inputs:
//   --projects-root <dir>    Required. Root containing per-project state dirs.
//   --run-id <id>            Required. Aggregate run id.
//   --started-at <iso>       Optional. Start timestamp; default: now.
//   --finished-at <iso>      Optional. Finish timestamp; default: now.
//   --root-dir <path>        Optional. Repo root recorded in the aggregate.
//   --project <id>           Repeatable. Project id whose result.json should be
//                            collected. When omitted, no projects are recorded.
//
// Outputs:
//   <projects-root>/gateway/operations/nightly-runs/<run-id>/result.json
//   <projects-root>/gateway/operations/nightly-latest.json   (atomic rename)
//
// Missing per-project results land as `status: "missing"` placeholders so the
// aggregate always reflects every discovered project.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { formatLocalTimestamp } from "./lib/time.mjs";

function parseArgs(argv) {
  const args = {
    projectsRoot: "",
    runId: "",
    startedAt: "",
    finishedAt: "",
    rootDir: "",
    projects: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--projects-root":
        args.projectsRoot = next ?? "";
        i += 1;
        break;
      case "--run-id":
        args.runId = next ?? "";
        i += 1;
        break;
      case "--started-at":
        args.startedAt = next ?? "";
        i += 1;
        break;
      case "--finished-at":
        args.finishedAt = next ?? "";
        i += 1;
        break;
      case "--root-dir":
        args.rootDir = next ?? "";
        i += 1;
        break;
      case "--project":
        if (!next) throw new Error("missing value for --project");
        args.projects.push(next);
        i += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: aggregate-nightly.mjs --projects-root <dir> --run-id <id> [--project <id>]...\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.projectsRoot) throw new Error("missing required --projects-root");
  if (!args.runId) throw new Error("missing required --run-id");
  return args;
}

function readPerProjectResult({ projectsRoot, runId, projectId }) {
  const resolvedStateDir = resolve(projectsRoot, "projects", projectId);
  const resultPath = resolve(
    resolvedStateDir,
    ".understand-anything",
    "nightly-runs",
    runId,
    "result.json",
  );
  if (!existsSync(resultPath)) {
    return {
      projectName: projectId,
      stateDir: resolvedStateDir,
      overallStatus: "missing",
      logs: { result: resultPath },
    };
  }
  try {
    const payload = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!payload.projectName) payload.projectName = projectId;
    if (!payload.logs) payload.logs = { result: resultPath };
    return payload;
  } catch (err) {
    return {
      projectName: projectId,
      stateDir: resolvedStateDir,
      overallStatus: "failed",
      error: err.message,
      logs: { result: resultPath },
    };
  }
}

function classify(projects) {
  let success = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let buildSuccess = 0;
  for (const p of projects) {
    if (p.overallStatus === "success") success += 1;
    else if (p.overallStatus === "skipped") skipped += 1;
    else if (p.overallStatus === "missing") missing += 1;
    else failed += 1;
    if (p.build?.status === "success") buildSuccess += 1;
  }
  let overallStatus;
  if (failed === 0 && missing === 0) {
    overallStatus = "success";
  } else if (failed === projects.length) {
    overallStatus = "failed";
  } else {
    overallStatus = "partial_success";
  }
  return { successCount: success, skippedCount: skipped, missingCount: missing, failedCount: failed, buildSuccessCount: buildSuccess, overallStatus };
}

function notifyFields({ projectsRoot, projects, stats, generatedAt }) {
  const success = [];
  const skipped = [];
  const failed = [];
  for (const project of projects) {
    const name = String(project.projectName || "");
    if (project.overallStatus === "success") {
      success.push(name);
      continue;
    }
    if (project.overallStatus === "skipped") {
      skipped.push(name);
      continue;
    }
    failed.push({
      project: name,
      reason: project.failureReason || project.overallStatus || "failed",
      logPath: project.logs?.result,
    });
  }
  return {
    generatedAt,
    projectsRoot,
    success,
    skipped,
    failed,
    totals: {
      success: stats.successCount,
      skipped: stats.skippedCount,
      failed: stats.failedCount + stats.missingCount,
    },
  };
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = formatLocalTimestamp();
  const operationsRoot = resolve(args.projectsRoot, "gateway", "operations");

  const projects = args.projects.map((projectId) =>
    readPerProjectResult({
      projectsRoot: args.projectsRoot,
      runId: args.runId,
      projectId,
    }),
  );

  const stats = classify(projects);
  const aggregatePath = resolve(
    operationsRoot,
    "nightly-runs",
    args.runId,
    "result.json",
  );
  const latestPath = resolve(operationsRoot, "nightly-latest.json");

  const aggregate = {
    runId: args.runId,
    startedAt: args.startedAt || now,
    finishedAt: args.finishedAt || now,
      ...notifyFields({ projectsRoot: args.projectsRoot, projects, stats, generatedAt: args.finishedAt || now }),
    rootDir: args.rootDir || "",
    projectCount: projects.length,
    ...stats,
    logs: { result: aggregatePath },
    projects,
  };

  const contents = JSON.stringify(aggregate, null, 2);
  atomicWrite(aggregatePath, contents);
  copyFileSync(aggregatePath, `${latestPath}.${process.pid}.tmp`);
  renameSync(`${latestPath}.${process.pid}.tmp`, latestPath);

  process.stdout.write(`${aggregate.overallStatus}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`aggregate-nightly: ${err.message}\n`);
  process.exit(2);
}
