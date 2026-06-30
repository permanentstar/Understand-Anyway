/**
 * Default deterministic graph-health gate. Mirrors the deploy
 * `runGraphHealthReview` 1:1 except for two OSS-only simplifications:
 *
 *  1. `stateDir/current` is followed when it is a project version symlink
 *     pointing at `versions/<id>/.understand-anything` (G20).
 *  2. `runtime/modules.json` parsing is identical, but its absence is treated
 *     as a warning instead of dropping silently — OSS runtimes don't have a
 *     module-catalog framework yet, so missing diagnostics is the norm.
 *
 * Output schema is identical to deploy: `{approved, issues, warnings, stats}`,
 * matching the `UA_REVIEW_JSON` contract documented in
 * `nightly-project-sync.sh`.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync as nodeExecFileSync } from "node:child_process";

export interface GraphHealthReviewOptions {
  repoPath: string;
  stateDir: string;
  /** Test seam: override git CLI invocation. */
  execFileSync?: typeof nodeExecFileSync;
}

export interface GraphHealthFinding {
  id: string;
  severity: "critical" | "warning";
  message: string;
  detail?: Record<string, unknown>;
}

export interface GraphHealthReviewResult {
  approved: boolean;
  issues: GraphHealthFinding[];
  warnings: GraphHealthFinding[];
  stats: Record<string, unknown>;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function countBy<T>(items: T[], pickKey: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = pickKey(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function currentGitHash(repoPath: string, exec: typeof nodeExecFileSync): string {
  try {
    return exec("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).toString().trim();
  } catch {
    return "";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickNodePath(node: Record<string, unknown>): string {
  for (const key of ["path", "filePath", "absolutePath", "sourcePath"]) {
    const value = node[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function isFileLikeNode(node: Record<string, unknown>): boolean {
  const type = String(node.type || node.kind || "").toLowerCase();
  if (type.includes("file")) return true;
  return Boolean(pickNodePath(node));
}

function readRuntimeModules(stateDir: string): Record<string, string> {
  const modulesPath = join(stateDir, ".understand-anything", "runtime", "modules.json");
  if (!existsSync(modulesPath)) return {};
  const payload = readJsonFile(modulesPath);
  const modules = Array.isArray((payload as { modules?: unknown }).modules)
    ? (payload as { modules: unknown[] }).modules
    : Array.isArray(payload)
      ? payload
      : [];
  const result: Record<string, string> = {};
  for (const moduleInfo of modules) {
    if (!isObject(moduleInfo)) continue;
    const id = String(moduleInfo.id || "");
    if (!id) continue;
    result[id] = String(moduleInfo.status || "");
  }
  return result;
}

function readLlmStats(stateDir: string, expectedRepoCommit: string): Record<string, unknown> | null {
  const statsPath = join(stateDir, ".understand-anything", "llm", "latest-stats.json");
  if (!existsSync(statsPath)) return null;
  try {
    const payload = readJsonFile(statsPath);
    if (!isObject(payload)) return null;
    const repoCommit = String(payload.repoCommit || "");
    if (expectedRepoCommit && repoCommit && repoCommit !== expectedRepoCommit) {
      return {
        enabled: false,
        status: "stale",
        provider: String(payload.provider || ""),
        model: String(payload.model || ""),
        repoCommit,
        requests: 0,
        tasks: 0,
        processedTasks: 0,
        failures: 0,
        timeouts: 0,
        skippedFiles: 0,
        candidateFiles: 0,
        processedFiles: 0,
        breakerTripped: false,
        enrichedNodes: 0,
        durationMs: 0,
      };
    }
    return {
      enabled: Boolean(payload.enabled),
      status: String(payload.status || ""),
      provider: String(payload.provider || ""),
      model: String(payload.model || ""),
      repoCommit,
      graphHash: String(payload.graphHash || ""),
      requests: Number(payload.requests || 0),
      tasks: Number(payload.tasks || 0),
      processedTasks: Number(payload.processedTasks || 0),
      failures: Number(payload.failures || 0),
      timeouts: Number(payload.timeouts || 0),
      skippedFiles: Number(payload.skippedFiles || 0),
      candidateFiles: Number(payload.candidateFiles || 0),
      processedFiles: Number(payload.processedFiles || 0),
      breakerTripped: Boolean(payload.breakerTripped),
      enrichedNodes: Number(payload.enrichedNodes || 0),
      durationMs: Number(payload.durationMs || 0),
    };
  } catch {
    return {
      enabled: true,
      status: "invalid_stats",
      provider: "",
      model: "",
      requests: 0,
      tasks: 0,
      processedTasks: 0,
      failures: 1,
      timeouts: 0,
      skippedFiles: 0,
      candidateFiles: 0,
      processedFiles: 0,
      breakerTripped: false,
      enrichedNodes: 0,
      durationMs: 0,
    };
  }
}

function resolveActiveStateRoot(stateDir: string): {
  effectiveStateRoot: string;
  resolutionSource: string;
  resolvedVersionId: string | null;
} {
  const input = resolve(stateDir);
  const currentLink = join(input, "current");
  try {
    if (!lstatSync(currentLink).isSymbolicLink()) {
      return { effectiveStateRoot: input, resolutionSource: "state-dir", resolvedVersionId: null };
    }
    const target = readlinkSync(currentLink);
    const resolvedTarget = resolve(input, target);
    if (!existsSync(join(resolvedTarget, ".understand-anything"))) {
      return { effectiveStateRoot: input, resolutionSource: "state-dir", resolvedVersionId: null };
    }
    return {
      effectiveStateRoot: resolvedTarget,
      resolutionSource: "current-link",
      resolvedVersionId: basename(resolvedTarget) || null,
    };
  } catch {
    return { effectiveStateRoot: input, resolutionSource: "state-dir", resolvedVersionId: null };
  }
}

export function runGraphHealthReview({
  repoPath,
  stateDir,
  execFileSync = nodeExecFileSync,
}: GraphHealthReviewOptions): GraphHealthReviewResult {
  const issues: GraphHealthFinding[] = [];
  const warnings: GraphHealthFinding[] = [];
  const { effectiveStateRoot, resolutionSource, resolvedVersionId } = resolveActiveStateRoot(stateDir);
  const graphPath = join(effectiveStateRoot, ".understand-anything", "knowledge-graph.json");
  const metaPath = join(effectiveStateRoot, ".understand-anything", "meta.json");
  const configPath = join(effectiveStateRoot, ".understand-anything", "config.json");

  for (const [id, filePath] of [
    ["graph_missing", graphPath],
    ["meta_missing", metaPath],
    ["config_missing", configPath],
  ] as const) {
    if (!existsSync(filePath)) {
      issues.push({ id, severity: "critical", message: `required artifact missing: ${filePath}` });
    }
  }
  if (issues.length > 0) {
    return {
      approved: false,
      issues,
      warnings,
      stats: { graphPath, metaPath, configPath, effectiveStateRoot, resolvedVersionId, resolutionSource, inputStateDir: stateDir },
    };
  }

  let graph: Record<string, unknown>;
  let meta: Record<string, unknown>;
  try {
    graph = readJsonFile(graphPath) as Record<string, unknown>;
    meta = readJsonFile(metaPath) as Record<string, unknown>;
    readJsonFile(configPath);
  } catch (error) {
    issues.push({
      id: "artifact_json_invalid",
      severity: "critical",
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      approved: false,
      issues,
      warnings,
      stats: { graphPath, metaPath, configPath, effectiveStateRoot, resolvedVersionId, resolutionSource, inputStateDir: stateDir },
    };
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isObject) : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(isObject) : [];
  const edgeTypes = countBy(edges, (edge) => String(edge.type || edge.kind || edge.relationship || ""));
  const nodeTypes = countBy(nodes, (node) => String(node.type || node.kind || ""));
  const containsEdges = edgeTypes.contains || 0;
  const importsEdges = edgeTypes.imports || edgeTypes.import || 0;
  const callsEdges = edgeTypes.calls || edgeTypes.call || 0;

  if (nodes.length === 0) {
    issues.push({ id: "graph_nodes_empty", severity: "critical", message: "knowledge graph has no nodes" });
  }
  if (edges.length === 0) {
    issues.push({ id: "graph_edges_empty", severity: "critical", message: "knowledge graph has no edges" });
  }
  if (containsEdges === 0) {
    issues.push({ id: "contains_edges_missing", severity: "critical", message: "knowledge graph has no contains edges" });
  }

  const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".java", ".scala", ".py", ".go", ".rs", ".cpp", ".cc", ".c", ".h", ".hpp"]);
  const repoLooksImportable = (() => {
    for (const node of nodes) {
      const nodePath = pickNodePath(node);
      const lower = nodePath.toLowerCase();
      for (const ext of sourceExtensions) {
        if (lower.endsWith(ext)) return true;
      }
    }
    return false;
  })();
  if (repoLooksImportable && importsEdges === 0) {
    issues.push({ id: "imports_edges_missing", severity: "critical", message: "import-capable project has zero import edges" });
  }

  const fileNodes = nodes.filter(isFileLikeNode);
  let missingFileCount = 0;
  for (const node of fileNodes) {
    const nodePath = pickNodePath(node);
    if (!nodePath) continue;
    const absolutePath = nodePath.startsWith("/") ? nodePath : resolve(repoPath, nodePath);
    if (!existsSync(absolutePath)) missingFileCount += 1;
  }
  if (fileNodes.length > 0 && missingFileCount / fileNodes.length > 0.25) {
    issues.push({
      id: "missing_file_nodes_high",
      severity: "critical",
      message: "too many file nodes point to missing source files",
      detail: { missingFileCount, fileNodeCount: fileNodes.length },
    });
  } else if (missingFileCount > 0) {
    warnings.push({
      id: "missing_file_nodes",
      severity: "warning",
      message: "some file nodes point to missing source files",
      detail: { missingFileCount, fileNodeCount: fileNodes.length },
    });
  }

  const metaGitHash = String(meta.gitCommitHash || meta.gitHash || "");
  const repoGitHash = currentGitHash(repoPath, execFileSync);
  if (repoGitHash && metaGitHash && repoGitHash !== metaGitHash) {
    issues.push({
      id: "git_hash_mismatch",
      severity: "critical",
      message: "graph meta git hash does not match repository HEAD",
      detail: { metaGitHash, repoGitHash },
    });
  }

  const moduleStatus = readRuntimeModules(effectiveStateRoot);
  const llmStats = readLlmStats(effectiveStateRoot, metaGitHash);
  for (const [moduleId, status] of Object.entries(moduleStatus)) {
    if (moduleId === "llm-analysis" && status === "deferred") continue;
    if (status !== "active") {
      issues.push({
        id: "runtime_module_not_active",
        severity: "critical",
        message: `runtime module is not active: ${moduleId}`,
        detail: { moduleId, status },
      });
    }
  }
  if (Object.keys(moduleStatus).length === 0) {
    warnings.push({ id: "runtime_modules_missing", severity: "warning", message: "runtime modules diagnostic is missing" });
  }

  if (callsEdges === 0) {
    warnings.push({ id: "calls_edges_missing", severity: "warning", message: "knowledge graph has no calls edges" });
  }

  const stats = {
    graphPath,
    metaPath,
    configPath,
    effectiveStateRoot,
    resolvedVersionId,
    resolutionSource,
    inputStateDir: stateDir,
    graphSizeBytes: statSync(graphPath).size,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeTypes,
    edgeTypes,
    containsEdges,
    importsEdges,
    callsEdges,
    fileNodeCount: fileNodes.length,
    missingFileCount,
    metaGitHash,
    repoGitHash,
    moduleStatus,
    llm: llmStats,
  };

  return {
    approved: issues.length === 0,
    issues,
    warnings,
    stats,
  };
}
