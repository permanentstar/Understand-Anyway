/**
 * Phase 4 — wrap. Assembles the merged graph into the final knowledge-graph
 * shape, then applies the two deterministic project-graph phases inline:
 * layer detection (`core.detectLayers`) and the heuristic tour
 * (`core.generateHeuristicTour`). Ported from deploy `wrapAsKnowledgeGraph`
 * plus the architecture/tour phase descriptors — we inline the two
 * deterministic phases rather than depend on the full modular runtime.
 */

import { buildProjectDescription } from "./summaries.js";
import { dedupeEdges, type GraphEdge } from "./graph-utils.js";
import { formatLocalTimestamp } from "./time.js";

export const GRAPH_VERSION = "understand-local-batched-1";

function applyDeterministicLayers(core: any, graph: any): void {
  if (typeof core?.detectLayers !== "function") {
    graph.layers = Array.isArray(graph?.layers) ? graph.layers : [];
    return;
  }
  try {
    graph.layers = core.detectLayers(graph);
  } catch {
    graph.layers = Array.isArray(graph?.layers) ? graph.layers : [];
  }
}

function applyDeterministicTour(core: any, graph: any): void {
  if (typeof core?.generateHeuristicTour !== "function") {
    graph.tour = Array.isArray(graph?.tour) ? graph.tour : [];
    return;
  }
  try {
    const tour = core.generateHeuristicTour(graph);
    graph.tour = Array.isArray(tour) ? tour : [];
  } catch {
    graph.tour = Array.isArray(graph?.tour) ? graph.tour : [];
  }
}

export interface WrapGraphOptions {
  scan: Record<string, any>;
  assembled: Record<string, any>;
  projectName: string;
  gitHash: string;
  outputLanguage: string;
  core: any;
  incremental?: boolean;
}

export function wrapAsKnowledgeGraph(options: WrapGraphOptions): any {
  const { scan, assembled, projectName, gitHash, outputLanguage, core, incremental = false } = options;
  const languages = Object.keys(scan?.stats?.byLanguage || {}).filter(Boolean);
  const nodes = Array.isArray(assembled?.nodes) ? assembled.nodes : [];
  const graph = {
    version: GRAPH_VERSION,
    kind: "codebase",
    project: {
      name: projectName,
      languages,
      frameworks: [] as string[],
      description: buildProjectDescription(
        projectName,
        scan?.totalFiles || nodes.length,
        outputLanguage,
        incremental,
      ),
      analyzedAt: formatLocalTimestamp(),
      gitCommitHash: gitHash,
    },
    nodes,
    edges: Array.isArray(assembled?.edges) ? dedupeEdges(assembled.edges as GraphEdge[]) : [],
    layers: [] as unknown[],
    tour: [] as unknown[],
  };
  applyDeterministicLayers(core, graph);
  applyDeterministicTour(core, graph);
  return graph;
}
