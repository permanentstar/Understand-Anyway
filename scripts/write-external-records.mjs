#!/usr/bin/env node
// scripts/write-external-records.mjs
//
// Aggregate-nightly external record writer. Keeps the deploy-compatible CLI
// surface and writes two worksheets through the existing Feishu Sheets provider:
// - nightly-update
// - project-update

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatLocalTimestamp } from "./lib/time.mjs";

const DEFAULT_NIGHTLY_WORKSHEET = "nightly-update";
const DEFAULT_PROJECT_WORKSHEET = "project-update";

async function loadFeishuSheetsModule() {
  try {
    return await import("@understand-anyway/provider-feishu-sheets");
  } catch {
    return await import(new URL("../packages/provider-feishu-sheets/dist/index.js", import.meta.url).href);
  }
}

const feishuSheetsModule = await loadFeishuSheetsModule();
const { FeishuSheetsRecordProvider } = feishuSheetsModule;

async function loadYamlParse() {
  try {
    const mod = await import("yaml");
    return mod.parse;
  } catch {
    const mod = await import(new URL("../packages/cli/node_modules/yaml/dist/index.js", import.meta.url).href);
    return mod.parse;
  }
}

function parseArgs(argv) {
  const args = {
    provider: "",
    input: "",
    sheet: "",
    config: process.env.UA_CONFIG || "",
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
    if (arg === "--config") {
      args.config = argv[i + 1] || args.config;
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
  --config <deploy.yaml>       Deploy config path; default UA_CONFIG / project root
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

function parseEnvFile(content) {
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const index = normalized.indexOf("=");
    if (index <= 0) continue;
    const key = normalized.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadEnvFile(envPath, { overwrite = false } = {}) {
  if (!envPath || !existsSync(envPath)) return;
  const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!overwrite && process.env[key]) continue;
    process.env[key] = value;
  }
}

function findDeployConfigPath(args) {
  const candidates = [
    args.config,
    process.env.UA_CONFIG,
    process.env.UA_PROJECTS_ROOT ? resolve(process.env.UA_PROJECTS_ROOT, "gateway", "config", "deploy.yaml") : "",
    process.env.HOME ? resolve(process.env.HOME, "understand-projects", "gateway", "config", "deploy.yaml") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function resolveTemplateString(value) {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr) => {
    const fileMatch = String(expr).match(/^file\(['"](.+)['"]\)$/);
    if (fileMatch) return readFileSync(fileMatch[1], "utf8").trim();
    return process.env[String(expr).trim()] ?? "";
  });
}

function resolveTemplates(value) {
  if (typeof value === "string") return resolveTemplateString(value);
  if (Array.isArray(value)) return value.map(resolveTemplates);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item)]));
  }
  return value;
}

async function loadFeishuRecordConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return null;
  const parse = await loadYamlParse();
  const config = resolveTemplates(parse(readFileSync(configPath, "utf8")) ?? {});
  const record = config.record ?? {};
  const providers = Array.isArray(record.providers) ? record.providers.map(String) : [];
  if (providers.length > 0 && !providers.includes("feishu-sheets")) return null;
  return record.config?.["feishu-sheets"] ?? null;
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

export const NIGHTLY_COLUMNS = [...feishuSheetsModule.NIGHTLY_UPDATE_COLUMNS];

export const PROJECT_COLUMNS = [...feishuSheetsModule.PROJECT_UPDATE_COLUMNS];

export function buildNightlyEnvelope(aggregate) {
  return {
    kind: "nightly-update",
    timestamp: aggregate.finishedAt || formatLocalTimestamp(),
    payload: {
      runId: aggregate.runId || "",
      startedAt: aggregate.startedAt || "",
      finishedAt: aggregate.finishedAt || "",
      overallStatus: aggregate.overallStatus || "",
      projectCount: Number(aggregate.projectCount || 0),
      successCount: Number(aggregate.successCount || 0),
      failedCount: Number(aggregate.failedCount || 0),
      buildSuccessCount: Number(aggregate.buildSuccessCount || 0),
      recordProvider: aggregate.records?.provider || aggregate.feishu?.provider || "",
      recordStatus: aggregate.records?.status || aggregate.feishu?.status || "",
      resultJson: aggregate.logs?.result || "",
    },
  };
}

