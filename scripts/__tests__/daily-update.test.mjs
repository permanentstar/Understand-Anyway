#!/usr/bin/env node
// scripts/__tests__/daily-update.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "daily-update.sh");
const NODE_BIN_DIR = dirname(process.execPath);

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
  return mkdtempSync(resolve(tmpdir(), "ua-d4-daily-"));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupWork(path) {
  const retryable = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      if (!retryable.has(error?.code) || attempt === 19) throw error;
      sleep(100 + attempt * 50);
    }
  }
}

// Replace nightly/refresh sub-scripts inside an isolated scripts/ copy with
// shims that record argv to a log file. daily-update.sh resolves siblings via
// SCRIPT_DIR/.. so we mirror real layout.
function setupSandbox(work, opts = {}) {
  const isolatedRoot = resolve(work, "ua");
  const isolatedScripts = resolve(isolatedRoot, "scripts");
  const isolatedLib = resolve(isolatedScripts, "lib");
  mkdirSync(isolatedLib, { recursive: true });
  cpSync(resolve(REPO_ROOT, "scripts", "lib"), isolatedLib, { recursive: true });
  cpSync(SCRIPT, resolve(isolatedScripts, "daily-update.sh"));
  cpSync(resolve(REPO_ROOT, "scripts", "aggregate-daily.mjs"), resolve(isolatedScripts, "aggregate-daily.mjs"));
  chmodSync(resolve(isolatedScripts, "daily-update.sh"), 0o755);
  chmodSync(resolve(isolatedScripts, "aggregate-daily.mjs"), 0o755);

  const nightlyLog = resolve(work, "nightly.log");
  const refreshLog = resolve(work, "refresh.log");
  const nightlyShim = `#!/usr/bin/env bash
{ printf '%s\\n' "$*"; } >> "${nightlyLog}"
${opts.nightlyExit === 1 ? "exit 1" : "exit 0"}
`;
  const refreshShim = `#!/usr/bin/env bash
{ printf '%s\\n' "$*"; } >> "${refreshLog}"
${opts.refreshExit === 1 ? "exit 1" : "exit 0"}
`;
  writeFileSync(resolve(isolatedScripts, "nightly-project-sync.sh"), nightlyShim);
  writeFileSync(resolve(isolatedScripts, "refresh-prod-server.sh"), refreshShim);
  chmodSync(resolve(isolatedScripts, "nightly-project-sync.sh"), 0o755);
  chmodSync(resolve(isolatedScripts, "refresh-prod-server.sh"), 0o755);

  // Init isolatedRoot as a git repo so self-update has something to pull.
  spawnSync("git", ["init", "-q"], { cwd: isolatedRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: isolatedRoot });
  spawnSync("git", ["config", "user.name", "test"], { cwd: isolatedRoot });
  writeFileSync(resolve(isolatedRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true" } }));
  spawnSync("git", ["add", "-A"], { cwd: isolatedRoot });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: isolatedRoot });

  return {
    scriptPath: resolve(isolatedScripts, "daily-update.sh"),
    nightlyLog,
    refreshLog,
    isolatedRoot,
  };
}

