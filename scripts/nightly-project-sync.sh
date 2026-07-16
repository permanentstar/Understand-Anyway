#!/usr/bin/env bash
# scripts/nightly-project-sync.sh
#
# Per-project serial sync entrypoint: discover -> git pull -> commit-gate ->
# `understand_anyway build` (bootstrap full on clean state, otherwise
# incremental) -> `project-state publish` -> graph-health gate -> write
# project `.understand-anything/nightly-latest.json` and per-project
# `result.json`.
#
# OSS-neutral. LLM, record sinks, retry policy, and review hook live in
# deploy.yaml; this script does not expose CLI flags for them.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

UA_LOG_TAG="nightly-project-sync"
export UA_LOG_TAG

load_env_file

usage() {
  cat <<'EOF'
Usage:
  nightly-project-sync.sh [options]

Discovers projects from <projectsRoot>/gateway/config/projects.json and runs each
through `git pull -> build -> project-state publish -> graph-health gate`.
Clean state bootstraps with a full build once; subsequent runs use incremental
build automatically. Build/serve options live in deploy.yaml.

Options:
  --project <id>          Sync only one projectId. Default: all visible.
  --deploy-profile <p>    Build spec profile (deploy.yaml deployProfiles.*).
  --llm-profile <name>    LLM provider profile (deploy.yaml llmProfiles.*).
  --no-pull               Skip git pull. Default: pull runs.
  --dry-run               Print commands; do not spawn understand-anyway.
  -h, --help              Show this help.
EOF
}

project_filter=""
deploy_profile=""
llm_profile=""
no_pull="false"
dry_run="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      require_value "$1" "${2:-}"
      project_filter="$2"
      shift 2
      ;;
    --deploy-profile)
      require_value "$1" "${2:-}"
      deploy_profile="$2"
      shift 2
      ;;
    --llm-profile)
      require_value "$1" "${2:-}"
      llm_profile="$2"
      shift 2
      ;;
    --no-pull)
      no_pull="true"
      shift
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$deploy_profile" ]]; then
  export UA_DEPLOY_PROFILE="$deploy_profile"
fi

UA_DRY_RUN="$dry_run"
export UA_DRY_RUN

projects_root="$(resolve_projects_root)"
mkdir -p "$projects_root"
deploy_config="$projects_root/gateway/config/deploy.yaml"

run_id="$(date +%Y%m%d-%H%M%S)"
operations_root="$projects_root/gateway/operations"
aggregate_dir="$operations_root/nightly-runs/$run_id"
mkdir -p "$aggregate_dir"
all_start_time="$(timestamp_now)"

discover_args=(--projects-root "$projects_root" --repo-root "$ROOT_DIR")
if [[ -n "$project_filter" ]]; then
  discover_args+=(--filter "$project_filter")
fi

discover_output="$(mktemp "${TMPDIR:-/tmp}/ua-nightly-projects.XXXXXX")"
if ! node "$SCRIPT_DIR/lib/discover-projects.mjs" "${discover_args[@]}" > "$discover_output"; then
  rm -f "$discover_output"
  exit 1
fi

# Per-project ids gathered for the aggregate write.
project_ids=()

# Read previous nightly-latest.json's commit (returns empty string when absent).
read_previous_commit() {
  local state_dir="$1"
  local latest="$state_dir/.understand-anything/nightly-latest.json"
  [[ -f "$latest" ]] || { printf ''; return; }
  STATE_LATEST="$latest" node <<'NODE'
const fs = require("node:fs");
try {
  const payload = JSON.parse(fs.readFileSync(process.env.STATE_LATEST, "utf8"));
  process.stdout.write(String(payload.commit || ""));
} catch {
  process.stdout.write("");
}
NODE
}

