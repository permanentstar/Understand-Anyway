#!/usr/bin/env node

import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { REPO_ROOT, run, runCapture } from "./lib/release-gate-helpers.mjs";

const PKG_DIRS = [
  "plugin-api",
  "core",
  "gateway",
  "provider-cli-runtime",
  "provider-feishu-auth",
  "provider-feishu-sheets",
  "provider-lark-im-notify",
  "provider-trae-cli-v1",
  "provider-trae-cli-v2",
  "cli",
];

export const PPE_CASES = ["ppe-repo", "ppe-npm-installed", "ppe-ops", "ppe-real-llm", "ppe-oss-release"];

// Fixed single-instance workspace for ppe-oss-release, shared between the
// deploy ssh session and the independent teardown ssh session.
const OSS_RELEASE_WORKROOT = "/tmp/ua-ppe-oss-release";

function usage() {
  return [
    "Usage: node scripts/release-gate-ppe.mjs --case <ppe-repo|ppe-npm-installed|ppe-ops|ppe-real-llm|ppe-oss-release> [--dry-run]",
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
    "  UA_RELEASE_GATE_PPE_TRAEX_BIN              default: traex",
    "  UA_RELEASE_GATE_PPE_REGISTRY               default: http://127.0.0.1:4873 (ppe-oss-release)",
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
  const traexBin = process.env.UA_RELEASE_GATE_PPE_TRAEX_BIN || "traex";
  const registry = process.env.UA_RELEASE_GATE_PPE_REGISTRY || "http://127.0.0.1:4873";
  const registryListen = registry.replace(/^https?:\/\//, "");
  const verdaccioStorage = process.env.UA_RELEASE_GATE_PPE_VERDACCIO_STORAGE || resolve(root, "verdaccio-storage");
  const tarballDir = process.env.UA_RELEASE_GATE_PPE_TARBALL_DIR || resolve(root, "verdaccio-tarballs");
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
    registry,
    registryListen,
    verdaccioStorage,
    tarballDir,
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
      "--deploy-profile ppe",
      "--llm-profile traex",
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
      "--deploy-profile ppe",
      "--llm-profile traex",
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

// Command segments that install a temporary `llm` shim (backed by `traex
// exec`) onto PATH and log in via Trae/Codebase auth. Shared by ppe-real-llm
// and ppe-oss-release so both drive real LLM through
// `@understand-anyway/provider-trae-cli-v2`, not Feishu SSO.
function traexShimSetupSegments(env, workRoot) {
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
  ];
}

function buildRealLlmShimCommand(env, workRoot) {
  return [
    ...traexShimSetupSegments(env, workRoot),
    `export UA_PLUGIN_ROOT=${quote(env.pluginRoot)}`,
    `cd ${quote(env.repoDir)}`,
    "node scripts/local-delivery-tests.mjs --profile real-llm --only shared-gateway --verbose",
  ].join("; ");
}

// Standard OSS deploy: within a single ssh session, run a self-contained
// Verdaccio lifecycle (start -> publish the staged tarballs -> install the CLI
// from that registry -> register a synthetic project -> run the bundled
// `understand-anyway ops daily-update` with traex LLM -> stop). Verdaccio is a
// child of this command's shell and is killed on EXIT via trap, so nothing is
// left holding the ssh channel. No source checkout, no git pull, no Feishu SSO.
function buildOssReleaseCommand(env, workRoot) {
  const installRoot = resolve(workRoot, "install");
  const projectsRoot = resolve(workRoot, "projects-root");
  const srcRoot = resolve(projectsRoot, "src", "oss-release-smoke");
  const binDir = resolve(installRoot, "node_modules", ".bin");
  const deployConfig = resolve(projectsRoot, "gateway", "config", "deploy.yaml");
  const verdaccioConfigFile = resolve(workRoot, "verdaccio.yaml");
  const verdaccioLog = resolve(workRoot, "verdaccio.log");
  const npmrcFile = resolve(workRoot, "npmrc");
  // Verdaccio accepts any token for $all publish, but the npm client still
  // requires an auth entry to send a publish request. Point a scoped userconfig
  // at a throwaway token for the local registry only.
  const registryNoScheme = env.registry.replace(/^https?:/, "");

  const verdaccioYaml = [
    `storage: ${resolve(workRoot, "verdaccio-storage")}`,
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

  const deployYaml = [
    "version: 1",
    "deploy:",
    `  host: \"${env.host}\"`,
    "  port: 18690",
    "  outputLanguage: \"en\"",
    "gateway:",
    "  retain: 2",
    "llmProfiles:",
    "  traex:",
    "    package: \"@understand-anyway/provider-trae-cli-v2\"",
    "    config:",
    "      command: \"traex\"",
    "      args: [\"exec\", \"--skip-git-repo-check\", \"--dangerously-bypass-approvals-and-sandbox\", \"--ephemeral\"]",
    "      modelArg: \"-m\"",
    "      promptMode: \"arg\"",
    "record:",
    "  providers: [\"local\"]",
    "deployProfiles:",
    "  ppe:",
    "    build:",
    "      mode: \"full\"",
    "      excludeTests: true",
    "      outputLanguage: \"en\"",
    "      llmAnalysis: true",
    "      llmRequired: false",
    "      llmModelCandidates: [\"small\"]",
    "",
  ].join("\n");
  const encodedYaml = Buffer.from(deployYaml, "utf8").toString("base64");

  // Two modules with an import + call edge so the graph-health gate sees a
  // real import graph. A single file yields zero import edges, which the gate
  // rejects as `imports_edges_missing` even though the deploy path is healthy.
  const greetFile = [
    "export function greet(name) {",
    "  return `hello ${name}`;",
    "}",
    "",
  ].join("\n");
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

  // Ordered publish of the tarballs already staged in env.tarballDir.
  // Quote only the directory so the remote shell still expands the glob.
  const publishSegments = PKG_DIRS.map(
    (pkg) =>
      `for f in ${quote(env.tarballDir)}/understand-anyway-${pkg}-*.tgz; do npm publish "$f" --userconfig ${quote(npmrcFile)} --registry ${env.registry} >/dev/null; done`,
  );

  return [
    "set -euo pipefail",
    `UA_OSS_WORKROOT=${quote(workRoot)}`,
    // Fresh workspace each run (fixed path, single instance). A prior teardown
    // may have left it clean; recreate defensively.
    `rm -rf ${quote(workRoot)}`,
    ...traexShimSetupSegments(env, workRoot),
    // Prepare workspace + configs.
    `mkdir -p ${quote(installRoot)} ${quote(srcRoot)} ${quote(resolve(projectsRoot, "gateway", "config"))} ${quote(resolve(workRoot, "verdaccio-storage"))}`,
    `printf %s ${quote(encodedGreet)} | base64 -d > ${quote(resolve(srcRoot, "greet.js"))}`,
    `printf %s ${quote(encodedIndex)} | base64 -d > ${quote(resolve(srcRoot, "index.js"))}`,
    `printf %s ${quote(encodedYaml)} | base64 -d > ${quote(deployConfig)}`,
    `printf %s ${quote(encodedVerdaccio)} | base64 -d > ${quote(verdaccioConfigFile)}`,
    `printf '%s\\n' ${quote(`${registryNoScheme}/:_authToken=ua-oss-release`)} > ${quote(npmrcFile)}`,
    // Start Verdaccio detached from the ssh channel: setsid + </dev/null so it
    // never inherits the channel fds. A `;` right after `&` is a bash syntax
    // error, so keep `cmd & VAR=$!` on one segment.
    `setsid npx --yes verdaccio@6 --listen ${env.registryListen} --config ${quote(verdaccioConfigFile)} </dev/null >${quote(verdaccioLog)} 2>&1 & VERDACCIO_PID=$!`,
    // Wait for the registry to accept connections.
    `for i in $(seq 1 30); do if curl -sf -o /dev/null ${env.registry}/-/ping 2>/dev/null || curl -sf -o /dev/null ${env.registry}/ 2>/dev/null; then break; fi; sleep 1; done`,
    // Publish the OSS packages in dependency order.
    ...publishSegments,
    // Standard install from the local registry into a clean prefix.
    `cd ${quote(installRoot)}`,
    "npm init -y >/dev/null 2>&1",
    `npm install @understand-anyway/cli --userconfig ${quote(npmrcFile)} --registry ${env.registry} --no-fund --no-audit`,
    `export PATH=${quote(binDir)}:$PATH`,
    `export UA_PROJECTS_ROOT=${quote(projectsRoot)}`,
    `export UA_PLUGIN_ROOT=${quote(env.pluginRoot)}`,
    // Register the synthetic project, then run the bundled orchestration.
    `understand-anyway init ${quote(srcRoot)} --project oss-release-smoke --repo-path ${quote(srcRoot)}`,
    [
      "understand-anyway ops daily-update",
      "--project oss-release-smoke",
      "--deploy-profile ppe",
      "--llm-profile traex",
      `--host ${quote(env.host)}`,
      "--port 18690",
      "--no-self-update",
      `--plugin-root ${quote(env.pluginRoot)}`,
    ].join(" "),
    // Deploy succeeded. Leave the (detached) dashboard + verdaccio running and
    // exit cleanly — a separate teardown ssh session tears them down. Stopping
    // this session's own dashboard daemon here would half-close the ssh channel
    // and surface as a spurious 255.
    "echo '[ppe-oss-release] deploy ok'",
    "exit 0",
  ].join("; ");
}

// Independent teardown for ppe-oss-release, run in its own ssh session. The
// deploy session must NOT stop the dashboard daemon it spawned (that tears down
// the channel as 255); here the dashboard is not our descendant, so stopping it
// plus verdaccio and removing the workRoot all close cleanly.
function buildOssReleaseTeardownCommand(env, workRoot) {
  const projectsRoot = resolve(workRoot, "projects-root");
  const registryPort = env.registryListen.split(":").pop();
  const binDir = resolve(workRoot, "install", "node_modules", ".bin");
  return [
    `export PATH=${quote(binDir)}:$PATH`,
    `understand-anyway gateway stop --projects-root ${quote(projectsRoot)} 2>/dev/null || true`,
    `VERDACCIO_REAL_PID="$(ss -ltnp 2>/dev/null | grep ':${registryPort}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"`,
    `[ -n "$VERDACCIO_REAL_PID" ] && kill $VERDACCIO_REAL_PID 2>/dev/null || true`,
    `for i in $(seq 1 15); do curl -sf -o /dev/null ${env.registry}/-/ping 2>/dev/null || break; sleep 1; done`,
    `rm -rf ${quote(workRoot)}`,
    "echo '[ppe-oss-release] teardown ok'",
    "exit 0",
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
    case "ppe-oss-release":
      return buildOssReleaseCommand(env, OSS_RELEASE_WORKROOT);
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

// Independent teardown ssh for ppe-oss-release. Best-effort: the dashboard
// daemon and verdaccio here are not descendants of this session, so stopping
// them closes cleanly (unlike doing it inside the deploy session).
export function buildOssReleaseTeardownSshCommand(env) {
  const remote = buildOssReleaseTeardownCommand(env, OSS_RELEASE_WORKROOT);
  return ["ssh", "-n", "-o", "BatchMode=yes", `${env.user}@${env.host}`, remote];
}

// For ppe-oss-release: build + pack the OSS packages locally and scp the
// tarballs to the PPE staging dir. The remote command then publishes them into
// a session-local Verdaccio. Kept here (not in the remote string) so the heavy
// lifting runs on the controller, not inside the ssh channel.
function prepareOssReleaseArtifacts(env) {
  const localTmp = resolve(REPO_ROOT, ".release-gate", "verdaccio-tarballs");
  mkdirSync(localTmp, { recursive: true });
  run("pnpm", ["-r", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  for (const pkg of PKG_DIRS) {
    // pnpm pack (not npm pack) rewrites the `workspace:*` dependency protocol
    // into concrete versions; npm pack leaves `workspace:` in place, which the
    // registry publish then rejects with EUNSUPPORTEDPROTOCOL.
    run("pnpm", ["pack", "--pack-destination", localTmp], {
      cwd: resolve(REPO_ROOT, "packages", pkg),
      stdio: "inherit",
    });
  }
  run("ssh", ["-n", "-o", "BatchMode=yes", `${env.user}@${env.host}`, `mkdir -p ${quote(env.tarballDir)}`], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  // Resolve the packed tarball for each package (name is
  // understand-anyway-<pkg>-<version>.tgz) and scp with explicit paths — no
  // shell globbing, so quoting stays safe.
  const staged = readdirSync(localTmp).filter((f) => f.endsWith(".tgz"));
  for (const pkg of PKG_DIRS) {
    const file = staged.find((f) => f.startsWith(`understand-anyway-${pkg}-`));
    if (!file) throw new Error(`packed tarball not found for ${pkg} in ${localTmp}`);
    run("scp", [resolve(localTmp, file), `${env.user}@${env.host}:${env.tarballDir}/`], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
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
  if (args.caseName === "ppe-oss-release") {
    prepareOssReleaseArtifacts(env);
    try {
      run(sshCmd, sshArgs, { cwd: REPO_ROOT, stdio: "inherit" });
    } finally {
      // Always tear down in a separate ssh session so the deploy verdict is not
      // masked and the PPE host is left clean (dashboard + verdaccio stopped,
      // workRoot removed). Best-effort — never let teardown mask the deploy.
      const [tCmd, ...tArgs] = buildOssReleaseTeardownSshCommand(env);
      const res = runCapture(tCmd, tArgs, { cwd: REPO_ROOT });
      process.stdout.write(res.stdout || "");
      if (res.status !== 0) {
        process.stderr.write(`[release-gate-ppe] teardown exited ${res.status}${res.stderr ? `: ${res.stderr}` : ""}\n`);
      }
    }
    return;
  }
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
