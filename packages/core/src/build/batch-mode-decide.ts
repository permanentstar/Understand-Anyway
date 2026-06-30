/**
 * Phase 2 batch-mode resolution. Pure function: `auto` is the public default
 * and resolves to `full` for fixture/toy workloads and `segmented` for real
 * repos.
 *
 * Decision rules:
 *
 *     full      -> full
 *     segmented -> segmented
 *     auto      -> batchCount<=3 && fileCount<=50 ? "full" : "segmented"
 *
 * Host metrics (cpu/mem) only flow into the human-readable `reason` string;
 * the decision itself depends solely on workload size so tests stay stable.
 */

export type BatchMode = "auto" | "full" | "segmented";
export type ResolvedBatchMode = Exclude<BatchMode, "auto">;

const FIXTURE_BATCH_THRESHOLD = 3;
const FIXTURE_FILE_THRESHOLD = 50;

export interface BatchModeDecisionInput {
  mode: BatchMode;
  batchCount: number;
  fileCount: number;
  /** Optional host metrics, surfaced only in `reason` (decision-irrelevant). */
  cpuCount?: number;
  memoryGb?: number;
}

export interface BatchModeDecision {
  mode: ResolvedBatchMode;
  /** Human-readable reason; safe for build logs. */
  reason: string;
}

export function decideBatchMode(input: BatchModeDecisionInput): BatchModeDecision {
  const hostSuffix = formatHostSuffix(input.cpuCount, input.memoryGb);
  if (input.mode === "full") return { mode: "full", reason: `explicit full mode${hostSuffix}` };
  if (input.mode === "segmented") return { mode: "segmented", reason: `explicit segmented mode${hostSuffix}` };

  if (input.batchCount <= FIXTURE_BATCH_THRESHOLD && input.fileCount <= FIXTURE_FILE_THRESHOLD) {
    return {
      mode: "full",
      reason: `auto: tiny workload, batches=${input.batchCount}, files=${input.fileCount}${hostSuffix}`,
    };
  }
  return {
    mode: "segmented",
    reason: `auto: segmented mapper, batches=${input.batchCount}, files=${input.fileCount}${hostSuffix}`,
  };
}

function formatHostSuffix(cpuCount?: number, memoryGb?: number): string {
  if (cpuCount === undefined && memoryGb === undefined) return "";
  const cpu = cpuCount !== undefined ? `cpu=${cpuCount}` : "";
  const mem = memoryGb !== undefined ? `memGb=${memoryGb.toFixed(1)}` : "";
  return `, ${[cpu, mem].filter(Boolean).join(", ")}`;
}