read_previous_overall_status() {
  local state_dir="$1"
  local latest="$state_dir/.understand-anything/nightly-latest.json"
  [[ -f "$latest" ]] || { printf ''; return; }
  STATE_LATEST="$latest" node <<'NODE'
const fs = require("node:fs");
try {
  const payload = JSON.parse(fs.readFileSync(process.env.STATE_LATEST, "utf8"));
  process.stdout.write(String(payload.overallStatus || ""));
} catch {
  process.stdout.write("");
}
NODE
}

# Resolve the current HEAD commit; empty string when not a git repo.
git_head() {
  local repo_path="$1"
  if [[ ! -d "$repo_path/.git" ]]; then
    printf ''
    return
  fi
  git -C "$repo_path" rev-parse HEAD 2>/dev/null || printf ''
}

# Path to the mutable state-root graph used by build/incremental build.
state_graph_path() {
  local state_dir="$1"
  printf '%s/.understand-anything/knowledge-graph.json' "$state_dir"
}

# Incremental nightly runs require both a persisted graph and a real git repo.
# Archive-synced source trees (no .git) stay on full builds because the
# incremental pipeline relies on git diff/change detection.
can_run_incremental_build() {
  local repo_path="$1"
  local state_dir="$2"
  [[ -d "$repo_path/.git" ]] && [[ -f "$(state_graph_path "$state_dir")" ]]
}

# Spawn `understand_anyway build --project <id> --exclude-tests`, using
# `--incremental` only when the state root already has a graph and the source
# repo has git metadata. Fresh deployments and archive-style source mirrors
# stay on full builds. Returns command exit code; in dry-run mode always
# returns 0.
spawn_build() {
  local project_id="$1"
  local repo_path="$2"
  local state_dir="$3"
  local cmd=(understand_anyway build
    --project "$project_id"
    --config "$deploy_config"
    --exclude-tests
    --no-dashboard)
  if can_run_incremental_build "$repo_path" "$state_dir"; then
    cmd+=(--incremental)
  fi
  if [[ -n "$deploy_profile" ]]; then
    cmd+=(--deploy-profile "$deploy_profile")
  fi
  if [[ -n "$llm_profile" ]]; then
    cmd+=(--llm-profile "$llm_profile")
  fi
  if can_run_incremental_build "$repo_path" "$state_dir"; then
    run_or_print "${cmd[@]}"
    return
  fi
  UA_BUILD_MODE_OVERRIDE=full run_or_print "${cmd[@]}"
}

# Run the deterministic graph-health gate. UA_REVIEW_CMD is no longer honored
# at the script level; integrate any external review by adapting
# `understand-anyway review-graph-health` directly.
run_gate_hook() {
  local project_id="$1"
  local review_json="$2"
  local log_dir="$3"
  understand_anyway review-graph-health \
    --project "$project_id" \
    --output "$review_json" \
    >>"$log_dir/review.log" 2>&1
}

