/**
 * Upstream-dependent fixture regression (drift probe).
 *
 * Runs the real deterministic build against the committed `fixtures/sample-repo`
 * using the installed upstream plugin, then asserts node/edge counts match the
 * committed baseline. Skips cleanly when no upstream plugin is available, so the
 * CI main gate (which has none) stays green; the CI `fixture-regression` job runs
 * it for real.
 *
 * Includes a third case (C7) that asserts segmented mode produces a graph with
 * the same nodes/edges counts as the full-mode baseline. The CLI entry the
 * scheduler spawns is `packages/cli/dist/cli.js`, so this case also implicitly
 * skips when the CLI dist has not been built yet.
 *
 * The fixture is copied into a temp dir before building so the committed tree
 * never accumulates `.understand-anything/` intermediates.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBuildMode, runFullBuild } from "./build/pipeline.js";
import { bootstrapUpstream, type UpstreamRuntime } from "./upstream.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "..", "fixtures");
const baselinePath = resolve(fixturesRoot, "expected-graph-counts.json");
const cliEntryPath = resolve(here, "..", "..", "cli", "dist", "cli.js");

async function tryBootstrap(): Promise<UpstreamRuntime | null> {
  try {
    // Vitest's transform breaks the default `new Function("import")` shim, so
    // inject a native dynamic import here; production uses the default shim.
    return await bootstrapUpstream({}, { importModule: (specifier) => import(specifier) });
  } catch {
    return null;
  }
}

const upstream = await tryBootstrap();

describe.skipIf(!upstream)("fixture graph regression (upstream-dependent)", () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(resolve(tmpdir(), "ua-fixture-e2e-"));
    cpSync(resolve(fixturesRoot, "sample-repo"), resolve(workdir, "sample-repo"), { recursive: true });
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("builds the fixture and matches the committed baseline counts", async () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const result = await runFullBuild({
      core: upstream!.core,
      skillDir: upstream!.skillDir,
      projectRoot: resolve(workdir, "sample-repo"),
      excludeTests: false,
      log: () => {},
    });

    const byType: Record<string, number> = {};
    for (const edge of result.graph.edges) {
      byType[edge.type] = (byType[edge.type] ?? 0) + 1;
    }

    expect(result.graph.nodes.length).toBe(baseline.nodes);
    expect(result.graph.edges.length).toBe(baseline.edges);
    expect(byType).toEqual(baseline.edgesByType);
  });

  it("resumes the fixture from existing intermediate artifacts", async () => {
    const result = await runBuildMode({
      core: upstream!.core,
      skillDir: upstream!.skillDir,
      projectRoot: resolve(workdir, "sample-repo"),
      mode: "resume",
      excludeTests: false,
      log: () => {},
    });

    expect(result.mode).toBe("resume");
    expect(result.graph.nodes.length).toBeGreaterThan(0);
  });

  // C7: segmented batch-mode must produce a graph equivalent to the full-mode
  // baseline. Skips when packages/cli/dist/cli.js has not been built yet.
  describe.skipIf(!existsSync(cliEntryPath))("segmented batch-mode (C7)", () => {
    it("produces the same node/edge counts as the full-mode baseline", async () => {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      const segmentedDir = mkdtempSync(resolve(tmpdir(), "ua-fixture-segmented-"));
      try {
        cpSync(resolve(fixturesRoot, "sample-repo"), resolve(segmentedDir, "sample-repo"), { recursive: true });
        const result = await runFullBuild({
          core: upstream!.core,
          skillDir: upstream!.skillDir,
          projectRoot: resolve(segmentedDir, "sample-repo"),
          batchMode: "segmented",
          mapperBatchCount: 1,
          mapperConcurrency: 2,
          cliEntry: cliEntryPath,
          excludeTests: false,
          log: () => {},
        });

        const byType: Record<string, number> = {};
        for (const edge of result.graph.edges) {
          byType[edge.type] = (byType[edge.type] ?? 0) + 1;
        }
        expect(result.graph.nodes.length).toBe(baseline.nodes);
        expect(result.graph.edges.length).toBe(baseline.edges);
        expect(byType).toEqual(baseline.edgesByType);
      } finally {
        rmSync(segmentedDir, { recursive: true, force: true });
      }
    }, 60_000);
  });
});
