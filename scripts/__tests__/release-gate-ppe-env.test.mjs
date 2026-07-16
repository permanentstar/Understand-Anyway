#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(repoRoot, "scripts", "release-gate-ppe-env.sh");

function isolatedEnv(env = {}) {
  const next = { ...process.env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("UA_RELEASE_GATE_")) delete next[key];
  }
  return { ...next, ...env };
}

function sourceEnv(env = {}, shell = "bash") {
  const command = `
    source '${script}'
    node <<'NODE'
const keys = [
  "UA_RELEASE_GATE_PPE_HOST",
  "UA_RELEASE_GATE_PPE_USER",
  "UA_RELEASE_GATE_PPE_ROOT",
  "UA_RELEASE_GATE_PPE_PLUGIN_ROOT",
  "UA_RELEASE_GATE_PPE_REPO_DIR",
  "UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT",
  "UA_RELEASE_GATE_PPE_NPM_DIR",
  "UA_RELEASE_GATE_PPE_TRAEX_BIN",
  "UA_RELEASE_GATE_PPE_REGISTRY",
  "UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD",
  "UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD",
  "UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD",
  "UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD",
  "UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD",
];
const out = {};
for (const key of keys) out[key] = process.env[key] ?? null;
process.stdout.write(JSON.stringify(out));
NODE
  `;
  const result = spawnSync(
    shell,
    ["-lc", command],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: isolatedEnv(env),
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const tempRoot = mkdtempSync(resolve(tmpdir(), "ua-ppe-env-"));
try {
  const repoBase = resolve(tempRoot, "abc123");
  mkdirSync(resolve(repoBase, "repo"), { recursive: true });
  mkdirSync(resolve(repoBase, "projects-root"), { recursive: true });
  writeFileSync(resolve(repoBase, "repo", "package.json"), "{}\n", "utf8");

  const npmA = resolve(tempRoot, "npm-installed-20260702-100000");
  const npmB = resolve(tempRoot, "npm-installed-20260703-100000");
  mkdirSync(resolve(npmA, "install"), { recursive: true });
  mkdirSync(resolve(npmB, "install"), { recursive: true });
  writeFileSync(resolve(npmA, "install", "package.json"), "{}\n", "utf8");
  writeFileSync(resolve(npmB, "install", "package.json"), "{}\n", "utf8");

  const env = sourceEnv({
    UA_RELEASE_GATE_PPE_HOST: "ppe.example.com",
    UA_RELEASE_GATE_PPE_USER: "ppe-user",
    UA_RELEASE_GATE_PPE_ROOT: tempRoot,
    UA_RELEASE_GATE_PPE_PLUGIN_ROOT: "/tmp/plugin-root",
  });

  assert.equal(env.UA_RELEASE_GATE_PPE_HOST, "ppe.example.com");
  assert.equal(env.UA_RELEASE_GATE_PPE_USER, "ppe-user");
  assert.equal(env.UA_RELEASE_GATE_PPE_ROOT, tempRoot);
  assert.equal(env.UA_RELEASE_GATE_PPE_PLUGIN_ROOT, "/tmp/plugin-root");
  assert.equal(env.UA_RELEASE_GATE_PPE_REPO_DIR, resolve(repoBase, "repo"));
  assert.equal(env.UA_RELEASE_GATE_PPE_REPO_PROJECTS_ROOT, resolve(repoBase, "projects-root"));
  assert.equal(env.UA_RELEASE_GATE_PPE_NPM_DIR, npmB);
  assert.equal(env.UA_RELEASE_GATE_PPE_TRAEX_BIN, "traex");
  assert.equal(env.UA_RELEASE_GATE_PPE_REGISTRY, "http://127.0.0.1:4873");
  assert.match(env.UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD, /release-gate-ppe\.mjs' --case ppe-repo$/);
  assert.match(env.UA_RELEASE_GATE_EXTERNAL_PPE_NPM_INSTALLED_CMD, /release-gate-ppe\.mjs' --case ppe-npm-installed$/);
  assert.match(env.UA_RELEASE_GATE_EXTERNAL_PPE_OPS_CMD, /release-gate-ppe\.mjs' --case ppe-ops$/);
  assert.match(env.UA_RELEASE_GATE_EXTERNAL_PPE_REAL_LLM_CMD, /release-gate-ppe\.mjs' --case ppe-real-llm$/);
  assert.match(env.UA_RELEASE_GATE_EXTERNAL_PPE_OSS_RELEASE_CMD, /release-gate-ppe\.mjs' --case ppe-oss-release$/);

  const overridden = sourceEnv({
    UA_RELEASE_GATE_PPE_HOST: "1.2.3.4",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: tempRoot,
    UA_RELEASE_GATE_PPE_PLUGIN_ROOT: "/tmp/plugin-root",
    UA_RELEASE_GATE_PPE_TRAEX_BIN: "/tmp/traex",
  });
  assert.equal(overridden.UA_RELEASE_GATE_PPE_HOST, "1.2.3.4");
  assert.equal(overridden.UA_RELEASE_GATE_PPE_USER, "tester");
  assert.equal(overridden.UA_RELEASE_GATE_PPE_TRAEX_BIN, "/tmp/traex");

  const zshEnv = sourceEnv({
    UA_RELEASE_GATE_PPE_HOST: "ppe.example.com",
    UA_RELEASE_GATE_PPE_USER: "ppe-user",
    UA_RELEASE_GATE_PPE_ROOT: tempRoot,
    UA_RELEASE_GATE_PPE_PLUGIN_ROOT: "/tmp/plugin-root",
  }, "zsh");
  assert.match(zshEnv.UA_RELEASE_GATE_EXTERNAL_PPE_REPO_CMD, new RegExp(`${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scripts/release-gate-ppe\\.mjs' --case ppe-repo$`));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("release-gate-ppe-env.test.mjs: all checks passed");
