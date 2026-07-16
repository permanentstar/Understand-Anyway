#!/usr/bin/env bash
# scripts/refresh-prod-server.sh
#
# Refresh prod-mode shared gateway runtime for projects whose nightly graph is
# up to date. Reads project list from `<projectsRoot>/gateway/config/projects.json`,
# refreshes each qualifying project's `dashboard-dist/`, writes prod registry
# entries, then starts one shared gateway that serves `/project/<id>/`.
#
# Build/serve options live in deploy.yaml. The script itself only takes
# deployment-topology flags and project filtering. Deploy profile must be set
# (CLI flag or UA_DEPLOY_PROFILE env from ~/.env); auto-detection has been
# removed because SSH-based heuristics misclassify ppe hosts. `dev` is rejected
# because this script refreshes the prod runtime.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

UA_LOG_TAG="refresh-prod-server"
export UA_LOG_TAG

load_env_file

usage() {
  cat <<'EOF'
Usage:
  refresh-prod-server.sh [options]

Refreshes per-project dashboard-dist (when nightly-latest says success) and
remounts the shared gateway. Build/serve options live in deploy.yaml.

Options:
  --host <addr>            Shared gateway bind host. Default: 127.0.0.1
                           (deploy.yaml: deploy.host)
  --port <num>             Shared gateway bind port. Default: 18666
                           (deploy.yaml: deploy.port)
  --project <id>           Refresh only one projectId. Default: all.
  --deploy-profile <p>     Override deployment profile (prod|ppe|dev). Default:
                           $UA_DEPLOY_PROFILE in ~/.env. Rejects dev for prod
                           refresh.
  --plugin-root <path>     Upstream plugin root needed by `dashboard build-dist`
                           when a project's dashboard-dist is missing.
  --dry-run                Print commands; do not spawn understand-anyway.
  -h, --help               Show this help.

Notes:
  - There is no force/all-builds escape hatch. To recover an out-of-band
    project, run `understand-anyway dashboard build-dist --project <id>`
    directly, then rerun this script.
  - The shared gateway is always stopped and restarted on each invocation.
EOF
}

host="127.0.0.1"
port="18666"
project_filter=""
deploy_profile_cli=""
plugin_root=""
dry_run="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)             require_value "$1" "${2:-}"; host="$2"; shift 2 ;;
    --port)             require_value "$1" "${2:-}"; port="$2"; shift 2 ;;
    --project)          require_value "$1" "${2:-}"; project_filter="$2"; shift 2 ;;
    --deploy-profile)   require_value "$1" "${2:-}"; deploy_profile_cli="$2"; shift 2 ;;
    --plugin-root)      require_value "$1" "${2:-}"; plugin_root="$2"; shift 2 ;;
    --dry-run)          dry_run="true"; shift ;;
    --help|-h)          usage; exit 0 ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! deploy_profile="$(resolve_deploy_profile "$deploy_profile_cli")"; then
  exit 2
fi
if [[ "$deploy_profile" == "dev" ]]; then
  printf '[refresh-prod-server] dev deploy profile is not allowed for prod refresh\n' >&2
  exit 2
fi
export UA_DEPLOY_PROFILE="$deploy_profile"

UA_DRY_RUN="$dry_run"
export UA_DRY_RUN

projects_root="$(resolve_projects_root)"
mkdir -p "$projects_root"

discover_args=(--projects-root "$projects_root" --repo-root "$ROOT_DIR")
if [[ -n "$project_filter" ]]; then
  discover_args+=(--filter "$project_filter")
fi

