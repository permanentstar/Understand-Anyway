/**
 * Embedding provider — turns text into dense vectors for semantic search.
 *
 * Open-source core keeps this abstract and optional. When no embedding
 * provider is configured, semantic search remains disabled.
 */

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = "noop-embedding";

  async embed(): Promise<number[]> {
    return [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}