while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  project_id="$(printf '%s' "$line" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).projectId||"")}catch{}})')"
  repo_path="$(printf '%s' "$line" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).repoPath||"")}catch{}})')"
  state_dir="$(printf '%s' "$line" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(r).stateDir||"")}catch{}})')"
  [[ -n "$project_id" ]] || continue

  project_started_at="$(timestamp_now)"
  log_dir="$state_dir/.understand-anything/nightly-runs/$run_id"
  mkdir -p "$log_dir"
  result_json="$state_dir/.understand-anything/nightly-runs/$run_id/result.json"
  nightly_latest="$state_dir/.understand-anything/nightly-latest.json"
  review_json="$log_dir/review.json"
  git_pull_log="$log_dir/git-pull.log"
  build_log="$log_dir/build.log"
  review_log="$log_dir/review.log"
  git_pull_status="skipped"
  git_pull_skipped="true"
  commit_before="$(git_head "$repo_path")"
  commit_after="$commit_before"

  # 1. git pull (best-effort; never blocks on its own)
  if [[ "$no_pull" != "true" && -d "$repo_path/.git" ]]; then
    git_pull_skipped="false"
    if run_or_print git -C "$repo_path" pull --ff-only >>"$git_pull_log" 2>&1; then
      git_pull_status="success"
    else
      git_pull_status="failed"
    fi
    commit_after="$(git_head "$repo_path")"
  fi

  current_commit="$commit_after"
  prev_commit="$(read_previous_commit "$state_dir")"
  prev_status="$(read_previous_overall_status "$state_dir")"

  # 2. commit gate: same commit + previous usable run → skipped. A prior
  # `skipped` already proves the current commit is covered, so keep skipping
  # instead of rebuilding every other run.
  # Escape hatch: when the skip path would land on a project whose
  # `current/dashboard-dist/` is missing (typical for freshly-migrated state
  # roots or the first nightly after method-A introduction), fall through to
  # a real build so `dashboard build-dist` + publish can heal the dist.
  current_dist="$state_dir/current/dashboard-dist"
  if [[ -n "$current_commit" && "$current_commit" == "$prev_commit" \
        && ( "$prev_status" == "success" || "$prev_status" == "skipped" ) \
        && -d "$current_dist" ]]; then
    printf '[nightly-project-sync] project=%s commit=%s skipped (no change since previous usable run)\n' "$project_id" "${current_commit:0:12}"
    PROJECT_NAME="$project_id" REPO_PATH="$repo_path" STATE_DIR="$state_dir" \
    COMMIT="$current_commit" RUN_ID="$run_id" \
    STARTED="$project_started_at" FINISHED="$(timestamp_now)" \
    GIT_PULL_STATUS="$git_pull_status" GIT_PULL_SKIPPED="$git_pull_skipped" \
    COMMIT_BEFORE="$commit_before" COMMIT_AFTER="$commit_after" \
    RESULT_PATH="$result_json" LATEST_PATH="$nightly_latest" \
    LOG_PATH="$log_dir" BUILD_LOG="$build_log" REVIEW_LOG="$review_log" GIT_PULL_LOG="$git_pull_log" \
    node <<'NODE'
