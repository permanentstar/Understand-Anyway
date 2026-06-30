#!/usr/bin/env node
// scripts/__tests__/refresh-prod-server.test.mjs
//
// Black-box tests for scripts/refresh-prod-server.sh using a fake
// `understand-anyway` shim on PATH that records argv to a log file.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "refresh-prod-server.sh");

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
  return mkdtempSync(resolve(tmpdir(), "ua-d4-refresh-"));
}

function setupFakeBin(workDir, behavior = "exit-0") {
  const binDir = resolve(workDir, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const logPath = resolve(workDir, "shim.log");
  const fail = behavior === "exit-1";
  const shim = `#!/usr/bin/env bash
{ printf '%s\\n' "$*"; } >> "${logPath}"
${fail ? "exit 1" : "exit 0"}
`;
  const shimPath = resolve(binDir, "understand-anyway");
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { binDir, logPath };
}

function setupProjects(projectsRoot, projects) {
  const cfgDir = resolve(projectsRoot, "gateway", "config");
  mkdirSync(cfgDir, { recursive: true });
  const repoBase = resolve(projectsRoot, "src");
  mkdirSync(repoBase, { recursive: true });
  const cfgProjects = projects.map((p) => ({
    projectId: p.id,
    repoPath: `\${projectBaseDir}/${p.id}`,
  }));
  writeFileSync(
    resolve(cfgDir, "projects.json"),
    JSON.stringify({ projectBaseDir: "src", projects: cfgProjects }),
  );
  for (const p of projects) {
    mkdirSync(resolve(repoBase, p.id), { recursive: true });
    const stateDir = resolve(projectsRoot, "projects", p.id);
    mkdirSync(resolve(stateDir, ".understand-anything"), { recursive: true });
    if (p.nightlyLatest) {
      writeFileSync(
        resolve(stateDir, ".understand-anything", "nightly-latest.json"),
        JSON.stringify(p.nightlyLatest),
      );
    }
  }
}

function runScript(args, env) {
  // Tests default UA_DEPLOY_PROFILE to "ppe" when not explicitly set so the
  // script does not exit 2 on missing profile. Tests that intentionally probe
  // the missing/invalid-profile path pass UA_DEPLOY_PROFILE="" explicitly.
  const effectiveEnv =
    "UA_DEPLOY_PROFILE" in env ? env : { ...env, UA_DEPLOY_PROFILE: "ppe" };
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: effectiveEnv });
}

