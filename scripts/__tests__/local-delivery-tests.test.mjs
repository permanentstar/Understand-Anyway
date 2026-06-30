#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(repoRoot, "scripts/local-delivery-tests.mjs");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function runWithEnv(args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

{
  const result = run(["--", "--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage: pnpm run delivery:local/);
}

{
  const tempRoot = mkdtempSync(resolve(tmpdir(), "ua-delivery-test-"));
  try {
    const pluginRoot = resolve(tempRoot, "plugin");
    const binDir = resolve(tempRoot, "bin");
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(resolve(pluginRoot, "package.json"), "{}\n", "utf8");
    writeFileSync(resolve(binDir, "pnpm"), "#!/bin/sh\nprintf '9.0.0\\n'\n", { mode: 0o755 });
    const result = runWithEnv(["--profile", "real-llm", "--only", "shared-gateway"], {
      UA_PLUGIN_ROOT: pluginRoot,
      PATH: binDir,
    });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /requires `llm` on PATH/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("local-delivery-tests.test.mjs: all checks passed");
