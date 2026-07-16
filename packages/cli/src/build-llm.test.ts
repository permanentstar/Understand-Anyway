import { describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "@understand-anyway/plugin-api";
import { buildLlmProvider } from "./build-llm.js";

const fakeLlmModule = {
  createLlmProvider: (config: unknown) => ({
    name: "fake-llm",
    config,
    async complete() {
      return { text: "{}" };
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

describe("buildLlmProvider", () => {
  it("returns undefined when llm analysis is disabled", async () => {
    await expect(buildLlmProvider({ enabled: false, packageName: null, config: {} })).resolves.toBeUndefined();
  });

  it("loads provider from explicit package and passes config", async () => {
    const provider = await buildLlmProvider({
      enabled: true,
      packageName: "pkg-llm",
      config: { providers: { llm: { package: "ignored", config: { model: "m" } } } } as ResolvedConfig,
      importModule: importer({ "pkg-llm": fakeLlmModule }),
    });
    expect(provider?.name).toBe("fake-llm");
    expect((provider as { config?: unknown }).config).toEqual({ model: "m" });
  });

  it("throws when enabled without provider package", async () => {
    await expect(buildLlmProvider({ enabled: true, packageName: null, config: {} })).rejects.toThrow(/LLM provider/);
  });

  it("builds the builtin mock provider without dynamic import", async () => {
    const importModule = async () => {
      throw new Error("should not import");
    };
    const provider = await buildLlmProvider({
      enabled: true,
      packageName: "mock",
      config: {} as ResolvedConfig,
      importModule,
    });
    expect(provider?.name).toBe("mock");
  });

  it("no longer treats cli-spawn as a builtin provider name", async () => {
    const importModule = vi.fn().mockResolvedValue(fakeLlmModule);
    const provider = await buildLlmProvider({
      enabled: true,
      packageName: "cli-spawn",
      config: { providers: { llm: { package: "cli-spawn", config: { model: "m" } } } } as ResolvedConfig,
      importModule,
    });
    expect(importModule).toHaveBeenCalledWith("cli-spawn");
    expect(provider?.name).toBe("fake-llm");
  });
});
