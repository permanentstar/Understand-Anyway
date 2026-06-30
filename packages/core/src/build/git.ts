/**
 * Git metadata helpers used to stamp graph/meta provenance. `execFile` is
 * injectable so tests run without a real git repo.
 */

import { execFileSync as nodeExecFileSync } from "node:child_process";

export interface GitDeps {
  execFileSync?: typeof nodeExecFileSync;
}

function exec(deps: GitDeps): typeof nodeExecFileSync {
  return deps.execFileSync ?? nodeExecFileSync;
}

export function currentGitHash(projectRoot: string, deps: GitDeps = {}): string {
  try {
    return exec(deps)("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).toString().trim();
  } catch {
    return "unknown";
  }
}

export function currentGitDirty(projectRoot: string, deps: GitDeps = {}): boolean {
  try {
    const status = exec(deps)("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).toString().trim();
    return status.length > 0;
  } catch {
    return true;
  }
}
