#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { upsertProdRegistryRecord } from "./lib/upsert-project-registry.mjs";
import {
  assert,
  assertGatewayHealthy,
  cleanup,
  commitAll,
  countNotificationFiles,
  ensurePreflight,
  httpGet,
  initProject,
  makeTempRoot,
  pickPort,
  prepareProjectSource,
  publishProjectVersion,
  readJson,
  readGatewayPid,
  runCapture,
  stopGateway,
  uaCli,
  waitFor,
} from "./lib/release-gate-helpers.mjs";

async function runServeProbe(projectsRoot, projectId, token) {
  const port = await pickPort(18780);
  const env = { ...process.env, UA_PROJECTS_ROOT: projectsRoot };
  const child = spawn(process.execPath, ["packages/cli/dist/cli.js", "serve", "--project", projectId, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitFor(async () => {
      const res = await httpGet(`http://127.0.0.1:${port}/knowledge-graph.json?token=${token}`).catch(() => null);
      return res?.status === 200;
    }, { timeoutMs: 20000, intervalMs: 500, label: "serve --project" });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveStop) => child.once("close", resolveStop));
  }
}

async function main() {
  const { pluginRoot } = ensurePreflight();
  const projectsRoot = makeTempRoot("ops");
  const cleanupPaths = [projectsRoot];
  const projectId = "release-gate-ops";
  const env = { UA_PROJECTS_ROOT: projectsRoot };
  try {
    const repoPath = prepareProjectSource(projectsRoot, projectId, { git: true });
    initProject(projectsRoot, projectId);

    uaCli(["compat", "--plugin-root", pluginRoot], { env });
    uaCli(["build", "--project", projectId, "--plugin-root", pluginRoot, "--llm-analysis", "--llm-provider", "mock"], { env });

    const reviewPath = resolve(projectsRoot, "review.json");
    uaCli(["review-graph-health", "--project", projectId, "--output", reviewPath], { env });
    const review = readJson(reviewPath);
    assert(review.approved === true, "review-graph-health should approve healthy fixture");

    uaCli(["dashboard", "build-dist", "--project", projectId, "--plugin-root", pluginRoot, "--rebuild-dashboard"], { env });

    const dashboardPort = await pickPort(18700);
    uaCli(["dashboard", "start", "--project", projectId, "--host", "127.0.0.1", "--port", String(dashboardPort), "--no-open"], { env });
    const dashboardPidPath = resolve(projectsRoot, "projects", projectId, ".understand-anything", "dashboard.pid");
    await waitFor(() => existsSync(dashboardPidPath), { label: "dashboard pid file" });
    const dashboardPid = readJson(dashboardPidPath);
    const dashboardHome = await httpGet(dashboardPid.url);
    assert([200, 302].includes(dashboardHome.status), `dashboard home got ${dashboardHome.status}`);
    const dashboardStatus = runCapture(process.execPath, ["packages/cli/dist/cli.js", "dashboard", "status", "--project", projectId], { cwd: process.cwd(), env: { ...process.env, ...env } });
    assert(/alive/.test(dashboardStatus.stdout), "dashboard status should report alive");
    uaCli(["dashboard", "stop", "--project", projectId], { env });
    const dashboardStatusAfter = runCapture(process.execPath, ["packages/cli/dist/cli.js", "dashboard", "status", "--project", projectId], { cwd: process.cwd(), env: { ...process.env, ...env } });
    assert(/missing/.test(dashboardStatusAfter.stdout), "dashboard status should report missing after stop");

    const v1 = publishProjectVersion({ projectsRoot, projectId, pluginRoot, llmFlags: ["--llm-analysis", "--llm-provider", "mock"], stable: true });
    const changedFile = resolve(repoPath, "src", "welcome.ts");
    writeFileSync(changedFile, `${readFileSync(changedFile, "utf8")}\nexport const releaseGateOps = 1;\n`, "utf8");
    commitAll(repoPath, "ops change");
    const v2 = publishProjectVersion({ projectsRoot, projectId, pluginRoot, llmFlags: ["--llm-analysis", "--llm-provider", "mock"], stable: false });

    const projectList = runCapture(process.execPath, ["packages/cli/dist/cli.js", "project-state", "list", "--project", projectId], { cwd: process.cwd(), env: { ...process.env, ...env } });
    assert(projectList.stdout.includes(v1) && projectList.stdout.includes(v2), "project-state list should contain both versions");
    const projectStatePath = resolve(projectsRoot, "projects", projectId, "versioned-state.json");
    let projectState = readJson(projectStatePath);
    assert(projectState.currentVersion === v2, "project currentVersion should point at latest publish");
    assert(projectState.stableVersion === v1, "project stableVersion should stay on v1 before set-stable");
    uaCli(["project-state", "rollback", "--project", projectId], { env });
    projectState = readJson(projectStatePath);
    assert(projectState.currentVersion === v1, "project rollback should restore v1");
    uaCli(["project-state", "set-stable", v2, "--project", projectId], { env });
    projectState = readJson(projectStatePath);
    assert(projectState.stableVersion === v2, "project set-stable should move stable to v2");
    uaCli(["project-state", "gc", "--project", projectId, "--retain", "2"], { env });

    const registryPath = resolve(projectsRoot, "gateway", "registry.json");
    const gatewayPort = await pickPort(18690);
    await upsertProdRegistryRecord({
      rootDir: process.cwd(),
      registryPath,
      projectId,
      projectRoot: repoPath,
      stateRoot: resolve(projectsRoot, "projects", projectId),
      host: "127.0.0.1",
      port: gatewayPort,
    });

    uaCli(["gateway", "publish", "--projects-root", projectsRoot, "--stable", "--retain", "2", "--plugin-root", pluginRoot], { env });
    uaCli(["gateway", "publish", "--projects-root", projectsRoot, "--retain", "2", "--plugin-root", pluginRoot], { env });
    const gatewayList = runCapture(process.execPath, ["packages/cli/dist/cli.js", "gateway", "list", "--projects-root", projectsRoot, "--json"], { cwd: process.cwd(), env: { ...process.env, ...env } });
    const releases = JSON.parse(gatewayList.stdout);
    assert(Array.isArray(releases) && releases.length >= 2, "gateway list should show at least two releases");
    const current = releases.find((r) => r.current);
    const stable = releases.find((r) => r.stable);
    assert(current && stable, "gateway list should show current and stable");
    uaCli(["gateway", "rollback", "--projects-root", projectsRoot], { env });
    const gatewayStatePath = resolve(projectsRoot, "gateway", "runtime", "state.json");
    let gatewayState = readJson(gatewayStatePath);
    assert(gatewayState.currentVersion === stable.versionId, "gateway rollback should restore stable release");
    uaCli(["gateway", "set-stable", current.versionId, "--projects-root", projectsRoot], { env });
    gatewayState = readJson(gatewayStatePath);
    assert(gatewayState.stableVersion === current.versionId, "gateway set-stable should move stable");
    uaCli(["gateway", "gc", "--retain", "2", "--projects-root", projectsRoot], { env });

    uaCli(["gateway", "start", "--projects-root", projectsRoot, "--host", "127.0.0.1", "--port", String(gatewayPort), "--no-open"], { env });
    await waitFor(() => readGatewayPid(projectsRoot) !== null, { label: "gateway pid" });
    const { token } = await assertGatewayHealthy({ projectsRoot, projectId, port: gatewayPort });
    await runServeProbe(projectsRoot, projectId, token);
    uaCli(["gateway", "stop", "--projects-root", projectsRoot], { env });

    const reportPath = resolve(projectsRoot, "gateway", "operations", "nightly-latest.json");
    mkdirSync(resolve(projectsRoot, "gateway", "operations"), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify({
        runId: "20260702-ops",
        overallStatus: "success",
        generatedAt: new Date().toISOString(),
        projectsRoot,
        success: [projectId],
        skipped: [],
        failed: [],
        totals: { success: 1, skipped: 0, failed: 0 },
      }, null, 2),
      "utf8",
    );
    const beforeNotify = countNotificationFiles(projectsRoot);
    uaCli(["notify", "nightly", "--report", reportPath, "--best-effort"], { env });
    const afterNotify = countNotificationFiles(projectsRoot);
    assert(afterNotify === beforeNotify + 1, "notify nightly should emit one local notification file");

    process.stdout.write("release-gate-ops: PASS\n");
  } finally {
    stopGateway(projectsRoot);
    cleanup(cleanupPaths);
  }
}

main().catch((err) => {
  process.stderr.write(`release-gate-ops: FAIL: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
