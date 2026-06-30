/**
 * Optional LLM file analysis for the build pipeline.
 *
 * Understand-Anyway never authors prompts or parses responses itself: it calls
 * upstream's `@understand-anything/core` exports (`buildFileAnalysisPrompt` /
 * `parseFileAnalysisResponse`) and only owns *when* to invoke a configured
 * provider and *how* to fold failures into the build. The default build runs
 * none of this (enabled=false); `--llm-analysis` turns it on and requires a
 * provider; `--llm-required` turns per-file failures into a build failure.
 *
 * Each call goes through `callWithRetry` so transient provider failures
 * (rate-limit / overload / timeout / network) are retried per the configured
 * `RetryPolicy`. Optional model candidates are neutral request metadata:
 * providers may honor `request.model`, while core owns only task-level
 * switching, cooldown, and stats.
 *
 * Everything is injectable (provider, readFile, core) so the CI main gate runs
 * with a fake provider and no upstream / no API key.
 */

import { LlmError, type LlmErrorKind, type LlmProvider } from "@understand-anyway/plugin-api";
import {
  callWithRetry,
  DEFAULT_RETRY_POLICY,
  type CallWithRetryDeps,
  type RetryAttemptLog,
  type RetryPolicy,
} from "./llm-retry.js";

/** Per-file analysis shape, mirroring upstream `parseFileAnalysisResponse`. */
export interface LLMFileAnalysis {
  fileSummary: string;
  tags: string[];
  complexity: "simple" | "moderate" | "complex";
  functionSummaries: Record<string, string>;
  classSummaries: Record<string, string>;
  languageNotes?: string;
}

export interface LlmBuildOptions {
  enabled: boolean;
  required: boolean;
  provider?: LlmProvider;
  timeoutMs?: number;
  /** Optional retry policy; falls back to DEFAULT_RETRY_POLICY when omitted. */
  retryPolicy?: RetryPolicy;
  /** Ordered model candidates. Providers may honor `request.model`. */
  modelCandidates?: string[];
  /** Cooldown applied to a model after a retryable task failure. Defaults to 60s. */
  modelCooldownMs?: number;
}

export interface LlmFailureRecord {
  filePath: string;
  reason: string;
  /** Final attempt's error classification (when known). */
  kind?: LlmErrorKind;
  /** Full per-attempt log for diagnostics. */
  attempts?: RetryAttemptLog[];
}

export interface LlmRetryStats {
  /** Number of attempts beyond the first that were retryable failures. */
  transientHits: number;
  /** Total attempts made across all files (>= requested). */
  totalAttempts: number;
}

export interface LlmModelGuardEvent {
  model: string;
  action: "cooldown";
  kind: LlmErrorKind;
  reason: string;
  cooldownUntil: number;
}

export interface LlmBuildStats {
  enabled: boolean;
  providerName?: string;
  requested: number;
  analyzed: number;
  failed: number;
  skipped: number;
  failures: LlmFailureRecord[];
  /** Retry counters; absent when LLM is disabled. */
  retries?: LlmRetryStats;
  /** Number of provider tasks. A task may analyze one file or a batch wrapper of multiple files. */
  tasks?: number;
  /** True when consecutive retryable task failures stopped the remaining work. */
  breakerTripped?: boolean;
  /** Current model candidate after automatic switching. */
  activeModel?: string;
  /** Number of times orchestration advanced to a later model candidate. */
  modelSwitches?: number;
  /** Model guard/cooldown events emitted after retryable task failures. */
  modelGuards?: LlmModelGuardEvent[];
}

export interface LlmPromptStub {
  operation: string;
  prompt: string;
  target?: string;
}

export interface LlmAttemptJournalEntry {
  scope: "file" | "graph";
  operation: string;
  target?: string;
  status: "ok" | "failed" | "partial";
  attempts: RetryAttemptLog[];
  reason?: string;
  kind?: LlmErrorKind;
}

export interface LlmArtifacts {
  promptStubs: LlmPromptStub[];
  attemptJournal: LlmAttemptJournalEntry[];
}

