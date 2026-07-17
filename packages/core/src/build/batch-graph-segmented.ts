/**
 * Parent-process scheduler for the segmented mapper (C7).
 *
 * Splits the missing batch indexes into enough segments to fill the configured
 * mapper slots, and validates each
 * segment's artefacts on disk before considering it successful.
 *
 * Capability coverage (plan §2):
 *   #1  mappers knob + auto segment sizing (from caller)
 *   #3  spawn child workers via the batch-mapper-worker subcommand
 *   #4  file-based hand-off of batch indexes (batch-indexes-<s>-<e>.txt)
 *   #5  "exit 0 but products incomplete = failure" judgement
 *   #6  60s progress logging with disk-truth ratios + ETA
 *   #7  ndjson metrics (mapper-segment events + summary)
 *   #8  LLM budget split across worker slots (when LLM is enabled)
 *   #10 hooks into mapper-reaper so SIGINT cleans children
 *   #11 caller-built `--llm-*` argv slice is appended verbatim
 *   #12 parent->child env passing (UA_BATCH_*)
 *   #13 disk-truth progress (listValidBatchOutputs) on every tick
 *
 * Everything mutable (spawn / fs / time / log / reaper registry) is
 * injectable so unit tests run without real spawns.
 */

import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { writeFileSync as nodeWriteFileSync, mkdirSync as nodeMkdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitLlmBudgetForMapperSlots, type LlmBudgetSlot } from "./llm-budget-split.js";
import {
  appendMetricsEvent,
  BATCH_MAPPER_METRICS_FILE,
  BATCH_OUTPUT_METRICS_FILE,
  batchOutputIsValid,
  listValidBatchOutputs,
  resetMetricsFile,
  type MetricsFsDeps,
} from "./mapper-metrics.js";
import {
  getDefaultReaperRegistry,
  trackChildProcess,
  type ReaperRegistry,
  type TrackableChild,
} from "./mapper-reaper.js";

export interface SegmentedBatch {
  batchIndex: number | string;
  files?: Array<{ path: string }>;
}

export interface SegmentedLlmConfig {
  enabled: boolean;
  /** Extra argv suffix for the worker, e.g. ["--llm-analysis", "--llm-provider", "..."]. */
  extraArgs: string[];
  /** Required total budget; the scheduler splits this across worker slots. */
  globalConcurrency: number;
  qpmLimit: number;
}

export interface SegmentedScheduleOptions {
  /** Absolute path of the CLI entry to spawn (set by build.ts at runtime). */
  cliEntry: string;
  /** State root the worker writes batch-*.json into. */
  analysisRoot: string;
  /** Project root (passed through to the worker for git/wrap). */
  projectRoot: string;
  /** Where batch-*.json + indexes/metrics files live. */
  intermediateDir: string;
  /** Pre-computed batch list (must match what the worker will see). */
  batches: SegmentedBatch[];
  /** When set, only batches that contain any of these paths are scheduled. */
  includePaths?: ReadonlyArray<string>;
  outputLanguage: string;
  projectName: string;
  gitHash: string;
  /** When `>0`, scan root differs from analysisRoot (forwarded via env). */
  scanRoot?: string;
  /** Optional LLM injection; when enabled, budget is split per slot. */
  llm?: SegmentedLlmConfig;
  /** Plugin root override (worker uses it via env). */
  pluginRoot?: string | null;
  mappers: number;
  /** Status / progress sink. Tests inject a no-op log. */
  log: (line: string) => void;
}

export interface SegmentedScheduleResult {
  segments: number;
  missing: number;
  written: number;
  mapperBatchCount?: number;
  /** Map of slot index -> assigned budget; absent when LLM is off. */
  slotBudgets?: LlmBudgetSlot[];
}

export type SpawnLike = (
  command: string,
  argv: ReadonlyArray<string>,
  options?: SpawnOptions,
) => ChildProcess;

export interface SchedulerDeps extends MetricsFsDeps {
  spawn?: SpawnLike;
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (handle: NodeJS.Timeout) => void;
  now?: () => number;
  reaperRegistry?: ReaperRegistry;
}

const PROGRESS_INTERVAL_MS = 60_000;
const SEGMENT_EVENT_TYPE = "mapper-segment";
const SCHEDULER_EVENT_TYPE = "mapper-scheduler";

function applyIncludeFilter(
  batches: SegmentedBatch[],
  includePaths?: ReadonlyArray<string>,
): SegmentedBatch[] {
  if (!includePaths || includePaths.length === 0) return batches;
  const includeSet = new Set(includePaths);
  return batches.filter((batch) => (batch.files || []).some((file) => includeSet.has(file.path)));
}

function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const result: T[][] = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += step) {
    result.push(items.slice(i, i + step));
  }
  return result;
}