function setupFakeBin(workDir) {
  const binDir = resolve(workDir, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const logPath = resolve(workDir, "shim.log");
  // pnpm shim — answers `install` and `build` with no-op. understand-anyway
  // shim is not used by daily-update directly (it delegates to sub-scripts).
  const pnpmShim = `#!/usr/bin/env bash
{ printf 'pnpm %s\\n' "$*"; } >> "${logPath}"
exit 0
`;
  const uaShim = `#!/usr/bin/env bash
{ printf 'ua %s\\n' "$*"; } >> "${logPath}"
# Mock 'gateway list --json' to return a configurable payload.
if [[ "$1" == "gateway" && "$2" == "list" ]]; then
  cat "${workDir}/gateway-list.json" 2>/dev/null || printf '[]'
fi
exit 0
`;
  writeFileSync(resolve(binDir, "pnpm"), pnpmShim);
  writeFileSync(resolve(binDir, "understand-anyway"), uaShim);
  chmodSync(resolve(binDir, "pnpm"), 0o755);
  chmodSync(resolve(binDir, "understand-anyway"), 0o755);
  return { binDir, logPath };
}

function setupLocalCli(isolatedRoot, logPath, gatewayListPath) {
  const cliPath = resolve(isolatedRoot, "packages", "cli", "dist", "cli.js");
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "local-cli " + process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "gateway" && process.argv[3] === "list") {
  try { process.stdout.write(fs.readFileSync(${JSON.stringify(gatewayListPath)}, "utf8")); }
  catch { process.stdout.write("[]"); }
}
`,
  );
  chmodSync(cliPath, 0o755);
}

function runScript(scriptPath, args, env) {
  const effectiveEnv =
    "UA_DEPLOY_PROFILE" in env ? env : { ...env, UA_DEPLOY_PROFILE: "ppe" };
  return spawnSync("bash", [scriptPath, ...args], { encoding: "utf8", env: effectiveEnv });
}

// --- Test 1: default flow runs nightly then refresh ---
{
  const work = makeTmp();
  try {
    const { scriptPath, nightlyLog, refreshLog } = setupSandbox(work);
    const { binDir } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    const result = runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    check("default: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    check("default: nightly invoked", existsSync(nightlyLog) && readFileSync(nightlyLog, "utf8").length > 0, "nightly log empty");
    check("default: refresh invoked", existsSync(refreshLog) && readFileSync(refreshLog, "utf8").length > 0, "refresh log empty");
    if (existsSync(refreshLog)) {
      const log = readFileSync(refreshLog, "utf8");
      check("default: refresh got --host h --port 1", log.includes("--host h") && log.includes("--port 1"), log);
    }
  } finally {
    cleanupWork(work);
  }
}

// --- Test 1a: repo-checkout fallback uses packages/cli/dist/cli.js when no global command exists ---
{
  const work = makeTmp();
  try {
    const { scriptPath, isolatedRoot } = setupSandbox(work);
    const binDir = resolve(work, "fakebin-no-ua");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(resolve(binDir, "pnpm"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(resolve(binDir, "pnpm"), 0o755);
    const logPath = resolve(work, "local-cli.log");
    const gatewayListPath = resolve(work, "gateway-list.json");
    writeFileSync(gatewayListPath, JSON.stringify([]));
    setupLocalCli(isolatedRoot, logPath, gatewayListPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${NODE_BIN_DIR}:/usr/bin:/bin`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    const result = runScript(scriptPath, ["--no-self-update", "--dry-run"], env);
    check("local-cli-fallback: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("local-cli-fallback: gateway list used local cli", log.includes("local-cli gateway list --json"), log);
  } finally {
    cleanupWork(work);
  }
}

// --- Test 1b: refresh inherits plugin root resolved from UA_PLUGIN_ROOT env ---
{
  const work = makeTmp();
  try {
    const { scriptPath, refreshLog } = setupSandbox(work);
    const { binDir } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      UA_PLUGIN_ROOT: "/tmp/fake-plugin-root",
      HOME: work,
    };
    const result = runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    check("plugin-root-env: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(refreshLog) ? readFileSync(refreshLog, "utf8") : "";
    check("plugin-root-env: refresh got --plugin-root from env", log.includes("--plugin-root /tmp/fake-plugin-root"), log);
  } finally {
    cleanupWork(work);
  }
}

// --- Test 2: --no-self-update skips git pull / pnpm ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const { binDir, logPath } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("no-self-update: pnpm install NOT invoked", !log.includes("pnpm install"), log);
    check("no-self-update: pnpm build NOT invoked", !log.includes("pnpm build"), log);
  } finally {
    cleanupWork(work);
  }
}

// --- Test 3: nightly fails but refresh still runs ---
{
  const work = makeTmp();
  try {
    const { scriptPath, refreshLog } = setupSandbox(work, { nightlyExit: 1 });
    const { binDir } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    const result = runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    // exit code: nightly failed → final exit non-zero
    check("nightly-fail: exit non-zero", result.status !== 0, `status=${result.status}`);
    check("nightly-fail: refresh STILL invoked", existsSync(refreshLog) && readFileSync(refreshLog, "utf8").length > 0, "refresh log empty");
  } finally {
    cleanupWork(work);
  }
}

// --- Test 4: gateway publish triggered when no current release ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const { binDir, logPath } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("publish: gateway publish invoked", log.includes("ua gateway publish"), log);
  } finally {
    cleanupWork(work);
  }
}

// --- Test 4a: gateway publish skipped when current release already exists ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const { binDir, logPath } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    const result = runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("publish-skip: gateway publish not invoked", !log.includes("ua gateway publish"), log);
    check(
      "publish-skip: stdout explains no runtime change",
      result.stdout.includes("gateway publish skipped: no runtime change detected"),
      result.stdout,
    );
    const latestPath = resolve(work, "projects", "gateway", "operations", "daily-latest.json");
    const latest = JSON.parse(readFileSync(latestPath, "utf8"));
    check(
      "publish-skip: daily aggregate remains success",
      latest.overallStatus === "success" && latest.gateway?.published === "skipped",
      JSON.stringify(latest),
    );
  } finally {
    cleanupWork(work);
  }
}

