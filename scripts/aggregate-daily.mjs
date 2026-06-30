#!/usr/bin/env node
// scripts/aggregate-daily.mjs
//
// Roll up a daily-update.sh run into a single aggregate JSON, combining the
// nightly aggregate with self-update + gateway publish + refresh status codes.
//
// Inputs (all optional except --projects-root and --run-id):
//   --projects-root <dir>             Required.
//   --run-id <id>                     Required.
//   --started-at / --finished-at      ISO timestamps; default: now.
//   --self-update-status <0|1>        0 = success, 1 = best-effort failure.
//   --self-update-skipped             Marks self-update as skipped (overrides status).
//   --deploy-head-before <hash>       HEAD before self-update.
//   --deploy-head-after <hash>        HEAD after self-update.
//   --gateway-published <true|false|skipped>  Gateway publish result.
//   --gateway-publish-reason <str>    Free-form text shown alongside the bool.
//   --nightly-status <int>            nightly-project-sync exit code.
//   --refresh-status <int>            refresh-prod-server exit code.
//   --log-path <path>                 daily-update.log path.
//   --root-dir <path>                 Repo root recorded in the aggregate.
//
// Outputs:
//   <projects-root>/aggregate/daily-runs/<run-id>/result.json
//   <projects-root>/aggregate/daily-latest.json   (atomic rename)

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";

function parseInt0(value, label) {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} expects integer, got ${value}`);
  return n;
}

function parseGatewayPublished(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "skipped") return "skipped";
  throw new Error(`${label} expects true|false|skipped, got ${value}`);
}

function parseStageDuration(raw) {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) {
    throw new Error(`--stage-duration expects <name>=<seconds>, got ${raw}`);
  }
  const name = raw.slice(0, eq);
  const seconds = parseInt0(raw.slice(eq + 1), "--stage-duration");
  if (seconds === null || seconds < 0) {
    throw new Error(`--stage-duration expects non-negative seconds, got ${raw}`);
  }
  return { name, seconds };
}

function parseArgs(argv) {
  const args = {
    projectsRoot: "",
    runId: "",
    startedAt: "",
    finishedAt: "",
    rootDir: "",
    selfUpdateStatus: null,
    selfUpdateSkipped: false,
    deployHeadBefore: "",
    deployHeadAfter: "",
    gatewayPublished: null,
    gatewayPublishReason: "",
    nightlyStatus: null,
    refreshStatus: null,
    logPath: "",
    stageDurations: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--projects-root":
        args.projectsRoot = next ?? ""; i += 1; break;
      case "--run-id":
        args.runId = next ?? ""; i += 1; break;
      case "--started-at":
        args.startedAt = next ?? ""; i += 1; break;
      case "--finished-at":
        args.finishedAt = next ?? ""; i += 1; break;
      case "--root-dir":
        args.rootDir = next ?? ""; i += 1; break;
      case "--self-update-status":
        args.selfUpdateStatus = parseInt0(next, flag); i += 1; break;
      case "--self-update-skipped":
        args.selfUpdateSkipped = true; break;
      case "--deploy-head-before":
        args.deployHeadBefore = next ?? ""; i += 1; break;
      case "--deploy-head-after":
        args.deployHeadAfter = next ?? ""; i += 1; break;
      case "--gateway-published":
        args.gatewayPublished = parseGatewayPublished(next, flag); i += 1; break;
      case "--gateway-publish-reason":
        args.gatewayPublishReason = next ?? ""; i += 1; break;
      case "--nightly-status":
        args.nightlyStatus = parseInt0(next, flag); i += 1; break;
      case "--refresh-status":
        args.refreshStatus = parseInt0(next, flag); i += 1; break;
      case "--log-path":
        args.logPath = next ?? ""; i += 1; break;
      case "--stage-duration": {
        const parsed = parseStageDuration(next ?? "");
        args.stageDurations[parsed.name] = parsed.seconds;
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        process.stdout.write("Usage: aggregate-daily.mjs --projects-root <dir> --run-id <id> [options]\n");
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

function readNightlyAggregate({ projectsRoot, runId }) {
  const path = resolve(projectsRoot, "gateway", "operations", "nightly-runs", runId, "result.json");
  if (!existsSync(path)) {
    return { path, payload: null };
  }
  try {
    return { path, payload: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { path, payload: null, error: err.message };
  }
}

function classifyOverall({ refreshStatus, nightlyStatus, gatewayPublished }) {
  if (gatewayPublished === false) return "failed";
  if (refreshStatus !== 0 && refreshStatus !== null) return "failed";
  if (nightlyStatus !== 0 && nightlyStatus !== null) return "partial_success";
  if (refreshStatus === null && nightlyStatus === null) return "skipped";
  return "success";
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date().toISOString();
  const operationsRoot = resolve(args.projectsRoot, "gateway", "operations");

  const nightly = readNightlyAggregate(args);
  const aggregatePath = resolve(operationsRoot, "daily-runs", args.runId, "result.json");
  const latestPath = resolve(operationsRoot, "daily-latest.json");

  const overallStatus = classifyOverall({
    refreshStatus: args.refreshStatus,
    nightlyStatus: args.nightlyStatus,
    gatewayPublished: args.gatewayPublished,
  });

  const aggregate = {
    runId: args.runId,
    startedAt: args.startedAt || now,
    finishedAt: args.finishedAt || now,
    rootDir: args.rootDir || "",
    selfUpdate: {
      skipped: args.selfUpdateSkipped,
      status: args.selfUpdateStatus,
      headBefore: args.deployHeadBefore || null,
      headAfter: args.deployHeadAfter || null,
      changed: Boolean(
        args.deployHeadBefore && args.deployHeadAfter && args.deployHeadBefore !== args.deployHeadAfter,
      ),
    },
    gateway: {
      published: args.gatewayPublished,
      reason: args.gatewayPublishReason || "",
    },
    nightly: {
      status: args.nightlyStatus,
      aggregatePath: nightly.path,
      summary: nightly.payload
        ? {
            projectCount: nightly.payload.projectCount,
            successCount: nightly.payload.successCount,
            skippedCount: nightly.payload.skippedCount,
            failedCount: nightly.payload.failedCount,
            missingCount: nightly.payload.missingCount,
            overallStatus: nightly.payload.overallStatus,
          }
        : null,
    },
    refresh: { status: args.refreshStatus },
    stageDurations: args.stageDurations,
    overallStatus,
    logs: {
      result: aggregatePath,
      daily: args.logPath || null,
      nightly: nightly.path,
    },
  };

  const contents = JSON.stringify(aggregate, null, 2);
  atomicWrite(aggregatePath, contents);
  copyFileSync(aggregatePath, `${latestPath}.${process.pid}.tmp`);
  renameSync(`${latestPath}.${process.pid}.tmp`, latestPath);

  process.stdout.write(`${overallStatus}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`aggregate-daily: ${err.message}\n`);
  process.exit(2);
}
