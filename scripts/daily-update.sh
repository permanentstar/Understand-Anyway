#!/usr/bin/env bash
# scripts/daily-update.sh
#
# OSS-neutral nightly cron entrypoint. Sequence:
#   1. self-update     git pull --ff-only && pnpm install && pnpm build
#   2. gateway publish best-effort versioning gate (D5)
#   3. nightly-project-sync.sh                     (D4)
#   4. notify nightly best-effort summary          (D6)
#   5. refresh-prod-server.sh                      (D4)
#   6. aggregate-daily.mjs                         (D8)
#
# Most behavior is configured in deploy.yaml (profile-driven). CLI flags only
# override deployment-topology bits that change per cron / per machine. LLM,
# record, retry policy, review hook and other non-topology options live in
# deploy.yaml exclusively — see docs/deployment-cli.md for the YAML reference.
#
# Failures in steps 1, 2, 4, and 6 are best-effort; nightly+refresh always run.
# Final exit code reflects the worst of nightly/refresh.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

UA_LOG_TAG="daily-update"
export UA_LOG_TAG

load_env_file

usage() {
  cat <<'EOF'
Usage:
  daily-update.sh [options]

CLI flags only cover deployment topology and recovery toggles. Build/serve
options (LLM provider, record sinks, retry policy, gate hook, etc.) belong to
deploy.yaml. See docs/deployment-cli.md.

Options:
  --host <addr>           Shared gateway bind host. Default: 127.0.0.1
                          (deploy.yaml: deploy.host)
  --port <num>            Shared gateway bind port. Default: 18666
                          (deploy.yaml: deploy.port)
  --project <id>          Restrict run to one projectId from
                          <projectsRoot>/gateway/config/projects.json. Default: all.
  --profile <name>        Build/serve profile to apply (deploy.yaml
                          profiles.*). Default: deploy.* base only.
  --deploy-profile <p>    Override deployment profile (prod|ppe|dev). Default:
                          $UA_DEPLOY_PROFILE in ~/.env; no auto-detection.
  --plugin-root <path>    Override upstream plugin root. Default:
                          $UA_PLUGIN_ROOT or auto-discovery.
  --no-self-update        Skip `git pull && pnpm install && pnpm build`.
  --no-pull               Skip git pull for source repos inside nightly.
  --dry-run               Print commands; do not spawn understand-anyway.
  -h, --help              Show this help.

Sequence:
  self-update -> gateway publish gate -> nightly-project-sync ->
  notify nightly -> refresh-prod-server -> aggregate-daily
EOF
}

host="127.0.0.1"
port="18666"
project=""
deploy_profile_cli=""
profile=""
plugin_root=""
no_pull="false"
self_update="true"
self_update_status=""
dry_run="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)            require_value "$1" "${2:-}"; host="$2"; shift 2 ;;
    --port)            require_value "$1" "${2:-}"; port="$2"; shift 2 ;;
    --project)         require_value "$1" "${2:-}"; project="$2"; shift 2 ;;
    --deploy-profile)  require_value "$1" "${2:-}"; deploy_profile_cli="$2"; shift 2 ;;
    --profile)         require_value "$1" "${2:-}"; profile="$2"; shift 2 ;;
    --plugin-root)     require_value "$1" "${2:-}"; plugin_root="$2"; shift 2 ;;
    --no-pull)         no_pull="true"; shift ;;
    --no-self-update)  self_update="false"; shift ;;
    --dry-run)         dry_run="true"; shift ;;
    --help|-h)         usage; exit 0 ;;
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

UA_DRY_RUN="$dry_run"
export UA_DRY_RUN

projects_root="$(resolve_projects_root)"
deploy_config="$projects_root/gateway/config/deploy.yaml"

stage_timer_start=0
stage_self_update=""
stage_gateway_publish=""
stage_nightly_project_sync=""
stage_refresh_prod_server=""
stage_begin() { stage_timer_start=$SECONDS; }
stage_end() {
  local name="$1"
  local elapsed=$(( SECONDS - stage_timer_start ))
  case "$name" in
    self-update) stage_self_update="$elapsed" ;;
    gateway-publish) stage_gateway_publish="$elapsed" ;;
    nightly-project-sync) stage_nightly_project_sync="$elapsed" ;;
    refresh-prod-server) stage_refresh_prod_server="$elapsed" ;;
  esac
}

run_id="$(date +%Y%m%d-%H%M%S)"
operations_root="$projects_root/gateway/operations"
mkdir -p "$operations_root/daily-runs"
run_dir="$operations_root/daily-runs/$run_id"
mkdir -p "$run_dir"
log_path="$run_dir/daily-update.log"
exec > >(tee -a "$log_path") 2>&1

printf '[daily-update] root=%s run_id=%s log=%s deploy_profile=%s\n' \
  "$ROOT_DIR" "$run_id" "$log_path" "$deploy_profile"

