#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assert,
  cleanup,
  commitAll,
  ensurePreflight,
  initProject,
  makeTempRoot,
  prepareProjectSource,
  readJson,
  uaCli,
} from "./lib/release-gate-helpers.mjs";

async function main() {
  const { pluginRoot } = ensurePreflight();
  const projectsRoot = makeTempRoot("build-modes");
  const cleanupPaths = [projectsRoot];
  const projectId = "release-gate-build";
  try {
    const repoPath = prepareProjectSource(projectsRoot, projectId, { git: true });
    const { env } = initProject(projectsRoot, projectId);

    uaCli(["build", "--project", projectId, "--plugin-root", pluginRoot, "--llm-analysis", "--llm-provider", "mock"], { env });
    uaCli(["build", "--project", projectId, "--plugin-root", pluginRoot, "--resume"], { env });

    const changedFile = resolve(repoPath, "src", "welcome.ts");
    writeFileSync(changedFile, `${readFileSync(changedFile, "utf8")}\nexport const releaseGateIncremental = 1;\n`, "utf8");
    commitAll(repoPath, "incremental change");
    uaCli(["build", "--project", projectId, "--plugin-root", pluginRoot, "--incremental"], { env });

    const backfillFile = resolve(repoPath, "src", "release_gate_backfill.ts");
    writeFileSync(backfillFile, "export const releaseGateBackfill = 1;\n", "utf8");
    uaCli(["build", "--project", projectId, "--plugin-root", pluginRoot, "--backfill", "--include", "src/release_gate_backfill.ts"], { env });

    const graphPath = resolve(projectsRoot, "projects", projectId, ".understand-anything", "knowledge-graph.json");
    const graph = readJson(graphPath);
    assert(Array.isArray(graph.nodes), "graph nodes missing after build mode matrix");
    assert(
      graph.nodes.some((node) => String(node?.filePath || "").includes("release_gate_backfill.ts")),
      "backfill result missing new file node",
    );

    uaCli(["repair", "llm-failures", "--project", projectId, "--plugin-root", pluginRoot, "--llm-provider", "mock", "--repair-dry-run"], { env });
    uaCli(["repair", "llm-graph-failures", "--project", projectId, "--plugin-root", pluginRoot, "--llm-provider", "mock", "--repair-dry-run"], { env });

    process.stdout.write("release-gate-build-modes: PASS\n");
  } finally {
    cleanup(cleanupPaths);
  }
}

main().catch((err) => {
  process.stderr.write(`release-gate-build-modes: FAIL: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