// --- Test 1: success project builds dist, writes registry, and starts one shared gateway ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    setupProjects(projectsRoot, [
      { id: "alpha", nightlyLatest: { overallStatus: "success", build: { status: "success" } } },
      { id: "beta", nightlyLatest: { overallStatus: "failed", build: { status: "failed" } } },
    ]);
    writeFileSync(
      resolve(projectsRoot, "gateway", "registry.json"),
      JSON.stringify({
        version: 2,
        updatedAt: null,
        projects: {
          stale: {
            id: "stale",
            name: "Stale",
            projectRoot: "",
            stateRoot: "",
            accessUrl: "",
            dashboardUrl: "",
            internalUrl: "",
            publicPath: "/project/stale/",
            runtimeMode: "prod",
            prodDistDir: "",
            prodToken: "",
            status: "running",
          },
        },
      }),
      "utf8",
    );

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(
      ["--host", "0.0.0.0", "--port", "12345", "--plugin-root", "/tmp/plugin"],
      env,
    );
    check("success: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const lines = log.split("\n").filter(Boolean);
    check(
      "success: build-dist then shared stop/start",
      lines.length === 3,
      `lines=\n${log}`,
    );
    check(
      "success: first invocation builds alpha dashboard-dist",
      lines[0]?.startsWith("dashboard build-dist"),
      lines[0],
    );
    check(
      "success: second invocation stops shared gateway",
      lines[1]?.startsWith("gateway stop") && lines[1]?.includes(`--projects-root ${projectsRoot}`),
      lines[1],
    );
    check(
      "success: third invocation starts shared gateway",
      lines[2]?.startsWith("gateway start") && lines[2]?.includes(`--projects-root ${projectsRoot}`),
      lines[2],
    );
    check(
      "success: build-dist forwards alpha project + plugin-root + rebuild",
      lines[0]?.includes("--project alpha")
        && lines[0]?.includes("--plugin-root /tmp/plugin")
        && lines[0]?.includes("--rebuild-dashboard"),
      lines[0],
    );
    check(
      "success: shared gateway forwards host/port without state-dir",
      lines[2]?.includes("--host 0.0.0.0")
        && lines[2]?.includes("--port 12345")
        && !lines[2]?.includes("--state-dir"),
      lines[2],
    );
    check(
      "success: stdout reports refreshed=1",
      result.stdout.includes("refreshed=1"),
      result.stdout,
    );
    check(
      "success: stdout reports skipped=1",
      result.stdout.includes("skipped=1"),
      result.stdout,
    );
    const registry = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "registry.json"), "utf8"));
    check(
      "success: registry contains alpha prod runtime",
      registry?.projects?.alpha?.runtimeMode === "prod"
        && registry?.projects?.alpha?.prodDistDir === resolve(projectsRoot, "projects", "alpha", "dashboard-dist"),
      JSON.stringify(registry),
    );
    check(
      "success: registry prunes projects removed from discovery",
      !registry?.projects?.stale,
      JSON.stringify(registry),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1a: multiple success projects build per-project dist but start one shared gateway ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    setupProjects(projectsRoot, [
      { id: "alpha", nightlyLatest: { overallStatus: "success", build: { status: "success" } } },
      { id: "beta", nightlyLatest: { overallStatus: "success", build: { status: "success" } } },
    ]);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(
      ["--host", "0.0.0.0", "--port", "12345", "--plugin-root", "/tmp/plugin"],
      env,
    );
    check("shared-gateway: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const lines = log.split("\n").filter(Boolean);
    const buildDistLines = lines.filter((line) => line.startsWith("dashboard build-dist"));
    const startLines = lines.filter((line) => line.startsWith("gateway start"));
    const stopLines = lines.filter((line) => line.startsWith("gateway stop"));

    check(
      "shared-gateway: builds alpha and beta dashboard-dist",
      buildDistLines.length === 2
        && buildDistLines.some((line) => line.includes("--project alpha"))
        && buildDistLines.some((line) => line.includes("--project beta")),
      log,
    );
    check(
      "shared-gateway: only one shared gateway start",
      startLines.length === 1 && startLines[0]?.includes(`--projects-root ${projectsRoot}`),
      log,
    );
    check(
      "shared-gateway: shared gateway stop/start on the shared state root",
      stopLines.length === 1 && stopLines[0]?.includes(`--projects-root ${projectsRoot}`),
      log,
    );
    check(
      "shared-gateway: shared gateway hides portal/project-route registry internals",
      startLines[0]?.includes(`--projects-root ${projectsRoot}`)
        && !startLines[0]?.includes("--state-dir")
        && !startLines[0]?.includes("--registry")
        && !startLines[0]?.includes("--portal"),
      startLines[0],
    );

    const registryPath = resolve(projectsRoot, "gateway", "registry.json");
    let registry = null;
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf8"));
    } catch (error) {
      registry = { error: String(error) };
    }
    check(
      "shared-gateway: registry contains alpha prod record",
      registry?.projects?.alpha?.runtimeMode === "prod"
        && registry?.projects?.alpha?.publicPath === "/project/alpha/"
        && registry?.projects?.alpha?.prodDistDir === resolve(projectsRoot, "projects", "alpha", "dashboard-dist"),
      JSON.stringify(registry),
    );
    check(
      "shared-gateway: registry contains beta prod record",
      registry?.projects?.beta?.runtimeMode === "prod"
        && registry?.projects?.beta?.publicPath === "/project/beta/"
        && registry?.projects?.beta?.prodDistDir === resolve(projectsRoot, "projects", "beta", "dashboard-dist"),
      JSON.stringify(registry),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1aa: shared gateway uses runtime/current release CLI when present ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    setupProjects(projectsRoot, [
      { id: "alpha", nightlyLatest: { overallStatus: "success", build: { status: "success" } } },
    ]);
    const currentCli = resolve(projectsRoot, "gateway", "runtime", "current", "dist", "cli.js");
    mkdirSync(resolve(currentCli, ".."), { recursive: true });
    writeFileSync(
      currentCli,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "release-cli " + process.argv.slice(2).join(" ") + "\\n");
`,
      "utf8",
    );

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(
      ["--host", "0.0.0.0", "--port", "12345", "--plugin-root", "/tmp/plugin"],
      env,
    );
    check("release-cli: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check(
      "release-cli: shared gateway start uses runtime/current cli",
      log.includes(`release-cli gateway start --projects-root ${projectsRoot}`),
      log,
    );
    check(
      "release-cli: shared gateway stop uses runtime/current cli",
      log.includes(`release-cli gateway stop --projects-root ${projectsRoot}`),
      log,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1ab: zero refreshed projects still restart the shared gateway ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    setupProjects(projectsRoot, [
      { id: "alpha", nightlyLatest: { overallStatus: "failed", build: { status: "failed" } } },
    ]);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--host", "0.0.0.0", "--port", "12345"], env);
    check("zero-refresh: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const lines = log.split("\n").filter(Boolean);
    check(
      "zero-refresh: shared gateway still stop/starts",
      lines.length === 2
        && lines[0]?.startsWith("gateway stop")
        && lines[1]?.startsWith("gateway start"),
      log,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1b: --deploy-profile dev is rejected for prod refresh ---
{
  const work = makeTmp();
  try {
    const env = { ...process.env, HOME: work };
    const result = runScript(["--deploy-profile", "dev"], env);
    check("deploy-profile dev: exit 2", result.status === 2, `status=${result.status}\n${result.stderr}`);
    check(
      "deploy-profile dev: stderr explains rejection",
      result.stderr.includes("dev deploy profile is not allowed"),
      result.stderr,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1c: auto profile is no longer supported ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work);
    setupProjects(projectsRoot, [{ id: "p1" }]);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--deploy-profile", "auto"], env);
    check("auto rejected: exit 2", result.status === 2, `status=${result.status}\n${result.stderr}`);
    check(
      "auto rejected: stderr mentions prod|ppe|dev",
      result.stderr.includes("expected prod|ppe|dev"),
      result.stderr,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1d: deploy profile defaults to UA_DEPLOY_PROFILE env ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work);
    setupProjects(projectsRoot, [
      { id: "envppe", nightlyLatest: { overallStatus: "success", build: { status: "success" } } },
    ]);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      UA_DEPLOY_PROFILE: "ppe",
      HOME: work,
    };
    const result = runScript(["--dry-run", "--plugin-root", "/p"], env);
    check("env profile: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    check(
      "env profile: deploy_profile=ppe",
      result.stdout.includes("deploy_profile=ppe"),
      result.stdout,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1e: deploy profile missing entirely → exit 2 ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work);
    setupProjects(projectsRoot, [{ id: "p1" }]);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      UA_DEPLOY_PROFILE: "",
      HOME: work,
    };
    const result = runScript([], env);
    check(
      "missing profile: exit 2",
      result.status === 2,
      `status=${result.status}\n${result.stderr}`,
    );
    check(
      "missing profile: stderr mentions UA_DEPLOY_PROFILE",
      result.stderr.includes("UA_DEPLOY_PROFILE"),
      result.stderr,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3 removed: --rebuild-project / --rebuild-all are gone. Run
// `understand-anyway dashboard build-dist --project <id>` directly to
// recover an out-of-band project before invoking this script.

// --- Test 4: dry-run prints commands without spawning understand-anyway ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    setupProjects(projectsRoot, [
      { id: "drya", nightlyLatest: { overallStatus: "success", build: { status: "success" } } },
    ]);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(
      ["--dry-run", "--host", "h", "--port", "1", "--plugin-root", "/p"],
      env,
    );
    check("dryrun: exit 0", result.status === 0, result.stderr);
    check(
      "dryrun: stdout has [dry-run] prefix",
      result.stdout.includes("[dry-run]"),
      result.stdout,
    );
    const logExists = existsSync(logPath);
    check("dryrun: shim NOT invoked", !logExists, logExists ? readFileSync(logPath, "utf8") : "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 5: --help works and exits 0 ---
{
  const work = makeTmp();
  try {
    const env = { ...process.env, HOME: work };
    const result = runScript(["--help"], env);
    check("help: exit 0", result.status === 0, result.stderr);
    check(
      "help: prints usage",
      result.stdout.includes("Usage:"),
      result.stdout.slice(0, 200),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 6: shim failure → failed counter > 0 ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work, "exit-1");
    setupProjects(projectsRoot, [
      { id: "fail", nightlyLatest: { overallStatus: "success", build: { status: "success" } } },
    ]);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(
      ["--host", "h", "--port", "1", "--plugin-root", "/p"],
      env,
    );
    check("failure: exit 1", result.status === 1, `status=${result.status}`);
    check(
      "failure: stdout reports project and gateway failures",
      result.stdout.includes("failed=2"),
      result.stdout,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 6a: project discovery failure must not prune existing registry records ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work);
    mkdirSync(resolve(projectsRoot, "gateway", "config"), { recursive: true });
    writeFileSync(resolve(projectsRoot, "gateway", "config", "projects.json"), "{ bad json", "utf8");
    writeFileSync(
      resolve(projectsRoot, "gateway", "registry.json"),
      JSON.stringify({
        version: 2,
        updatedAt: null,
        projects: {
          keep: {
            id: "keep",
            name: "Keep",
            projectRoot: "/repo/keep",
            stateRoot: "/state/keep",
            accessUrl: "http://127.0.0.1:1/project/keep/",
            dashboardUrl: "http://127.0.0.1:1/project/keep/",
            internalUrl: "",
            publicPath: "/project/keep/",
            runtimeMode: "prod",
            prodDistDir: "/state/keep/dashboard-dist",
            prodToken: "tok",
            status: "running",
          },
        },
      }),
      "utf8",
    );

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--host", "127.0.0.1", "--port", "1"], env);
    check("discover-fail: exit 1", result.status === 1, `${result.status}\n${result.stderr}\n${result.stdout}`);
    const registry = JSON.parse(readFileSync(resolve(projectsRoot, "gateway", "registry.json"), "utf8"));
    check("discover-fail: registry still keeps existing records", Boolean(registry.projects?.keep), JSON.stringify(registry));
    check("discover-fail: stderr mentions projects parse failure", result.stderr.includes("failed to parse"), result.stderr);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 7 removed: --print-deploy-context flag is gone. Inspect
// $UA_DEPLOY_PROFILE / $UA_PROJECTS_ROOT directly when debugging.

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall tests passed\n");
