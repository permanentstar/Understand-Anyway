/**
 * LLM provider — executes a single upstream-generated prompt and returns the
 * raw completion text. Understand-Anyway never authors prompts or parses
 * responses itself; both come from upstream's `@understand-anything/core`
 * contracts. This interface only owns "who runs the LLM".
 *
 * Default form is a CLI provider (claude/codex/gemini/local/OpenAI-compatible).
 * A host-delegated form (e.g. MCP sampling) is possible but optional and must
 * always have a CLI fallback. Vendor CLIs live in the overlay.
 */

export interface LlmRequest {
  prompt: string;
  /** Optional model override selected by orchestration or provider config. */
  model?: string;
  /** Optional system prompt, when the provider supports it. */
  system?: string;
  /** Soft timeout in milliseconds. */
  timeoutMs?: number;
}

export interface LlmResponse {
  text: string;
  /** Provider-specific usage/metadata, when available. */
  meta?: Record<string, unknown>;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Fails fast; used when LLM analysis is requested but no provider configured. */
export class UnconfiguredLlmProvider implements LlmProvider {
  readonly name = "unconfigured";
  async complete(): Promise<LlmResponse> {
    throw new Error(
      "No LLM provider configured. Pass --llm-provider or disable --llm-analysis.",
    );
  }
}

/**
 * Classification of provider failures the build pipeline knows how to react to.
 * Providers should throw `LlmError` with the appropriate kind; bare `Error`
 * instances are treated as `unknown` (not retryable) by the retry layer.
 */
export type LlmErrorKind =
  | "rate-limit"
  | "overload"
  | "timeout"
  | "network"
  | "auth"
  | "bad-request"
  | "parse"
  | "unknown";

const RETRYABLE_KINDS: ReadonlySet<LlmErrorKind> = new Set([
  "rate-limit",
  "overload",
  "timeout",
  "network",
]);

export interface LlmErrorOptions {
  /** Server-suggested wait before the next attempt (e.g. parsed Retry-After). */
  retryAfterMs?: number;
  /** Underlying provider error, kept opaque. */
  cause?: unknown;
}

/**
 * Provider failure with a fixed classification. `retryable` is derived from
 * `kind` and cannot be overridden by callers — this prevents providers from
 * marking deterministic failures (auth, bad-request, parse) as retryable.
 */
export class LlmError extends Error {
  readonly name = "LlmError";
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;

  constructor(kind: LlmErrorKind, message: string, options: LlmErrorOptions = {}) {
    super(message);
    this.kind = kind;
    this.retryable = RETRYABLE_KINDS.has(kind);
    this.retryAfterMs = options.retryAfterMs;
    this.cause = options.cause;
  }
}