const fs = require("node:fs");
const result = {
  projectName: process.env.PROJECT_NAME,
  repoPath: process.env.REPO_PATH,
  stateDir: process.env.STATE_DIR,
  commit: process.env.COMMIT,
  runId: process.env.RUN_ID,
  startedAt: process.env.STARTED,
  finishedAt: process.env.FINISHED,
  git: {
    pullStatus: process.env.GIT_PULL_STATUS,
    pullSkipped: process.env.GIT_PULL_SKIPPED === "true",
    commitBefore: process.env.COMMIT_BEFORE || null,
    commitAfter: process.env.COMMIT_AFTER || null,
  },
  build: { status: "skipped" },
  dashboardBuildDist: { status: "skipped", logPath: null },
  review: {
    status: "skipped",
    approved: true,
    issueCount: 0,
    warningCount: 0,
    commandConfigured: false,
    runnerPath: null,
    failureReason: null,
    jsonPath: null,
  },
  gate: {
    status: "skipped",
    approved: true,
    criticalCount: 0,
    warningCount: 0,
    failureReason: null,
    jsonPath: null,
    logPath: process.env.REVIEW_LOG || null,
    issues: [],
    warnings: [],
    stats: { source: "skip-commit-gate" },
  },
  llm: null,
  llmGuard: [],
  overallStatus: "skipped",
  failureReason: null,
  needsManualIntervention: false,
  logs: {
    result: process.env.RESULT_PATH,
    script: process.env.LOG_PATH,
    gitPull: process.env.GIT_PULL_LOG,
    build: process.env.BUILD_LOG,
    review: process.env.REVIEW_LOG,
  },
};
fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(result, null, 2));
fs.writeFileSync(process.env.LATEST_PATH, JSON.stringify(result, null, 2));
NODE
    project_ids+=("$project_id")
    continue
  fi

  # 3. spawn build
  build_status="success"
  if ! spawn_build "$project_id" "$repo_path" "$state_dir" >>"$build_log" 2>&1; then
    build_status="failed"
  fi

  # 3a. dashboard build-dist — refresh flat staging <state_dir>/dashboard-dist.
  # Runs after a successful build; Method A: `project-state publish` promotes
  # the flat staging into `versions/<vid>/dashboard-dist/`. build-dist failure
  # is a warning (dashboardBuildDist.status=failed) and does NOT block publish
  # or fail nightly overallStatus, so a build+graph success still lands.
  # Plugin root is auto-resolved by the CLI (matches `build`); pass an explicit
  # --plugin-root only when UA_PLUGIN_ROOT is set.
  dashboard_build_dist_status="skipped"
  dashboard_build_dist_log="$log_dir/dashboard-build-dist.log"
  if [[ "$build_status" == "success" ]]; then
    dashboard_build_dist_cmd=(understand_anyway dashboard build-dist
      --project "$project_id"
      --rebuild-dashboard)
    if [[ -n "${UA_PLUGIN_ROOT:-}" ]]; then
      dashboard_build_dist_cmd+=(--plugin-root "$UA_PLUGIN_ROOT")
    fi
    if run_or_print "${dashboard_build_dist_cmd[@]}" >>"$dashboard_build_dist_log" 2>&1; then
      dashboard_build_dist_status="success"
    else
      dashboard_build_dist_status="failed"
      printf '[nightly-project-sync] project=%s dashboard build-dist failed (warning; publish will proceed)\n' \
        "$project_id" >&2
    fi
  fi

  # 3b. publish into versions/<vid>/ when build succeeds so prod runtime serves
  # an immutable snapshot via the project's `current` symlink.
  publish_status="skipped"
  publish_log="$log_dir/project-state-publish.log"
  if [[ "$build_status" == "success" ]]; then
    publish_vid="$(date +%Y%m%d%H%M%S)"
    publish_cmd=(understand_anyway project-state publish "$publish_vid"
      --project "$project_id"
      --source-root "$repo_path"
      --stable)
    if run_or_print "${publish_cmd[@]}" >>"$publish_log" 2>&1; then
      publish_status="success"
    else
      publish_status="failed"
      printf '[nightly-project-sync] project=%s publish failed; nightly will surface the build but prod refresh may serve stale dist\n' \
        "$project_id" >&2
    fi
  fi

  # 4. gate hook (skipped on build failure)
  gate_approved="false"
  gate_status="skipped"
  gate_failure_reason=""
  gate_issues="[]"
  gate_warnings="[]"
  gate_stats="{}"
  review_status="skipped"
  review_failure_reason=""
  if [[ "$build_status" == "success" ]]; then
    run_gate_hook "$project_id" "$review_json" "$log_dir" >>"$review_log" 2>&1 || true
    if [[ -f "$review_json" ]]; then
      gate_approved="$(REVIEW="$review_json" node -e 'let p=JSON.parse(require("node:fs").readFileSync(process.env.REVIEW,"utf8"));process.stdout.write(p.approved===true?"true":"false")')"
      gate_issues="$(REVIEW="$review_json" node -e 'let p=JSON.parse(require("node:fs").readFileSync(process.env.REVIEW,"utf8"));process.stdout.write(JSON.stringify(Array.isArray(p.issues)?p.issues:[]))')"
      gate_warnings="$(REVIEW="$review_json" node -e 'let p=JSON.parse(require("node:fs").readFileSync(process.env.REVIEW,"utf8"));process.stdout.write(JSON.stringify(Array.isArray(p.warnings)?p.warnings:[]))')"
      gate_stats="$(REVIEW="$review_json" node -e 'let p=JSON.parse(require("node:fs").readFileSync(process.env.REVIEW,"utf8"));process.stdout.write(JSON.stringify(p.stats||{}))')"
      if [[ "$gate_approved" == "true" ]]; then
        gate_status="approved"
        review_status="approved"
      else
        gate_status="rejected"
        review_status="rejected"
        gate_failure_reason="gate_rejected"
        review_failure_reason="gate_rejected"
      fi
    else
      gate_status="failed"
      review_status="failed"
      gate_failure_reason="review_result_missing"
      review_failure_reason="review_result_missing"
    fi
  else
    review_status="skipped"
    review_failure_reason="build_failed"
    gate_failure_reason="build_failed"
  fi

  # 5. write result.json + nightly-latest.json
  overall_status="success"
  failure_reason=""
  needs_manual_intervention="false"
  if [[ "$build_status" != "success" ]]; then
    overall_status="failed"
    failure_reason="build_failed"
    needs_manual_intervention="true"
  elif [[ "$gate_approved" != "true" ]]; then
    overall_status="failed"
    failure_reason="${gate_failure_reason:-gate_rejected}"
    needs_manual_intervention="true"
  fi

  PROJECT_NAME="$project_id" REPO_PATH="$repo_path" STATE_DIR="$state_dir" \
  COMMIT="$current_commit" RUN_ID="$run_id" \
  STARTED="$project_started_at" FINISHED="$(timestamp_now)" \
  GIT_PULL_STATUS="$git_pull_status" GIT_PULL_SKIPPED="$git_pull_skipped" \
  COMMIT_BEFORE="$commit_before" COMMIT_AFTER="$commit_after" \
  BUILD_STATUS="$build_status" PUBLISH_STATUS="$publish_status" PUBLISH_LOG="$publish_log" \
  DASHBOARD_BUILD_DIST_STATUS="$dashboard_build_dist_status" DASHBOARD_BUILD_DIST_LOG="$dashboard_build_dist_log" \
  GATE_STATUS="$gate_status" GATE_APPROVED="$gate_approved" GATE_FAILURE_REASON="$gate_failure_reason" \
  GATE_ISSUES="$gate_issues" GATE_WARNINGS="$gate_warnings" GATE_STATS="$gate_stats" \
  REVIEW_STATUS="$review_status" REVIEW_FAILURE_REASON="$review_failure_reason" \
  REVIEW_JSON="$review_json" REVIEW_LOG="$review_log" \
  OVERALL_STATUS="$overall_status" FAILURE_REASON="$failure_reason" NEEDS_MANUAL_INTERVENTION="$needs_manual_intervention" \
  RESULT_PATH="$result_json" LATEST_PATH="$nightly_latest" LOG_DIR="$log_dir" GIT_PULL_LOG="$git_pull_log" BUILD_LOG="$build_log" \
  node <<'NODE'
