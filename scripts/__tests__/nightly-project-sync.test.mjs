#!/usr/bin/env node
// scripts/__tests__/nightly-project-sync.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "nightly-project-sync.sh");

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
  return mkdtempSync(resolve(tmpdir(), "ua-d4-nightly-"));
}

function setupFakeBin(workDir, gateOpts = {}) {
  const binDir = resolve(workDir, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const logPath = resolve(workDir, "shim.log");
  const approved = gateOpts.approved === false ? "false" : "true";
  const failed = gateOpts.failed === true ? "true" : "false";
  const shim = `#!/usr/bin/env bash
{ printf '%s\\n' "$*"; } >> "${logPath}"
if [[ "$1" == "review-graph-health" ]]; then
  output=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ "${failed}" == "true" ]]; then
    exit 7
  fi
  if [[ "${approved}" == "true" ]]; then
    printf '%s' '{"approved":true,"issues":[],"warnings":[],"stats":{"source":"fake"}}' > "$output"
    exit 0
  else
    printf '%s' '{"approved":false,"issues":["fake-issue"],"warnings":[],"stats":{"source":"fake"}}' > "$output"
    exit 1
  fi
fi
exit 0
`;
  const shimPath = resolve(binDir, "understand-anyway");
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { binDir, logPath };
}

function gitInit(repoDir) {
  spawnSync("git", ["init", "-q"], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: repoDir });
  writeFileSync(resolve(repoDir, "README.md"), "x");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
}

function setupOneProject(projectsRoot) {
  const cfgDir = resolve(projectsRoot, "gateway", "config");
  mkdirSync(cfgDir, { recursive: true });
  const repoBase = resolve(projectsRoot, "src");
  mkdirSync(repoBase, { recursive: true });
  const repoDir = resolve(repoBase, "alpha");
  mkdirSync(repoDir, { recursive: true });
  gitInit(repoDir);
  writeFileSync(
    resolve(cfgDir, "projects.json"),
    JSON.stringify({
      projectBaseDir: "src",
      projects: [{ projectId: "alpha", repoPath: "${projectBaseDir}/alpha" }],
    }),
  );
  return { repoDir, stateDir: resolve(projectsRoot, "projects", "alpha") };
}

function runScript(args, env) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
}

