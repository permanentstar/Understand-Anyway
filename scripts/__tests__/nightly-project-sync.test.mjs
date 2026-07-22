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
  const buildDistFailed = gateOpts.buildDistFailed === true ? "true" : "false";
  const shim = `#!/usr/bin/env bash
{ printf '%s\\n' "$*"; } >> "${logPath}"
graph_path_for_project() {
  local project=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project)
        project="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  if [[ -z "$project" || -z "\${UA_PROJECTS_ROOT:-}" ]]; then
    printf ''
    return
  fi
  printf '%s/projects/%s/.understand-anything/knowledge-graph.json' "$UA_PROJECTS_ROOT" "$project"
}
if [[ "$1" == "build" ]]; then
  graph_path="$(graph_path_for_project "$@")"
  incremental="false"
  for arg in "$@"; do
    if [[ "$arg" == "--incremental" ]]; then
      incremental="true"
    fi
  done
  if [[ "$incremental" == "true" && -n "$graph_path" && ! -f "$graph_path" ]]; then
    printf 'error: build: incremental requires existing graph; run full build explicitly first: %s\\n' "$graph_path" >&2
    exit 9
  fi
  if [[ -n "$graph_path" ]]; then
    mkdir -p "$(dirname "$graph_path")"
    printf '%s' '{"nodes":[],"edges":[]}' > "$graph_path"
  fi
  exit 0
fi
if [[ "$1" == "dashboard" && "$2" == "build-dist" ]]; then
  if [[ "${buildDistFailed}" == "true" ]]; then
    exit 3
  fi
  # Simulate method-A staging: build-dist creates the flat <stateRoot>/dashboard-dist
  # so a subsequent 'project-state publish' has something to promote.
  state_root=""
  project_id=""
  for i in $(seq 1 $#); do
    if [[ "\${!i}" == "--project" ]]; then
      nxt=$((i+1)); project_id="\${!nxt}"
    fi
  done
  # Best-effort resolve state root from UA_PROJECTS_ROOT (used in tests).
  if [[ -n "$project_id" && -n "\${UA_PROJECTS_ROOT:-}" ]]; then
    state_root="$UA_PROJECTS_ROOT/projects/$project_id"
    mkdir -p "$state_root/dashboard-dist"
  fi
  exit 0
fi
if [[ "$1" == "project-state" && "$2" == "publish" ]]; then
  # Simulate promotion of flat staging into versions/<vid>/dashboard-dist and
  # atomically flip the 'current' symlink so <stateRoot>/current/dashboard-dist
  # exists after publish. Version id is passed positionally right after
  # 'publish'; project id from --project.
  version_id="$3"
  project_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project_id="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -n "$project_id" && -n "\${UA_PROJECTS_ROOT:-}" && -n "$version_id" ]]; then
    state_root="$UA_PROJECTS_ROOT/projects/$project_id"
    mkdir -p "$state_root/versions/$version_id/dashboard-dist"
    ln -sfn "$state_root/versions/$version_id" "$state_root/current"
  fi
  exit 0
fi
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

function setupOneProject(projectsRoot, options = {}) {
  const cfgDir = resolve(projectsRoot, "gateway", "config");
  mkdirSync(cfgDir, { recursive: true });
  const repoBase = resolve(projectsRoot, "src");
  mkdirSync(repoBase, { recursive: true });
  const repoDir = resolve(repoBase, "alpha");
  mkdirSync(repoDir, { recursive: true });
  if (options.gitRepo !== false) {
    gitInit(repoDir);
  } else {
    writeFileSync(resolve(repoDir, "README.md"), "x");
  }
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

// --- Test 1: clean-state first run bootstraps with full build, then writes nightly-latest.json ---
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
    const firstBuildLine = log.split("\n").find((line) => line.startsWith("build ")) ?? "";
    check("first: clean-state build omits --incremental", !firstBuildLine.includes("--incremental"), log);
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

// --- Test 1b: clean-state deploy profile bootstrap still succeeds when profile defaults to incremental ---
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
    const result = runScript(["--no-pull", "--deploy-profile", "ppe"], env);
    check("profile-bootstrap: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const firstBuildLine = log.split("\n").find((line) => line.startsWith("build ")) ?? "";
    check("profile-bootstrap: build keeps deploy profile but omits --incremental", firstBuildLine.includes("--deploy-profile ppe") && !firstBuildLine.includes("--incremental") && !firstBuildLine.includes("--profile "), log);
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    check("profile-bootstrap: nightly-latest.json exists", existsSync(nightlyLatest), nightlyLatest);
    if (existsSync(nightlyLatest)) {
      const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
      check("profile-bootstrap: overallStatus=success", payload.overallStatus === "success", JSON.stringify(payload));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1c: non-git repo checkouts keep using full bootstrap builds ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work);
    setupOneProject(projectsRoot, { gitRepo: false });

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
    };
    const first = runScript(["--no-pull", "--deploy-profile", "ppe"], env);
    const second = runScript(["--no-pull", "--deploy-profile", "ppe"], env);
    check("non-git-profile: first exit 0", first.status === 0, `${first.status}\n${first.stderr}`);
    check("non-git-profile: second exit 0", second.status === 0, `${second.status}\n${second.stderr}`);
    const buildLines = (existsSync(logPath) ? readFileSync(logPath, "utf8") : "")
      .split("\n")
      .filter((line) => line.startsWith("build "));
    check("non-git-profile: both runs spawned builds", buildLines.length === 2, buildLines.join("\n"));
    check(
      "non-git-profile: archive-style repos never switch to --incremental",
      buildLines.every((line) => line.includes("--deploy-profile ppe") && !line.includes("--incremental") && !line.includes("--profile ")),
      buildLines.join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 1d: deploy/llm profiles are forwarded to build ---
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
    const result = runScript(["--no-pull", "--deploy-profile", "ppe", "--llm-profile", "traex"], env);
    check("profiles: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const buildLine = log.split("\n").find((line) => line.startsWith("build ")) ?? "";
    check("profiles: build got deploy profile", buildLine.includes("--deploy-profile ppe"), buildLine);
    check("profiles: build got llm profile", buildLine.includes("--llm-profile traex"), buildLine);
    check("profiles: build does not get legacy profile", !buildLine.includes("--profile "), buildLine);
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

// --- Test 2b: repeated unchanged runs keep skipping (no every-other rebuild) ---
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
    runScript(["--no-pull"], env); // first: builds
    runScript(["--no-pull"], env); // second: skips (writes overallStatus=skipped)
    const third = runScript(["--no-pull"], env); // third: must still skip
    check("skip-guard: third exit 0", third.status === 0, third.stderr);
    check("skip-guard: third run reports skipped", third.stdout.includes("skipped"), third.stdout);
    const buildLines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("build "));
    check(
      "skip-guard: build only ran once across three unchanged runs",
      buildLines.length === 1,
      buildLines.join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 2c: skip guard self-heals when current/dashboard-dist is missing ---
// Simulates a state root migrated from a legacy layout: same commit, previous
// nightly succeeded, but `current/dashboard-dist/` was never created. The skip
// path must fall through to a real build so dashboard build-dist + publish can
// promote a fresh dist into the versioned target.
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
    runScript(["--no-pull"], env); // first: real build, seeds nightly-latest
    const firstLog = readFileSync(logPath, "utf8");

    // Delete the current/dashboard-dist that the first run would have promoted
    // (fake bin doesn't actually create one; simulate the legacy state root
    // where publish landed but no dashboard-dist was ever staged).
    const currentDist = resolve(stateDir, "current", "dashboard-dist");
    rmSync(currentDist, { recursive: true, force: true });

    const second = runScript(["--no-pull"], env);
    check("skip-self-heal: second exit 0", second.status === 0, second.stderr);
    const secondLog = readFileSync(logPath, "utf8");
    check(
      "skip-self-heal: build re-invoked instead of skipping",
      secondLog.length > firstLog.length,
      `first=${firstLog.length} second=${secondLog.length}`,
    );
    check(
      "skip-self-heal: second run does NOT report skipped",
      !second.stdout.includes("skipped"),
      second.stdout,
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
    const allLines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const secondLines = allLines.length;
    check(
      "commit-changed: build re-invoked",
      secondLines === firstLines + 4,
      `before=${firstLines} after=${secondLines}`,
    );
    const buildLines = allLines.filter((line) => line.startsWith("build "));
    check(
      "commit-changed: follow-up build uses --incremental once graph exists",
      buildLines[buildLines.length - 1]?.includes("--incremental") === true,
      buildLines.join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 4 removed: --review-cmd is gone. External review hooks must
// integrate via `understand-anyway review-graph-health` adapters.

// --- Test 3b: dashboard build-dist runs between build and project-state publish ---
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
      UA_PLUGIN_ROOT: "/tmp/fake-plugin-root",
    };
    const result = runScript(["--no-pull"], env);
    check("build-dist-seq: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const buildIdx = lines.findIndex((line) => line.startsWith("build "));
    const buildDistIdx = lines.findIndex((line) => line.startsWith("dashboard build-dist"));
    const publishIdx = lines.findIndex((line) => line.startsWith("project-state publish"));
    check("build-dist-seq: build invoked", buildIdx !== -1, lines.join("\n"));
    check("build-dist-seq: dashboard build-dist invoked", buildDistIdx !== -1, lines.join("\n"));
    check("build-dist-seq: project-state publish invoked", publishIdx !== -1, lines.join("\n"));
    check(
      "build-dist-seq: nightly publish does not auto-set stable",
      (lines[publishIdx] ?? "").includes("--stable") === false,
      lines.join("\n"),
    );
    check(
      "build-dist-seq: build → dashboard build-dist → project-state publish order",
      buildIdx < buildDistIdx && buildDistIdx < publishIdx,
      `build=${buildIdx} build-dist=${buildDistIdx} publish=${publishIdx}\n${lines.join("\n")}`,
    );
    const buildDistLine = lines[buildDistIdx] ?? "";
    check(
      "build-dist-seq: build-dist forwards --project and --rebuild-dashboard",
      buildDistLine.includes("--project alpha") && buildDistLine.includes("--rebuild-dashboard"),
      buildDistLine,
    );
    check(
      "build-dist-seq: build-dist forwards --plugin-root",
      buildDistLine.includes("--plugin-root /tmp/fake-plugin-root"),
      buildDistLine,
    );
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
    check(
      "build-dist-seq: result.json has dashboardBuildDist.status=success",
      payload.dashboardBuildDist?.status === "success",
      JSON.stringify(payload.dashboardBuildDist),
    );
    check(
      "build-dist-seq: result.json has dashboardBuildDist.logPath",
      typeof payload.dashboardBuildDist?.logPath === "string" && payload.dashboardBuildDist.logPath.endsWith("dashboard-build-dist.log"),
      JSON.stringify(payload.dashboardBuildDist),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3c: dashboard build-dist failure does NOT fail overallStatus ---
{
  const work = makeTmp();
  try {
    const projectsRoot = resolve(work, "projects");
    const { binDir, logPath } = setupFakeBin(work, { buildDistFailed: true });
    const { stateDir } = setupOneProject(projectsRoot);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      UA_PROJECTS_ROOT: projectsRoot,
      HOME: work,
      UA_PLUGIN_ROOT: "/tmp/fake-plugin-root",
    };
    const result = runScript(["--no-pull"], env);
    check("build-dist-fail: exit 0 despite build-dist failure", result.status === 0, `${result.status}\n${result.stderr}`);
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    // publish still ran even though build-dist failed
    const publishIdx = lines.findIndex((line) => line.startsWith("project-state publish"));
    check("build-dist-fail: project-state publish still ran", publishIdx !== -1, lines.join("\n"));
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
    check(
      "build-dist-fail: overallStatus=success (build-dist warning, not gate)",
      payload.overallStatus === "success",
      JSON.stringify(payload),
    );
    check(
      "build-dist-fail: dashboardBuildDist.status=failed",
      payload.dashboardBuildDist?.status === "failed",
      JSON.stringify(payload.dashboardBuildDist),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- Test 3d: dashboard build-dist runs without --plugin-root when UA_PLUGIN_ROOT is unset ---
// The CLI auto-resolves upstream plugin (matching `build`); nightly should not
// gate on UA_PLUGIN_ROOT presence.
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
    delete env.UA_PLUGIN_ROOT;
    const result = runScript(["--no-pull"], env);
    check("build-dist-no-plugin: exit 0", result.status === 0, `${result.status}\n${result.stderr}`);
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const buildDistIdx = lines.findIndex((line) => line.startsWith("dashboard build-dist"));
    check("build-dist-no-plugin: dashboard build-dist invoked", buildDistIdx !== -1, lines.join("\n"));
    const buildDistLine = lines[buildDistIdx] ?? "";
    check(
      "build-dist-no-plugin: build-dist without --plugin-root when UA_PLUGIN_ROOT unset",
      !buildDistLine.includes("--plugin-root"),
      buildDistLine,
    );
    const nightlyLatest = resolve(stateDir, ".understand-anything", "nightly-latest.json");
    const payload = JSON.parse(readFileSync(nightlyLatest, "utf8"));
    check(
      "build-dist-no-plugin: dashboardBuildDist.status=success",
      payload.dashboardBuildDist?.status === "success",
      JSON.stringify(payload.dashboardBuildDist),
    );
    check(
      "build-dist-no-plugin: overallStatus=success",
      payload.overallStatus === "success",
      JSON.stringify(payload),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

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

// --- Test 10/10a/11/12 removed: low-level LLM flags / record sinks /
// --print-deploy-context are no longer CLI surface; they live in deploy.yaml
// under deployProfiles.*.build / llmProfiles.* / record.*.

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