function workerSlotsFor(missing: number, requested: number, llm?: SegmentedLlmConfig): number {
  const targetSlots = Math.max(1, Math.min(requested, Math.max(1, missing)));
  if (!llm?.enabled) return targetSlots;
  return Math.max(1, Math.min(targetSlots, llm.globalConcurrency, llm.qpmLimit));
}

function writeIndexesFile(
  intermediateDir: string,
  segment: Array<number | string>,
  deps: MetricsFsDeps,
): string {
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  const mkdir = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { nodeMkdirSync(p, o); });
  mkdir(intermediateDir, { recursive: true });
  const start = segment[0];
  const end = segment[segment.length - 1];
  const path = resolve(intermediateDir, `batch-indexes-${start}-${end}.txt`);
  write(path, `${segment.join("\n")}\n`, "utf8");
  return path;
}

function writeIncludeFile(
  intermediateDir: string,
  includePaths: ReadonlyArray<string>,
  deps: MetricsFsDeps,
): string {
  const write = deps.writeFileSync ?? ((p: string, d: string, e: "utf8") => nodeWriteFileSync(p, d, e));
  const mkdir = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { nodeMkdirSync(p, o); });
  mkdir(intermediateDir, { recursive: true });
  const path = resolve(intermediateDir, "batch-include-paths.txt");
  write(path, `${[...includePaths].sort().join("\n")}\n`, "utf8");
  return path;
}

function buildWorkerArgs(
  options: SegmentedScheduleOptions,
  indexesFile: string,
  includeFile: string | null,
  slotBudget: LlmBudgetSlot | undefined,
): string[] {
  const argv: string[] = [
    options.cliEntry,
    "batch-mapper-worker",
    "--state-dir", options.analysisRoot,
    "--project-root", options.projectRoot,
    "--output-language", options.outputLanguage,
    "--indexes-file", indexesFile,
  ];
  if (includeFile) argv.push("--include-paths-file", includeFile);
  if (options.pluginRoot) argv.push("--plugin-root", options.pluginRoot);
  if (options.llm?.enabled) {
    argv.push(...options.llm.extraArgs);
    if (slotBudget) {
      argv.push("--global-llm-concurrency", String(slotBudget.globalConcurrency));
      argv.push("--llm-qpm-limit", String(slotBudget.qpmLimit));
    }
  }
  return argv;
}

function buildWorkerEnv(options: SegmentedScheduleOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UA_BATCH_SCAN_ROOT: options.scanRoot ?? options.analysisRoot,
    UA_BATCH_PROJECT_NAME: options.projectName,
    UA_BATCH_GIT_HASH: options.gitHash,
    UA_CLI_ENTRY: options.cliEntry,
  };
}

interface RunSegmentResult {
  ok: boolean;
  durationMs: number;
  /** Indexes whose batch-*.json was missing / invalid after the worker exited. */
  invalid: Array<number | string>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

async function runOneSegment(
  options: SegmentedScheduleOptions,
  segment: Array<number | string>,
  workerIndex: number,
  slotBudget: LlmBudgetSlot | undefined,
  deps: SchedulerDeps,
): Promise<RunSegmentResult> {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? Date.now;
  const indexesFile = writeIndexesFile(options.intermediateDir, segment, deps);
  const includeFile = options.includePaths && options.includePaths.length > 0
    ? writeIncludeFile(options.intermediateDir, options.includePaths, deps)
    : null;
  const argv = buildWorkerArgs(options, indexesFile, includeFile, slotBudget);
  const startedAt = now();

  options.log(
    `[mapper] worker ${workerIndex} segment ${segment[0]}-${segment[segment.length - 1]} (${segment.length} batches)`
    + (slotBudget ? ` llm-budget=${slotBudget.globalConcurrency}/${slotBudget.qpmLimit}` : ""),
  );

  const childOpts: SpawnOptions = { stdio: "inherit", env: buildWorkerEnv(options) };
  const child = spawnFn(process.execPath, argv, childOpts) as ChildProcess & TrackableChild;
  trackChildProcess(child, deps.reaperRegistry ?? getDefaultReaperRegistry());

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  });
  const durationMs = now() - startedAt;
  const llmEnabled = Boolean(options.llm?.enabled);
  const invalid = segment.filter(
    (idx) => !batchOutputIsValid(options.intermediateDir, idx, { llmEnabled }, deps),
  );
  return { ok: exit.code === 0 && invalid.length === 0, durationMs, invalid, exitCode: exit.code, signal: exit.signal };
}

