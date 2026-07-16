#!/usr/bin/env node

// One-shot LIVE deploy on the PPE host using the standard OSS install path
// (Verdaccio registry), leaving a running dashboard for interactive use.
//
// Differs from the ppe-oss-release gate case in intent, not in flow:
//   - deploys into the CLI's STANDARD data root ($HOME/understand-projects),
//     resolved by the CLI itself (we do NOT set UA_PROJECTS_ROOT)
//   - deploy-tool scratch (CLI install prefix, verdaccio, llm shim, tarballs)
//     lives in a separate $HOME/.ua-live-deploy-work, never polluting the root
//   - Verdaccio is stopped after install (no longer needed; the gateway runtime
//     release is self-contained), but the dashboard daemon is left RUNNING
//   - reads back the real dashboard URL (with token) from the pid file
//
// No hacks: standard `pnpm pack` -> publish -> `npm install @understand-anyway/cli`
// -> `understand-anyway init` -> `understand-anyway ops daily-update`. LLM is
// driven by the built-in `cli-spawn` provider talking DIRECTLY to `traex exec`
// (no shim): the real config file `scripts/deploy.ppe.yaml` sets
// providers.llm.package=cli-spawn with command=traex + modelArg=-m, so the
// orchestration-selected model is injected on the command line. The config is
// scp'd to the standard data root as a real on-disk file (no base64 inlining).
//
// Env (reuse scripts/release-gate-ppe-env.sh):
//   UA_RELEASE_GATE_PPE_HOST / _USER / _ROOT / _PLUGIN_ROOT / _TRAEX_BIN
//   UA_RELEASE_GATE_PPE_REGISTRY (default http://127.0.0.1:4873)
// Optional:
//   UA_LIVE_DEPLOY_HOME    default: /home/<ppe-user>  (drives $HOME/understand-projects)
//   UA_LIVE_DEPLOY_WORK    default: <home>/.ua-live-deploy-work
//   UA_LIVE_DEPLOY_PORT    default: 18690
//   UA_LIVE_DEPLOY_PROJECT default: oss-live-demo

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, run, runCapture } from "./lib/release-gate-helpers.mjs";

const DEPLOY_CONFIG_SAMPLE = resolve(REPO_ROOT, "scripts", "deploy.ppe.yaml");

