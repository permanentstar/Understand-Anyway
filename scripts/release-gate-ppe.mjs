#!/usr/bin/env node

import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { REPO_ROOT, run } from "./lib/release-gate-helpers.mjs";

export const PPE_CASES = ["ppe-repo", "ppe-npm-installed", "ppe-ops", "ppe-real-llm"];

function usage() {
  return [
    "Usage: node scripts/release-gate-ppe.mjs --case <ppe-repo|ppe-npm-installed|ppe-ops|ppe-real-llm> [--dry-run]",
    "",
    "Required env:",
    "  UA_RELEASE_GATE_PPE_HOST",
    "  UA_RELEASE_GATE_PPE_USER",
    "  UA_RELEASE_GATE_PPE_ROOT",
    "  UA_RELEASE_GATE_PPE_PLUGIN_ROOT",
    "",
    "Optional env:",
    "  UA_RELEASE_GATE_PPE_REPO_DIR               default: <root>/0d7ada6/repo",
    "  UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT     default: <root>/0d7ada6/projects-root",
    "  UA_RELEASE_GATE_PPE_NPM_DIR                default: <root>/npm-installed-20260702-165612",
    "  UA_RELEASE_GATE_PPE_TRAEX_BIN              default: /home/<user>/.local/bin/traex",
    "",
  ].join("\n");
}

export function parseArgs(argv) {
  const out = { caseName: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--case":
        out.caseName = String(argv[++i] || "").trim();
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!PPE_CASES.includes(out.caseName)) {
    throw new Error(`--case must be one of ${PPE_CASES.join(", ")}`);
  }
  return out;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildEnv() {
  const host = requiredEnv("UA_RELEASE_GATE_PPE_HOST");
  const user = requiredEnv("UA_RELEASE_GATE_PPE_USER");
  const root = requiredEnv("UA_RELEASE_GATE_PPE_ROOT");
  const pluginRoot = requiredEnv("UA_RELEASE_GATE_PPE_PLUGIN_ROOT");
  const repoBase = resolve(root, "0d7ada6");
  const npmBase = process.env.UA_RELEASE_GATE_PPE_NPM_DIR || resolve(root, "npm-installed-20260702-165612");
  const repoDir = process.env.UA_RELEASE_GATE_PPE_REPO_DIR || resolve(repoBase, "repo");
  const repoProjectsRoot = process.env.UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT || resolve(repoBase, "projects-root");
  const npmOrchRepo = resolve(npmBase, "orch-repo");
  const npmInstallDir = resolve(npmBase, "install");
  const npmProjectsRoot = resolve(npmBase, "projects-root");
  const traexBin = process.env.UA_RELEASE_GATE_PPE_TRAEX_BIN || `/home/${user}/.local/bin/traex`;
  return {
    host,
    user,
    root,
    pluginRoot,
    repoDir,
    repoProjectsRoot,
    npmBase,
    npmOrchRepo,
    npmInstallDir,
    npmProjectsRoot,
    traexBin,
  };
}

function buildRepoCommand(env) {
  return [
    "set -euo pipefail",
    `export UA_PROJECTS_ROOT=${quote(env.repoProjectsRoot)}`,
    `cd ${quote(env.repoDir)}`,
    [
      "bash scripts/daily-update.sh",
      "--project understand-anyway-main",
      "--profile small",
      "--deploy-profile ppe",
      `--host ${quote(env.host)}`,
      "--port 18666",
      "--no-self-update",
      "--no-pull",
      `--plugin-root ${quote(env.pluginRoot)}`,
    ].join(" "),
  ].join("; ");
}

function buildNpmInstalledCommand(env) {
  return [
    "set -euo pipefail",
    `export PATH=${quote(resolve(env.npmInstallDir, "node_modules", ".bin"))}:$PATH`,
    `export UA_PROJECTS_ROOT=${quote(env.npmProjectsRoot)}`,
    `cd ${quote(env.npmOrchRepo)}`,
    [
      "bash scripts/daily-update.sh",
      "--project understand-anyway-npm",
      "--profile small",
      "--deploy-profile ppe",
      `--host ${quote(env.host)}`,
      "--port 18672",
      "--no-self-update",
      "--no-pull",
      `--plugin-root ${quote(env.pluginRoot)}`,
    ].join(" "),
  ].join("; ");
}

function buildOpsCommand(env) {
  return [
    "set -euo pipefail",
    `export UA_PROJECTS_ROOT=${quote(env.repoProjectsRoot)}`,
    `cd ${quote(env.repoDir)}`,
    [
      "node packages/cli/dist/cli.js compat",
      `--plugin-root ${quote(env.pluginRoot)}`,
    ].join(" "),
    [
      "node packages/cli/dist/cli.js review-graph-health",
      "--project understand-anyway-main",
      `--output ${quote(resolve(env.repoProjectsRoot, "gateway", "operations", "ppe-ops-review.json"))}`,
    ].join(" "),
    [
      "node packages/cli/dist/cli.js project-state list",
      "--project understand-anyway-main",
    ].join(" "),
    [
      "node packages/cli/dist/cli.js gateway publish",
      `--projects-root ${quote(env.repoProjectsRoot)}`,
      `--plugin-root ${quote(env.pluginRoot)}`,
      "--retain 2",
    ].join(" "),
    [
      "node packages/cli/dist/cli.js notify nightly",
      `--report ${quote(resolve(env.repoProjectsRoot, "gateway", "operations", "nightly-latest.json"))}`,
      `--config ${quote(resolve(env.repoProjectsRoot, "gateway", "config", "deploy.yaml"))}`,
      "--best-effort",
    ].join(" "),
  ].join("; ");
}

function buildRealLlmShimCommand(env, workRoot) {
  const shimRoot = resolve(workRoot, "llm-shim");
  const shimFile = resolve(shimRoot, "llm");
  const shimScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"--version\" ]]; then",
    "  echo \"llm-shim 0.1\"",
    "  exit 0",
    "fi",
    "if [[ \"${1:-}\" == \"--help\" ]]; then",
    "  echo \"usage: llm [-p] [--output-format text] <prompt>\"",
    "  exit 0",
    "fi",
    "if [[ \"${1:-}\" == \"-p\" ]]; then shift; fi",
    "if [[ \"${1:-}\" == \"--output-format\" ]]; then shift 2; fi",
    "prompt=\"${*:-}\"",
    `workdir=${quote(resolve(workRoot, "traex-work"))}`,
    "out=\"$workdir/out.txt\"",
    "log=\"$workdir/exec.log\"",
    "err=\"$workdir/exec.err\"",
    "mkdir -p \"$workdir\"",
    "rm -f \"$out\" \"$log\" \"$err\"",
    `${quote(env.traexBin)} exec --skip-git-repo-check -C "$workdir" --dangerously-bypass-approvals-and-sandbox --output-last-message "$out" "$prompt" >"$log" 2>"$err"`,
    "cat \"$out\"",
  ].join("\n");
  const encodedShim = Buffer.from(shimScript, "utf8").toString("base64");
  return [
    `mkdir -p ${quote(shimRoot)}`,
    `printf %s ${quote(encodedShim)} | base64 -d > ${quote(shimFile)}`,
    `chmod +x ${quote(shimFile)}`,
    `export PATH=${quote(shimRoot)}:$PATH`,
    `${quote(env.traexBin)} login --git-code`,
    `export UA_PLUGIN_ROOT=${quote(env.pluginRoot)}`,
    `cd ${quote(env.repoDir)}`,
    "node scripts/local-delivery-tests.mjs --profile real-llm --only shared-gateway --verbose",
  ].join("; ");
}