function summarizeModuleStatus(stats) {
  const moduleStatus = stats?.moduleStatus;
  if (!moduleStatus || typeof moduleStatus !== "object" || Array.isArray(moduleStatus)) return "";
  return Object.entries(moduleStatus).map(([key, value]) => `${key}:${value}`).join(",");
}

function buildProjectEnvelopes(aggregate) {
  return (Array.isArray(aggregate.projects) ? aggregate.projects : []).map((project) => ({
    kind: "project-update",
    timestamp: project.finishedAt || aggregate.finishedAt || formatLocalTimestamp(),
    payload: (() => {
      const gate = project.gate || project.review || {};
      const stats = gate.stats || {};
      const llm = project.llm || stats.llm || {};
      return {
      runId: aggregate.runId || project.runId || "",
      startedAt: project.startedAt || aggregate.startedAt || "",
      finishedAt: project.finishedAt || aggregate.finishedAt || "",
      project: project.projectName || "",
      projectName: project.projectName || "",
      repoPath: project.repoPath || "",
      stateDir: project.stateDir || "",
      overallStatus: project.overallStatus || "",
      failureReason: project.failureReason || "",
      needsManualIntervention: Boolean(project.needsManualIntervention),
      buildStatus: project.build?.status || "",
      gateStatus: gate.status || project.review?.status || "",
      gateApproved: Boolean(gate.approved ?? project.review?.approved),
      gateFailureReason: gate.failureReason || project.failureReason || project.review?.failureReason || "",
      criticalCount: Number(gate.criticalCount ?? project.review?.issueCount ?? 0),
      warningCount: Number(gate.warningCount ?? project.review?.warningCount ?? 0),
      commitBefore: project.git?.commitBefore || "",
      commitAfter: project.git?.commitAfter || "",
      nodeCount: Number(stats.nodeCount || 0),
      edgeCount: Number(stats.edgeCount || 0),
      containsEdges: Number(stats.containsEdges || 0),
      importsEdges: Number(stats.importsEdges || 0),
      callsEdges: Number(stats.callsEdges || 0),
      fileNodeCount: Number(stats.fileNodeCount || 0),
      missingFileCount: Number(stats.missingFileCount || 0),
      moduleStatus: summarizeModuleStatus(stats),
      llmEnabled: Boolean(llm.enabled),
      llmStatus: llm.status || "",
      llmProvider: llm.provider || "",
      llmModel: llm.model || "",
      llmRequests: Number(llm.requests || 0),
      llmTasks: Number(llm.tasks || 0),
      llmProcessedTasks: Number(llm.processedTasks || 0),
      llmFailures: Number(llm.failures || 0),
      llmTimeouts: Number(llm.timeouts || 0),
      llmCandidateFiles: Number(llm.candidateFiles || 0),
      llmProcessedFiles: Number(llm.processedFiles || 0),
      llmBreakerTripped: Boolean(llm.breakerTripped),
      llmEnrichedNodes: Number(llm.enrichedNodes || 0),
      resultJson: project.logs?.result || "",
      buildLog: project.logs?.build || "",
      gateJson: gate.jsonPath || project.review?.jsonPath || "",
      gateLog: gate.logPath || project.logs?.review || "",
      build: project.build || {},
      gate: project.gate || {},
      git: project.git || {},
      logs: project.logs || {},
      llm: project.llm || {},
      };
    })(),
  }));
}

export { buildProjectEnvelopes };