export async function writeBatchGraphFilesSegmented(
  options: SegmentedScheduleOptions,
  deps: SchedulerDeps = {},
): Promise<SegmentedScheduleResult> {
  const filtered = applyIncludeFilter(options.batches, options.includePaths);
  const indexes = filtered
    .map((batch) => batch.batchIndex)
    .filter((idx) => idx !== undefined && idx !== null);
  const llmEnabled = Boolean(options.llm?.enabled);
  const missingIndexes = indexes.filter(
    (idx) => !batchOutputIsValid(options.intermediateDir, idx, { llmEnabled }, deps),
  );
  const totalFiles = filtered.reduce((acc, batch) => acc + (batch.files?.length ?? 0), 0);

  resetMetricsFile(options.intermediateDir, BATCH_MAPPER_METRICS_FILE, deps);
  resetMetricsFile(options.intermediateDir, BATCH_OUTPUT_METRICS_FILE, deps);

  if (missingIndexes.length === 0) {
    options.log("[mapper] no missing batches; nothing to do");
    appendMetricsEvent(
      options.intermediateDir,
      BATCH_MAPPER_METRICS_FILE,
      { type: SCHEDULER_EVENT_TYPE, status: "skipped", missing: 0 },
      deps,
    );
    return { segments: 0, missing: 0, written: 0 };
  }

  const slots = workerSlotsFor(missingIndexes.length, options.mappers, options.llm);
  const mapperBatchCount = Math.max(1, Math.ceil(missingIndexes.length / slots));
  const segments = chunk(missingIndexes, mapperBatchCount);
  options.log(`[mapper] auto mapperBatchCount=${mapperBatchCount} for missing=${missingIndexes.length}, slots=${slots}`);
  const slotBudgets = options.llm?.enabled
    ? splitLlmBudgetForMapperSlots(
        { globalConcurrency: options.llm.globalConcurrency, qpmLimit: options.llm.qpmLimit },
        slots,
      )
    : undefined;
  if (slotBudgets) {
    options.log(`[mapper] llm budget split into ${slots} slots: ${slotBudgets.map((s) => `${s.globalConcurrency}/${s.qpmLimit}`).join(", ")}`);
  }

  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const buildStartedAt = (deps.now ?? Date.now)();

  const progressTimer = setIntervalFn(() => {
    const validIndexes = listValidBatchOutputs(options.intermediateDir, missingIndexes, { llmEnabled }, deps);
    const completed = validIndexes.length;
    const elapsedMin = ((deps.now ?? Date.now)() - buildStartedAt) / 60_000;
    const rate = elapsedMin > 0 ? completed / elapsedMin : 0;
    const remaining = missingIndexes.length - completed;
    const eta = rate > 0 ? remaining / rate : 0;
    const pct = Math.round((completed / Math.max(1, missingIndexes.length)) * 100);
    options.log(
      `[mapper] progress ${completed}/${missingIndexes.length} batches (${pct}%), `
      + `${totalFiles} files in scope, ${rate.toFixed(1)} batches/min, eta=${Math.ceil(eta)}min`,
    );
  }, PROGRESS_INTERVAL_MS);

  let nextSegment = 0;
  const worker = async (slot: number): Promise<void> => {
    while (true) {
      const segmentIndex = nextSegment++;
      if (segmentIndex >= segments.length) return;
      const segment = segments[segmentIndex]!;
      const result = await runOneSegment(options, segment, slot, slotBudgets?.[slot], deps);
      appendMetricsEvent(
        options.intermediateDir,
        BATCH_MAPPER_METRICS_FILE,
        {
          type: SEGMENT_EVENT_TYPE,
          status: result.ok ? "success" : "failed",
          slot,
          segmentStart: segment[0],
          segmentEnd: segment[segment.length - 1],
          segmentSize: segment.length,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          signal: result.signal,
          invalid: result.invalid,
        },
        deps,
      );
      if (!result.ok) {
        throw new Error(
          `mapper segment ${segment[0]}-${segment[segment.length - 1]} failed`
          + (result.exitCode !== 0 ? ` (exit=${result.exitCode}${result.signal ? `, signal=${result.signal}` : ""})` : "")
          + (result.invalid.length > 0 ? ` invalid=${result.invalid.length}` : ""),
        );
      }
    }
  };

  try {
    const workers = Array.from({ length: slots }, (_, slot) => worker(slot));
    await Promise.all(workers);
  } finally {
    clearIntervalFn(progressTimer);
  }

  const written = listValidBatchOutputs(options.intermediateDir, missingIndexes, { llmEnabled }, deps).length;
  appendMetricsEvent(
    options.intermediateDir,
    BATCH_MAPPER_METRICS_FILE,
    { type: SCHEDULER_EVENT_TYPE, status: "success", segments: segments.length, missing: missingIndexes.length, written, mapperBatchCount },
    deps,
  );

  return { segments: segments.length, missing: missingIndexes.length, written, mapperBatchCount, slotBudgets };
}
