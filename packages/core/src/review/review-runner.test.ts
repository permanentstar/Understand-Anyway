import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_RUNNER_ERROR_KINDS,
  ReviewRunnerError,
  loadAndValidateReviewSummary,
  runReviewHook,
} from "./review-runner.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "ua-review-runner-"));
}

describe("loadAndValidateReviewSummary", () => {
  it("returns normalized summary for a well-formed payload", () => {
    const dir = makeTmp();
    const path = join(dir, "review.json");
    writeFileSync(path, JSON.stringify({
      approved: true,
      issues: [{ id: "x" }],
      warnings: [],
      stats: { source: "test" },
    }));
    const summary = loadAndValidateReviewSummary(path);
    expect(summary.approved).toBe(true);
    expect(summary.issues).toEqual([{ id: "x" }]);
    expect(summary.warnings).toEqual([]);
    expect(summary.stats).toEqual({ source: "test" });
    expect(summary.raw.approved).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws OUTPUT_MISSING when file is absent or path empty", () => {
    expect(() => loadAndValidateReviewSummary("")).toThrow(ReviewRunnerError);
    try {
      loadAndValidateReviewSummary("");
    } catch (err) {
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_MISSING);
    }
    expect(() => loadAndValidateReviewSummary("/nonexistent/review.json")).toThrow(/review output missing/);
  });

  it("throws OUTPUT_INVALID for non-JSON content", () => {
    const dir = makeTmp();
    const path = join(dir, "review.json");
    writeFileSync(path, "not-json");
    try {
      loadAndValidateReviewSummary(path);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewRunnerError);
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws OUTPUT_INVALID when payload is an array (not object)", () => {
    const dir = makeTmp();
    const path = join(dir, "review.json");
    writeFileSync(path, JSON.stringify([1, 2]));
    try {
      loadAndValidateReviewSummary(path);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws OUTPUT_INVALID when 'approved' is missing or not boolean", () => {
    const dir = makeTmp();
    const path = join(dir, "review.json");
    writeFileSync(path, JSON.stringify({ approved: "yes", issues: [], warnings: [], stats: {} }));
    try {
      loadAndValidateReviewSummary(path);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID);
      expect((err as ReviewRunnerError).message).toMatch(/approved/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws OUTPUT_INVALID when 'issues' is not array", () => {
    const dir = makeTmp();
    const path = join(dir, "review.json");
    writeFileSync(path, JSON.stringify({ approved: true, issues: "no", warnings: [], stats: {} }));
    try {
      loadAndValidateReviewSummary(path);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID);
      expect((err as ReviewRunnerError).message).toMatch(/issues/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws OUTPUT_INVALID when 'warnings' is not array", () => {
    const dir = makeTmp();
    const path = join(dir, "review.json");
    writeFileSync(path, JSON.stringify({ approved: true, issues: [], warnings: "no", stats: {} }));
    try {
      loadAndValidateReviewSummary(path);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID);
      expect((err as ReviewRunnerError).message).toMatch(/warnings/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws OUTPUT_INVALID when 'stats' is not an object", () => {
    const dir = makeTmp();
    const path = join(dir, "review.json");
    writeFileSync(path, JSON.stringify({ approved: true, issues: [], warnings: [], stats: [1] }));
    try {
      loadAndValidateReviewSummary(path);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_INVALID);
      expect((err as ReviewRunnerError).message).toMatch(/stats/);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runReviewHook", () => {
  it("throws MISSING_COMMAND when reviewCmd is empty", () => {
    try {
      runReviewHook({ reviewCmd: "   " });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewRunnerError);
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.MISSING_COMMAND);
    }
  });

  it("throws COMMAND_FAILED when bash exits non-zero", () => {
    try {
      runReviewHook({ reviewCmd: "exit 7", env: { UA_REVIEW_JSON: "/tmp/never" } as NodeJS.ProcessEnv });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewRunnerError);
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.COMMAND_FAILED);
      expect((err as ReviewRunnerError).message).toMatch(/exit code/);
    }
  });

  it("throws OUTPUT_MISSING when command succeeds but no review.json was written", () => {
    const dir = makeTmp();
    const reviewJson = join(dir, "review.json");
    try {
      runReviewHook({ reviewCmd: "true", env: { UA_REVIEW_JSON: reviewJson } as NodeJS.ProcessEnv });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewRunnerError);
      expect((err as ReviewRunnerError).kind).toBe(REVIEW_RUNNER_ERROR_KINDS.OUTPUT_MISSING);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the validated summary on success", () => {
    const dir = makeTmp();
    const reviewJson = join(dir, "review.json");
    const summary = runReviewHook({
      reviewCmd: `printf '{"approved":true,"issues":[],"warnings":[],"stats":{"source":"hook"}}' > "$UA_REVIEW_JSON"`,
      env: { UA_REVIEW_JSON: reviewJson, PATH: process.env.PATH } as NodeJS.ProcessEnv,
    });
    expect(summary.approved).toBe(true);
    expect(summary.stats).toEqual({ source: "hook" });
    rmSync(dir, { recursive: true, force: true });
  });
});
