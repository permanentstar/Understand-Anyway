import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = resolve(repoRoot, "scripts", "deploy.ppe.yaml");
const yaml = readFileSync(configPath, "utf8");

assert.match(yaml, /package:\s*"@understand-anyway\/provider-trae-cli-v2"/);
assert.match(yaml, /command:\s*"traex"/);
assert.doesNotMatch(yaml, /\/home\//, "deploy.ppe.yaml must not commit machine-local absolute paths");
assert.doesNotMatch(yaml, /^\s*-\s*"-C"\s*$/m, "deploy.ppe.yaml should not force a local LLM workdir");

console.log("deploy-ppe-config.test.mjs: all checks passed");