// --- Test 1: first run invokes build, writes nightly-latest.json ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    const { stateDir } = setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--no-pull"], env);
    check("first: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check("first: build invoked with --project", log.includes("build --project alpha"), log);
    check("first: --incremental flag", log.includes("--incremental"), log);
    check("first: --exclude-tests flag", log.includes("--exclude-tests"), log);
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    check("first: nightly-latest.json exists", existsSync(nightlyLatest), nightlyLatest);
    if (existsSync(nightlyLatest)) {
      const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
      check("first: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
      check("first: build.status=success", payload.build?.status === "success", JSON.stringify(payload));
      check("first: gate.approved=true", payload.gate?.approved === true, JSON.stringify(payload));
      check("first: review.status=approved", payload.review?.status === "approved", JSON.stringify(payload));
      check("first: review.commandConfigured=false", payload.review?.commandConfigured === false, JSON.stringify(payload));
      check("first: gate.criticalCount=0", payload.gate?.criticalCount === 0, JSON.stringify(payload));
      check("first: needsManualIntervention=false", payload.needsManualIntervention === false, JSON.stringify(payload));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 2: second run with same commit + previous success → skipped ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    runScript(["--no-pull"], env);
    const firstLog = readFileSync(logPath, "utf8");
    const result = runScript(["--no-pull"], env);
    check("second: exit 0", result.status === 0, result.stderr);
    const secondLog = readFileSync(logPath, "utf8");
    check(
      "second: build NOT re-invoked (commit gate)",
      firstLog === secondLog,
      `before:\n${firstLog}\nafter:\n${secondLog}`,
    );
    check(
      "second: stdout reports skipped",
      result.stdout.includes("skipped"),
      result.stdout,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3: commit changed → build rerun ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    const { repoDir } = setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    runScript(["--no-pull"], env);
    const firstLines = readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;

    // Make a new commit.
    writeFileSync(resolve(repoDir, "B.md"), "y");
    spawnSync("git", ["add", "-A"], { cwd: repoDir });
    spawnSync("git", ["commit", "-q", "-m", "second"], { cwd: repoDir });

    runScript(["--no-pull"], env);
    const secondLines = readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
    check(
      "commit-changed: build re-invoked",
      secondLines === firstLines + 3,
      `before=${firstLines} after=${secondLines}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 4 removed: --review-cmd is gone. External review hooks must
// integrate via `understand-anyway review-graph-health` adapters.

// --- Test 5: aggregate result.json written under projectsRoot/gateway/operations ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work);
    setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    runScript(["--no-pull"], env);
    const aggLatest = resolve(projectsRoot, "gateway", "operations", "nightly-latest.json");
    check("agg: latest written", existsSync(aggLatest), aggLatest);
    if (existsSync(aggLatest)) {
      const payload = JSON.parse(readFileSync(aggLatest, "utf8"));
      check("agg: projectCount=1", payload.projectCount === 1, JSON.stringify(payload));
      check("agg: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 6: --help works ---
{
  const work = makeTmp();
  try {
    const env = { ...process.env, HOME: work };
    const result = runScript(["--help"], env);
    check("help: exit 0", result.status === 0);
    check("help: prints usage", result.stdout.includes("Usage:"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 7: default gate spawns `review-graph-health` and approves ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    const { stateDir } = setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--no-pull"], env);
    check("default-gate: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = readFileSync(logPath, "utf8");
    check("default-gate: review-graph-health invoked", log.includes("review-graph-health"), log);
    check("default-gate: --project flag forwarded", log.includes("review-graph-health --project alpha"), log);
    check("default-gate: --output flag forwarded", log.includes("--output"), log);
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
    check("default-gate: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
    check("default-gate: gate.approved=true", payload.gate?.approved === true, JSON.stringify(payload));
    check("default-gate: stats from review-graph-health", payload.gate?.stats?.source === "fake", JSON.stringify(payload.gate));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 8: default gate rejects → overallStatus=failed, exit 1 ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work, { approved: false });
    const { stateDir } = setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--no-pull"], env);
    check("default-gate-rejected: exit 1", result.status === 1, `status=${result.status}`);
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
    check("default-gate-rejected: overallStatus=failed", payload.overallStatus === "failed", JSON.stringify(payload));
    check("default-gate-rejected: gate.approved=false", payload.gate?.approved === false, JSON.stringify(payload));
    check(
      "default-gate-rejected: gate.issues forwarded",
      Array.isArray(payload.gate?.issues) && payload.gate.issues.includes("fake-issue"),
      JSON.stringify(payload.gate),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 9: default gate command failed (no JSON written) → failed ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir } = setupFakeBin(work, { failed: true });
    const { stateDir } = setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--no-pull"], env);
    check("default-gate-failed: exit 1", result.status === 1, `status=${result.status}`);
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
    check("default-gate-failed: overallStatus=failed", payload.overallStatus === "failed", JSON.stringify(payload));
    check("default-gate-failed: failureReason=review_result_missing", payload.failureReason === "review_result_missing", JSON.stringify(payload));
    check("default-gate-failed: gate.approved=false", payload.gate?.approved === false, JSON.stringify(payload));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 10/10a/11/12 removed: LLM flags / --llm-profile / record sinks /
// --print-deploy-context are no longer CLI surface; they live in deploy.yaml
// under profiles.<name>.build.* / providers.llm / record.*.

// --- Test 13: discovery failure exits non-zero and does not write an empty aggregate ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    mkdirSync(resolve(projectsRoot, "gateway", "config"), { recursive: true });
    writeFileSync(resolve(projectsRoot, "gateway", "config", "projects.json"), "{ bad json", "utf8");
    const { binDir } = setupFakeBin(work);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const result = runScript(["--no-pull"], env);
    check("discover-fail: exit non-zero", result.status !== 0, `${result.status}\n${result.stderr}\n${result.stdout}`);
    check("discover-fail: stderr mentions parse failure", result.stderr.includes("failed to parse"), result.stderr);
    check(
      "discover-fail: aggregate not written",
      !existsSync(resolve(projectsRoot, "gateway", "operations", "nightly-latest.json")),
      "nightly-latest.json should not exist",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall tests passed\n");