export interface LlmAnalysisFile {
  path: string;
}

export interface RunLlmFileAnalysisOptions {
  enabled: boolean;
  required: boolean;
  files: LlmAnalysisFile[];
  analysisRoot: string;
  projectContext: string;
  readFile: (absPath: string) => string;
  provider?: LlmProvider;
  /** Upstream `@understand-anything/core` (prompt builder + parser). */
  core: any;
  timeoutMs?: number;
  /** Optional retry policy; defaults to DEFAULT_RETRY_POLICY. */
  retryPolicy?: RetryPolicy;
  /** Per-worker QPM cap. Values <=0 disable throttling. */
  qpmLimit?: number;
  /** Reserved for future parallel file analysis; current implementation is sequential. */
  globalConcurrency?: number;
  /** Max primary files per batch-wrapper provider call. Defaults to 15. */
  taskFileCount?: number;
  /** Consecutive retryable task failures before aborting remaining tasks. Defaults to 5. */
  breakerRetryableFailureThreshold?: number;
  /** Ordered model candidates. Providers may honor `request.model`. */
  modelCandidates?: string[];
  /** Cooldown applied to a model after a retryable task failure. Defaults to 60s. */
  modelCooldownMs?: number;
  /** Test seam: injectable sleep/random/now for the retry layer. */
  retryDeps?: CallWithRetryDeps;
}

export interface LlmFileAnalysisRun {
  analyses: Map<string, LLMFileAnalysis>;
  stats: LlmBuildStats;
  artifacts?: LlmArtifacts;
}

export type LlmGraphStage = "layers" | "project-summary" | "tour";

export interface LlmGraphFailureRecord {
  stage: LlmGraphStage;
  reason: string;
  kind?: LlmErrorKind;
  attempts?: RetryAttemptLog[];
}

export interface LlmGraphStats {
  enabled: boolean;
  providerName?: string;
  requested: number;
  applied: number;
  failed: number;
  skipped: number;
  failures: LlmGraphFailureRecord[];
  retries?: LlmRetryStats;
}

export interface RunLlmGraphEnhancementOptions {
  enabled: boolean;
  required: boolean;
  graph: any;
  projectContext: string;
  provider?: LlmProvider;
  core: any;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  modelCandidates?: string[];
  retryDeps?: CallWithRetryDeps;
}

export interface LlmGraphEnhancementRun {
  graph: any;
  stats: LlmGraphStats;
  artifacts?: LlmArtifacts;
}

function emptyStats(enabled: boolean, providerName?: string): LlmBuildStats {
  return {
    enabled,
    providerName,
    requested: 0,
    analyzed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    retries: enabled ? { transientHits: 0, totalAttempts: 0 } : undefined,
    tasks: 0,
    breakerTripped: false,
    modelSwitches: 0,
  };
}

function emptyGraphStats(enabled: boolean, providerName?: string): LlmGraphStats {
  return {
    enabled,
    providerName,
    requested: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    retries: enabled ? { transientHits: 0, totalAttempts: 0 } : undefined,
  };
}

