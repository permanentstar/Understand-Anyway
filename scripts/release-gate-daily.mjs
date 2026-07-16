#!/usr/bin/env node

import { readJson, ensurePreflight, makeTempRoot, prepareProjectSource, initProject, writeDeployConfig, cleanup, run, stopGateway, assert } from "./lib/release-gate-helpers.mjs";
import { resolve } from "node:path";

async function main() {
  const { pluginRoot } = ensurePreflight();
  const projectsRoot = makeTempRoot("daily");
  const cleanupPaths = [projectsRoot];
  const projectId = "release-gate-daily";
  try {
    const repoPath = prepareProjectSource(projectsRoot, projectId, { git: true });
    initProject(projectsRoot, projectId);
    writeDeployConfig(projectsRoot, { host: "127.0.0.1", port: 18666 });

    const env = {
      ...process.env,
      UA_PROJECTS_ROOT: projectsRoot,
      UA_PLUGIN_ROOT: pluginRoot,
      UA_DEPLOY_PROFILE: "ppe",
    };
    const dailyScript = resolve(process.cwd(), "scripts", "daily-update.sh");

    run("bash", [dailyScript, "--project", projectId, "--profile", "small", "--no-self-update", "--no-pull", "--host", "127.0.0.1", "--port", "18666"], { cwd: process.cwd(), env });
    let latest = readJson(resolve(projectsRoot, "projects", projectId, ".understand-anything", "nightly-latest.json"));
    assert(latest.overallStatus === "success", "first daily run should succeed");

    run("bash", [dailyScript, "--project", projectId, "--profile", "small", "--no-self-update", "--no-pull", "--host", "127.0.0.1", "--port", "18666"], { cwd: process.cwd(), env });
    latest = readJson(resolve(projectsRoot, "projects", projectId, ".understand-anything", "nightly-latest.json"));
    assert(latest.build?.status === "skipped", "second daily run should skip build when commit is unchanged");

    process.stdout.write("release-gate-daily: PASS\n");
  } finally {
    stopGateway(projectsRoot);
    cleanup(cleanupPaths);
  }
}

main().catch((err) => {
  process.stderr.write(`release-gate-daily: FAIL: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
