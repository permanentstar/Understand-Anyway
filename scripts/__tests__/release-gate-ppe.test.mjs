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
  assert.match(result.stdout, /--case <ppe-repo\|ppe-npm-installed\|ppe-ops\|ppe-real-llm\|ppe-oss-release>/);
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

{
  const result = run(["--case", "ppe-oss-release", "--dry-run"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: "/tmp/ua-ppe",
    UA_RELEASE_GATE_PPE_PLUGIN_ROOT: "/tmp/plugin",
    UA_RELEASE_GATE_PPE_TRAEX_BIN: "/tmp/bin/traex",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ppe-oss-release/);
  assert.match(result.stdout, /ssh -n -o BatchMode=yes/);
  // Standard install: from a registry, not from a source checkout build.
  assert.match(result.stdout, /npm (install|i) .*@understand-anyway\/cli@0\.0\.1-next\.8/);
  assert.match(result.stdout, /--registry http:\/\/127\.0\.0\.1:4873/);
  assert.match(result.stdout, /understand-anyway-plugin-api-0\.0\.1-next\.8\.tgz/);
  assert.doesNotMatch(result.stdout, /understand-anyway-plugin-api-\*\.tgz/);
  // Smoke dashboard port must be chosen on the PPE host at runtime so repeated
  // release gates do not collide with a dashboard left running by another case.
  assert.match(result.stdout, /SMOKE_PORT/);
  assert.match(result.stdout, /start=18690; const end=18730/);
  assert.match(result.stdout, /--port "\$SMOKE_PORT"/);
  assert.doesNotMatch(result.stdout, /--port 18690/);
  // Ops orchestration runs via the bundled subcommand, no source repo.
  assert.match(result.stdout, /understand-anyway ops daily-update/);
  assert.doesNotMatch(result.stdout, /git pull/);
  assert.doesNotMatch(result.stdout, /packages\/cli\/dist\/cli\.js/);
  // Verdaccio lifecycle: deploy session starts it detached (setsid) and exits
  // cleanly; teardown happens in a separate ssh session (see teardown test).
  assert.match(result.stdout, /verdaccio@6/);
  assert.match(result.stdout, /setsid npx --yes verdaccio@6/);
  assert.match(result.stdout, /VERDACCIO_PID=\$!/);
  // Deploy session must NOT stop the gateway it spawned (that 255s the channel).
  assert.doesNotMatch(result.stdout, /gateway stop/);
  // LLM stays on traex (Trae/Codebase auth), not Feishu SSO.
  assert.match(result.stdout, /login --git-code/);
}

{
  // Registry override flows through to the install command.
  const result = run(["--case", "ppe-oss-release", "--dry-run"], {
    UA_RELEASE_GATE_PPE_HOST: "10.0.0.1",
    UA_RELEASE_GATE_PPE_USER: "tester",
    UA_RELEASE_GATE_PPE_ROOT: "/tmp/ua-ppe",
    UA_RELEASE_GATE_PPE_PLUGIN_ROOT: "/tmp/plugin",
    UA_RELEASE_GATE_PPE_TRAEX_BIN: "/tmp/bin/traex",
    UA_RELEASE_GATE_PPE_REGISTRY: "http://127.0.0.1:4999",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--registry http:\/\/127\.0\.0\.1:4999/);
}

{
  // Independent teardown ssh: stops the gateway + verdaccio and removes the
  // shared workRoot in a session that does not own those daemons.
  const mod = await import("../release-gate-ppe.mjs");
  const teardown = mod.buildOssReleaseTeardownSshCommand({
    host: "10.0.0.1",
    user: "tester",
    registry: "http://127.0.0.1:4873",
    registryListen: "127.0.0.1:4873",
  });
  const joined = teardown.join(" ");
  assert.match(joined, /^ssh -n -o BatchMode=yes tester@10\.0\.0\.1 /);
  assert.match(joined, /gateway stop/);
  assert.match(joined, /:4873/);
  assert.match(joined, /rm -rf '\/tmp\/ua-ppe-oss-release'/);
  assert.doesNotMatch(joined, /setsid/);
}

console.log("release-gate-ppe.test.mjs: all checks passed");