// --- Test 4b: gateway publish triggered when upstream plugin version drifted ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const { binDir, logPath } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));

    const projectsRoot = resolve(work, "projects");
    const releaseDir = resolve(projectsRoot, "gateway", "runtime", "releases", "v1");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(resolve(releaseDir, "manifest.json"), JSON.stringify({ upstreamVersion: "1.2.3" }));

    const pluginRoot = resolve(work, "plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(resolve(pluginRoot, "package.json"), JSON.stringify({ version: "2.0.0" }));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(scriptPath, ["--no-self-update", "--plugin-root", pluginRoot], env);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("publish-drift: gateway publish invoked", log.includes("ua gateway publish"), log);
    check(
      "publish-drift: stdout explains drift reason",
      result.stdout.includes("upstream plugin version drifted 1.2.3->2.0.0"),
      result.stdout,
    );
  } finally {
    cleanupWork(work);
  }
}

// --- Test 4c: gateway publish forwards plugin root resolved from UA_PLUGIN_ROOT env ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const { binDir, logPath } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([]));

    const pluginRoot = resolve(work, "plugin-from-env");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(resolve(pluginRoot, "package.json"), JSON.stringify({ version: "3.0.0" }));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      UA_PLUGIN_ROOT: pluginRoot,
      HOME: work,
    };
    runScript(scriptPath, ["--no-self-update"], env);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check(
      "publish-env-plugin-root: gateway publish receives --plugin-root from env",
      log.includes(`ua gateway publish --plugin-root ${pluginRoot}`),
      log,
    );
  } finally {
    cleanupWork(work);
  }
}

// --- Test 5: --help works ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const env = { ...process.env, HOME: work };
    const result = runScript(scriptPath, ["--help"], env);
    check("help: exit 0", result.status === 0);
    check("help: prints usage", result.stdout.includes("Usage:"));
  } finally {
    cleanupWork(work);
  }
}

// --- Test 6: --dry-run propagated to subcommands ---
{
  const work = makeTmp();
  try {
    const { scriptPath, nightlyLog, refreshLog } = setupSandbox(work);
    const { binDir } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    runScript(scriptPath, ["--no-self-update", "--dry-run", "--host", "h", "--port", "1"], env);
    const nightly = existsSync(nightlyLog) ? readFileSync(nightlyLog, "utf8") : "";
    const refresh = existsSync(refreshLog) ? readFileSync(refreshLog, "utf8") : "";
    check("dryrun: --dry-run forwarded to nightly", nightly.includes("--dry-run"), nightly);
    check("dryrun: --dry-run forwarded to refresh", refresh.includes("--dry-run"), refresh);
  } finally {
    cleanupWork(work);
  }
}

// --- Test 7: notify nightly invoked when aggregate/nightly-latest.json exists ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const { binDir, logPath } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));
    const projectsRoot = resolve(work, "projects");
    mkdirSync(resolve(projectsRoot, "gateway", "operations"), { recursive: true });
    const reportPath = resolve(projectsRoot, "gateway", "operations", "nightly-latest.json");
    writeFileSync(reportPath, "{}");

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check(
      "notify: nightly invoked with --report and --best-effort",
      log.includes("ua notify nightly --report") && log.includes("--best-effort"),
      log,
    );
  } finally {
    cleanupWork(work);
  }
}

// --- Test 8: notify skipped when nightly-latest.json missing ---
{
  const work = makeTmp();
  try {
    const { scriptPath } = setupSandbox(work);
    const { binDir, logPath } = setupFakeBin(work);
    writeFileSync(resolve(work, "gateway-list.json"), JSON.stringify([{ versionId: "v1", current: true, stable: true }]));

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: resolve(work, "projects"),
      HOME: work,
    };
    const result = runScript(scriptPath, ["--no-self-update", "--host", "h", "--port", "1"], env);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("notify-skip: notify nightly NOT invoked", !log.includes("ua notify nightly"), log);
    check(
      "notify-skip: skip message printed",
      result.stdout.includes("notify nightly skipped"),
      result.stdout,
    );
  } finally {
    cleanupWork(work);
  }
}

// --- Test 9 removed: LLM flags are no longer CLI surface; they live in
// deploy.yaml under profiles.<name>.build.llm* and providers.llm. The CLI
// surface kept is just --profile.

// --- Test 10 removed: --print-deploy-context is gone. Inspect
// $UA_DEPLOY_PROFILE / $UA_PROJECTS_ROOT directly when debugging.

// --- Test 11 removed: record sinks (provider/sheet/worksheets) are
// configured in deploy.yaml under record.*.

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall tests passed\n");
