/**
 * Generic retry layer around a single LLM call. Plan §2.2.
 *
 * Policy is the only knob; the algorithm itself is deterministic and contains
 * no fallback decisions (those live in providers / overlay):
 *   1. Run fn(); record an "ok" attempt log on success.
 *   2. On failure, classify the error: LlmError keeps its kind; bare Error is
 *      treated as kind="unknown" (not retryable).
 *   3. If retryable and attempt < maxAttempts, sleep then retry.
 *      Delay = retryAfterMs (if the provider supplied one) else jittered
 *      exponential backoff capped at maxBackoffMs.
 *   4. Otherwise rethrow.
 */

import { LlmError, type LlmErrorKind } from "@understand-anyway/plugin-api";

export interface RetryPolicy {
  /** Max attempts including the first try. 1 disables retry entirely. */
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  /** Symmetric jitter ratio in [0, 1]. 0 = deterministic delays. */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 500,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
  jitterRatio: 0.2,
};

export interface RetryAttemptLog {
  attempt: number;
  kind: LlmErrorKind | "ok";
  delayMs: number;
  durationMs: number;
}

export interface CallWithRetryDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const DEFAULT_DEPS: Required<CallWithRetryDeps> = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
};

function classifyError(err: unknown): { kind: LlmErrorKind; retryable: boolean; retryAfterMs?: number } {
  if (err instanceof LlmError) {
    return { kind: err.kind, retryable: err.retryable, retryAfterMs: err.retryAfterMs };
  }
  return { kind: "unknown", retryable: false };
}

function computeBackoffDelay(attemptIndex: number, policy: RetryPolicy, random: () => number): number {
  const base = Math.min(
    policy.initialBackoffMs * policy.backoffMultiplier ** attemptIndex,
    policy.maxBackoffMs,
  );
  if (policy.jitterRatio <= 0) return base;
  const factor = 1 + (random() - 0.5) * 2 * policy.jitterRatio;
  return base * factor;
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  onAttempt: (log: RetryAttemptLog) => void = () => {},
  deps: CallWithRetryDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? DEFAULT_DEPS.sleep;
  const random = deps.random ?? DEFAULT_DEPS.random;
  const now = deps.now ?? DEFAULT_DEPS.now;
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));

  let lastError: unknown;
  let delayMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (delayMs > 0) await sleep(delayMs);
    const startedAt = now();
    try {
      const result = await fn();
      onAttempt({ attempt, kind: "ok", delayMs, durationMs: now() - startedAt });
      return result;
    } catch (err) {
      const durationMs = now() - startedAt;
      const { kind, retryable, retryAfterMs } = classifyError(err);
      onAttempt({ attempt, kind, delayMs, durationMs });
      lastError = err;
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      delayMs = retryAfterMs ?? computeBackoffDelay(attempt - 1, policy, random);
    }
  }
  // Unreachable: the loop either returns or rethrows on the final attempt.
  throw lastError ?? new Error("callWithRetry exited the retry loop without resolving");
}
