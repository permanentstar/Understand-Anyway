import type { LlmProvider, LlmProviderFactory, LlmRequest, LlmResponse } from "@understand-anyway/plugin-api";
import { runCliCommand, type CliCommandResult, type CliCommandSpec } from "../../provider-cli-runtime/src/index.js";

export type TraeCliV2RunResult = CliCommandResult;
export type TraeCliV2RunSpec = CliCommandSpec;

export interface TraeCliV2RunnerDeps {
  run?: (spec: TraeCliV2RunSpec) => Promise<TraeCliV2RunResult>;
}

export interface TraeCliV2LlmProviderOptions {
  model?: string;
  command?: string;
  args?: string[];
  modelArg?: string;
  promptMode?: "arg" | "stdin";
  defaultTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  deps?: TraeCliV2RunnerDeps;
}

const DEFAULT_MODEL = "trae-cli-v2-default";
const DEFAULT_TIMEOUT_MS = 30_000;

function shouldPassModel(model: string): boolean {
  const normalized = model.trim();
  return normalized.length > 0 && normalized !== DEFAULT_MODEL;
}

export class TraeCliV2LlmProvider implements LlmProvider {
  readonly name = "trae-cli-v2";

  private readonly model: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly modelArg?: string;
  private readonly promptMode: "arg" | "stdin";
  private readonly defaultTimeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly runImpl: (spec: TraeCliV2RunSpec) => Promise<TraeCliV2RunResult>;

  constructor(options: TraeCliV2LlmProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.command = options.command ?? "llm";
    this.args = options.args ?? ["-p", "--output-format", "text"];
    this.modelArg = options.modelArg?.trim() || undefined;
    this.promptMode = options.promptMode ?? "arg";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = options.env;
    this.runImpl = options.deps?.run ?? runCliCommand;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const model = request.model ?? this.model;
    const args = [...this.args];
    if (this.modelArg && shouldPassModel(model) && !args.includes(this.modelArg)) {
      args.push(this.modelArg, model);
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const finalArgs = this.promptMode === "arg" ? [...args, request.prompt] : args;
    const result = await this.runImpl({
      command: this.command,
      args: finalArgs,
      input: this.promptMode === "stdin" ? request.prompt : undefined,
      timeoutMs,
      env: this.env,
    });

    if (result.timedOut) {
      throw new Error(`trae-cli-v2 provider: command timed out after ${timeoutMs}ms`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr
        || `trae-cli-v2 provider: command exited with ${result.signal || `code ${result.exitCode ?? "unknown"}`}`,
      );
    }

    return {
      text: result.stdout.trim(),
      meta: { provider: this.name, model, command: this.command },
    };
  }
}

export const createLlmProvider: LlmProviderFactory = (config) =>
  new TraeCliV2LlmProvider((config ?? {}) as TraeCliV2LlmProviderOptions);
