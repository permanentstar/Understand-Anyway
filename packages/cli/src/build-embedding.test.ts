import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "@understand-anyway/plugin-api";
import { buildEmbeddingProvider } from "./build-embedding.js";

const fakeEmbeddingModule = {
  createEmbeddingProvider: (config: unknown) => ({
    name: "fake-embedding",
    config,
    async embed() {
      return [1, 0];
    },
  }),
};

function importer(map: Record<string, Record<string, unknown>>) {
  return async (pkg: string) => {
    const mod = map[pkg];
    if (!mod) throw new Error(`module not found: ${pkg}`);
    return mod;
  };
}

describe("buildEmbeddingProvider", () => {
  it("returns undefined when disabled", async () => {
    await expect(buildEmbeddingProvider({ enabled: false, packageName: null, config: {} })).resolves.toBeUndefined();
  });

  it("loads provider from explicit package and passes config", async () => {
    const provider = await buildEmbeddingProvider({
      enabled: true,
      packageName: "pkg-embedding",
      config: { providers: { embedding: { package: "ignored", config: { model: "m" } } } } as ResolvedConfig,
      importModule: importer({ "pkg-embedding": fakeEmbeddingModule }),
    });
    expect(provider?.name).toBe("fake-embedding");
    expect((provider as { config?: unknown }).config).toEqual({ model: "m" });
  });

  it("throws when enabled without provider package", async () => {
    await expect(buildEmbeddingProvider({ enabled: true, packageName: null, config: {} })).rejects.toThrow(/embedding-provider/);
  });
});
