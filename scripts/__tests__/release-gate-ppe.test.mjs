#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(repoRoot, "scripts", "release-gate-ppe.mjs");

function isolatedEnv(env = {}) {
  const next = { ...process.env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("UA_RELEASE_GATE_")) delete next[key];
  }
  return { ...next, ...env };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: isolatedEnv(env),
  });
}

{
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /release-gate-ppe\.mjs/);
  assert.match(result.stdout, /--case <ppe-repo\|ppe-npm-installed\|ppe-ops\|ppe-real-llm>/);
}

{
  const result = run(["--case", "ppe-repo"], {
    UA_RELEASE_GATE_PPE_HOST: "",
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /missing UA_RELEASE_GATE_PPE_HOST/);
}

{
  const result = run(["--case", "ppe-repo"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /missing UA_RELEASE_GATE_PPE_ROOT/);
}

{
  const result = run(["--case", "ppe-real-llm", "--dry-run"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: "/tmp/ua-ppe",
    UA_RELEASE_GATE_PPE_PLUGIN_ROOT: "/tmp/plugin",
    UA_RELEASE_GATE_PPE_TRAEX_BIN: "/tmp/bin/traex",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ppe-real-llm/);
  assert.match(result.stdout, /ssh -n -o BatchMode=yes/);
  assert.doesNotMatch(result.stdout, /<<'EOS'/);
  assert.match(result.stdout, /login --git-code/);
  assert.match(result.stdout, /local-delivery-tests\.mjs --profile real-llm --only shared-gateway --verbose/);
}

console.log("release-gate-ppe.test.mjs: all checks passed");