export async function runLlmFileAnalysis(options: RunLlmFileAnalysisOptions): Promise<LlmFileAnalysisRun> {
  const analyses = new Map<string, LLMFileAnalysis>();

  if (!options.enabled) {
    return { analyses, stats: emptyStats(false) };
  }
  if (!options.provider) {
    throw new Error("build: no LLM provider configured (pass --llm-provider or disable --llm-analysis)");
  }

  const provider = options.provider;
  const buildPrompt = options.core?.buildFileAnalysisPrompt;
  const parseResponse = options.core?.parseFileAnalysisResponse;
  if (typeof buildPrompt !== "function" || typeof parseResponse !== "function") {
    throw new Error("build: upstream core is missing buildFileAnalysisPrompt/parseFileAnalysisResponse (LLM analysis unavailable)");
  }

  const stats = emptyStats(true, provider.name);
  const artifacts: LlmArtifacts = { promptStubs: [], attemptJournal: [] };
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const throttleSleep = options.retryDeps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.qpmLimit && options.qpmLimit > 0
    ? 60_000 / options.qpmLimit
    : 0;
  const tasks = createFileAnalysisTasks(options.files, options.taskFileCount ?? 15);
  stats.tasks = tasks.length;
  const workerCount = Math.max(1, Math.floor(options.globalConcurrency ?? 1));
  let nextTaskIndex = 0;
  let consecutiveRetryableFailures = 0;
  const breakerThreshold = Math.max(1, Math.floor(options.breakerRetryableFailureThreshold ?? 5));
  const modelGuard = createModelGuard({
    candidates: options.modelCandidates ?? [],
    cooldownMs: options.modelCooldownMs,
    stats,
    now: options.retryDeps?.now ?? Date.now,
    sleep: throttleSleep,
  });

  let throttleChain = Promise.resolve();
  let hasStartedTask = false;
  const awaitThrottleSlot = async () => {
    if (intervalMs <= 0) return;
    const previous = throttleChain;
    let release!: () => void;
    throttleChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (hasStartedTask) {
      await throttleSleep(intervalMs);
    }
    hasStartedTask = true;
    release();
  };

  const runTask = async (task: LlmAnalysisFile[]) => {
    await awaitThrottleSlot();
    stats.requested += task.length;
    const model = await modelGuard.selectModel();
    if (task.length > 1) {
      const outcome = await runBatchFileAnalysisTask({ ...options, files: task, provider, stats, analyses, policy, model, artifacts });
      consecutiveRetryableFailures = outcome.retryableFailure ? consecutiveRetryableFailures + 1 : 0;
      if (outcome.retryableFailure) modelGuard.cooldown(model, outcome.error);
      if (consecutiveRetryableFailures >= breakerThreshold) stats.breakerTripped = true;
      return;
    }
    const file = task[0]!;
    const filePath = file.path;
    const attemptLogs: RetryAttemptLog[] = [];
    let succeeded = false;
    let caught: unknown;
    try {
      const content = options.readFile(`${options.analysisRoot}/${filePath}`);
      const prompt = buildPrompt(filePath, content, options.projectContext);
      artifacts.promptStubs.push({ operation: "file-analysis", target: filePath, prompt });
      const parsed = await callWithRetry(
        async () => {
          const response = await provider.complete({ prompt, model, timeoutMs: options.timeoutMs });
          const result = parseResponse(response.text);
          if (!result) {
            throw new LlmError("parse", `LLM parse failed for ${filePath}`);
          }
          return result as LLMFileAnalysis;
        },
        policy,
        (log) => attemptLogs.push(log),
        options.retryDeps,
      );
      analyses.set(filePath, parsed);
      stats.analyzed += 1;
      succeeded = true;
    } catch (error) {
      caught = error;
    }

    if (stats.retries && attemptLogs.length > 0) {
      stats.retries.totalAttempts += attemptLogs.length;
      stats.retries.transientHits += attemptLogs.length - 1;
    }
    if (attemptLogs.length > 0) {
      artifacts.attemptJournal.push({
        scope: "file",
        operation: "file-analysis",
        target: filePath,
        status: succeeded ? "ok" : "failed",
        attempts: attemptLogs,
        reason: succeeded ? undefined : ((caught as Error).message),
        kind: caught instanceof LlmError ? caught.kind : undefined,
      });
    }

    if (succeeded) {
      consecutiveRetryableFailures = 0;
      return;
    }
    const error = caught;
    const reason = (error as Error).message;
    const kind: LlmErrorKind | undefined = error instanceof LlmError ? error.kind : undefined;
    if (options.required) {
      throw error instanceof Error ? error : new Error(reason);
    }
    stats.failed += 1;
    stats.failures.push({ filePath, reason, kind, attempts: attemptLogs });
    consecutiveRetryableFailures = error instanceof LlmError && error.retryable
      ? consecutiveRetryableFailures + 1
      : 0;
    if (error instanceof LlmError && error.retryable) modelGuard.cooldown(model, error);
    if (consecutiveRetryableFailures >= breakerThreshold) stats.breakerTripped = true;
  };

  const workers = Array.from({ length: Math.min(workerCount, tasks.length || 1) }, async () => {
    while (true) {
      const currentIndex = nextTaskIndex;
      nextTaskIndex += 1;
      const task = tasks[currentIndex];
      if (!task) return;
      if (stats.breakerTripped) {
        stats.skipped += task.length;
        continue;
      }
      await runTask(task);
    }
  });
  await Promise.all(workers);

  return { analyses, stats, artifacts };
}