function mappingFor(recordConfig, kind, fallbackWorksheet) {
  const configured = recordConfig?.mappings?.[kind];
  const worksheets = recordConfig?.worksheets ?? {};
  const worksheetOverride = worksheets[kind]
    || (kind === "nightly-update" ? worksheets.nightly : undefined)
    || (kind === "project-update" ? worksheets.project : undefined);
  const mapping = {
    worksheet: String(configured?.worksheet || worksheetOverride || fallbackWorksheet),
    aliases: configured?.aliases && typeof configured.aliases === "object"
      ? Object.fromEntries(
          Object.entries(configured.aliases).map(([key, value]) => [
            String(key),
            Array.isArray(value) ? value.map(String) : String(value),
          ]),
        )
      : undefined,
  };
  if (Array.isArray(configured?.columns) && configured.columns.length > 0) {
    mapping.columns = configured.columns.map(String);
  }
  return mapping;
}

export async function resolveRuntime(args) {
  loadEnvFile(resolve(process.env.HOME || "", ".env"), { overwrite: false });
  const configPath = findDeployConfigPath(args);
  if (configPath) {
    loadEnvFile(resolve(dirname(configPath), ".env"), { overwrite: true });
  }
  const recordConfig = await loadFeishuRecordConfig(configPath);
  const provider = args.provider || (recordConfig ? "feishu" : process.env.UA_RECORD_PROVIDER) || "none";
  const sheet = args.sheet
    || recordConfig?.spreadsheetToken
    || process.env.UA_RECORD_SHEET
    || process.env.UA_NIGHTLY_SHEET
    || process.env.UA_ANALYTICS_SHEET
    || "";
  return { configPath, recordConfig, provider, sheet };
}

async function writeFeishu(args, runtime, aggregate) {
  const appId = runtime.recordConfig?.appId || process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || "";
  if (!appId) throw new Error("missing Feishu app id; set record.config.feishu-sheets.appId or FEISHU_APP_ID/LARK_APP_ID");
  const provider = new FeishuSheetsRecordProvider({
    appId,
    appSecret: runtime.recordConfig?.appSecret || process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || undefined,
    appSecretFile: runtime.recordConfig?.appSecretFile || process.env.FEISHU_APP_SECRET_FILE || undefined,
    appSecretEnv: runtime.recordConfig?.appSecretEnv || process.env.FEISHU_APP_SECRET_ENV || "FEISHU_APP_SECRET",
    spreadsheetToken: extractSpreadsheetToken(runtime.sheet),
    mappings: {
      "nightly-update": mappingFor(runtime.recordConfig, "nightly-update", args.nightlyWorksheet),
      "project-update": mappingFor(runtime.recordConfig, "project-update", args.projectWorksheet),
    },
    log: (message) => process.stderr.write(`${message}\n`),
  });

  const recordAwareAggregate = {
    ...aggregate,
    records: {
      ...(aggregate.records ?? {}),
      provider: aggregate.records?.provider || "feishu",
      status: aggregate.records?.status || "success",
    },
  };
  await provider.write(buildNightlyEnvelope(recordAwareAggregate));
  for (const envelope of buildProjectEnvelopes(recordAwareAggregate)) {
    await provider.write(envelope);
  }
  process.stdout.write(
    `[write-external-records] provider=feishu sheet=${runtime.sheet} nightly=${args.nightlyWorksheet} project=${args.projectWorksheet}\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.input)) {
    throw new Error(`missing aggregate result: ${args.input}`);
  }
  const aggregate = JSON.parse(readFileSync(args.input, "utf8"));
  const runtime = await resolveRuntime(args);

  if (runtime.provider === "none" || !runtime.provider) {
    process.stdout.write("[write-external-records] provider=none skipped\n");
    return;
  }
  if (runtime.provider !== "feishu") {
    throw new Error(`unsupported record provider: ${runtime.provider}`);
  }
  if (!runtime.sheet) {
    throw new Error("missing Feishu spreadsheet token/url (--sheet or record.config.feishu-sheets.spreadsheetToken)");
  }
  await writeFeishu(args, runtime, aggregate);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exit(1);
  }
}
