import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { LlmProvider, LlmRequest, LlmResponse } from "@understand-anyway/plugin-api";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function killSpawnedProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  deps: {
    platform?: NodeJS.Platform;
    killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): void {
  if (!child.pid) return;
  const platform = deps.platform ?? process.platform;
  const killProcess = deps.killProcess ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  if (platform !== "win32") {
    killProcess(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

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

async function runCliPrompt(options: {
  command: string;
  args: string[];
  prompt: string;
  promptMode: "arg" | "stdin";
  timeoutMs: number;
  spawnImpl?: SpawnLike;
}): Promise<string> {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  return await new Promise<string>((resolve, reject) => {
    const child = spawnImpl(options.command, options.promptMode === "arg" ? [...options.args, options.prompt] : options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cb();
    };
    const timeout = setTimeout(() => {
      killSpawnedProcessGroup(child, "SIGTERM");
      finish(() => reject(new Error(`cli-spawn command timed out after ${options.timeoutMs}ms`)));
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr || `cli-spawn command exited with code ${code ?? "unknown"}`));
      });
    });
    if (options.promptMode === "stdin") {
      child.stdin?.end(options.prompt);
    } else {
      child.stdin?.end();
    }
  });
}

const CLI_SPAWN_DEFAULT_MODEL = "cli-spawn-default";

function shouldPassModel(model: string): boolean {
  const normalized = model.trim();
  return normalized.length > 0 && normalized !== CLI_SPAWN_DEFAULT_MODEL;
}

export class CliSpawnLlmProvider implements LlmProvider {
  readonly name = "cli-spawn";
  private readonly model: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly modelArg?: string;
  private readonly promptMode: "arg" | "stdin";
  private readonly spawnImpl?: SpawnLike;

  constructor(options: {
    model?: string;
    command?: string;
    args?: string[];
    modelArg?: string;
    promptMode?: "arg" | "stdin";
    spawnImpl?: SpawnLike;
  }) {
    this.model = options.model ?? CLI_SPAWN_DEFAULT_MODEL;
    this.command = options.command ?? "llm";
    this.args = options.args ?? ["-p", "--output-format", "text"];
    this.modelArg = options.modelArg?.trim() || undefined;
    this.promptMode = options.promptMode ?? "arg";
    this.spawnImpl = options.spawnImpl;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const model = request.model ?? this.model;
    const args = [...this.args];
    if (this.modelArg && shouldPassModel(model) && !args.includes(this.modelArg)) {
      args.push(this.modelArg, model);
    }
    const text = await runCliPrompt({
      command: this.command,
      args,
      prompt: request.prompt,
      promptMode: this.promptMode,
      timeoutMs: request.timeoutMs ?? 30_000,
      spawnImpl: this.spawnImpl,
    });
    return {
      text,
      meta: { provider: this.name, model },
    };
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
  if (name === "cli-spawn") {
    return new CliSpawnLlmProvider({
      model: config.model as string | undefined,
      command: config.command as string | undefined,
      args: Array.isArray(config.args) ? config.args.filter((item): item is string => typeof item === "string") : undefined,
      modelArg: config.modelArg as string | undefined,
      promptMode: config.promptMode === "stdin" ? "stdin" : "arg",
      spawnImpl: config.spawnImpl as SpawnLike | undefined,
    });
  }
  return undefined;
}
