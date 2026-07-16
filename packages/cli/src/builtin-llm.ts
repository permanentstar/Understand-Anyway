import type { LlmProvider, LlmRequest, LlmResponse } from "@understand-anyway/plugin-api";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  private readonly model: string;

  constructor(options: { model?: string } = {}) {
    this.model = options.model ?? "mock-summary-v1";
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const preview = request.prompt.split(/\r?\n/).find((line) => line.trim()) ?? request.prompt;
    return {
      text: JSON.stringify({
        results: [
          {
            filePath: "mock",
            response: {
              fileSummary: `Mock summary for ${preview.slice(0, 80)}`,
              tags: ["llm-mock"],
              complexity: "moderate",
              functionSummaries: {},
              classSummaries: {},
            },
          },
        ],
      }),
      meta: { provider: this.name, model: this.model },
    };
  }
}

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name = "openai-compatible";
  private readonly model: string;
  private readonly apiBase: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    model?: string;
    apiBase?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    fetchImpl?: FetchLike;
  }) {
    this.model = options.model ?? "default";
    this.apiBase = String(options.apiBase || "").replace(/\/$/, "");
    this.apiKey = options.apiKey ?? process.env[options.apiKeyEnv ?? "UA_LLM_API_KEY"];
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
    try {
      const response = await this.fetchImpl(`${this.apiBase}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          messages: [{ role: "user", content: request.prompt }],
        }),
      });
      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: Record<string, unknown>;
      };
      return {
        text: String(json.choices?.[0]?.message?.content || ""),
        meta: json.usage,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createBuiltinLlmProvider(
  packageName: string | null | undefined,
  config: Record<string, unknown> = {},
): LlmProvider | undefined {
  const name = String(packageName || "").trim();
  if (!name) return undefined;
  if (name === "mock") return new MockLlmProvider({ model: config.model as string | undefined });
  if (name === "openai-compatible") {
    return new OpenAiCompatibleLlmProvider({
      model: config.model as string | undefined,
      apiBase: config.apiBase as string | undefined,
      apiKey: config.apiKey as string | undefined,
      apiKeyEnv: config.apiKeyEnv as string | undefined,
      fetchImpl: config.fetchImpl as FetchLike | undefined,
    });
  }
  return undefined;
}