# Decide whether the given project's nightly result qualifies for refresh.
should_refresh_project() {
  local state_dir="$1"
  local latest="$state_dir/.understand-anything/nightly-latest.json"
  [[ -f "$latest" ]] || return 1
  LATEST="$latest" node <<'NODE'
const fs = require("node:fs");
try {
  const latest = JSON.parse(fs.readFileSync(process.env.LATEST, "utf8"));
  process.exit(latest.overallStatus === "success" ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

refreshed_count=0
skipped_count=0
failed_count=0
discovered_project_ids_csv=""

append_csv() {
  local current="${1:-}"
  local next="${2:-}"
  if [[ -z "$next" ]]; then
    printf '%s\n' "$current"
    return
  fi
  if [[ -z "$current" ]]; then
    printf '%s\n' "$next"
    return
  fi
  printf '%s,%s\n' "$current" "$next"
}

# Build the per-project dashboard-dist without starting a per-project daemon.
spawn_dashboard_build_dist() {
  local project_id="$1"
  local state_dir="$2"
  if [[ -z "$plugin_root" ]]; then
    if [[ -d "$state_dir/dashboard-dist" ]] && [[ -n "$(ls -A "$state_dir/dashboard-dist" 2>/dev/null)" ]]; then
      return 0
    fi
    printf '[refresh-prod-server] missing --plugin-root and %s/dashboard-dist is absent\n' "$state_dir" >&2
    return 1
  fi
  local cmd=(understand_anyway dashboard build-dist
    --project "$project_id"
    --plugin-root "$plugin_root"
    --rebuild-dashboard)
  run_or_print "${cmd[@]}"
}

registry_path="$projects_root/gateway/registry.json"
shared_gateway_state_dir="$projects_root/gateway"

resolve_shared_gateway_cli() {
  local candidate="$projects_root/gateway/runtime/current/dist/cli.js"
  if [[ -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

ensure_shared_gateway_dirs() {
  if [[ "$dry_run" == "true" ]]; then
    return 0
  fi
  mkdir -p "$shared_gateway_state_dir"
}

upsert_prod_registry_record() {
  local project_id="$1"
  local state_dir="$2"
  local repo_path="$3"
  if [[ "$dry_run" == "true" ]]; then
    printf '[dry-run] registry upsert project=%s state_dir=%s repo=%s\n' "$project_id" "$state_dir" "$repo_path"
    return 0
  fi
  node "$SCRIPT_DIR/lib/upsert-project-registry.mjs" \
    --root-dir "$ROOT_DIR" \
    --registry-path "$registry_path" \
    --project-id "$project_id" \
    --project-root "$repo_path" \
    --state-root "$state_dir" \
    --host "$host" \
    --port "$port"
}

prune_registry_records() {
  if [[ -n "$project_filter" ]]; then
    return 0
  fi
  if [[ "$dry_run" == "true" ]]; then
    printf '[dry-run] registry prune keep=%s\n' "$discovered_project_ids_csv"
    return 0
  fi
  ROOT_DIR_ENV="$ROOT_DIR" \
  SCRIPT_DIR_ENV="$SCRIPT_DIR" \
  REGISTRY_PATH_ENV="$registry_path" \
  PROJECT_IDS_ENV="$discovered_project_ids_csv" \
    node --input-type=module <<'NODE'
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const helperUrl = pathToFileURL(resolve(process.env.SCRIPT_DIR_ENV, "lib/upsert-project-registry.mjs")).href;
const { pruneRegistryRecords } = await import(helperUrl);

const removed = await pruneRegistryRecords({
  rootDir: process.env.ROOT_DIR_ENV,
  registryPath: process.env.REGISTRY_PATH_ENV,
  projectIds: String(process.env.PROJECT_IDS_ENV || "").split(",").filter(Boolean),
});
if (removed.length > 0) {
  process.stdout.write(`[refresh-prod-server] registry pruned projects=${removed.join(",")}\n`);
}
NODE
}

spawn_shared_gateway() {
  ensure_shared_gateway_dirs
  local release_cli=""
  local -a stop_cmd
  local -a cmd
  if release_cli="$(resolve_shared_gateway_cli)"; then
    stop_cmd=(node "$release_cli" gateway stop --projects-root "$projects_root")
    run_or_print "${stop_cmd[@]}" || true
    cmd=(node "$release_cli" gateway start
      --projects-root "$projects_root"
      --host "$host"
      --port "$port"
      --no-open)
  else
    stop_cmd=(understand_anyway gateway stop --projects-root "$projects_root")
    run_or_print "${stop_cmd[@]}" || true
    cmd=(understand_anyway gateway start
      --projects-root "$projects_root"
      --host "$host"
      --port "$port"
      --no-open)
  fi
  run_or_print "${cmd[@]}"
}

discover_output="$(mktemp "${TMPDIR:-/tmp}/ua-refresh-projects.XXXXXX")"
if ! node "$SCRIPT_DIR/lib/discover-projects.mjs" "${discover_args[@]}" > "$discover_output"; then
  rm -f "$discover_output"
  exit 1
fi

while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  project_id="$(printf '%s' "$line" | node -e '
    let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>{
      try { process.stdout.write(JSON.parse(raw).projectId || ""); } catch {}
    });
  ')"
  repo_path="$(printf '%s' "$line" | node -e '
    let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>{
      try { process.stdout.write(JSON.parse(raw).repoPath || ""); } catch {}
    });
  ')"
  state_dir="$(printf '%s' "$line" | node -e '
    let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>{
      try { process.stdout.write(JSON.parse(raw).stateDir || ""); } catch {}
    });
  ')"
  [[ -n "$project_id" ]] || continue
  discovered_project_ids_csv="$(append_csv "$discovered_project_ids_csv" "$project_id")"

  if ! should_refresh_project "$state_dir"; then
    printf '[refresh-prod-server] skip project=%s state_dir=%s\n' "$project_id" "$state_dir"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  printf '[refresh-prod-server] refresh project=%s state_dir=%s\n' "$project_id" "$state_dir"
  mkdir -p "$state_dir"
  if spawn_dashboard_build_dist "$project_id" "$state_dir" && upsert_prod_registry_record "$project_id" "$state_dir" "$repo_path"; then
    refreshed_count=$((refreshed_count + 1))
  else
    failed_count=$((failed_count + 1))
  fi
done < "$discover_output"
rm -f "$discover_output"

if ! prune_registry_records; then
  failed_count=$((failed_count + 1))
fi

if ! spawn_shared_gateway; then
  failed_count=$((failed_count + 1))
fi

printf '[refresh-prod-server] deploy_profile=%s refreshed=%s skipped=%s failed=%s\n' \
  "$deploy_profile" "$refreshed_count" "$skipped_count" "$failed_count"

if [[ "$failed_count" -gt 0 ]]; then
  exit 1
fi
exit 0