deploy_head_before=""
deploy_head_after=""
if [[ -d "$ROOT_DIR/.git" ]]; then
  deploy_head_before="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
  deploy_head_after="$deploy_head_before"
fi

# 1. self-update (best-effort; failures do not block follow-up steps)
if [[ "$self_update" == "true" ]]; then
  stage_begin
  if run_or_print git -C "$ROOT_DIR" pull --ff-only \
    && run_or_print pnpm -C "$ROOT_DIR" install \
    && run_or_print pnpm -C "$ROOT_DIR" build; then
    if [[ -d "$ROOT_DIR/.git" ]]; then
      deploy_head_after="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
    fi
    self_update_status="0"
    printf '[daily-update] self-update done\n'
  else
    self_update_status="1"
    printf '[daily-update] self-update failed (best-effort); continuing\n' >&2
  fi
  stage_end "self-update"
else
  printf '[daily-update] skip self-update\n'
fi

# 2. gateway publish gate (best-effort)
gateway_published="skipped"
gateway_publish_reason=""
needs_publish="false"

# Read current gateway version from `understand_anyway gateway list --json`.
current_gateway_version="$(understand_anyway gateway list --json 2>/dev/null | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{const releases=JSON.parse(r);const current=Array.isArray(releases)?releases.find((entry)=>entry&&entry.current):null;process.stdout.write(String(current?.versionId||""))}catch{}})' 2>/dev/null || true)"

if [[ -z "$current_gateway_version" ]]; then
  needs_publish="true"
  gateway_publish_reason="no current gateway release"
elif [[ -n "$deploy_head_before" && -n "$deploy_head_after" && "$deploy_head_before" != "$deploy_head_after" ]]; then
  if git -C "$ROOT_DIR" diff --name-only "$deploy_head_before" "$deploy_head_after" 2>/dev/null \
      | grep -Eq '^(packages/|package\.json$|package-lock\.json$|pnpm-lock\.yaml$)'; then
    needs_publish="true"
    gateway_publish_reason="deploy code changed ${deploy_head_before:0:12}->${deploy_head_after:0:12}"
  fi
fi

resolved_plugin_root=""
if [[ -n "$plugin_root" ]]; then
  resolved_plugin_root="$plugin_root"
elif [[ -n "${UA_PLUGIN_ROOT:-}" ]]; then
  resolved_plugin_root="${UA_PLUGIN_ROOT}"
fi

if [[ "$needs_publish" != "true" && -n "$current_gateway_version" && -n "$resolved_plugin_root" ]]; then
  upstream_drift="$(
    DAILY_PROJECTS_ROOT="$projects_root" \
    DAILY_CURRENT_GATEWAY_VERSION="$current_gateway_version" \
    DAILY_PLUGIN_ROOT="$resolved_plugin_root" \
      node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
try {
  const currentVersion = String(process.env.DAILY_CURRENT_GATEWAY_VERSION || "").trim();
  const projectsRoot = String(process.env.DAILY_PROJECTS_ROOT || "").trim();
  const pluginRoot = String(process.env.DAILY_PLUGIN_ROOT || "").trim();
  if (!currentVersion || !projectsRoot || !pluginRoot) process.exit(0);
  const manifestPath = path.resolve(projectsRoot, "gateway", "runtime", "releases", currentVersion, "manifest.json");
  const pluginPackagePath = path.resolve(pluginRoot, "package.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(pluginPackagePath)) process.exit(0);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const pluginPkg = JSON.parse(fs.readFileSync(pluginPackagePath, "utf8"));
  const recorded = String(manifest.upstreamVersion || "").trim();
  const installed = String(pluginPkg.version || "").trim();
  if (recorded && installed && recorded !== installed) {
    process.stdout.write(`${recorded}->${installed}`);
  }
} catch {}
NODE
  )"
  if [[ -n "$upstream_drift" ]]; then
    needs_publish="true"
    gateway_publish_reason="upstream plugin version drifted ${upstream_drift}"
  fi
fi

if [[ "$needs_publish" == "true" ]]; then
  stage_begin
  printf '[daily-update] gateway publish triggered: %s\n' "$gateway_publish_reason"
  publish_cmd=(understand_anyway gateway publish)
  if [[ -n "$resolved_plugin_root" ]]; then
    publish_cmd+=(--plugin-root "$resolved_plugin_root")
  fi
  if run_or_print "${publish_cmd[@]}"; then
    gateway_published="true"
  else
    gateway_published="false"
    printf '[daily-update] gateway publish failed (best-effort)\n' >&2
  fi
  stage_end "gateway-publish"
else
  printf '[daily-update] gateway publish skipped: no runtime change detected\n'
fi

# 3. nightly-project-sync
nightly_args=()
if [[ -n "$project" ]]; then nightly_args+=(--project "$project"); fi
if [[ "$no_pull" == "true" ]]; then nightly_args+=(--no-pull); fi
if [[ -n "$profile" ]]; then nightly_args+=(--profile "$profile"); fi
if [[ "$dry_run" == "true" ]]; then nightly_args+=(--dry-run); fi

