/**
 * Unit tests for callWithRetry. All side effects (sleep / random / now) are
 * injected, so the algorithm is fully deterministic under test.
 *
 * Locked behaviour (plan §2.2):
 * - retry only when err is an LlmError with retryable=true
 * - bare Error is treated as unknown (i.e. not retried)
 * - delay = retryAfterMs if provider supplied it; otherwise backoff with jitter
 * - backoff = min(initial * multiplier^(attempt-1), maxBackoff)
 * - jitter applied as base * (1 + (random()-0.5) * 2 * jitterRatio)
 * - maxAttempts is inclusive of the first try (maxAttempts=1 -> no retry)
 */

import { describe, expect, it } from "vitest";
import { LlmError } from "@understand-anyway/plugin-api";
import {
  callWithRetry,
  DEFAULT_RETRY_POLICY,
  type RetryAttemptLog,
  type RetryPolicy,
} from "./llm-retry.js";

interface Harness {
  sleeps: number[];
  attempts: RetryAttemptLog[];
  policy: RetryPolicy;
  /** Deterministic deps: sleep records duration, now ticks 1 per call, random returns 0.5 (no jitter). */
  deps: { sleep: (ms: number) => Promise<void>; random: () => number; now: () => number };
}

function harness(overrides: Partial<RetryPolicy> = {}, randomValue = 0.5): Harness {
  const sleeps: number[] = [];
  let clock = 0;
  const attempts: RetryAttemptLog[] = [];
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    jitterRatio: 0, // tests opt-in to jitter explicitly
    ...overrides,
  };
  return {
    sleeps,
    attempts,
    policy,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => randomValue,
      now: () => ++clock,
    },
  };
}

