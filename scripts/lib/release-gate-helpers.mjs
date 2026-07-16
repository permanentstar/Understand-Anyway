import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
export const CLI_DIST = resolve(REPO_ROOT, "packages", "cli", "dist", "cli.js");
export const FIXTURE_REPO = resolve(REPO_ROOT, "packages", "core", "fixtures", "sample-repo");

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resolvePluginRoot() {
  const candidates = [
    process.env.UA_PLUGIN_ROOT || "",
    resolve(process.env.HOME || "", ".understand-anything-plugin"),
    resolve(process.env.HOME || "", ".understand-anything", "repo", "understand-anything-plugin"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
  }
  throw new Error("missing UA_PLUGIN_ROOT and no default upstream plugin root found");
}

export function ensurePreflight() {
  assert(process.versions.node.split(".")[0] >= "20", `Node >= 20 required, got ${process.versions.node}`);
  assert(existsSync(CLI_DIST), `CLI not built: ${CLI_DIST}`);
  assert(existsSync(FIXTURE_REPO), `fixture missing: ${FIXTURE_REPO}`);
  return { pluginRoot: resolvePluginRoot() };
}

export function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
  if (res.error) throw new Error(`spawn ${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
  }
  return res;
}

export function runCapture(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
  });
}

export function uaCli(args, options = {}) {
  return run(process.execPath, [CLI_DIST, ...args], options);
}

export function makeTempRoot(label) {
  return mkdtempSync(resolve(tmpdir(), `ua-release-gate-${label}-`));
}

export function cleanup(paths) {
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}

export function initGitRepo(repoRoot) {
  run("git", ["init", "-q"], { cwd: repoRoot, stdio: "ignore" });
  run("git", ["config", "user.email", "release-gate@example.invalid"], { cwd: repoRoot, stdio: "ignore" });
  run("git", ["config", "user.name", "release-gate"], { cwd: repoRoot, stdio: "ignore" });
  run("git", ["add", "-A"], { cwd: repoRoot, stdio: "ignore" });
  run("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
}

export function commitAll(repoRoot, message) {
  run("git", ["add", "-A"], { cwd: repoRoot, stdio: "ignore" });
  run("git", ["commit", "-q", "-m", message], { cwd: repoRoot, stdio: "ignore" });
}

export function prepareProjectSource(projectsRoot, projectId, { git = true } = {}) {
  const dest = resolve(projectsRoot, "src", projectId);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(FIXTURE_REPO, dest, { recursive: true });
  if (git) initGitRepo(dest);
  return dest;
}

export function initProject(projectsRoot, projectId) {
  const env = { UA_PROJECTS_ROOT: projectsRoot };
  const repoPath = resolve(projectsRoot, "src", projectId);
  uaCli(
    ["init", repoPath, "--project", projectId, "--repo-path", "${projectsRoot}/src/${projectId}"],
    { env },
  );
  return { env, repoPath };
}

export function publishProjectVersion({ projectsRoot, projectId, pluginRoot, llmFlags = [], stable = true, retain = 2 }) {
  const env = { UA_PROJECTS_ROOT: projectsRoot };
  uaCli(["build", "--project", projectId, "--plugin-root", pluginRoot, ...llmFlags], { env });
  uaCli(["dashboard", "build-dist", "--project", projectId, "--plugin-root", pluginRoot, "--rebuild-dashboard"], { env });
  const vid = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const args = [
    "project-state",
    "publish",
    vid,
    "--project",
    projectId,
    "--source-root",
    resolve(projectsRoot, "src", projectId),
    "--retain",
    String(retain),
  ];
  if (stable) args.push("--stable");
  uaCli(args, { env });
  return vid;
}

export function readGatewayPid(projectsRoot) {
  const path = resolve(projectsRoot, "gateway", ".understand-anything", "dashboard.pid");
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function stopGateway(projectsRoot) {
  try {
    runCapture(process.execPath, [CLI_DIST, "gateway", "stop", "--projects-root", projectsRoot]);
  } catch {}
}

export async function portFree(port) {
  return await new Promise((resolveProbe) => {
    const srv = createServer();
    srv.once("error", () => resolveProbe(false));
    srv.once("listening", () => srv.close(() => resolveProbe(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function pickPort(preferred, tries = 5) {
  let port = preferred;
  for (let i = 0; i < tries; i += 1) {
    if (await portFree(port)) return port;
    port += 1;
  }
  throw new Error(`no free port near ${preferred}`);
}

export function httpGet(url, headers = {}) {
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
    req.on("timeout", () => req.destroy(new Error("http timeout")));
    req.end();
  });
}

export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 500, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const ok = await predicate();
      if (ok) return true;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

export async function assertGatewayHealthy({ projectsRoot, projectId, port }) {
  const pid = readGatewayPid(projectsRoot);
  assert(pid && pid.port === port, `gateway pid missing or wrong port for ${projectsRoot}`);
  const base = `http://127.0.0.1:${port}`;
  const portal = await httpGet(`${base}/`);
  assert(portal.status === 200, `portal got ${portal.status}`);
  const registry = readJson(resolve(projectsRoot, "gateway", "registry.json"));
  const token = registry.projects?.[projectId]?.prodToken;
  assert(token, `registry missing prodToken for ${projectId}`);
  const projectHome = await httpGet(`${base}/project/${projectId}/?token=${token}`);
  assert([200, 302].includes(projectHome.status), `project home got ${projectHome.status}`);
  const kg = await httpGet(`${base}/project/${projectId}/knowledge-graph.json?token=${token}`);
  assert(kg.status === 200, `knowledge-graph got ${kg.status}`);
  return { base, token, kg: JSON.parse(kg.body) };
}

export function writeDeployConfig(projectsRoot, { host = "127.0.0.1", port = 18666 } = {}) {
  const configDir = resolve(projectsRoot, "gateway", "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    resolve(configDir, "deploy.yaml"),
    [
      "version: 1",
      "deploy:",
      `  host: \"${host}\"`,
      `  port: ${port}`,
      "  outputLanguage: \"en\"",
      "gateway:",
      "  retain: 2",
      "providers:",
      "  llm:",
      "    package: \"mock\"",
      "record:",
      "  providers: [\"local\"]",
      "profiles:",
      "  small:",
      "    use: [llm]",
      "    build:",
      "      mode: \"incremental\"",
      "      excludeTests: true",
      "      outputLanguage: \"en\"",
      "      llmAnalysis: true",
      "      llmRequired: false",
      "      llmRetry:",
      "        maxAttempts: 2",
      "        initialBackoffMs: 300",
      "        maxBackoffMs: 10000",
      "",
    ].join("\n"),
    "utf8",
  );
}

export function countNotificationFiles(projectsRoot) {
  const dir = resolve(projectsRoot, "notifications");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).length;
}
