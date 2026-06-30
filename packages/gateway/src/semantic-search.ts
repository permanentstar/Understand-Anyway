import type { EmbeddingProvider } from "@understand-anyway/plugin-api";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SemanticSearchNode {
  id: string;
  type: string;
  name?: string;
  summary?: string;
}

export interface SemanticSearchResult {
  nodeId: string;
  score: number;
}

export interface SemanticSearchArtifacts {
  nodes: SemanticSearchNode[];
  embeddings: Record<string, number[]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
    magA += a[index]! * a[index]!;
    magB += b[index]! * b[index]!;
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

export class SemanticSearchEngine {
  private readonly nodes: SemanticSearchNode[];
  private readonly embeddings: Map<string, number[]>;

  constructor(nodes: SemanticSearchNode[], embeddings: Record<string, number[]>) {
    this.nodes = nodes;
    this.embeddings = new Map(Object.entries(embeddings));
  }

  hasEmbeddings(): boolean {
    return this.embeddings.size > 0;
  }

  search(queryEmbedding: number[], options: { limit?: number; threshold?: number; types?: string[] } = {}): SemanticSearchResult[] {
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0;
    const typeFilter = options.types;
    const scored: SemanticSearchResult[] = [];
    for (const node of this.nodes) {
      if (typeFilter && !typeFilter.includes(node.type)) continue;
      const embedding = this.embeddings.get(node.id);
      if (!embedding) continue;
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) {
        scored.push({ nodeId: node.id, score: 1 - similarity });
      }
    }
    scored.sort((left, right) => left.score - right.score);
    return scored.slice(0, limit);
  }
}

export async function searchSemantically(options: {
  provider: EmbeddingProvider;
  query: string;
  nodes: SemanticSearchNode[];
  embeddings: Record<string, number[]>;
  limit?: number;
  threshold?: number;
  types?: string[];
}): Promise<SemanticSearchResult[]> {
  const queryEmbedding = await options.provider.embed(options.query);
  const engine = new SemanticSearchEngine(options.nodes, options.embeddings);
  return engine.search(queryEmbedding, {
    limit: options.limit,
    threshold: options.threshold,
    types: options.types,
  });
}

export function readSemanticSearchArtifacts(stateRoot: string): SemanticSearchArtifacts {
  // Prefer the versioned `current/.understand-anything` so prod reads from the
  // published version; fall back to the flat layout for unmigrated state roots.
  const versionedDir = resolve(stateRoot, "current", ".understand-anything");
  const flatDir = resolve(stateRoot, ".understand-anything");
  const graphDir = existsSync(resolve(versionedDir, "knowledge-graph.json")) ? versionedDir : flatDir;
  const graphPath = resolve(graphDir, "knowledge-graph.json");
  const embeddingsPath = resolve(graphDir, "embeddings.json");
  if (!existsSync(graphPath) || !existsSync(embeddingsPath)) {
    return { nodes: [], embeddings: {} };
  }

  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes?: SemanticSearchNode[] };
  const embeddings = JSON.parse(readFileSync(embeddingsPath, "utf8")) as Record<string, number[]>;
  return {
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    embeddings: embeddings && typeof embeddings === "object" ? embeddings : {},
  };
}