describe("callWithRetry", () => {
  it("returns first-call success and records a single ok attempt", async () => {
    const h = harness();
    const result = await callWithRetry(async () => "hello", h.policy, (log) => h.attempts.push(log), h.deps);
    expect(result).toBe("hello");
    expect(h.attempts).toEqual([
      { attempt: 1, kind: "ok", delayMs: 0, durationMs: expect.any(Number) },
    ]);
    expect(h.sleeps).toEqual([]);
  });

  it("retries on retryable LlmError and succeeds on second attempt", async () => {
    const h = harness({ maxAttempts: 3, initialBackoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 1000 });
    let calls = 0;
    const result = await callWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new LlmError("rate-limit", "429");
        return "ok";
      },
      h.policy,
      (log) => h.attempts.push(log),
      h.deps,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(h.attempts.map((a) => a.kind)).toEqual(["rate-limit", "ok"]);
    expect(h.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    // first attempt no delay; second delay = base 100 * 2^0 = 100
    expect(h.sleeps).toEqual([100]);
  });

  it("does NOT retry terminal LlmError (auth)", async () => {
    const h = harness();
    let calls = 0;
    await expect(
      callWithRetry(
        async () => {
          calls += 1;
          throw new LlmError("auth", "401");
        },
        h.policy,
        (log) => h.attempts.push(log),
        h.deps,
      ),
    ).rejects.toBeInstanceOf(LlmError);
    expect(calls).toBe(1);
    expect(h.attempts.map((a) => a.kind)).toEqual(["auth"]);
    expect(h.sleeps).toEqual([]);
  });

  it("treats a bare Error as unknown and does NOT retry it", async () => {
    const h = harness();
    let calls = 0;
    await expect(
      callWithRetry(
        async () => {
          calls += 1;
          throw new Error("plain failure");
        },
        h.policy,
        (log) => h.attempts.push(log),
        h.deps,
      ),
    ).rejects.toThrow("plain failure");
    expect(calls).toBe(1);
    expect(h.attempts.map((a) => a.kind)).toEqual(["unknown"]);
    expect(h.sleeps).toEqual([]);
  });

  it("exhausts attempts and re-throws last error with attempt log on cause", async () => {
    const h = harness({ maxAttempts: 3, initialBackoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 1000 });
    let calls = 0;
    let caught: unknown;
    try {
      await callWithRetry(
        async () => {
          calls += 1;
          throw new LlmError("overload", `attempt ${calls}`);
        },
        h.policy,
        (log) => h.attempts.push(log),
        h.deps,
      );
    } catch (err) {
      caught = err;
    }
    expect(calls).toBe(3);
    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).message).toBe("attempt 3");
    expect(h.attempts.map((a) => a.kind)).toEqual(["overload", "overload", "overload"]);
    // delays: 100 * 2^0 = 100, then 100 * 2^1 = 200
    expect(h.sleeps).toEqual([100, 200]);
  });

  it("respects retryAfterMs when provider supplies it (overrides backoff)", async () => {
    const h = harness({ maxAttempts: 3, initialBackoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 1000 });
    let calls = 0;
    await callWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new LlmError("rate-limit", "429", { retryAfterMs: 4242 });
        return "ok";
      },
      h.policy,
      (log) => h.attempts.push(log),
      h.deps,
    );
    expect(h.sleeps).toEqual([4242]);
    expect(h.attempts[1]?.delayMs).toBe(4242);
  });

  it("caps backoff at maxBackoffMs", async () => {
    const h = harness({ maxAttempts: 5, initialBackoffMs: 1000, backoffMultiplier: 10, maxBackoffMs: 3000 });
    let calls = 0;
    try {
      await callWithRetry(
        async () => {
          calls += 1;
          throw new LlmError("timeout", "slow");
        },
        h.policy,
        (log) => h.attempts.push(log),
        h.deps,
      );
    } catch {
      /* expected */
    }
    expect(calls).toBe(5);
    // raw backoffs would be 1000, 10000, 100000, 1000000 — all capped at 3000 except first
    expect(h.sleeps).toEqual([1000, 3000, 3000, 3000]);
  });

  it("applies jitter symmetrically using injected random()", async () => {
    // random=0 -> -jitterRatio (-20% with ratio 0.2); random=1 -> +20%
    const low = harness({ maxAttempts: 2, initialBackoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 5000, jitterRatio: 0.2 }, 0);
    const high = harness({ maxAttempts: 2, initialBackoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 5000, jitterRatio: 0.2 }, 1);
    let lowCalls = 0;
    let highCalls = 0;
    try {
      await callWithRetry(
        async () => {
          lowCalls += 1;
          throw new LlmError("network", "");
        },
        low.policy,
        (l) => low.attempts.push(l),
        low.deps,
      );
    } catch {
      /* expected */
    }
    try {
      await callWithRetry(
        async () => {
          highCalls += 1;
          throw new LlmError("network", "");
        },
        high.policy,
        (l) => high.attempts.push(l),
        high.deps,
      );
    } catch {
      /* expected */
    }
    expect(lowCalls).toBe(2);
    expect(highCalls).toBe(2);
    expect(low.sleeps[0]).toBe(800); // 1000 * (1 + (0 - 0.5) * 2 * 0.2) = 1000 * 0.8
    expect(high.sleeps[0]).toBe(1200); // 1000 * (1 + (1 - 0.5) * 2 * 0.2) = 1000 * 1.2
  });

  it("maxAttempts=1 means no retry at all", async () => {
    const h = harness({ maxAttempts: 1 });
    let calls = 0;
    await expect(
      callWithRetry(
        async () => {
          calls += 1;
          throw new LlmError("rate-limit", "x");
        },
        h.policy,
        (log) => h.attempts.push(log),
        h.deps,
      ),
    ).rejects.toBeInstanceOf(LlmError);
    expect(calls).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("records durationMs on every attempt log entry", async () => {
    const h = harness({ maxAttempts: 2, initialBackoffMs: 50, backoffMultiplier: 2, maxBackoffMs: 500 });
    await callWithRetry(
      async () => "ok",
      h.policy,
      (log) => h.attempts.push(log),
      h.deps,
    );
    for (const log of h.attempts) {
      expect(log.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
