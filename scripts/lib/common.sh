#!/usr/bin/env bash
# scripts/lib/common.sh
#
# Shared bash helpers for daily-update / nightly-project-sync / refresh-prod-server.
# Source from each script:
#   . "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib/common.sh"
#
# All helpers are pure and idempotent. No side effects beyond what each helper
# documents.

# shellcheck shell=bash

# Load ~/.env into the current shell, but never overwrite an existing variable.
# Safe to call multiple times.
load_env_file() {
  local env_file="${HOME}/.env"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line
    line="$(printf '%s' "$raw_line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    local key="${line%%=*}"
    [[ "$key" != "$line" ]] || continue
    local val="${line#*=}"
    if [[ -z "${!key:-}" ]]; then
      export "$key"="$val"
    fi
  done < "$env_file"
}

# Print ISO 8601 timestamp with timezone, e.g. 2026-06-23T15:42:01+08:00.
timestamp_now() {
  date +"%Y-%m-%dT%H:%M:%S%z" | sed -E 's/([+-][0-9]{2})([0-9]{2})$/\1:\2/'
}

# require_value <flag> <value> — exit 2 if value is empty or starts with --.
require_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    printf 'Missing value for %s\n' "$flag" >&2
    exit 2
  fi
}

# resolve_projects_root — print the OSS-neutral projects root.
# Order: $UA_PROJECTS_ROOT > $HOME/understand-projects.
resolve_projects_root() {
  if [[ -n "${UA_PROJECTS_ROOT:-}" ]]; then
    printf '%s\n' "$UA_PROJECTS_ROOT"
    return 0
  fi
  printf '%s\n' "$HOME/understand-projects"
}

# resolve_deploy_profile <cli-override> — resolve the deployment profile.
# Order: CLI override > UA_DEPLOY_PROFILE env (loaded from ~/.env).
# Exits 2 when neither is configured or the value is not prod/ppe/dev.
# The `auto` keyword is intentionally NOT supported: every machine must declare
# its deployment role explicitly, either via the script flag or ~/.env.
resolve_deploy_profile() {
  local cli_override="${1:-}"
  local resolved="${cli_override:-${UA_DEPLOY_PROFILE:-}}"
  case "$resolved" in
    prod|ppe|dev)
      printf '%s\n' "$resolved"
      return 0
      ;;
    "")
      printf 'deploy profile not configured: set UA_DEPLOY_PROFILE in ~/.env or pass --deploy-profile <prod|ppe|dev>\n' >&2
      return 2
      ;;
    *)
      printf 'invalid deploy profile: %s (expected prod|ppe|dev)\n' "$resolved" >&2
      return 2
      ;;
  esac
}

# run_step <name> -- <cmd...> — wrap a command with start/finish log lines.
# Returns the wrapped command's exit code.
run_step() {
  local name="$1"
  shift
  printf '[%s] step=%s started_at=%s\n' "${UA_LOG_TAG:-script}" "$name" "$(timestamp_now)"
  "$@"
  local status=$?
  printf '[%s] step=%s finished_at=%s status=%s\n' "${UA_LOG_TAG:-script}" "$name" "$(timestamp_now)" "$status"
  return "$status"
}

# run_or_print <cmd...> — when UA_DRY_RUN=true, print the command and skip
# execution; otherwise spawn it. Returns 0 in dry-run mode regardless.
run_or_print() {
  if [[ "${UA_DRY_RUN:-false}" == "true" ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

# understand_anyway <args...> — resolve the CLI for repo-checkout deployments.
# Prefer a user-installed command on PATH; when absent, fall back to this
# checkout's built CLI at <repo>/packages/cli/dist/cli.js.
understand_anyway() {
  if command -v understand-anyway >/dev/null 2>&1; then
    command understand-anyway "$@"
    return $?
  fi
  local root="${ROOT_DIR:-}"
  local local_cli="$root/packages/cli/dist/cli.js"
  if [[ -n "$root" && -f "$local_cli" ]]; then
    node "$local_cli" "$@"
    return $?
  fi
  printf 'understand-anyway command not found and local CLI is missing: %s\n' "$local_cli" >&2
  return 127
}
