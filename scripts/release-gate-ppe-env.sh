#!/usr/bin/env bash
# Source this file before running PPE external release-gate cases.
#
# Usage:
#   source scripts/release-gate-ppe-env.sh
#   pnpm run release:gate -- --external ppe-repo --external ppe-npm-installed --external ppe-ops --external ppe-real-llm

if [[ -n "${BASH_VERSION:-}" && "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'release-gate-ppe-env.sh must be sourced, not executed:\n' >&2
  printf '  source scripts/release-gate-ppe-env.sh\n' >&2
  exit 2
fi

if [[ -n "${BASH_VERSION:-}" ]]; then
  __ua_ppe_env_source_path="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  eval '__ua_ppe_env_source_path="${(%):-%x}"'
else
  __ua_ppe_env_source_path="$0"
fi

__ua_ppe_env_script_dir="$(cd -- "$(dirname -- "$__ua_ppe_env_source_path")" && pwd -P)"
__ua_ppe_env_repo_root="$(cd -- "$__ua_ppe_env_script_dir/.." && pwd -P)"

: "${UA_RELEASE_GATE_PPE_HOST:=10.37.226.132}"
: "${UA_RELEASE_GATE_PPE_USER:=suheng.cloud}"
: "${UA_RELEASE_GATE_PPE_ROOT:=/data00/home/suheng.cloud/understand-anyway-ppe}"
: "${UA_RELEASE_GATE_PPE_PLUGIN_ROOT:=/data00/home/suheng.cloud/.local/share/understand-anything-plugin/understand-anything-plugin}"
: "${UA_RELEASE_GATE_PPE_TRAEX_BIN:=/home/${UA_RELEASE_GATE_PPE_USER}/.local/bin/traex}"
: "${UA_RELEASE_GATE_PPE_REGISTRY:=http://127.0.0.1:4873}"

__ua_ppe_env_find_repo_base() {
  local root="$1"
  local candidate
  for candidate in "$root"/*; do
    [[ -d "$candidate/repo" && -d "$candidate/projects-root" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

__ua_ppe_env_find_latest_npm_dir() {
  local root="$1"
  local latest=""
  local candidate
  for candidate in "$root"/npm-installed-*; do
    [[ -d "$candidate/install" ]] || continue
    latest="$candidate"
  done
  [[ -n "$latest" ]] || return 1
  printf '%s\n' "$latest"
}

if [[ -z "${UA_RELEASE_GATE_PPE_REPO_DIR:-}" || -z "${UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT:-}" ]]; then
  __ua_ppe_env_repo_base="$(__ua_ppe_env_find_repo_base "$UA_RELEASE_GATE_PPE_ROOT" 2>/dev/null || true)"
  if [[ -n "$__ua_ppe_env_repo_base" ]]; then
    : "${UA_RELEASE_GATE_PPE_REPO_DIR:=$__ua_ppe_env_repo_base/repo}"
    : "${UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT:=$__ua_ppe_env_repo_base/projects-root}"
  fi
fi

if [[ -z "${UA_RELEASE_GATE_PPE_NPM_DIR:-}" ]]; then
  __ua_ppe_env_npm_dir="$(__ua_ppe_env_find_latest_npm_dir "$UA_RELEASE_GATE_PPE_ROOT" 2>/dev/null || true)"
  if [[ -n "$__ua_ppe_env_npm_dir" ]]; then
    UA_RELEASE_GATE_PPE_NPM_DIR="$__ua_ppe_env_npm_dir"
  fi
fi

export UA_RELEASE_GATE_PPE_HOST
export UA_RELEASE_GATE_PPE_USER
export UA_RELEASE_GATE_PPE_ROOT
export UA_RELEASE_GATE_PPE_PLUGIN_ROOT
export UA_RELEASE_GATE_PPE_REPO_DIR
export UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT
export UA_RELEASE_GATE_PPE_NPM_DIR
export UA_RELEASE_GATE_PPE_TRAEX_BIN
export UA_RELEASE_GATE_PPE_REGISTRY

: "${UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD:=node '$__ua_ppe_env_repo_root/scripts/release-gate-ppe.mjs' --case ppe-repo}"
: "${UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD:=node '$__ua_ppe_env_repo_root/scripts/release-gate-ppe.mjs' --case ppe-npm-installed}"
: "${UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD:=node '$__ua_ppe_env_repo_root/scripts/release-gate-ppe.mjs' --case ppe-ops}"
: "${UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD:=node '$__ua_ppe_env_repo_root/scripts/release-gate-ppe.mjs' --case ppe-real-llm}"
: "${UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD:=node '$__ua_ppe_env_repo_root/scripts/release-gate-ppe.mjs' --case ppe-oss-release}"

export UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD
export UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD
export UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD
export UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD
export UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD

unset __ua_ppe_env_script_dir
unset __ua_ppe_env_repo_root
unset __ua_ppe_env_source_path
unset __ua_ppe_env_repo_base
unset __ua_ppe_env_npm_dir