function createModelGuard(options: {
  candidates: string[];
  cooldownMs?: number;
  stats: LlmBuildStats;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): {
  selectModel: () => Promise<string | undefined>;
  cooldown: (model: string | undefined, error: unknown) => void;
} {
  const candidates = options.candidates.map((model) => model.trim()).filter(Boolean);
  const cooldownMs = Math.max(0, Math.floor(options.cooldownMs ?? 60_000));
  const cooldownUntil = new Map<string, number>();
  let index = 0;
  if (candidates[0]) options.stats.activeModel = candidates[0];

  const switchTo = (next: number) => {
    if (next === index) return;
    index = next;
    options.stats.activeModel = candidates[index];
    options.stats.modelSwitches = (options.stats.modelSwitches ?? 0) + 1;
  };

  const isAvailable = (model: string, now: number) => (cooldownUntil.get(model) ?? 0) <= now;

  const findAvailable = (start: number, now: number): number => {
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const candidateIndex = (start + offset) % candidates.length;
      if (isAvailable(candidates[candidateIndex]!, now)) return candidateIndex;
    }
    return -1;
  };

  const selectEarliest = (): { index: number; waitMs: number } => {
    let earliestIndex = 0;
    let earliestUntil = Number.POSITIVE_INFINITY;
    for (let i = 0; i < candidates.length; i += 1) {
      const until = cooldownUntil.get(candidates[i]!) ?? 0;
      if (until < earliestUntil) {
        earliestUntil = until;
        earliestIndex = i;
      }
    }
    return { index: earliestIndex, waitMs: Math.max(0, earliestUntil - options.now()) };
  };

  return {
    selectModel: async () => {
      if (candidates.length === 0) return undefined;
      const now = options.now();
      const available = findAvailable(index, now);
      if (available >= 0) {
        switchTo(available);
        options.stats.activeModel = candidates[index];
        return candidates[index];
      }
      const earliest = selectEarliest();
      if (earliest.waitMs > 0) await options.sleep(earliest.waitMs);
      switchTo(earliest.index);
      options.stats.activeModel = candidates[index];
      return candidates[index];
    },
    cooldown: (model, error) => {
      if (!model || !(error instanceof LlmError) || !error.retryable) return;
      const until = options.now() + cooldownMs;
      cooldownUntil.set(model, until);
      options.stats.modelGuards ??= [];
      options.stats.modelGuards.push({
        model,
        action: "cooldown",
        kind: error.kind,
        reason: error.message,
        cooldownUntil: until,
      });
      const next = findAvailable((index + 1) % candidates.length, options.now());
      switchTo(next >= 0 ? next : (index + 1) % candidates.length);
    },
  };
}

function createFileAnalysisTasks(files: LlmAnalysisFile[], taskFileCount: number): LlmAnalysisFile[][] {
  const size = Math.max(1, Math.floor(taskFileCount || 15));
  const tasks: LlmAnalysisFile[][] = [];
  for (let i = 0; i < files.length; i += size) {
    tasks.push(files.slice(i, i + size));
  }
  return tasks;
}

