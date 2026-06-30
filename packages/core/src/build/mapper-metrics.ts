/**
 * Lightweight ndjson metrics + batch-output validation for the segmented
 * mapper (C7). Intentionally minimal:
 *
 *   - `batch-mapper.ndjson` and `batch-output.ndjson` live directly inside the
 *     intermediate dir (same place as `batch-*.json`) — no extra layout.
 *   - `appendMetricsEvent` is best-effort: a write failure must never break
 *     the build, since metrics are purely observational.
 *   - `batchOutputIsValid` is the on-disk truth used by progress logging and
 *     "exit 0 but products incomplete = failure" judgement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const BATCH_MAPPER_METRICS_FILE = "batch-mapper.ndjson";
export const BATCH_OUTPUT_METRICS_FILE = "batch-output.ndjson";

export interface MetricsFsDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string, encoding: "utf8") => void;
  appendFileSync?: (path: string, data: string, encoding: "utf8") => void;
  mkdirSync?: (path: string, options: { recursive: boolean }) => void;
}

function getDeps(deps: MetricsFsDeps): Required<MetricsFsDeps> {
  return {
    existsSync: deps.existsSync ?? existsSync,
    readFileSync: deps.readFileSync ?? readFileSync,
    writeFileSync: deps.writeFileSync ?? writeFileSync,
    appendFileSync: deps.appendFileSync ?? appendFileSync,
    mkdirSync: deps.mkdirSync ?? mkdirSync,
  };
}

export function resetMetricsFile(
  intermediateDir: string,
  fileName: string,
  deps: MetricsFsDeps = {},
): void {
  const d = getDeps(deps);
  d.mkdirSync(intermediateDir, { recursive: true });
  d.writeFileSync(resolve(intermediateDir, fileName), "", "utf8");
}

export function appendMetricsEvent(
  intermediateDir: string,
  fileName: string,
  event: Record<string, unknown>,
  deps: MetricsFsDeps = {},
): void {
  const d = getDeps(deps);
  try {
    d.mkdirSync(intermediateDir, { recursive: true });
    d.appendFileSync(
      resolve(intermediateDir, fileName),
      `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
      "utf8",
    );
  } catch {
    // Metrics are best-effort; a write failure must never break the build.
  }
}

export interface BatchOutputCheckOptions {
  /** When true, the artifact must carry a non-empty LLM-enriched payload. */
  llmEnabled?: boolean;
}

/**
 * Considers a batch output "valid" when the file exists, parses as JSON with
 * a `nodes` array, and (if llmEnabled) carries an `llmEnriched` marker.
 * Matches deploy `batchOutputIsValid` semantics; broken artefacts read as
 * invalid so they get retried/rebuilt on the next attempt.
 */
export function batchOutputIsValid(
  intermediateDir: string,
  batchIndex: number | string,
  options: BatchOutputCheckOptions = {},
  deps: MetricsFsDeps = {},
): boolean {
  const d = getDeps(deps);
  const path = resolve(intermediateDir, `batch-${batchIndex}.json`);
  if (!d.existsSync(path)) return false;
  try {
    const data = JSON.parse(d.readFileSync(path, "utf8")) as unknown;
    if (!data || typeof data !== "object") return false;
    const nodes = (data as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) return false;
    if (options.llmEnabled && !(data as { llmEnriched?: unknown }).llmEnriched) return false;
    return true;
  } catch {
    return false;
  }
}

export function listValidBatchOutputs(
  intermediateDir: string,
  indexes: ReadonlyArray<number | string>,
  options: BatchOutputCheckOptions = {},
  deps: MetricsFsDeps = {},
): Array<number | string> {
  return indexes.filter((idx) => batchOutputIsValid(intermediateDir, idx, options, deps));
}

export function metricsPath(intermediateDir: string, fileName: string): string {
  return resolve(intermediateDir, fileName);
}

// Re-export `dirname` so consumers can derive sibling paths without importing
// node:path twice. Kept here so the module is self-contained for its callers.
export { dirname as _path_dirname };