stage_begin
run_step "nightly-project-sync" bash "$SCRIPT_DIR/nightly-project-sync.sh" "${nightly_args[@]+"${nightly_args[@]}"}"
nightly_status=$?
stage_end "nightly-project-sync"
if [[ "$nightly_status" -ne 0 ]]; then
  printf '[daily-update] nightly-project-sync exit=%s; continuing to refresh\n' "$nightly_status"
fi

# 3.5 notify nightly summary (best-effort; failures never block refresh)
nightly_report="$operations_root/nightly-latest.json"
if [[ -f "$nightly_report" ]]; then
  notify_args=(notify nightly --report "$nightly_report" --config "$deploy_config" --best-effort)
  if [[ "$dry_run" == "true" ]]; then notify_args+=(--dry-run); fi
  run_or_print understand_anyway "${notify_args[@]}" || \
    printf '[daily-update] notify nightly failed (best-effort)\n' >&2
else
  printf '[daily-update] notify nightly skipped: %s missing\n' "$nightly_report"
fi

# 4. refresh-prod-server
refresh_args=(--host "$host" --port "$port" --deploy-profile "$deploy_profile")
if [[ -n "$project" ]]; then refresh_args+=(--project "$project"); fi
if [[ -n "$profile" ]]; then refresh_args+=(--profile "$profile"); fi
if [[ -n "$resolved_plugin_root" ]]; then refresh_args+=(--plugin-root "$resolved_plugin_root"); fi
if [[ "$dry_run" == "true" ]]; then refresh_args+=(--dry-run); fi

stage_begin
run_step "refresh-prod-server" bash "$SCRIPT_DIR/refresh-prod-server.sh" "${refresh_args[@]}"
refresh_status=$?
stage_end "refresh-prod-server"
if [[ "$refresh_status" -ne 0 ]]; then
  printf '[daily-update] refresh-prod-server exit=%s\n' "$refresh_status"
fi

printf '[daily-update] completed run_id=%s gateway_published=%s nightly_status=%s refresh_status=%s\n' \
  "$run_id" "$gateway_published" "$nightly_status" "$refresh_status"

# 5. aggregate daily roll-up
aggregate_daily_args=(
  "$SCRIPT_DIR/aggregate-daily.mjs"
  --projects-root "$projects_root"
  --run-id "$run_id"
  --root-dir "$ROOT_DIR"
  --gateway-published "$gateway_published"
  --gateway-publish-reason "$gateway_publish_reason"
  --nightly-status "$nightly_status"
  --refresh-status "$refresh_status"
  --log-path "$log_path"
)
if [[ -n "$deploy_head_before" ]]; then
  aggregate_daily_args+=(--deploy-head-before "$deploy_head_before")
fi
if [[ -n "$deploy_head_after" ]]; then
  aggregate_daily_args+=(--deploy-head-after "$deploy_head_after")
fi
if [[ -n "$stage_self_update" ]]; then
  aggregate_daily_args+=(--stage-duration "self-update=$stage_self_update")
fi
if [[ -n "$stage_gateway_publish" ]]; then
  aggregate_daily_args+=(--stage-duration "gateway-publish=$stage_gateway_publish")
fi
if [[ -n "$stage_nightly_project_sync" ]]; then
  aggregate_daily_args+=(--stage-duration "nightly-project-sync=$stage_nightly_project_sync")
fi
if [[ -n "$stage_refresh_prod_server" ]]; then
  aggregate_daily_args+=(--stage-duration "refresh-prod-server=$stage_refresh_prod_server")
fi
if [[ "$self_update" == "true" ]]; then
  aggregate_daily_args+=(--self-update-status "${self_update_status:-1}")
else
  aggregate_daily_args+=(--self-update-skipped)
fi
node "${aggregate_daily_args[@]}" >/dev/null || \
  printf '[daily-update] aggregate-daily failed (best-effort)\n' >&2

stage_summary=""
if [[ -n "$stage_self_update" ]]; then stage_summary+="self-update=${stage_self_update}s "; fi
if [[ -n "$stage_gateway_publish" ]]; then stage_summary+="gateway-publish=${stage_gateway_publish}s "; fi
if [[ -n "$stage_nightly_project_sync" ]]; then stage_summary+="nightly-project-sync=${stage_nightly_project_sync}s "; fi
if [[ -n "$stage_refresh_prod_server" ]]; then stage_summary+="refresh-prod-server=${stage_refresh_prod_server}s "; fi
if [[ -n "$stage_summary" ]]; then
  printf '[daily-update] stage_summary=%s\n' "${stage_summary% }"
fi

if [[ "$refresh_status" -ne 0 ]]; then
  exit "$refresh_status"
fi
exit "$nightly_status"