function buildBatchFileAnalysisPrompt(
  files: LlmAnalysisFile[],
  options: RunLlmFileAnalysisOptions,
): string {
  const fileBlocks = files.map((file, index) => {
    const content = options.readFile(`${options.analysisRoot}/${file.path}`);
    return [
      `## File ${index + 1}`,
      `filePath: ${file.path}`,
      "",
      "```",
      content,
      "```",
    ].join("\n");
  }).join("\n\n");

  return [
    "You are a code analysis assistant. Analyze each source file independently for Understand-Anything and return a JSON object.",
    "",
    `Project context: ${options.projectContext}`,
    "",
    "For each file, produce the same upstream single-file analysis JSON object:",
    "- \"fileSummary\": A concise summary of what this file does (1-2 sentences).",
    "- \"tags\": An array of relevant tags.",
    "- \"complexity\": One of \"simple\", \"moderate\", or \"complex\".",
    "- \"functionSummaries\": An object mapping function names to 1-sentence summaries.",
    "- \"classSummaries\": An object mapping class names to 1-sentence summaries.",
    "- \"languageNotes\": Optional notes about language-specific patterns or idioms used.",
    "",
    "Return ONLY strict JSON, with no markdown fences and no additional text.",
    "The response shape must be:",
    "{\"results\":[{\"filePath\":\"<same filePath from the job>\",\"response\":{<the upstream single-file JSON object>}}]}",
    "Every input filePath must appear at most once in results.",
    "",
    "Input files:",
    "",
    fileBlocks,
  ].join("\n");
}

function parseBatchFileAnalysisResponse(
  text: string,
  parseResponse: (response: string) => LLMFileAnalysis | null,
): Array<{ filePath: string; analysis: LLMFileAnalysis }> {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonText = fenceMatch?.[1] ? fenceMatch[1].trim() : trimmed;
  const parsed = JSON.parse(jsonText) as { results?: unknown };
  if (!Array.isArray(parsed.results)) return [];
  const analyses: Array<{ filePath: string; analysis: LLMFileAnalysis }> = [];
  for (const entry of parsed.results) {
    if (!entry || typeof entry !== "object") continue;
    const filePath = String((entry as { filePath?: unknown }).filePath || "");
    const response = (entry as { response?: unknown }).response;
    const analysis = parseResponse(typeof response === "string" ? response : JSON.stringify(response || {}))
      ?? normalizeFileAnalysisObject(response);
    if (filePath && analysis) analyses.push({ filePath, analysis });
  }
  return analyses;
}

function normalizeFileAnalysisObject(value: unknown): LLMFileAnalysis | null {
  if (!value || typeof value !== "object") return null;
  const fileSummary = String((value as { fileSummary?: unknown }).fileSummary || "").trim();
  if (!fileSummary) return null;
  const tags = Array.isArray((value as { tags?: unknown }).tags)
    ? ((value as { tags?: unknown[] }).tags ?? []).filter((tag): tag is string => typeof tag === "string")
    : [];
  const complexityValue = (value as { complexity?: unknown }).complexity;
  const complexity = complexityValue === "simple" || complexityValue === "moderate" || complexityValue === "complex"
    ? complexityValue
    : "moderate";
  const stringRecord = (raw: unknown): Record<string, string> => {
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof item === "string") out[key] = item;
    }
    return out;
  };
  return {
    fileSummary,
    tags,
    complexity,
    functionSummaries: stringRecord((value as { functionSummaries?: unknown }).functionSummaries),
    classSummaries: stringRecord((value as { classSummaries?: unknown }).classSummaries),
    languageNotes: typeof (value as { languageNotes?: unknown }).languageNotes === "string"
      ? (value as { languageNotes: string }).languageNotes
      : undefined,
  };
}

