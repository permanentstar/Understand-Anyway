/**
 * `understand-anyway run-review-hook` runner. Spawns `bash -lc <UA_REVIEW_CMD>`
 * via {@link runReviewHook}, validates the resulting `UA_REVIEW_JSON`, and
 * maps the four error kinds to deterministic exit codes (2 / 3 / 4 / 5).
 */
import {
  REVIEW_RUNNER_ERROR_KINDS,
  ReviewRunnerError,
  runReviewHook,
} from "@understand-anyway/core";
import type { ReviewRunHookArgs } from "../args.js";

const EXIT_CODES: Record<string, number> = {
  [REVIEW_RUNNER_ERROR_KINDS.MISSING_COMMAND]: 2,
  [REVIEW_RUNNER_ERROR_KINDS.COMMAND_FAILED]: 3,
  [REVIEW_RUNNER_ERROR_KINDS.OUTPUT_MISSING]: 4,
  [REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID]: 5,
};

export interface RunReviewHookDeps {
  log?: (message: string) => void;
  error?: (message: string) => void;
  exit?: (code: number) => void;
  env?: NodeJS.ProcessEnv;
}

export function runReviewHookCli(args: ReviewRunHookArgs, deps: RunReviewHookDeps = {}): void {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const errLog = deps.error ?? ((m: string) => process.stderr.write(`${m}\n`));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const env = deps.env ?? process.env;

  try {
    const summary = runReviewHook({ reviewCmd: args.reviewCmd, env });
    log(JSON.stringify({
      approved: summary.approved,
      issueCount: summary.issues.length,
      warningCount: summary.warnings.length,
    }));
    exit(0);
  } catch (error) {
    if (error instanceof ReviewRunnerError) {
      errLog(error.message);
      exit(EXIT_CODES[error.kind] ?? 1);
      return;
    }
    throw error;
  }
}
