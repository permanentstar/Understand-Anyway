import { describe, expect, it, vi } from "vitest";
import {
  MockLlmProvider,
  OpenAiCompatibleLlmProvider,
} from "./builtin-llm.js";

describe("MockLlmProvider", () => {
  it("returns deterministic JSON text", async () => {
    const provider = new MockLlmProvider({ model: "mock-v1" });
    const response = await provider.complete({ prompt: "analyze src/a.ts", model: "mock-v1" });
    const parsed = JSON.parse(response.text);
    expect(parsed.results[0].response.fileSummary).toContain("Mock summary");
  });
});

describe("OpenAiCompatibleLlmProvider", () => {
  it("parses chat completions into raw text", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));
    const provider = new OpenAiCompatibleLlmProvider({
      model: "gpt-x",
      apiBase: "https://example.test/v1",
      apiKey: "secret",
      fetchImpl: fetchImpl as never,
    });
    const response = await provider.complete({ prompt: "hello", timeoutMs: 1000 });
    expect(response.text).toBe("{\"ok\":true}");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