const fs = require("node:fs");
const buildStatus = process.env.BUILD_STATUS;
const gateApproved = process.env.GATE_APPROVED === "true";
let llmStats = null;
try {
  const llmStatsPath = `${process.env.STATE_DIR}/.understand-anything/llm/latest-stats.json`;
  if (fs.existsSync(llmStatsPath)) {
    llmStats = JSON.parse(fs.readFileSync(llmStatsPath, "utf8"));
  }
} catch {
  llmStats = null;
}
const llmGuard = Array.isArray(llmStats?.modelGuards) ? llmStats.modelGuards : [];
const gate = {
  status: process.env.GATE_STATUS,
  approved: gateApproved,
  criticalCount: JSON.parse(process.env.GATE_ISSUES || "[]").length,
  warningCount: JSON.parse(process.env.GATE_WARNINGS || "[]").length,
  failureReason: process.env.GATE_FAILURE_REASON || null,
  jsonPath: process.env.REVIEW_JSON || null,
  logPath: process.env.REVIEW_LOG || null,
  issues: JSON.parse(process.env.GATE_ISSUES || "[]"),
  warnings: JSON.parse(process.env.GATE_WARNINGS || "[]"),
  stats: JSON.parse(process.env.GATE_STATS || "{}"),
};
const result = {
  projectName: process.env.PROJECT_NAME,
  repoPath: process.env.REPO_PATH,
  stateDir: process.env.STATE_DIR,
  commit: process.env.COMMIT,
  runId: process.env.RUN_ID,
  startedAt: process.env.STARTED,
  finishedAt: process.env.FINISHED,
  git: {
    pullStatus: process.env.GIT_PULL_STATUS,
    pullSkipped: process.env.GIT_PULL_SKIPPED === "true",
    commitBefore: process.env.COMMIT_BEFORE || null,
    commitAfter: process.env.COMMIT_AFTER || null,
  },
  build: { status: buildStatus },
  publish: {
    status: process.env.PUBLISH_STATUS,
    logPath: process.env.PUBLISH_LOG || null,
  },
  dashboardBuildDist: {
    status: process.env.DASHBOARD_BUILD_DIST_STATUS,
    logPath: process.env.DASHBOARD_BUILD_DIST_LOG || null,
  },
  review: {
    status: process.env.REVIEW_STATUS,
    approved: gateApproved,
    issueCount: gate.issues.length,
    warningCount: gate.warnings.length,
    commandConfigured: false,
    runnerPath: "understand_anyway review-graph-health",
    failureReason: process.env.REVIEW_FAILURE_REASON || null,
    jsonPath: process.env.REVIEW_JSON || null,
  },
  gate,
  llm: llmStats,
  llmGuard,
  overallStatus: process.env.OVERALL_STATUS,
  failureReason: process.env.FAILURE_REASON || null,
  needsManualIntervention: process.env.NEEDS_MANUAL_INTERVENTION === "true",
  logs: {
    result: process.env.RESULT_PATH,
    script: process.env.LOG_DIR,
    gitPull: process.env.GIT_PULL_LOG,
    build: process.env.BUILD_LOG,
    review: process.env.REVIEW_LOG,
  },
};
fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(result, null, 2));
fs.writeFileSync(process.env.LATEST_PATH, JSON.stringify(result, null, 2));
NODE

  printf '[nightly-project-sync] project=%s commit=%s build=%s gate.approved=%s\n' \
    "$project_id" "${current_commit:0:12}" "$build_status" "$gate_approved"

  project_ids+=("$project_id")
