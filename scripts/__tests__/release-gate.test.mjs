#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_REQUIRED_CHECKS,
  buildCheckPlan,
  helpText,
  parseReleaseGateArgs,
} from "../release-gate.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..");

assert.match(helpText(), /pnpm run release:gate/);
assert.match(helpText(), /--external <case>/);

assert.deepEqual(parseReleaseGateArgs([]), {
  external: [],
  verbose: false,
});

assert.deepEqual(parseReleaseGateArgs(["--external", "ppe-repo", "--external", "ppe-npm-installed", "--verbose"]), {
  external: ["ppe-repo", "ppe-npm-installed"],
  verbose: true,
});

assert.deepEqual(parseReleaseGateArgs(["--", "--external", "ppe-repo"]), {
  external: ["ppe-repo"],
  verbose: false,
});

assert.throws(() => parseReleaseGateArgs(["--external"]), /missing value/i);
assert.throws(() => parseReleaseGateArgs(["--wat"]), /unknown/i);

assert.equal(Array.isArray(LOCAL_REQUIRED_CHECKS), true);
assert.ok(LOCAL_REQUIRED_CHECKS.length >= 10, "local gate should contain multiple mandatory checks");

const names = LOCAL_REQUIRED_CHECKS.map((c) => c.name);
for (const requiredName of [
  "static:typecheck_build_test",
  "static:test_scripts",
  "release:dry_run",
  "local:repo_checkout",
  "local:verdaccio",
  "local:shared_gateway_mock",
  "local:shared_gateway_real_llm",
  "local:build_modes",
  "local:ops_versioning",
  "local:daily_idempotence",
]) {
  assert.ok(names.includes(requiredName), `missing required local check ${requiredName}`);
}

const plan = buildCheckPlan(parseReleaseGateArgs(["--external", "ppe-repo"]));
assert.equal(plan.local.length, LOCAL_REQUIRED_CHECKS.length);
assert.deepEqual(plan.external.map((c) => c.name), ["ppe-repo"]);
assert.equal(plan.external[0].required, false);

const gitignore = readFileSync(resolve(REPO_ROOT, ".gitignore"), "utf8");
assert.match(gitignore, /^\.release-gate\/$/m);

const staticCheck = LOCAL_REQUIRED_CHECKS.find((check) => check.name === "static:typecheck_build_test");
assert.deepEqual(
  [
    [staticCheck.command, ...staticCheck.args].join(" "),
    [staticCheck.next.command, ...staticCheck.next.args].join(" "),
    [staticCheck.next2.command, ...staticCheck.next2.args].join(" "),
  ],
  ["pnpm -r build", "pnpm -r typecheck", "pnpm -r test"],
);

const ciWorkflow = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const buildStepIndex = ciWorkflow.indexOf("name: Build");
const typecheckStepIndex = ciWorkflow.indexOf("name: Typecheck");
const testStepIndex = ciWorkflow.indexOf("name: Test");
assert.ok(buildStepIndex >= 0, "CI workflow should contain a Build step");
assert.ok(typecheckStepIndex >= 0, "CI workflow should contain a Typecheck step");
assert.ok(testStepIndex >= 0, "CI workflow should contain a Test step");
assert.ok(buildStepIndex < typecheckStepIndex, "CI Build step should run before Typecheck");
assert.ok(typecheckStepIndex < testStepIndex, "CI Typecheck step should run before Test");

console.log("release-gate.test.mjs: all checks passed");
