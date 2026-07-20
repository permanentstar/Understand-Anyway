#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, ensurePreflight, run } from "./lib/release-gate-helpers.mjs";

export const EXTERNAL_CASE_ENV_VARS = {
  "ppe-repo": "UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD",
  "ppe-npm-installed": "UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD",
  "ppe-ops": "UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD",
  "ppe-real-llm": "UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD",
  "ppe-oss-release": "UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD",
};

export const LOCAL_REQUIRED_CHECKS = [
  { name: "static:typecheck_build_test", command: "pnpm", args: ["-r", "build"], next: { command: "pnpm", args: ["-r", "typecheck"] }, next2: { command: "pnpm", args: ["-r", "test"] }, required: true },
  { name: "static:test_scripts", command: "pnpm", args: ["test:scripts"], required: true },
  { name: "static:lint_isolation", command: "pnpm", args: ["lint:isolation"], required: true },
  { name: "static:lint_isolation_test", command: "pnpm", args: ["lint:isolation:test"], required: true },
  { name: "static:lint_scripts", command: "pnpm", args: ["lint:scripts"], required: true },
  { name: "static:git_diff_check", command: "git", args: ["diff", "--check"], required: true },
  { name: "release:dry_run", command: process.execPath, args: ["scripts/release.mjs", "patch", "--dry-run"], required: true },
  { name: "local:repo_checkout", command: process.execPath, args: ["scripts/local-delivery-tests.mjs", "--only", "repo-checkout"], required: true },
  { name: "local:verdaccio", command: process.execPath, args: ["scripts/local-delivery-tests.mjs", "--only", "verdaccio"], required: true },
  { name: "local:shared_gateway_mock", command: process.execPath, args: ["scripts/local-delivery-tests.mjs", "--only", "shared-gateway"], required: true },
  { name: "local:shared_gateway_real_llm", command: process.execPath, args: ["scripts/local-delivery-tests.mjs", "--profile", "real-llm", "--only", "shared-gateway"], required: true },
  { name: "local:build_modes", command: process.execPath, args: ["scripts/release-gate-build-modes.mjs"], required: true },
  { name: "local:ops_versioning", command: process.execPath, args: ["scripts/release-gate-ops.mjs"], required: true },
  { name: "local:daily_idempotence", command: process.execPath, args: ["scripts/release-gate-daily.mjs"], required: true },
];

export function helpText() {
  return [
    "Usage: pnpm run release:gate [-- --external <case> ...] [--verbose]",
    "",
    "Local required checks always run first.",
    "External suites are optional and become blocking when explicitly requested.",
    "",
    "Supported external cases:",
    ...Object.keys(EXTERNAL_CASE_ENV_VARS).map((name) => `  - ${name}`),
    "",
    "External case commands are provided through environment variables:",
    ...Object.entries(EXTERNAL_CASE_ENV_VARS).map(([name, envKey]) => `  ${name}: ${envKey}`),
    "",
  ].join("\n");
}

export function parseReleaseGateArgs(argv) {
  const out = { external: [], verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        break;
      case "--external": {
        const value = String(argv[++i] || "").trim();
        if (!value || value.startsWith("-")) throw new Error("missing value for --external");
        if (!(value in EXTERNAL_CASE_ENV_VARS)) throw new Error(`unknown external case: ${value}`);
        out.external.push(value);
        break;
      }
      case "--verbose":
      case "-v":
        out.verbose = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${helpText()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

export function buildCheckPlan(args) {
  const external = args.external.map((name) => ({
    name,
    required: false,
    envVar: EXTERNAL_CASE_ENV_VARS[name],
  }));
  return { local: LOCAL_REQUIRED_CHECKS, external };
}

function runCheck(check, { verbose }, env) {
  const stdio = verbose ? "inherit" : "inherit";
  run(check.command, check.args, { cwd: REPO_ROOT, stdio, env });
  if (check.next) run(check.next.command, check.next.args, { cwd: REPO_ROOT, stdio, env });
  if (check.next2) run(check.next2.command, check.next2.args, { cwd: REPO_ROOT, stdio, env });
}

function externalCommandFromEnv(check) {
  const command = String(process.env[check.envVar] || "").trim();
  if (!command) {
    throw new Error(`external case ${check.name} requested but ${check.envVar} is not set`);
  }
  return command;
}

function runExternalCheck(check, { verbose }) {
  const command = externalCommandFromEnv(check);
  run("bash", ["-lc", command], { cwd: REPO_ROOT, stdio: verbose ? "inherit" : "inherit" });
}

function writeSummary(runId, records) {
  const dir = resolve(REPO_ROOT, ".release-gate", runId);
  mkdirSync(dir, { recursive: true });
  const payload = {
    runId,
    overallStatus: records.every((r) => r.status === "success") ? "success" : "failed",
    local: {
      status: records.filter((r) => r.scope === "local").every((r) => r.status === "success") ? "success" : "failed",
      checks: records.filter((r) => r.scope === "local"),
    },
    external: {
      requested: records.filter((r) => r.scope === "external").map((r) => r.name),
      checks: records.filter((r) => r.scope === "external"),
    },
  };
  writeFileSync(resolve(dir, "summary.json"), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function printSummary(payload) {
  process.stdout.write("\n[release:gate] summary\n");
  for (const record of [...payload.local.checks, ...payload.external.checks]) {
    process.stdout.write(`  ${record.status === "success" ? "PASS" : "FAIL"}  ${record.name} (${record.durationMs}ms)\n`);
  }
  process.stdout.write(`  overall=${payload.overallStatus}\n`);
}

async function main() {
  const args = parseReleaseGateArgs(process.argv.slice(2));
  const { pluginRoot } = ensurePreflight();
  const childEnv = { ...process.env, UA_PLUGIN_ROOT: process.env.UA_PLUGIN_ROOT || pluginRoot };
  const plan = buildCheckPlan(args);
  const records = [];

  for (const check of plan.local) {
    const started = Date.now();
    try {
      runCheck(check, args, childEnv);
      records.push({ scope: "local", name: check.name, required: true, status: "success", durationMs: Date.now() - started, command: [check.command, ...check.args].join(" ") });
    } catch (err) {
      records.push({ scope: "local", name: check.name, required: true, status: "failed", durationMs: Date.now() - started, command: [check.command, ...check.args].join(" "), error: err.message });
    }
  }

  for (const check of plan.external) {
    const started = Date.now();
    try {
      runExternalCheck(check, args);
      records.push({ scope: "external", name: check.name, required: false, status: "success", durationMs: Date.now() - started, command: process.env[check.envVar] || "" });
    } catch (err) {
      records.push({ scope: "external", name: check.name, required: false, status: "failed", durationMs: Date.now() - started, command: process.env[check.envVar] || "", error: err.message });
    }
  }

  const payload = writeSummary(new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14), records);
  printSummary(payload);
  process.exit(payload.overallStatus === "success" ? 0 : 1);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`[release:gate] fatal: ${err.stack || err.message || err}\n`);
    process.exit(1);
  });
}
