import { dedupeEdges, type GraphEdge } from "./graph-utils.js";

/**
 * Partial-graph merge ported from deploy. **Intentional fork** from upstream
 * `core.mergeGraphUpdate(graph, changedFilePaths, newNodes, newEdges, newCommitHash)`:
 *
 * - Signature: `(existing, update, affectedFiles)` — composes pre-built
 *   `update` payload instead of taking individual nodes/edges arrays.
 * - Edge dedupe via `dedupeEdges` (this layer); upstream relies on caller dedupe.
 * - Does NOT update `graph.project.gitCommitHash` / `analyzedAt` here;
 *   `persistValidatedGraph` updates these in a separate pass for clearer
 *   responsibility separation.
 *
 * Renamed from `mergeGraphUpdate` (E1.5, 2026-06-24) to remove name collision
 * with upstream while preserving the deploy-derived semantics.
 */

interface GraphNode {
  id: string;
  filePath?: string;
  [key: string]: unknown;
}

interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
  [key: string]: unknown;
}

function nodeBelongsToFiles(node: GraphNode, files: Set<string>): boolean {
  if (node.filePath && files.has(node.filePath)) return true;
  return files.has(node.id);
}

/**
 * Partial-graph merge ported from deploy. **Intentional fork** from upstream
 * `core.mergeGraphUpdate(graph, changedFilePaths, newNodes, newEdges, newCommitHash)`:
 *
 * - Signature: `(existing, update, affectedFiles)` — composes pre-built
 *   `update` payload instead of taking individual nodes/edges arrays.
 * - Edge dedupe via `dedupeEdges` (this layer); upstream relies on caller dedupe.
 * - Does NOT update `graph.project.gitCommitHash` / `analyzedAt` here;
 *   `persistValidatedGraph` updates these in a separate pass for clearer
 *   responsibility separation.
 *
 * Renamed from `mergeGraphUpdate` (E1.5, 2026-06-24) to remove name collision
 * with upstream while preserving the deploy-derived semantics.
 */
export function mergeGraphPartialUpdate<T extends GraphLike>(existing: T, update: GraphLike, affectedFiles: string[]): T {
  const affected = new Set(affectedFiles);
  const removedNodeIds = new Set(
    existing.nodes.filter((node) => nodeBelongsToFiles(node, affected)).map((node) => node.id),
  );
  const keptNodes = existing.nodes.filter((node) => !removedNodeIds.has(node.id));
  const keptNodeIds = new Set(keptNodes.map((node) => node.id));
  const updateNodeIds = new Set(update.nodes.map((node) => node.id));
  const allowedNodeIds = new Set([...keptNodeIds, ...updateNodeIds]);

  const keptEdges = existing.edges.filter(
    (edge) =>
      allowedNodeIds.has(edge.source) &&
      allowedNodeIds.has(edge.target) &&
      !removedNodeIds.has(edge.source) &&
      !removedNodeIds.has(edge.target),
  );
  const updateEdges = update.edges.filter((edge) => allowedNodeIds.has(edge.source) && allowedNodeIds.has(edge.target));

  return {
    ...existing,
    nodes: [...keptNodes, ...update.nodes],
    edges: dedupeEdges([...keptEdges, ...updateEdges]),
  };
}