async function runBatchFileAnalysisTask(
  options: RunLlmFileAnalysisOptions & {
    files: LlmAnalysisFile[];
    provider: LlmProvider;
    stats: LlmBuildStats;
    analyses: Map<string, LLMFileAnalysis>;
    policy: RetryPolicy;
    model?: string;
    artifacts: LlmArtifacts;
  },
): Promise<{ retryableFailure: boolean; error?: unknown }> {
  const parseResponse = options.core.parseFileAnalysisResponse as (response: string) => LLMFileAnalysis | null;
  const attemptLogs: RetryAttemptLog[] = [];
  let parsed: Array<{ filePath: string; analysis: LLMFileAnalysis }> = [];
  let caught: unknown;
  const prompt = buildBatchFileAnalysisPrompt(options.files, options);
  options.artifacts.promptStubs.push({
    operation: "file-analysis-batch",
    target: options.files.map((file) => file.path).join(","),
    prompt,
  });
  try {
    parsed = await callWithRetry(
      async () => {
        const response = await options.provider.complete({ prompt, model: options.model, timeoutMs: options.timeoutMs });
        const result = parseBatchFileAnalysisResponse(response.text, parseResponse);
        if (result.length === 0) {
          throw new LlmError("parse", "LLM batch file analysis parse failed");
        }
        return result;
      },
      options.policy,
      (log) => attemptLogs.push(log),
      options.retryDeps,
    );
  } catch (error) {
    caught = error;
  }

  if (options.stats.retries && attemptLogs.length > 0) {
    options.stats.retries.totalAttempts += attemptLogs.length;
    options.stats.retries.transientHits += attemptLogs.length - 1;
  }
  const expected = !caught ? new Set(options.files.map((file) => file.path)) : null;
  const returned = new Set<string>();
  if (!caught) {
    for (const { filePath, analysis } of parsed) {
      if (!expected!.has(filePath)) continue;
      returned.add(filePath);
      options.analyses.set(filePath, analysis);
      options.stats.analyzed += 1;
    }
  }
  const missing = !caught
    ? options.files.filter((file) => !returned.has(file.path))
    : [];
  const missingReason = missing.length > 0
    ? `LLM batch response missing file result: ${missing.map((file) => file.path).join(", ")}`
    : undefined;
  if (attemptLogs.length > 0) {
    options.artifacts.attemptJournal.push({
      scope: "file",
      operation: "file-analysis-batch",
      target: options.files.map((file) => file.path).join(","),
      status: caught ? "failed" : (missing.length > 0 ? "partial" : "ok"),
      attempts: attemptLogs,
      reason: caught ? ((caught as Error).message) : missingReason,
      kind: caught instanceof LlmError ? caught.kind : undefined,
    });
  }

  if (!caught) {
    if (missing.length > 0) {
      if (options.required) {
        throw new LlmError("parse", missingReason!);
      }
      for (const file of missing) {
        options.stats.failed += 1;
        options.stats.failures.push({ filePath: file.path, reason: "LLM batch response missing file result", attempts: attemptLogs });
      }
    }
    return { retryableFailure: false };
  }

  const reason = (caught as Error).message;
  const kind: LlmErrorKind | undefined = caught instanceof LlmError ? caught.kind : undefined;
  if (options.required) {
    throw caught instanceof Error ? caught : new Error(reason);
  }
  for (const file of options.files) {
    options.stats.failed += 1;
    options.stats.failures.push({ filePath: file.path, reason, kind, attempts: attemptLogs });
  }
  return { retryableFailure: caught instanceof LlmError && caught.retryable, error: caught };
}

interface GraphStageSpec {
  stage: LlmGraphStage;
  buildPromptName: string;
  parseResponseName: string;
  buildPrompt?: (graph: any, buildPrompt: (...args: any[]) => string, options: RunLlmGraphEnhancementOptions) => string;
  apply: (graph: any, parsed: any, core: any) => any;
}

function graphFileList(graph: any): string[] {
  const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const paths = nodes
    .filter((node: any) => node?.type === "file")
    .map((node: any) => node.filePath ?? node.path ?? node.id)
    .filter((path: unknown): path is string => typeof path === "string" && path.length > 0);
  return Array.from(new Set<string>(paths)).sort((a, b) => a.localeCompare(b));
}

