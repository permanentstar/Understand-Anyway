import {
  LlmError,
  type LlmErrorKind,
  type LlmProvider,
  type LlmProviderFactory,
  type LlmRequest,
  type LlmResponse,
} from "@understand-anyway/plugin-api";
import {
  probeCommandAvailability,
  runCliCommand,
  type CliCommandResult,
  type CliCommandSpec,
} from "../../provider-cli-runtime/src/index.js";

export type TraeCliV1RunResult = CliCommandResult;
export type TraeCliV1RunSpec = CliCommandSpec;

export interface TraeCliV1RunnerDeps {
  isAvailable?: (command: string) => boolean;
  run?: (spec: TraeCliV1RunSpec) => Promise<TraeCliV1RunResult>;
}

export interface TraeCliV1LlmProviderOptions {
  env?: NodeJS.ProcessEnv;
  model?: string;
  command?: string;
  baseArgs?: string[];
  promptMode?: "arg" | "stdin";
  defaultTimeoutMs?: number;
  deps?: TraeCliV1RunnerDeps;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BASE_ARGS = ["-p", "--output-format", "text"];

function parseArgs(raw: string): string[] {
  return raw
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasOption(args: string[], option: string): boolean {
  return args.includes(option);
}

function hasTraeConfig(args: string[], key: string): boolean {
  return args.some((arg, index) => arg === "-c" && (args[index + 1] ?? "").startsWith(`${key}=`));
}

function shouldPassModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "trae-cli-v1";
}

function parseRetryAfterMs(stderr: string): number | undefined {
  const match = stderr.match(/Retry-After:\s*([\d.]+)/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function classifyTraeCliV1Failure(stderr: string): { kind: LlmErrorKind; retryAfterMs?: number } {
  const retryAfterMs = parseRetryAfterMs(stderr);

  if (/\b429\b|rate.?limit/i.test(stderr)) {
    return { kind: "rate-limit", retryAfterMs };
  }
  if (/\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bETIMEDOUT\b/i.test(stderr)) {
    return { kind: "network" };
  }
  if (/server.?overload|\b5\d{2}\b/i.test(stderr)) {
    return { kind: "overload", retryAfterMs };
  }
  if (/\btime(?:d)?\s*out\b|timeout/i.test(stderr)) {
    return { kind: "timeout" };
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(stderr)) {
    return { kind: "auth" };
  }
  if (/\b400\b|bad request/i.test(stderr)) {
    return { kind: "bad-request" };
  }
  return { kind: "unknown" };
}

function resolveCommand(options: TraeCliV1LlmProviderOptions, env: NodeJS.ProcessEnv): string {
  return options.command
    || env.UA_LLM_TRAECLI_V1_COMMAND
    || env.UA_LLM_COCO_CLI
    || env.UA_COCO_CLI
    || "traecli";
}

function resolveBaseArgs(options: TraeCliV1LlmProviderOptions, env: NodeJS.ProcessEnv): string[] {
  if (options.baseArgs) return [...options.baseArgs];
  const rawArgs = env.UA_LLM_TRAECLI_V1_ARGS ?? env.UA_LLM_COCO_ARGS ?? env.UA_COCO_CLI_ARGS;
  return rawArgs === undefined ? [...DEFAULT_BASE_ARGS] : parseArgs(String(rawArgs));
}

function resolvePromptMode(options: TraeCliV1LlmProviderOptions, env: NodeJS.ProcessEnv): "arg" | "stdin" {
  if (options.promptMode) return options.promptMode;
  return env.UA_LLM_TRAECLI_V1_PROMPT_MODE === "stdin" || env.UA_LLM_COCO_PROMPT_MODE === "stdin"
    ? "stdin"
    : "arg";
}

export class TraeCliV1LlmProvider implements LlmProvider {
  readonly name = "trae-cli-v1";

  private readonly env: NodeJS.ProcessEnv;
  private readonly model: string;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly promptMode: "arg" | "stdin";
  private readonly defaultTimeoutMs: number;
  private readonly isAvailableImpl: (command: string) => boolean;
  private readonly runImpl: (spec: TraeCliV1RunSpec) => Promise<TraeCliV1RunResult>;
  private availability: boolean | null = null;

  constructor(options: TraeCliV1LlmProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.model = options.model || "trae-cli-v1";
    this.command = resolveCommand(options, this.env);
    this.baseArgs = resolveBaseArgs(options, this.env);
    this.promptMode = resolvePromptMode(options, this.env);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.isAvailableImpl = options.deps?.isAvailable ?? probeCommandAvailability;
    this.runImpl = options.deps?.run ?? runCliCommand;
  }

  isAvailable(): boolean {
    if (this.availability === null) this.availability = this.isAvailableImpl(this.command);
    return this.availability;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.isAvailable()) {
      throw new LlmError("unknown", `trae-cli-v1 provider: command '${this.command}' not found`);
    }

    const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : this.defaultTimeoutMs;
    const model = request.model ?? this.model;
    const args = [...this.baseArgs];
    if (shouldPassModel(model) && !hasTraeConfig(args, "default_model")) {
      args.push("-c", `default_model=${model}`);
    }
    if (!hasOption(args, "--query-timeout")) {
      args.push("--query-timeout", `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`);
    }

    const finalArgs = this.promptMode === "arg" ? [...args, request.prompt] : args;
    const result = await this.runImpl({
      command: this.command,
      args: finalArgs,
      input: this.promptMode === "stdin" ? request.prompt : undefined,
      timeoutMs,
      env: this.env,
    });

    if (result.timedOut) {
      throw new LlmError("timeout", `trae-cli-v1 provider: command timed out after ${timeoutMs}ms`, {
        cause: result,
      });
    }
    if (result.exitCode !== 0) {
      const combined =
        result.stderr || `trae-cli-v1 command exited with ${result.signal || `code ${result.exitCode ?? "unknown"}`}`;
      const { kind, retryAfterMs } = classifyTraeCliV1Failure(combined);
      throw new LlmError(kind, `trae-cli-v1 provider: ${combined}`, { retryAfterMs, cause: result });
    }

    return {
      text: result.stdout.trim(),
      meta: {
        provider: this.name,
        model,
        command: this.command,
        exitCode: result.exitCode,
      },
    };
  }
}

export const createLlmProvider: LlmProviderFactory = (config) =>
  new TraeCliV1LlmProvider((config ?? {}) as TraeCliV1LlmProviderOptions);