const PKG_DIRS = [
  "plugin-api",
  "core",
  "gateway",
  "provider-feishu-auth",
  "provider-feishu-sheets",
  "cli",
];

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`missing ${name} (did you 'source scripts/release-gate-ppe-env.sh'?)`);
  return value;
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildEnv() {
  const host = requiredEnv("UA_RELEASE_GATE_PPE_HOST");
  const user = requiredEnv("UA_RELEASE_GATE_PPE_USER");
  const pluginRoot = requiredEnv("UA_RELEASE_GATE_PPE_PLUGIN_ROOT");
  const registry = process.env.UA_RELEASE_GATE_PPE_REGISTRY || "http://127.0.0.1:4873";
  const registryListen = registry.replace(/^https?:\/\//, "");
  const home = process.env.UA_LIVE_DEPLOY_HOME || `/home/${user}`;
  // Standard data root: the CLI's own default (`$HOME/understand-projects`).
  // We do NOT pass UA_PROJECTS_ROOT so the CLI resolves this itself — the
  // real standard deployment shape.
  const projectsRoot = `${home}/understand-projects`;
  // Deploy-tool scratch (CLI install prefix, verdaccio).
  // Kept OUTSIDE the standard data root so it never pollutes it.
  const toolRoot = process.env.UA_LIVE_DEPLOY_WORK || `${home}/.ua-live-deploy-work`;
  // Tarball staging must live OUTSIDE toolRoot too: the deploy command
  // `rm -rf`'s toolRoot at the start, which would wipe scp'd tarballs.
  const tarballDir = process.env.UA_LIVE_DEPLOY_TARBALL_DIR || `${home}/.ua-live-deploy-tarballs`;
  const port = String(process.env.UA_LIVE_DEPLOY_PORT || "18690");
  const project = process.env.UA_LIVE_DEPLOY_PROJECT || "oss-live-demo";
  return { host, user, pluginRoot, registry, registryListen, home, projectsRoot, toolRoot, tarballDir, port, project };
}

// llm workdir for `traex exec -C <dir>` (must match deploy.ppe.yaml's -C path).
function llmWorkdir(env) {
  return resolve(env.projectsRoot, "gateway", ".understand-anything", "llm-work");
}

function buildDeployCommand(env) {
  const toolRoot = env.toolRoot;
  const projectsRoot = env.projectsRoot;
  const installRoot = resolve(toolRoot, "install");
  const srcRoot = resolve(projectsRoot, "src", env.project);
  const binDir = resolve(installRoot, "node_modules", ".bin");
  const deployConfig = resolve(projectsRoot, "gateway", "config", "deploy.yaml");
  const verdaccioConfigFile = resolve(toolRoot, "verdaccio.yaml");
  const verdaccioLog = resolve(toolRoot, "verdaccio.log");
  const npmrcFile = resolve(toolRoot, "npmrc");
  const tarballDir = env.tarballDir;
  const stagedConfig = resolve(tarballDir, "deploy.ppe.yaml");
  const workdir = llmWorkdir(env);
  const registryNoScheme = env.registry.replace(/^https?:/, "");
  // Shared-gateway dashboard writes its pid (with url+token) under the gateway
  // state root, not the per-project dir.
  const pidFile = resolve(projectsRoot, "gateway", ".understand-anything", "dashboard.pid");

  const verdaccioYaml = [
    `storage: ${resolve(toolRoot, "verdaccio-storage")}`,
    "uplinks:",
    "  npmjs:",
    "    url: https://registry.npmjs.org/",
    "packages:",
    "  '@understand-anyway/*':",
    "    access: $all",
    "    publish: $all",
    "    unpublish: $all",
    "  '**':",
    "    access: $all",
    "    proxy: npmjs",
    "publish:",
    "  allow_offline: true",
    "log: { type: stdout, format: pretty, level: warn }",
    "",
  ].join("\n");
  const encodedVerdaccio = Buffer.from(verdaccioYaml, "utf8").toString("base64");

  // Two-module sample so the graph-health gate sees real import edges.
  const greetFile = ["export function greet(name) {", "  return `hello ${name}`;", "}", ""].join("\n");
  const indexFile = [
    "import { greet } from \"./greet.js\";",
    "",
    "export function main(name) {",
    "  return greet(name);",
    "}",
    "",
  ].join("\n");
  const encodedGreet = Buffer.from(greetFile, "utf8").toString("base64");
  const encodedIndex = Buffer.from(indexFile, "utf8").toString("base64");

  const publishSegments = PKG_DIRS.map(
    (pkg) =>
      `for f in ${quote(tarballDir)}/understand-anyway-${pkg}-*.tgz; do npm publish "$f" --userconfig ${quote(npmrcFile)} --registry ${env.registry} >/dev/null; done`,
  );

  return [
    "set -euo pipefail",
    // Reset both the standard data root and the deploy-tool scratch.
    `rm -rf ${quote(projectsRoot)} ${quote(toolRoot)}`,
    `mkdir -p ${quote(installRoot)} ${quote(srcRoot)} ${quote(resolve(projectsRoot, "gateway", "config"))} ${quote(workdir)} ${quote(resolve(toolRoot, "verdaccio-storage"))}`,
    `printf %s ${quote(encodedGreet)} | base64 -d > ${quote(resolve(srcRoot, "greet.js"))}`,
    `printf %s ${quote(encodedIndex)} | base64 -d > ${quote(resolve(srcRoot, "index.js"))}`,
    // Real config file (scp'd, not inlined): place the standard deploy.yaml.
    `cp ${quote(stagedConfig)} ${quote(deployConfig)}`,
    `printf %s ${quote(encodedVerdaccio)} | base64 -d > ${quote(verdaccioConfigFile)}`,
    `printf '%s\\n' ${quote(`${registryNoScheme}/:_authToken=ua-oss-live`)} > ${quote(npmrcFile)}`,
    // Verdaccio detached from the ssh channel; stopped after install below.
    `setsid npx --yes verdaccio@6 --listen ${env.registryListen} --config ${quote(verdaccioConfigFile)} </dev/null >${quote(verdaccioLog)} 2>&1 & VERDACCIO_PID=$!`,
    `for i in $(seq 1 30); do if curl -sf -o /dev/null ${env.registry}/-/ping 2>/dev/null || curl -sf -o /dev/null ${env.registry}/ 2>/dev/null; then break; fi; sleep 1; done`,
    ...publishSegments,
    // Standard install from the local registry into the deploy-tool prefix.
    `cd ${quote(installRoot)}`,
    "npm init -y >/dev/null 2>&1",
    `npm install @understand-anyway/cli --userconfig ${quote(npmrcFile)} --registry ${env.registry} --no-fund --no-audit`,
    `export PATH=${quote(binDir)}:$PATH`,
    // HOME drives the CLI's standard projects-root default
    // ($HOME/understand-projects). We deliberately do NOT set UA_PROJECTS_ROOT
    // so this exercises the true standard deployment shape.
    `export HOME=${quote(env.home)}`,
    `export UA_PLUGIN_ROOT=${quote(env.pluginRoot)}`,
    // Register + orchestrate (build, gateway publish, dashboard start).
    `understand-anyway init ${quote(srcRoot)} --project ${quote(env.project)} --repo-path ${quote(srcRoot)}`,
    [
      "understand-anyway ops daily-update",
      `--project ${quote(env.project)}`,
      "--profile small",
      "--deploy-profile ppe",
      `--host ${quote(env.host)}`,
      `--port ${env.port}`,
      "--no-self-update",
      `--plugin-root ${quote(env.pluginRoot)}`,
    ].join(" "),
    // Verdaccio is no longer needed once install + gateway runtime are in place.
    // Stop it (registry storage stays on disk) but LEAVE the dashboard running.
    `kill $VERDACCIO_PID 2>/dev/null || true`,
    `VERDACCIO_REAL_PID="$(ss -ltnp 2>/dev/null | grep ':${env.registryListen.split(":").pop()}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"`,
    `[ -n "$VERDACCIO_REAL_PID" ] && kill $VERDACCIO_REAL_PID 2>/dev/null || true`,
    // Emit the live dashboard URL (with token) from the pid file for access.
    "echo '===LIVE-DASHBOARD==='",
    `cat ${quote(pidFile)} 2>/dev/null || echo 'pid file missing'`,
    "echo '===END-LIVE-DASHBOARD==='",
    "echo '[ppe-live-deploy] deploy ok'",
    "exit 0",
  ].join("; ");
}

function prepareArtifacts(env) {
  const localTmp = resolve(REPO_ROOT, ".release-gate", "verdaccio-tarballs");
  rmSync(localTmp, { recursive: true, force: true });
  mkdirSync(localTmp, { recursive: true });
  run("pnpm", ["-r", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  for (const pkg of PKG_DIRS) {
    run("pnpm", ["pack", "--pack-destination", localTmp], {
      cwd: resolve(REPO_ROOT, "packages", pkg),
      stdio: "inherit",
    });
  }
  const tarballDir = env.tarballDir;
  run("ssh", ["-n", "-o", "BatchMode=yes", `${env.user}@${env.host}`, `rm -rf ${quote(tarballDir)}; mkdir -p ${quote(tarballDir)}`], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  const staged = readdirSync(localTmp).filter((f) => f.endsWith(".tgz"));
  for (const pkg of PKG_DIRS) {
    const file = staged.find((f) => f.startsWith(`understand-anyway-${pkg}-`));
    if (!file) throw new Error(`packed tarball not found for ${pkg} in ${localTmp}`);
    run("scp", [resolve(localTmp, file), `${env.user}@${env.host}:${tarballDir}/`], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
  // Real config file: scp the standard deploy.yaml into the (un-rm'd) tarball
  // staging dir; the deploy command copies it into the data root after reset.
  run("scp", [DEPLOY_CONFIG_SAMPLE, `${env.user}@${env.host}:${tarballDir}/deploy.ppe.yaml`], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

function main() {
  let env;
  try {
    env = buildEnv();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(`[ppe-live-deploy] host=${env.host} project=${env.project} projectsRoot=${env.projectsRoot} toolRoot=${env.toolRoot} port=${env.port}\n`);
  prepareArtifacts(env);

  const command = buildDeployCommand(env);
  const logPath = "/tmp/ua-ppe-live-deploy.log";
  const remote = [
    `rm -f ${quote(logPath)}`,
    `( ${command} ) >${quote(logPath)} 2>&1`,
    "status=$?",
    `cat ${quote(logPath)}`,
    "exit $status",
  ].join("; ");
  const res = runCapture("ssh", ["-n", "-o", "BatchMode=yes", `${env.user}@${env.host}`, remote], { cwd: REPO_ROOT });
  process.stdout.write(res.stdout || "");
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.status ?? 1);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[ppe-live-deploy] fatal: ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
}