const GRAPH_STAGES: GraphStageSpec[] = [
  {
    stage: "layers",
    buildPromptName: "buildLayerDetectionPrompt",
    parseResponseName: "parseLayerDetectionResponse",
    apply: (graph, parsed, core) => {
      const applied = typeof core.applyLLMLayers === "function"
        ? core.applyLLMLayers(graph, parsed)
        : undefined;
      if (applied && typeof applied === "object" && !Array.isArray(applied)) return applied;
      if (Array.isArray(applied)) return { ...graph, layers: applied };
      if (Array.isArray(parsed)) return { ...graph, layers: parsed };
      if (Array.isArray(parsed?.layers)) return { ...graph, layers: parsed.layers };
      return graph;
    },
  },
  {
    stage: "project-summary",
    buildPromptName: "buildProjectSummaryPrompt",
    parseResponseName: "parseProjectSummaryResponse",
      buildPrompt: (graph, buildPrompt) => buildPrompt(graphFileList(graph), []),
    apply: (graph, parsed) => {
      const project = { ...(graph.project ?? {}) };
      if (typeof parsed === "string") {
        project.summary = parsed;
      } else if (parsed && typeof parsed === "object") {
        const summary = parsed.summary ?? parsed.projectSummary ?? parsed.description;
        if (summary !== undefined) project.summary = String(summary);
        if (Array.isArray(parsed.frameworks)) project.frameworks = parsed.frameworks;
        if (Array.isArray(parsed.tags)) project.tags = parsed.tags;
      }
      return { ...graph, project };
    },
  },
  {
    stage: "tour",
    buildPromptName: "buildTourGenerationPrompt",
    parseResponseName: "parseTourGenerationResponse",
    apply: (graph, parsed) => {
      if (Array.isArray(parsed)) return { ...graph, tour: parsed };
      if (Array.isArray(parsed?.tour)) return { ...graph, tour: parsed.tour };
      return graph;
    },
  },
];

export async function runLlmGraphEnhancement(
  options: RunLlmGraphEnhancementOptions,
): Promise<LlmGraphEnhancementRun> {
  let graph = options.graph;
  if (!options.enabled) {
    return { graph, stats: emptyGraphStats(false) };
  }
  if (!options.provider) {
    throw new Error("build: no LLM provider configured (pass --llm-provider or disable --llm-analysis)");
  }

  const provider = options.provider;
  const stats = emptyGraphStats(true, provider.name);
  const artifacts: LlmArtifacts = { promptStubs: [], attemptJournal: [] };
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const model = options.modelCandidates?.map((entry) => entry.trim()).find(Boolean);

  for (const spec of GRAPH_STAGES) {
    const buildPrompt = options.core?.[spec.buildPromptName];
    const parseResponse = options.core?.[spec.parseResponseName];
    if (typeof buildPrompt !== "function" || typeof parseResponse !== "function") {
      stats.skipped += 1;
      continue;
    }

    stats.requested += 1;
    const attemptLogs: RetryAttemptLog[] = [];
    let parsed: any;
    let caught: unknown;
    const prompt = spec.buildPrompt
      ? spec.buildPrompt(graph, buildPrompt, options)
      : buildPrompt(graph, options.projectContext);
    artifacts.promptStubs.push({ operation: spec.stage, prompt });
    try {
      parsed = await callWithRetry(
        async () => {
          const response = await provider.complete({ prompt, model, timeoutMs: options.timeoutMs });
          const result = parseResponse(response.text);
          if (!result) {
            throw new LlmError("parse", `LLM graph ${spec.stage} parse failed`);
          }
          return result;
        },
        policy,
        (log) => attemptLogs.push(log),
        options.retryDeps,
      );
      graph = spec.apply(graph, parsed, options.core);
      stats.applied += 1;
    } catch (error) {
      caught = error;
    }

    if (stats.retries && attemptLogs.length > 0) {
      stats.retries.totalAttempts += attemptLogs.length;
      stats.retries.transientHits += attemptLogs.length - 1;
    }
    if (attemptLogs.length > 0) {
      artifacts.attemptJournal.push({
        scope: "graph",
        operation: spec.stage,
        status: caught ? "failed" : "ok",
        attempts: attemptLogs,
        reason: caught ? ((caught as Error).message) : undefined,
        kind: caught instanceof LlmError ? caught.kind : undefined,
      });
    }

    if (!caught) continue;
    const reason = (caught as Error).message;
    const kind: LlmErrorKind | undefined = caught instanceof LlmError ? caught.kind : undefined;
    if (options.required) {
      throw caught instanceof Error ? caught : new Error(reason);
    }
    stats.failed += 1;
    stats.failures.push({ stage: spec.stage, reason, kind, attempts: attemptLogs });
  }

  return { graph, stats, artifacts };
}
