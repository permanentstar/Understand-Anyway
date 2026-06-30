/**
 * Unit tests for LlmError and the kind -> retryable derivation rules.
 *
 * Rules (locked by plan decisions):
 * - rate-limit / overload / timeout / network -> retryable
 * - auth / bad-request / parse / unknown -> NOT retryable
 * - retryAfterMs is opt-in metadata and never forced
 * - retryable is derived from kind and cannot be overridden by callers
 */

import { describe, expect, it } from "vitest";
import { LlmError, type LlmErrorKind } from "./llm.js";

const RETRYABLE_KINDS: LlmErrorKind[] = ["rate-limit", "overload", "timeout", "network"];
const TERMINAL_KINDS: LlmErrorKind[] = ["auth", "bad-request", "parse", "unknown"];

describe("LlmError", () => {
  it("is an Error subclass with the right name and message", () => {
    const err = new LlmError("rate-limit", "too many requests");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.name).toBe("LlmError");
    expect(err.message).toBe("too many requests");
  });

  it.each(RETRYABLE_KINDS)("marks kind=%s as retryable", (kind) => {
    expect(new LlmError(kind, "x").retryable).toBe(true);
  });

  it.each(TERMINAL_KINDS)("marks kind=%s as NOT retryable", (kind) => {
    expect(new LlmError(kind, "x").retryable).toBe(false);
  });

  it("treats unknown as terminal (conservative default)", () => {
    expect(new LlmError("unknown", "huh").retryable).toBe(false);
  });

  it("preserves retryAfterMs when provided", () => {
    const err = new LlmError("rate-limit", "x", { retryAfterMs: 1500 });
    expect(err.retryAfterMs).toBe(1500);
  });

  it("leaves retryAfterMs undefined when not provided", () => {
    expect(new LlmError("rate-limit", "x").retryAfterMs).toBeUndefined();
  });

  it("preserves cause as an opaque value", () => {
    const inner = new Error("boom");
    const err = new LlmError("network", "wrap", { cause: inner });
    expect(err.cause).toBe(inner);
  });
});