function buildCommand(caseName, env) {
  switch (caseName) {
    case "ppe-repo":
      return buildRepoCommand(env);
    case "ppe-npm-installed":
      return buildNpmInstalledCommand(env);
    case "ppe-ops":
      return buildOpsCommand(env);
    case "ppe-real-llm": {
      const workRoot = resolve("/tmp", `ua-ppe-real-llm-${randomUUID()}`);
      return buildRealLlmShimCommand(env, workRoot);
    }
    default:
      throw new Error(`unsupported case: ${caseName}`);
  }
}

export function buildSshCommand(caseName, env) {
  const command = buildCommand(caseName, env);
  const logPath = `/tmp/ua-release-gate-${caseName}.log`;
  const remote = [
    `rm -f ${quote(logPath)}`,
    `( ${command} ) >${quote(logPath)} 2>&1`,
    "status=$?",
    `cat ${quote(logPath)}`,
    "exit $status",
  ].join("; ");
  return ["ssh", "-n", "-o", "BatchMode=yes", `${env.user}@${env.host}`, remote];
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exit(2);
  }

  let env;
  try {
    env = buildEnv();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  const [sshCmd, ...sshArgs] = buildSshCommand(args.caseName, env);
  if (args.dryRun) {
    process.stdout.write(`[release-gate-ppe] ${args.caseName}\n`);
    process.stdout.write(`${sshCmd} ${sshArgs.join(" ")}\n`);
    return;
  }

  const artifactDir = resolve(REPO_ROOT, ".release-gate", "ppe");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(resolve(artifactDir, `${args.caseName}.last-command.txt`), `${sshCmd} ${sshArgs.join(" ")}\n`, "utf8");
  run(sshCmd, sshArgs, { cwd: REPO_ROOT, stdio: "inherit" });
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[release-gate-ppe] fatal: ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
}
