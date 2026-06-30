/**
 * Phase 3 — merge. Runs the upstream `merge-batch-graphs.py` script via a
 * Python compat wrapper that injects `from __future__ import annotations` so it
 * works across Python versions. Ported verbatim from deploy
 * `runPythonCompatScript`.
 */

import { execFileSync as nodeExecFileSync } from "node:child_process";
import { join } from "node:path";
import type { BuildLog } from "./scan.js";

export interface MergeFsDeps {
  execFileSync?: typeof nodeExecFileSync;
}

const PYTHON_COMPAT_RUNNER = [
  "import sys",
  "from pathlib import Path",
  "script = Path(sys.argv[1])",
  "code = 'from __future__ import annotations\\n' + script.read_text(encoding='utf-8')",
  "globals_dict = {'__name__': '__main__', '__file__': str(script)}",
  "sys.argv = [str(script), *sys.argv[2:]]",
  "exec(compile(code, str(script), 'exec'), globals_dict)",
].join("; ");

export function runPythonCompatScript(
  scriptPath: string,
  args: string[],
  cwd: string,
  deps: MergeFsDeps = {},
): void {
  const exec = deps.execFileSync ?? nodeExecFileSync;
  exec("python3", ["-c", PYTHON_COMPAT_RUNNER, scriptPath, ...args], { cwd, stdio: "inherit" });
}

export interface RunMergeOptions {
  skillDir: string;
  analysisRoot: string;
  log: BuildLog;
}

export function runMergePhase(options: RunMergeOptions, deps: MergeFsDeps = {}): void {
  const { skillDir, analysisRoot, log } = options;
  log("phase 3/4 merge batch graphs");
  runPythonCompatScript(join(skillDir, "merge-batch-graphs.py"), [analysisRoot], analysisRoot, deps);
}
