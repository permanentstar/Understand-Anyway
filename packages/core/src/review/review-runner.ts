/**
 * Review hook executor + output schema validator. Mirrors the deploy
 * `review-runner` 1:1 (error kinds, exit-code semantics, schema), so the
 * `UA_REVIEW_CMD` contract documented in `nightly-project-sync.sh` is shared
 * between deploy and OSS.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const REVIEW_RUNNER_ERROR_KINDS = {
  MISSING_COMMAND: "missing_command",
  COMMAND_FAILED: "command_failed",
  OUTPUT_MISSING: "output_missing",
  OUTPUT_INVALID: "output_invalid",
} as const;

export type ReviewRunnerErrorKind =
  (typeof REVIEW_RUNNER_ERROR_KINDS)[keyof typeof REVIEW_RUNNER_ERROR_KINDS];

export interface ReviewRunnerOptions {
  reviewCmd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReviewSummary {
  approved: boolean;
  issues: unknown[];
  warnings: unknown[];
  stats: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export class ReviewRunnerError extends Error {
  readonly kind: ReviewRunnerErrorKind;

  constructor(kind: ReviewRunnerErrorKind, message: string) {
    super(message);
    this.name = "ReviewRunnerError";
    this.kind = kind;
  }
}

function normalizeList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeStats(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function loadAndValidateReviewSummary(reviewJsonPath: string): ReviewSummary {
  if (!reviewJsonPath || !existsSync(reviewJsonPath)) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.OUTPUT_MISSING,
      `review output missing: ${reviewJsonPath || "<empty>"}`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(reviewJsonPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID,
      `review output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID,
      "review output must be a JSON object",
    );
  }
  if (typeof raw.approved !== "boolean") {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID,
      "review output field 'approved' must be boolean",
    );
  }
  if (!Array.isArray(raw.issues)) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID,
      "review output field 'issues' must be an array",
    );
  }
  if (!Array.isArray(raw.warnings)) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID,
      "review output field 'warnings' must be an array",
    );
  }
  if (!raw.stats || typeof raw.stats !== "object" || Array.isArray(raw.stats)) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID,
      "review output field 'stats' must be an object",
    );
  }

  return {
    approved: raw.approved,
    issues: normalizeList(raw.issues),
    warnings: normalizeList(raw.warnings),
    stats: normalizeStats(raw.stats),
    raw,
  };
}

export function runReviewHook({ reviewCmd, env = process.env }: ReviewRunnerOptions): ReviewSummary {
  const command = String(reviewCmd || "").trim();
  if (!command) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.MISSING_COMMAND,
      "review command missing",
    );
  }

  const reviewJsonPath = String(env.UA_REVIEW_JSON || "").trim();
  const result = spawnSync("bash", ["-lc", command], {
    env,
    stdio: "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new ReviewRunnerError(
      REVIEW_RUNNER_ERROR_KINDS.COMMAND_FAILED,
      `review command failed with exit code ${result.status ?? "unknown"}`,
    );
  }

  return loadAndValidateReviewSummary(reviewJsonPath);
}
