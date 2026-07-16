#!/usr/bin/env node
// scripts/write-external-records.mjs
//
// Aggregate-nightly external record writer. Keeps the deploy-compatible CLI
// surface and writes two worksheets through the existing Feishu Sheets provider:
// - nightly-update
// - project-update

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FeishuSheetsRecordProvider } from "../packages/provider-feishu-sheets/dist/index.js";

const DEFAULT_NIGHTLY_WORKSHEET = "nightly-update";
const DEFAULT_PROJECT_WORKSHEET = "project-update";

function parseArgs(argv) {
  const args = {
    provider: process.env.UA_RECORD_PROVIDER || "none",
    input: "",
    sheet: process.env.UA_RECORD_SHEET || process.env.UA_NIGHTLY_SHEET || process.env.UA_ANALYTICS_SHEET || "",
    nightlyWorksheet: process.env.UA_RECORD_NIGHTLY_WORKSHEET || DEFAULT_NIGHTLY_WORKSHEET,
    projectWorksheet: process.env.UA_RECORD_PROJECT_WORKSHEET || DEFAULT_PROJECT_WORKSHEET,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provider") {
      args.provider = argv[i + 1] || "none";
      i += 1;
      continue;
    }
    if (arg === "--input") {
      args.input = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--sheet") {
      args.sheet = argv[i + 1] || args.sheet;
      i += 1;
      continue;
    }
    if (arg === "--nightly-worksheet") {
      args.nightlyWorksheet = argv[i + 1] || args.nightlyWorksheet;
      i += 1;
      continue;
    }
    if (arg === "--project-worksheet") {
      args.projectWorksheet = argv[i + 1] || args.projectWorksheet;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        `write-external-records.mjs --provider <none|feishu> --input <aggregate-result.json> [options]

Options:
  --provider <name>            External record provider; default none
  --input <file>               Aggregate nightly result JSON
  --sheet <url|token>          External record spreadsheet URL or token
  --nightly-worksheet <name>   Run summary worksheet; default ${DEFAULT_NIGHTLY_WORKSHEET}
  --project-worksheet <name>   Project update worksheet; default ${DEFAULT_PROJECT_WORKSHEET}
`,
      );
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.input) throw new Error("missing --input");
  return args;
}

function loadEnvFile() {
  const envPath = resolve(process.env.HOME || "", ".env");
  if (!envPath || !existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const index = normalized.indexOf("=");
    if (index <= 0) continue;
    const key = normalized.slice(0, index).trim();
    if (!key || process.env[key]) continue;
    let value = normalized.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Accept either a bare spreadsheet token or a Feishu Sheets URL and return the
 * bare token. Recognized shapes:
 *   - "shtxxxxxxxxxxxx"                                          -> as-is
 *   - "https://<host>/sheets/<token>?sheet=<worksheet>"          -> <token>
 *   - "https://<host>/sheets/<token>/"                            -> <token>
 * Empty input throws — a missing sheet is a config bug worth failing loudly.
 */
export function extractSpreadsheetToken(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("missing Feishu spreadsheet token/url");
  const match = raw.match(/\/sheets\/([^/?#]+)/);
  return match ? match[1] : raw;
}

function buildNightlyEnvelope(aggregate) {
  return {
    kind: "nightly-update",
    timestamp: aggregate.finishedAt || new Date().toISOString(),
    payload: {
      runId: aggregate.runId || "",
      startedAt: aggregate.startedAt || "",
      finishedAt: aggregate.finishedAt || "",
      overallStatus: aggregate.overallStatus || "",
      projectCount: Number(aggregate.projectCount || 0),
      successCount: Number(aggregate.successCount || 0),
      failedCount: Number(aggregate.failedCount || 0),
      buildSuccessCount: Number(aggregate.buildSuccessCount || 0),
      resultJson: aggregate.logs?.result || "",
    },
  };
}

function buildProjectEnvelopes(aggregate) {
  return (Array.isArray(aggregate.projects) ? aggregate.projects : []).map((project) => ({
    kind: "project-update",
    timestamp: project.finishedAt || aggregate.finishedAt || new Date().toISOString(),
    payload: {
      runId: aggregate.runId || project.runId || "",
      startedAt: project.startedAt || aggregate.startedAt || "",
      finishedAt: project.finishedAt || aggregate.finishedAt || "",
      projectName: project.projectName || "",
      repoPath: project.repoPath || "",
      stateDir: project.stateDir || "",
      overallStatus: project.overallStatus || "",
      failureReason: project.failureReason || "",
      needsManualIntervention: Boolean(project.needsManualIntervention),
      build: project.build || {},
      gate: project.gate || {},
      git: project.git || {},
      logs: project.logs || {},
      llm: project.llm || {},
    },
  }));
}

async function writeFeishu(args, aggregate) {
  loadEnvFile();
  const appId = process.env.FEISHU_APP_ID || "";
  if (!appId) throw new Error("missing FEISHU_APP_ID; put it in ~/.env");
  const provider = new FeishuSheetsRecordProvider({
    appId,
    appSecret: process.env.FEISHU_APP_SECRET || undefined,
    appSecretFile: process.env.FEISHU_APP_SECRET_FILE || undefined,
    appSecretEnv: process.env.FEISHU_APP_SECRET_ENV || "FEISHU_APP_SECRET",
    spreadsheetToken: extractSpreadsheetToken(args.sheet),
    mappings: {
      "nightly-update": {
        worksheet: args.nightlyWorksheet,
        columns: [
          "runId",
          "startedAt",
          "finishedAt",
          "overallStatus",
          "projectCount",
          "successCount",
          "failedCount",
          "buildSuccessCount",
          "resultJson",
        ],
      },
      "project-update": {
        worksheet: args.projectWorksheet,
        columns: [
          "runId",
          "startedAt",
          "finishedAt",
          "projectName",
          "repoPath",
          "stateDir",
          "overallStatus",
          "build.status",
          "gate.status",
          "gate.approved",
          "failureReason",
          "needsManualIntervention",
          "git.commitBefore",
          "git.commitAfter",
          "llm.providerName",
          "logs.result",
          "logs.build",
          "gate.jsonPath",
          "gate.logPath",
        ],
      },
    },
    log: (message) => process.stderr.write(`${message}\n`),
  });

  await provider.write(buildNightlyEnvelope(aggregate));
  for (const envelope of buildProjectEnvelopes(aggregate)) {
    await provider.write(envelope);
  }
  process.stdout.write(
    `[write-external-records] provider=feishu sheet=${args.sheet} nightly=${args.nightlyWorksheet} project=${args.projectWorksheet}\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.input)) {
    throw new Error(`missing aggregate result: ${args.input}`);
  }
  const aggregate = JSON.parse(readFileSync(args.input, "utf8"));

  if (args.provider === "none" || !args.provider) {
    process.stdout.write("[write-external-records] provider=none skipped\n");
    return;
  }
  if (args.provider !== "feishu") {
    throw new Error(`unsupported record provider: ${args.provider}`);
  }
  if (!args.sheet) {
    throw new Error("missing Feishu spreadsheet token/url (--sheet)");
  }
  await writeFeishu(args, aggregate);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exit(1);
  }
}
