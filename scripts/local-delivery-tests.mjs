#!/usr/bin/env node
// scripts/local-delivery-tests.mjs
//
// One-shot local delivery verification orchestrator.
//
// Runs the three local release-test layers in order:
//   1. repo-checkout    repo + pnpm install/build, direct CLI from dist/
//   2. npm-verdaccio    Verdaccio local registry publish + pnpm add
//   3. shared-gateway   two projects + LLM enrichment + token isolation
//
// LLM enrichment is exercised only in case 3:
//   - --profile oss        → builtin "mock" provider (deterministic stub)
//   - --profile real-llm   → builtin "cli-spawn" provider (real CLI, requires `llm` on PATH)
//
// Usage:
//   pnpm run delivery:local [--profile oss|real-llm] [--only repo-checkout|verdaccio|shared-gateway]
//                           [--keep-running] [--keep-temp] [--verbose]
//
// Exit codes:
//   0  all selected cases passed
//   1  one or more cases failed
//   2  preflight (env / tools) failed

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_DIST = resolve(REPO_ROOT, "packages", "cli", "dist", "cli.js");
const FIXTURE_REPO = resolve(REPO_ROOT, "packages", "core", "fixtures", "sample-repo");

const ALL_CASES = ["repo-checkout", "verdaccio", "shared-gateway"];

function parseArgv(argv) {
  const out = {
    profile: "oss",
    only: null,
    keepRunning: false,
    keepTemp: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        break;
      case "--profile":
        out.profile = String(argv[++i] || "").trim();
        if (!["oss", "real-llm"].includes(out.profile)) {
          die(`--profile must be oss or real-llm, got ${out.profile}`, 2);
        }
        break;
      case "--only":
        out.only = String(argv[++i] || "").trim();
        if (!ALL_CASES.includes(out.only)) {
          die(`--only must be one of ${ALL_CASES.join("|")}, got ${out.only}`, 2);
        }
        break;
      case "--keep-running":
        out.keepRunning = true;
        break;
      case "--keep-temp":
        out.keepTemp = true;
        break;
      case "--verbose":
      case "-v":
        out.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        die(`unknown argument: ${arg}`, 2);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: pnpm run delivery:local [options]",
      "",
      "Options:",
      "  --profile <oss|real-llm>   LLM profile for case 3. oss=mock (default), real-llm=cli-spawn",
      "  --only <case>               Run only one case (repo-checkout|verdaccio|shared-gateway)",
      "  --keep-running              After case 3, leave the gateway running and print URL/token/PID",
      "  --keep-temp                 Do not delete temp work dirs (debug)",
      "  --verbose, -v               Stream subprocess stdout/stderr live",
      "  --help, -h                  Show this help",
      "",
      "Required environment:",
      "  UA_PLUGIN_ROOT              Path to an installed Understand-Anything plugin root",
      "",
    ].join("\n"),
  );
}

function die(msg, code = 1) {
  process.stderr.write(`[delivery:local] ${msg}\n`);
  process.exit(code);
}

function log(msg) {
  process.stdout.write(`[delivery:local] ${msg}\n`);
}

function logStep(name, msg) {
  process.stdout.write(`[delivery:local] [${name}] ${msg}\n`);
}

// -- helpers ------------------------------------------------------------------

function run(cmd, args, options = {}) {
  const { cwd, env, stdio = "inherit", verbose } = options;
  if (verbose || process.env.UA_DELIVERY_VERBOSE === "1") {
    process.stdout.write(`[run] ${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
  }
  const res = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio,
    encoding: "utf8",
  });
  if (res.error) throw new Error(`spawn ${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
  }
  return res;
}

function runCapture(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
  });
}