done < "$discover_output"
rm -f "$discover_output"

# 6. aggregate write
all_finished="$(timestamp_now)"
aggregate_path="$aggregate_dir/result.json"
aggregate_latest="$operations_root/nightly-latest.json"
mkdir -p "$operations_root"

aggregate_args=(
  "$SCRIPT_DIR/aggregate-nightly.mjs"
  --projects-root "$projects_root"
  --run-id "$run_id"
  --started-at "$all_start_time"
  --finished-at "$all_finished"
  --root-dir "$ROOT_DIR"
)
for project_id in "${project_ids[@]:-}"; do
  [[ -n "$project_id" ]] || continue
  aggregate_args+=(--project "$project_id")
done
node "${aggregate_args[@]}" >/dev/null

# 7. record sinks (best-effort; configured entirely via deploy.yaml record.*).
#    External record provider/sheet/worksheets are loaded by
#    write-external-records.mjs from the resolved deploy config. Failures here
#    never block aggregate or final exit code.
record_script="${UA_WRITE_EXTERNAL_RECORDS_SCRIPT:-$SCRIPT_DIR/write-external-records.mjs}"
if [[ -f "$record_script" ]]; then
  record_log="$aggregate_dir/external-records.log"
  if run_or_print node "$record_script" --input "$aggregate_path" >"$record_log" 2>&1; then
    printf '[nightly-project-sync] external records synced (see %s)\n' "$record_log"
  else
    printf '[nightly-project-sync] external record sync failed: %s\n' "$record_log" >&2
  fi
fi

# 8. exit code: 1 if any project failed.
final_status="$(LATEST="$aggregate_latest" node -e 'let p=JSON.parse(require("node:fs").readFileSync(process.env.LATEST,"utf8"));process.stdout.write(p.overallStatus||"")')"
printf '[nightly-project-sync] run_id=%s aggregate=%s\n' "$run_id" "$final_status"
case "$final_status" in
  success|partial_success) exit 0 ;;
  *) exit 1 ;;
esac
