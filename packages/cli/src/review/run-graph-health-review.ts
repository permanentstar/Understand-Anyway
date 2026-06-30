/**
 * `understand-anyway review-graph-health` runner. Wraps {@link
 * runGraphHealthReview} with the project/output pair, writes the
 * full review JSON to disk, prints a one-line `{approved,issueCount,
 * warningCount}` summary and exits 0/1.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runGraphHealthReview } from "@understand-anyway/core";
import type { ReviewGraphHealthArgs } from "../args.js";
import { resolveProjectContext } from "../project-context.js";

export interface RunReviewGraphHealthDeps {
  log?: (message: string) => void;
  exit?: (code: number) => void;
  writeFile?: (path: string, content: string) => void;
  resolveProjectContext?: typeof resolveProjectContext;
}

export function runReviewGraphHealth(args: ReviewGraphHealthArgs, deps: RunReviewGraphHealthDeps = {}): void {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const writeFile = deps.writeFile ?? ((p, c) => writeFileSync(p, c));
  const resolveCtx = deps.resolveProjectContext ?? resolveProjectContext;
  const ctx = resolveCtx(args.projectId);

  const result = runGraphHealthReview({
    repoPath: resolve(ctx.repoPath),
    stateDir: resolve(ctx.stateRoot),
  });
  writeFile(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`);
  log(JSON.stringify({
    approved: result.approved,
    issueCount: result.issues.length,
    warningCount: result.warnings.length,
  }));
  exit(result.approved ? 0 : 1);
}
