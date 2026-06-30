import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewGraphHealth } from "./run-graph-health-review.js";
import { runReviewHookCli } from "./run-review-hook.js";

interface CapturedExit {
  code: number | null;
}

function captureExit(): { exit: (code: number) => void; status: CapturedExit } {
  const status: CapturedExit = { code: null };
  const exit = (code: number) => {
    if (status.code === null) status.code = code;
  };
  return { exit, status };
}

function makeStateDir(graph: unknown): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ua-cli-review-"));
  const aa = join(dir, ".understand-anything");
  mkdirSync(aa, { recursive: true });
  writeFileSync(join(aa, "knowledge-graph.json"), JSON.stringify(graph));
  writeFileSync(join(aa, "meta.json"), JSON.stringify({ gitCommitHash: "deadbeef" }));
  writeFileSync(join(aa, "config.json"), JSON.stringify({ schemaVersion: 1 }));
  mkdirSync(join(aa, "runtime"), { recursive: true });
  writeFileSync(join(aa, "runtime", "modules.json"), JSON.stringify({ modules: [{ id: "scan", status: "active" }] }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("runReviewGraphHealth (CLI runner)", () => {
  it("approves a healthy fixture, writes review.json, and exits 0", () => {
    const repo = mkdtempSync(join(tmpdir(), "ua-cli-review-repo-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "//");
    writeFileSync(join(repo, "src", "b.ts"), "//");
    const fx = makeStateDir({
      nodes: [
        { id: "f1", type: "file", path: "src/a.ts" },
        { id: "f2", type: "file", path: "src/b.ts" },
      ],
      edges: [
        { type: "contains", source: "f1", target: "f2" },
        { type: "imports", source: "f1", target: "f2" },
        { type: "calls", source: "f1", target: "f2" },
      ],
    });
    const output = join(fx.dir, "review.json");
    const { exit, status } = captureExit();
    const logs: string[] = [];

    runReviewGraphHealth(
      { command: "review-graph-health", projectId: "alpha", output },
      {
        exit,
        log: (m) => logs.push(m),
        resolveProjectContext: () => ({
          projectId: "alpha",
          repoPath: repo,
          stateRoot: fx.dir,
          projectsRoot: join(fx.dir, ".."),
          portalAssetsRoot: join(fx.dir, "..", "gateway", "portal-assets"),
          projectsConfigPath: join(fx.dir, "..", "gateway", "config", "projects.json"),
          deployConfigPath: join(fx.dir, "..", "gateway", "config", "deploy.yaml"),
          entry: { projectId: "alpha" },
        }),
      },
    );

    expect(status.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(output, "utf8"));
    expect(onDisk.approved).toBe(true);
    expect(onDisk.issues).toEqual([]);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ approved: true, issueCount: 0, warningCount: 0 });
    fx.cleanup();
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects a graph with empty nodes and exits 1", () => {
    const repo = mkdtempSync(join(tmpdir(), "ua-cli-review-repo-"));
    const fx = makeStateDir({ nodes: [], edges: [] });
    const output = join(fx.dir, "review.json");
    const { exit, status } = captureExit();

    runReviewGraphHealth(
      { command: "review-graph-health", projectId: "alpha", output },
      {
        exit,
        log: () => {},
        resolveProjectContext: () => ({
          projectId: "alpha",
          repoPath: repo,
          stateRoot: fx.dir,
          projectsRoot: join(fx.dir, ".."),
          portalAssetsRoot: join(fx.dir, "..", "gateway", "portal-assets"),
          projectsConfigPath: join(fx.dir, "..", "gateway", "config", "projects.json"),
          deployConfigPath: join(fx.dir, "..", "gateway", "config", "deploy.yaml"),
          entry: { projectId: "alpha" },
        }),
      },
    );

    expect(status.code).toBe(1);
    const onDisk = JSON.parse(readFileSync(output, "utf8"));
    expect(onDisk.approved).toBe(false);
    fx.cleanup();
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("runReviewHookCli", () => {
  it("exits 2 (MISSING_COMMAND) when reviewCmd is empty", () => {
    const { exit, status } = captureExit();
    const errs: string[] = [];
    runReviewHookCli(
      { command: "run-review-hook", reviewCmd: "" },
      { exit, error: (m) => errs.push(m), env: {} },
    );
    expect(status.code).toBe(2);
    expect(errs[0]).toMatch(/missing/);
  });

  it("exits 3 (COMMAND_FAILED) when bash command exits non-zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-cli-review-hook-"));
    const reviewJson = join(dir, "review.json");
    const { exit, status } = captureExit();
    runReviewHookCli(
      { command: "run-review-hook", reviewCmd: "exit 7" },
      { exit, error: () => {}, env: { UA_REVIEW_JSON: reviewJson } as NodeJS.ProcessEnv },
    );
    expect(status.code).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 4 (OUTPUT_MISSING) when command succeeds but writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-cli-review-hook-"));
    const reviewJson = join(dir, "review.json");
    const { exit, status } = captureExit();
    runReviewHookCli(
      { command: "run-review-hook", reviewCmd: "true" },
      { exit, error: () => {}, env: { UA_REVIEW_JSON: reviewJson } as NodeJS.ProcessEnv },
    );
    expect(status.code).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 5 (OUTPUT_INVALID) when output is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-cli-review-hook-"));
    const reviewJson = join(dir, "review.json");
    const { exit, status } = captureExit();
    runReviewHookCli(
      { command: "run-review-hook", reviewCmd: `printf 'not-json' > "$UA_REVIEW_JSON"` },
      { exit, error: () => {}, env: { UA_REVIEW_JSON: reviewJson, PATH: process.env.PATH } as NodeJS.ProcessEnv },
    );
    expect(status.code).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 with summary line when hook succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-cli-review-hook-"));
    const reviewJson = join(dir, "review.json");
    const { exit, status } = captureExit();
    const logs: string[] = [];
    runReviewHookCli(
      {
        command: "run-review-hook",
        reviewCmd: `printf '{"approved":true,"issues":[],"warnings":[],"stats":{"k":"v"}}' > "$UA_REVIEW_JSON"`,
      },
      { exit, log: (m) => logs.push(m), env: { UA_REVIEW_JSON: reviewJson, PATH: process.env.PATH } as NodeJS.ProcessEnv },
    );
    expect(status.code).toBe(0);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ approved: true, issueCount: 0, warningCount: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});
