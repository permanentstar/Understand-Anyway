/** Edge identity + dedupe, ported verbatim from deploy. */

export interface GraphEdge {
  type: string;
  source: string;
  target: string;
  [key: string]: unknown;
}

export function edgeKey(edge: GraphEdge): string {
  return `${edge.type}|${edge.source}|${edge.target}`;
}

export function dedupeEdges<T extends GraphEdge>(edges: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}