function checkTool(name, args = ["--version"]) {
  const probe = spawnSync(name, args, { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return null;
  }
  return (probe.stdout || probe.stderr || "").trim().split(/\s+/).pop();
}

async function portFree(port) {
  return await new Promise((resolveProbe) => {
    const srv = createServer();
    srv.once("error", () => resolveProbe(false));
    srv.once("listening", () => {
      srv.close(() => resolveProbe(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(preferred, tries = 3) {
  let port = preferred;
  for (let i = 0; i < tries; i += 1) {
    if (await portFree(port)) return port;
    port += 1;
  }
  throw new Error(`no free port near ${preferred} (tried ${tries})`);
}

function httpGet(url, headers = {}) {
  return new Promise((resolveHttp, rejectHttp) => {
    const req = httpRequest(url, { method: "GET", headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolveHttp({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", rejectHttp);
    req.on("timeout", () => {
      req.destroy(new Error("http timeout"));
    });
    req.end();
  });
}

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 500, label = "condition" }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const ok = await predicate();
      if (ok) return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function assert(condition, msg) {
  if (!condition) {
    throw new Error(`assertion failed: ${msg}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readGatewayPid(projectsRoot) {
  const path = resolve(projectsRoot, "gateway", ".understand-anything", "dashboard.pid");
  if (!existsSync(path)) return null;
  return readJson(path);
}

function uaCli(args, options = {}) {
  return run(process.execPath, [CLI_DIST, ...args], options);
}

function makeTempRoot(label) {
  return mkdtempSync(resolve(tmpdir(), `ua-delivery-${label}-`));
}

function copyTrackedRepoSnapshot(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const tracked = runCapture("git", ["ls-files", "-z"], { cwd: REPO_ROOT });
  if (tracked.status !== 0) {
    throw new Error(`git ls-files failed: ${tracked.stderr || tracked.stdout}`);
  }
  for (const rel of tracked.stdout.split("\0")) {
    if (!rel) continue;
    const src = resolve(REPO_ROOT, rel);
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    const dest = resolve(targetDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  run("git", ["init"], { cwd: targetDir, stdio: "ignore" });
  run("git", ["add", "-A"], { cwd: targetDir, stdio: "ignore" });
  run(
    "git",
    ["-c", "user.name=local-delivery", "-c", "user.email=local-delivery@example.invalid", "commit", "-m", "snapshot"],
    { cwd: targetDir, stdio: "ignore" },
  );
}

function cleanup(paths, keep) {
  if (keep) return;
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

function stopGateway(projectsRoot) {
  try {
    runCapture(process.execPath, [CLI_DIST, "gateway", "stop", "--projects-root", projectsRoot]);
  } catch {}
}

function prepareProjectSource(projectsRoot, projectId) {
  const dest = resolve(projectsRoot, "src", projectId);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(FIXTURE_REPO, dest, { recursive: true });
  return dest;
}

function publishProjectVersion({ projectsRoot, projectId, pluginRoot, llmFlags = [] }) {
  const env = { UA_PROJECTS_ROOT: projectsRoot };
  uaCli(
    ["build", "--project", projectId, "--plugin-root", pluginRoot, ...llmFlags],
    { env },
  );
  uaCli(
    ["dashboard", "build-dist", "--project", projectId, "--plugin-root", pluginRoot, "--rebuild-dashboard"],
    { env },
  );
  const vid = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  uaCli(
    [
      "project-state",
      "publish",
      vid,
      "--project",
      projectId,
      "--source-root",
      resolve(projectsRoot, "src", projectId),
      "--stable",
      "--retain",
      "2",
    ],
    { env },
  );
  return vid;
}

async function assertGatewayHealthy({ projectsRoot, projectId, port }) {
  const pid = readGatewayPid(projectsRoot);
  assert(pid && pid.port, "gateway pid file missing or no port");
  const base = `http://127.0.0.1:${pid.port}`;

  // Portal HTML
  const portal = await httpGet(`${base}/`);
  assert(portal.status === 200, `portal / got ${portal.status}`);
  assert(/<html/i.test(portal.body), "portal / body is not HTML");

  // Project route requires token from registry
  const registry = readJson(resolve(projectsRoot, "gateway", "registry.json"));
  const record = registry.projects?.[projectId];
  assert(record?.prodToken, `registry has no prodToken for ${projectId}`);
  const token = record.prodToken;

  const projectHome = await httpGet(`${base}/project/${projectId}/?token=${token}`);
  assert([200, 302].includes(projectHome.status), `project home got ${projectHome.status}`);

  const kg = await httpGet(`${base}/project/${projectId}/knowledge-graph.json?token=${token}`);
  assert(kg.status === 200, `knowledge-graph.json got ${kg.status}`);
  const kgJson = JSON.parse(kg.body);
  assert(Array.isArray(kgJson.nodes) && kgJson.nodes.length > 0, "knowledge-graph.json has no nodes");

  return { pid, token, base, kg: kgJson, record };
}

// -- preflight ----------------------------------------------------------------

async function preflight(opts) {
  log("preflight: checking environment...");
  const pluginRoot = process.env.UA_PLUGIN_ROOT;
  if (!pluginRoot) die("missing UA_PLUGIN_ROOT (export it to the upstream plugin root)", 2);
  const required = ["package.json"];
  for (const name of required) {
    if (!existsSync(resolve(pluginRoot, name))) {
      die(`UA_PLUGIN_ROOT=${pluginRoot} missing ${name}/`, 2);
    }
  }
  const major = Number((process.versions.node || "0").split(".")[0]);
  if (major < 20) die(`Node >= 20 required, got ${process.versions.node}`, 2);
  if (!checkTool("pnpm")) die("pnpm not on PATH", 2);
  if (!existsSync(CLI_DIST)) die(`CLI not built (${CLI_DIST}); run pnpm build`, 2);
  if (!existsSync(FIXTURE_REPO)) die(`fixture missing: ${FIXTURE_REPO}`, 2);
    if (opts.profile === "real-llm" && !checkTool("llm")) die("--profile real-llm requires `llm` on PATH", 2);
  log(`preflight: ok (profile=${opts.profile}, plugin-root=${pluginRoot})`);
  return { pluginRoot };
}

// -- case 1: repo-checkout ----------------------------------------------------

async function caseRepoCheckout({ pluginRoot, opts }) {
  const name = "repo-checkout";
  logStep(name, "starting");
  const projectsRoot = makeTempRoot("repo");
  const cleanupPaths = [projectsRoot];
  const env = { UA_PROJECTS_ROOT: projectsRoot };
  const projectId = "mini-project";
  try {
    prepareProjectSource(projectsRoot, projectId);
    logStep(name, "init");
    uaCli(
      [
        "init",
        resolve(projectsRoot, "src", projectId),
        "--project",
        projectId,
        "--repo-path",
        "${projectsRoot}/src/${projectId}",
      ],
      { env },
    );
    logStep(name, "build + publish");
    publishProjectVersion({ projectsRoot, projectId, pluginRoot });

    logStep(name, "gateway publish");
    const port = await pickPort(18666);
    uaCli(
      ["gateway", "publish", "--projects-root", projectsRoot, "--stable", "--retain", "2", "--plugin-root", pluginRoot],
      { env },
    );

    logStep(name, `gateway start on :${port}`);
    // Manually upsert prod registry record so portal/project-route resolves.
    const { upsertProdRegistryRecord } = await import(
      pathToFileUrl(resolve(REPO_ROOT, "scripts/lib/upsert-project-registry.mjs"))
    );
    await upsertProdRegistryRecord({
      rootDir: REPO_ROOT,
      registryPath: resolve(projectsRoot, "gateway", "registry.json"),
      projectId,
      projectRoot: resolve(projectsRoot, "src", projectId),
      stateRoot: resolve(projectsRoot, "projects", projectId),
      host: "127.0.0.1",
      port,
    });

    uaCli(
      ["gateway", "start", "--projects-root", projectsRoot, "--host", "127.0.0.1", "--port", String(port), "--no-open"],
      { env },
    );

    await waitFor(
      async () => {
        const p = readGatewayPid(projectsRoot);
        if (!p) return false;
        const res = await httpGet(`http://127.0.0.1:${p.port}/`).catch(() => null);
        return res && res.status === 200;
      },
      { label: "gateway listening" },
    );

    logStep(name, "asserting endpoints");
    await assertGatewayHealthy({ projectsRoot, projectId, port });
    logStep(name, "PASS");
    return { ok: true };
  } catch (err) {
    logStep(name, `FAIL: ${err.message}`);
    return { ok: false, error: err };
  } finally {
    stopGateway(projectsRoot);
    cleanup(cleanupPaths, opts.keepTemp);
  }
}

// -- case 2: npm-verdaccio ----------------------------------------------------

async function caseVerdaccio({ pluginRoot, opts }) {
  const name = "verdaccio";
  logStep(name, "starting");
  const tempRoot = makeTempRoot("verdaccio");
  const projectsRoot = resolve(tempRoot, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  const cleanupPaths = [tempRoot];
  const projectId = "mini-project";
  const env = { UA_PROJECTS_ROOT: projectsRoot };

  let verdaccioProc = null;
  try {
    const registryPort = await pickPort(4873);
    const registryUrl = `http://127.0.0.1:${registryPort}`;
    const storageRoot = resolve(tempRoot, "verdaccio-storage");
    mkdirSync(storageRoot, { recursive: true });
    const configPath = resolve(tempRoot, "verdaccio-config.yaml");
    writeFileSync(
      configPath,
      [
        `storage: ${storageRoot}`,
        "auth:",
        "  htpasswd:",
        `    file: ${resolve(tempRoot, "htpasswd")}`,
        "    max_users: -1",
        "uplinks:",
        "  npmjs:",
        "    url: https://registry.npmjs.org/",
        "    timeout: 30s",
        "    maxage: 2m",
        "packages:",
        "  '@understand-anyway/*':",
        "    access: $all",
        "    publish: $anonymous",
        "    unpublish: $anonymous",
        "  '@*/*':",
        "    access: $all",
        "    publish: $anonymous",
        "    proxy: npmjs",
        "  '**':",
        "    access: $all",
        "    publish: $anonymous",
        "    unpublish: $anonymous",
        "    proxy: npmjs",
        "log: { type: stdout, format: pretty, level: warn }",
        "",
      ].join("\n"),
      "utf8",
    );

    logStep(name, `starting Verdaccio on :${registryPort}`);
    verdaccioProc = spawn(
      "pnpm",
      ["dlx", "verdaccio", "-c", configPath, "-l", `127.0.0.1:${registryPort}`],
      { stdio: opts.verbose ? "inherit" : ["ignore", "pipe", "pipe"], cwd: tempRoot },
    );
    if (!opts.verbose && verdaccioProc.stdout) {
      verdaccioProc.stdout.on("data", () => {});
      verdaccioProc.stderr?.on("data", () => {});
    }
    await waitFor(
      async () => {
        const res = await httpGet(`${registryUrl}/-/ping`).catch(() => null);
        return res && (res.status === 200 || res.status === 404);
      },
      { timeoutMs: 60000, label: "verdaccio ready" },
    );

    logStep(name, "publishing 6 packages");
    const npmrcPath = resolve(tempRoot, ".npmrc");
    writeFileSync(
      npmrcPath,
      [
        `registry=${registryUrl}/`,
        `//127.0.0.1:${registryPort}/:_authToken=anonymous`,
        "always-auth=false",
        "",
      ].join("\n"),
      "utf8",
    );
    const npmEnv = { npm_config_userconfig: npmrcPath, NPM_CONFIG_USERCONFIG: npmrcPath };
    const releaseRepo = resolve(tempRoot, "release-repo");
    logStep(name, "creating clean release-script snapshot");
    copyTrackedRepoSnapshot(releaseRepo);
    run("pnpm", ["install", "--frozen-lockfile"], { cwd: releaseRepo, env: npmEnv });
    run(
      process.execPath,
      ["scripts/release.mjs", "patch", "--skip-git", "--registry", registryUrl],
      { cwd: releaseRepo, env: npmEnv },
    );

    logStep(name, "verifying packages on registry");
    const expected = [
      "@understand-anyway/core",
      "@understand-anyway/gateway",
      "@understand-anyway/plugin-api",
      "@understand-anyway/provider-feishu-auth",
      "@understand-anyway/provider-feishu-sheets",
      "@understand-anyway/cli",
    ];
    for (const pkg of expected) {
      const packageUrl = `${registryUrl}/${encodeURIComponent(pkg).replace(/%40/g, "@").replace(/%2F/g, "/")}`;
      await waitFor(
        async () => {
          const res = await httpGet(packageUrl).catch(() => null);
          return res?.status === 200;
        },
        { timeoutMs: 30000, intervalMs: 1000, label: `${pkg} on registry` },
      );
    }

    logStep(name, "installing CLI into clean dir");
    const installDir = resolve(tempRoot, "install");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      resolve(installDir, "package.json"),
      JSON.stringify({ name: "ua-delivery-install-probe", version: "0.0.0", private: true }, null, 2),
    );
    run("pnpm", ["add", "@understand-anyway/cli", "--registry", registryUrl, "--no-lockfile"], {
      cwd: installDir,
      env: npmEnv,
    });
    const cliPkg = readJson(
      resolve(installDir, "node_modules", "@understand-anyway", "cli", "package.json"),
    );
    for (const [dep, ver] of Object.entries(cliPkg.dependencies ?? {})) {
      assert(!String(ver).startsWith("workspace:"), `installed CLI still has workspace: dep ${dep}=${ver}`);
    }

    logStep(name, "exec --help via pnpm exec");
    const helpProbe = runCapture("pnpm", ["exec", "understand-anyway", "--help"], { cwd: installDir });
    assert(helpProbe.status === 0, `pnpm exec understand-anyway --help failed: ${helpProbe.stderr}`);
    assert(/understand-anyway/.test(helpProbe.stdout), "help output missing CLI name");

    logStep(name, "running build via installed CLI");
    prepareProjectSource(projectsRoot, projectId);
    run(
      "pnpm",
      [
        "exec",
        "understand-anyway",
        "init",
        resolve(projectsRoot, "src", projectId),
        "--project",
        projectId,
        "--repo-path",
        "${projectsRoot}/src/${projectId}",
      ],
      { cwd: installDir, env },
    );
    run(
      "pnpm",
      [
        "exec",
        "understand-anyway",
        "build",
        "--project",
        projectId,
        "--plugin-root",
        pluginRoot,
      ],
      { cwd: installDir, env },
    );

    logStep(name, "PASS");
    return { ok: true };
  } catch (err) {
    logStep(name, `FAIL: ${err.message}`);
    return { ok: false, error: err };
  } finally {
    if (verdaccioProc && !verdaccioProc.killed) {
      try { verdaccioProc.kill("SIGTERM"); } catch {}
    }
    cleanup(cleanupPaths, opts.keepTemp);
  }
}

// -- case 3: shared-gateway + LLM --------------------------------------------

function llmFlagsForProfile(profile) {
  // Both profiles enable enrichment, but we don't pass --llm-required: the
  // builtin mock provider satisfies the file-level prompt schema but not the
  // graph-level layer-detection prompt schema, so requiring strict success
  // would always fail the build. We assert observable file-level outputs
  // (node summaries / llm-mock tag) directly in assertLlmArtifacts instead.
  if (profile === "real-llm") {
    return ["--llm-analysis", "--llm-provider", "cli-spawn"];
  }
  return ["--llm-analysis", "--llm-provider", "mock"];
}

function assertLlmArtifacts({ projectsRoot, projectId, kg }) {
  const stateRoot = resolve(projectsRoot, "projects", projectId, "current");
  const ua = resolve(stateRoot, ".understand-anything");
  assert(existsSync(ua), `${ua} missing`);

  // llm/ observability output (best-effort: may live under intermediate/ or llm/)
  const llmDir = resolve(ua, "llm");
  const intermediateDir = resolve(ua, "intermediate");
  const hasLlm = existsSync(llmDir) && readdirSync(llmDir).length > 0;
  const hasBatches = existsSync(intermediateDir)
    && readdirSync(intermediateDir).some((n) => /^batch-.*\.json$/.test(n));
  assert(hasLlm || hasBatches, `no LLM/batch artifacts under ${ua}`);

  // File-level enrichment landed on graph nodes when LLM ran successfully.
  const enrichedNodes = (kg.nodes || []).filter((n) =>
    typeof n?.summary === "string" && n.summary.trim().length > 0,
  );
  assert(enrichedNodes.length > 0, "no graph node carries a non-empty summary after LLM enrichment");
}

async function caseSharedGateway({ pluginRoot, opts }) {
  const name = "shared-gateway";
  logStep(name, `starting (profile=${opts.profile})`);
  const projectsRoot = makeTempRoot("shared");
  const cleanupPaths = [projectsRoot];
  const env = { UA_PROJECTS_ROOT: projectsRoot };
  const ids = ["mini-project", "mini-project-b"];
  const llmFlags = llmFlagsForProfile(opts.profile);

  let keptRunning = false;
  try {
    for (const id of ids) {
      prepareProjectSource(projectsRoot, id);
      logStep(name, `init ${id}`);
      uaCli(
        [
          "init",
          resolve(projectsRoot, "src", id),
          "--project",
          id,
          "--repo-path",
          "${projectsRoot}/src/${projectId}",
        ],
        { env },
      );
      logStep(name, `build+publish ${id} (llm-provider=${llmFlags[3]})`);
      publishProjectVersion({ projectsRoot, projectId: id, pluginRoot, llmFlags });
    }

    logStep(name, "gateway publish");
    uaCli(
      ["gateway", "publish", "--projects-root", projectsRoot, "--stable", "--retain", "2", "--plugin-root", pluginRoot],
      { env },
    );

    const port = await pickPort(18666);
    const { upsertProdRegistryRecord } = await import(
      pathToFileUrl(resolve(REPO_ROOT, "scripts/lib/upsert-project-registry.mjs"))
    );
    for (const id of ids) {
      await upsertProdRegistryRecord({
        rootDir: REPO_ROOT,
        registryPath: resolve(projectsRoot, "gateway", "registry.json"),
        projectId: id,
        projectRoot: resolve(projectsRoot, "src", id),
        stateRoot: resolve(projectsRoot, "projects", id),
        host: "127.0.0.1",
        port,
      });
    }

    logStep(name, `gateway start on :${port}`);
    uaCli(
      ["gateway", "start", "--projects-root", projectsRoot, "--host", "127.0.0.1", "--port", String(port), "--no-open"],
      { env },
    );

    await waitFor(
      async () => {
        const p = readGatewayPid(projectsRoot);
        if (!p) return false;
        const res = await httpGet(`http://127.0.0.1:${p.port}/`).catch(() => null);
        return res && res.status === 200;
      },
      { label: "gateway listening" },
    );

    logStep(name, "asserting endpoints + LLM artifacts");
    const results = [];
    for (const id of ids) {
      const r = await assertGatewayHealthy({ projectsRoot, projectId: id, port });
      assertLlmArtifacts({ projectsRoot, projectId: id, kg: r.kg });
      results.push({ id, ...r });
    }

    logStep(name, "asserting token isolation (project A token on project B → 403)");
    const [a, b] = results;
    const cross = await httpGet(`${a.base}/project/${b.id}/knowledge-graph.json?token=${a.token}`);
    assert(cross.status === 403, `cross-token expected 403, got ${cross.status}`);

    logStep(name, "republishing gateway and re-asserting");
    uaCli(
      ["gateway", "publish", "--projects-root", projectsRoot, "--stable", "--retain", "2", "--plugin-root", pluginRoot],
      { env },
    );
    for (const id of ids) {
      const after = await httpGet(`${a.base}/project/${id}/knowledge-graph.json?token=${results.find((x) => x.id === id).token}`);
      assert(after.status === 200, `post-republish ${id} knowledge-graph.json got ${after.status}`);
    }

    if (opts.keepRunning) {
      keptRunning = true;
      const pid = readGatewayPid(projectsRoot);
      log("");
      log("=== --keep-running: gateway left in place for manual verification ===");
      log(`  projectsRoot: ${projectsRoot}`);
      log(`  portal:       http://127.0.0.1:${pid.port}/`);
      for (const r of results) {
        log(`  ${r.id}: http://127.0.0.1:${pid.port}/project/${r.id}/?token=${r.token}`);
      }
      log(`  pid:          ${pid.pid}`);
      log(`  stop:         node ${CLI_DIST} gateway stop --projects-root ${projectsRoot}`);
    }

    logStep(name, "PASS");
    return { ok: true };
  } catch (err) {
    logStep(name, `FAIL: ${err.message}`);
    return { ok: false, error: err };
  } finally {
    if (!keptRunning) {
      stopGateway(projectsRoot);
      cleanup(cleanupPaths, opts.keepTemp);
    }
  }
}

function pathToFileUrl(p) {
  return new URL(`file://${p}`).href;
}

// -- main ---------------------------------------------------------------------

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const { pluginRoot } = await preflight(opts);

  const selected = opts.only ? [opts.only] : ALL_CASES;
  const summary = [];
  let exitCode = 0;

  for (const c of selected) {
    let result;
    if (c === "repo-checkout") result = await caseRepoCheckout({ pluginRoot, opts });
    else if (c === "verdaccio") result = await caseVerdaccio({ pluginRoot, opts });
    else if (c === "shared-gateway") result = await caseSharedGateway({ pluginRoot, opts });
    summary.push({ case: c, ok: result.ok });
    if (!result.ok) exitCode = 1;
  }

  log("");
  log("=== summary ===");
  for (const s of summary) {
    log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.case}`);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[delivery:local] fatal: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
