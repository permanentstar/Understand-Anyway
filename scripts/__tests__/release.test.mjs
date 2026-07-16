// Behavior tests for scripts/release.mjs.
// Run with: node scripts/__tests__/release.test.mjs
// (Registered in package.json `test:scripts` alongside the other script suites.)

import { strict as assert } from "node:assert";
import {
  PUBLIC_NPM_REGISTRY,
  TAG_RE,
  assertNoPublishedVersionConflicts,
  bumpVersion,
  compareVersions,
  originMainFetchCommand,
  parseFullVersion,
  parseNpmVersionsOutput,
  parseFlags,
  publishFailureRecoveryMessage,
  publishCommand,
  publishCommands,
  pushCommand,
  readLockstepVersion,
  shouldRunPublicNpmWhoami,
  validateReleaseOptions,
} from "../release.mjs";

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n    ${err.message}\n`);
    process.exitCode = 1;
  }
}

process.stdout.write("release.test.mjs:\n");

// --- bumpVersion ---
test("bumpVersion patch/minor/major on 0.0.1", () => {
  assert.equal(bumpVersion("0.0.1", "patch"), "0.0.2");
  assert.equal(bumpVersion("0.0.1", "minor"), "0.1.0");
  assert.equal(bumpVersion("0.0.1", "major"), "1.0.0");
});

test("bumpVersion patch/minor/major on 1.2.3", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
});

test("bumpVersion accepts explicit X.Y.Z", () => {
  assert.equal(bumpVersion("0.0.1", "0.4.0"), "0.4.0");
  assert.equal(bumpVersion("1.2.3", "9.9.9"), "9.9.9");
});

test("bumpVersion rejects explicit versions that do not advance", () => {
  assert.throws(() => bumpVersion("0.0.1", "0.0.1"), /must be greater/);
  assert.throws(() => bumpVersion("0.0.1", "0.0.0"), /must be greater/);
  assert.throws(() => bumpVersion("1.2.3", "1.2.2"), /must be greater/);
});

test("bumpVersion rejects leading-zero semver components", () => {
  assert.throws(() => bumpVersion("01.2.3", "patch"), /is not X\.Y\.Z/);
  assert.throws(() => bumpVersion("0.0.1", "01.2.3"), /bump level must be/);
  assert.throws(() => bumpVersion("0.0.1", "1.02.3"), /bump level must be/);
  assert.throws(() => bumpVersion("0.0.1", "1.2.03"), /bump level must be/);
});

test("bumpVersion rejects malformed current version", () => {
  assert.throws(() => bumpVersion("1.2", "patch"), /is not X\.Y\.Z/);
  assert.throws(() => bumpVersion("1.2.a", "patch"), /is not X\.Y\.Z/);
  assert.throws(() => bumpVersion("", "patch"), /is not X\.Y\.Z/);
});

test("bumpVersion rejects malformed level", () => {
  assert.throws(() => bumpVersion("0.0.1", "1.2"), /bump level must be/);
  assert.throws(() => bumpVersion("0.0.1", "v1.0.0"), /bump level must be/);
  assert.throws(() => bumpVersion("0.0.1", "unknown"), /bump level must be/);
});

// --- bumpVersion prerelease ---
test("bumpVersion prerelease starts counter at 0 from a core version", () => {
  assert.equal(bumpVersion("0.0.1", "prerelease", "next"), "0.0.1-next.0");
  assert.equal(bumpVersion("1.2.3", "prerelease", "beta"), "1.2.3-beta.0");
});

test("bumpVersion prerelease increments counter with the same tag", () => {
  assert.equal(bumpVersion("0.0.1-next.0", "prerelease", "next"), "0.0.1-next.1");
  assert.equal(bumpVersion("0.0.1-next.5", "prerelease", "next"), "0.0.1-next.6");
});

test("bumpVersion prerelease resets counter when tag switches", () => {
  assert.equal(bumpVersion("0.0.1-next.0", "prerelease", "beta"), "0.0.1-beta.0");
});

test("bumpVersion release-out strips prerelease suffix on patch/minor/major", () => {
  assert.equal(bumpVersion("0.0.1-next.0", "patch"), "0.0.1");
  assert.equal(bumpVersion("0.0.1-next.5", "patch"), "0.0.1");
  assert.equal(bumpVersion("0.0.1-next.0", "minor"), "0.1.0");
  assert.equal(bumpVersion("0.0.1-next.0", "major"), "1.0.0");
});

test("bumpVersion explicit release-out from prerelease", () => {
  assert.equal(bumpVersion("0.0.1-next.0", "0.0.1"), "0.0.1");
  assert.equal(bumpVersion("0.0.1-next.5", "0.0.1"), "0.0.1");
});

test("bumpVersion explicit prerelease from core", () => {
  assert.equal(bumpVersion("0.0.1", "0.0.1-next.0"), "0.0.1-next.0");
  assert.equal(bumpVersion("0.0.1", "0.0.2-next.0"), "0.0.2-next.0");
});

test("bumpVersion explicit prerelease must advance", () => {
  assert.throws(() => bumpVersion("0.0.1-next.0", "0.0.1-next.0"), /must be greater/);
  assert.throws(() => bumpVersion("0.0.1-next.1", "0.0.1-next.0"), /must be greater/);
});

test("bumpVersion prerelease requires a tag argument", () => {
  assert.throws(() => bumpVersion("0.0.1", "prerelease"), /prerelease.*tag/i);
  assert.throws(() => bumpVersion("0.0.1", "prerelease", ""), /prerelease.*tag/i);
});

test("bumpVersion prerelease rejects invalid tag names", () => {
  assert.throws(() => bumpVersion("0.0.1", "prerelease", "01bad"), /invalid.*tag/i);
  assert.throws(() => bumpVersion("0.0.1", "prerelease", "-bad"), /invalid.*tag/i);
  assert.throws(() => bumpVersion("0.0.1", "prerelease", "bad tag"), /invalid.*tag/i);
});

// --- compareVersions ---
test("compareVersions orders prerelease before core, and lexicographically", () => {
  assert.equal(compareVersions(parseFullVersion("0.0.1-next.0"), parseFullVersion("0.0.1-next.1")) < 0, true);
  assert.equal(compareVersions(parseFullVersion("0.0.1-next.1"), parseFullVersion("0.0.1")) < 0, true);
  assert.equal(compareVersions(parseFullVersion("0.0.1"), parseFullVersion("0.0.2-next.0")) < 0, true);
  assert.equal(compareVersions(parseFullVersion("0.0.2-next.0"), parseFullVersion("0.0.2")) < 0, true);
  assert.equal(compareVersions(parseFullVersion("0.0.1-next.0"), parseFullVersion("0.0.1-next.0")), 0);
});

// --- parseFullVersion / TAG_RE ---
test("parseFullVersion parses core and prerelease shapes", () => {
  assert.deepEqual(parseFullVersion("0.0.1"), { core: [0, 0, 1], prerelease: null });
  assert.deepEqual(parseFullVersion("1.2.3-next.7"), { core: [1, 2, 3], prerelease: { tag: "next", num: 7 } });
  assert.equal(parseFullVersion("bad"), null);
  assert.equal(parseFullVersion("0.0.1-01bad.0"), null);
});

test("TAG_RE matches legal npm dist-tag / prerelease tag names", () => {
  assert.equal(TAG_RE.test("next"), true);
  assert.equal(TAG_RE.test("latest"), true);
  assert.equal(TAG_RE.test("beta1"), true);
  assert.equal(TAG_RE.test("rc-1"), true);
  assert.equal(TAG_RE.test("01bad"), false);
  assert.equal(TAG_RE.test("-bad"), false);
  assert.equal(TAG_RE.test(""), false);
  assert.equal(TAG_RE.test("bad tag"), false);
});

// --- readLockstepVersion ---
test("readLockstepVersion returns baseline when all match", () => {
  const fakeRead = (p) => JSON.stringify({ version: "0.0.1", name: p });
  const paths = ["/a/pkg-a/package.json", "/a/pkg-b/package.json", "/a/pkg-c/package.json"];
  assert.equal(readLockstepVersion(paths, fakeRead), "0.0.1");
});

test("readLockstepVersion throws when versions diverge", () => {
  const fakeRead = (p) => {
    if (p.includes("pkg-b")) return JSON.stringify({ version: "0.0.2" });
    return JSON.stringify({ version: "0.0.1" });
  };
  const paths = ["/a/pkg-a/package.json", "/a/pkg-b/package.json", "/a/pkg-c/package.json"];
  assert.throws(() => readLockstepVersion(paths, fakeRead), /not in lockstep.*pkg-a=0\.0\.1.*pkg-b=0\.0\.2/);
});

test("readLockstepVersion tolerates single package", () => {
  const fakeRead = () => JSON.stringify({ version: "9.9.9" });
  assert.equal(readLockstepVersion(["/a/pkg-a/package.json"], fakeRead), "9.9.9");
});

// --- parseFlags ---
test("parseFlags accepts dry-run, skip flags, and registry", () => {
  assert.deepEqual(
    parseFlags(["--dry-run", "--skip-git", "--skip-publish", "--registry", "http://127.0.0.1:4873/"]),
    { dryRun: true, skipGit: true, skipPublish: true, registry: "http://127.0.0.1:4873", tag: "latest" },
  );
});

test("parseFlags defaults to the public npm registry", () => {
  assert.deepEqual(parseFlags([]), {
    dryRun: false,
    skipGit: false,
    skipPublish: false,
    registry: PUBLIC_NPM_REGISTRY,
    tag: "latest",
  });
});

test("parseFlags normalizes registry URLs", () => {
  assert.equal(parseFlags(["--registry", "HTTPS://REGISTRY.NPMJS.ORG/"]).registry, PUBLIC_NPM_REGISTRY);
  assert.equal(parseFlags(["--registry", "HTTP://LOCALHOST:4873/"]).registry, "http://localhost:4873");
});

test("parseFlags rejects unknown flags and missing registry", () => {
  assert.throws(() => parseFlags(["--wat"]), /unknown option/);
  assert.throws(() => parseFlags(["--registry"]), /requires a value/);
  assert.throws(() => parseFlags(["--registry", "--skip-git"]), /requires a value/);
});

test("parseFlags rejects unsafe registry strings", () => {
  assert.throws(() => parseFlags(["--registry", "ftp://example.com"]), /invalid --registry URL/);
  assert.throws(() => parseFlags(["--registry", "http://127.0.0.1:4873;echo bad"]), /invalid --registry URL/);
  assert.throws(() => parseFlags(["--registry", "http://127.0.0.1:4873 bad"]), /invalid --registry URL/);
  assert.throws(() => parseFlags(["--registry", "https://registry.npmjs.org?x=1"]), /invalid --registry URL/);
  assert.throws(() => parseFlags(["--registry", "https://registry.npmjs.org/#token"]), /invalid --registry URL/);
  assert.throws(() => parseFlags(["--registry", "https://user:pass@registry.npmjs.org/"]), /invalid --registry URL/);
});

test("parseFlags accepts --tag and defaults to latest", () => {
  assert.equal(parseFlags(["--tag", "next"]).tag, "next");
  assert.equal(parseFlags(["--tag", "beta"]).tag, "beta");
  assert.equal(parseFlags([]).tag, "latest");
});

test("parseFlags rejects missing --tag value", () => {
  assert.throws(() => parseFlags(["--tag"]), /requires a value/);
  assert.throws(() => parseFlags(["--tag", "--dry-run"]), /requires a value/);
});

test("parseFlags rejects invalid --tag names", () => {
  assert.throws(() => parseFlags(["--tag", "bad tag"]), /invalid --tag/);
  assert.throws(() => parseFlags(["--tag", "01bad"]), /invalid --tag/);
  assert.throws(() => parseFlags(["--tag", "-bad"]), /invalid --tag/);
  assert.throws(() => parseFlags(["--tag", ""]), /requires a value/);
});

// --- release option policy ---
test("validateReleaseOptions allows the normal public npm release path", () => {
  assert.doesNotThrow(() => validateReleaseOptions({
    dryRun: false,
    skipGit: false,
    skipPublish: false,
    registry: PUBLIC_NPM_REGISTRY,
    tag: "latest",
    nextVersion: "0.0.2",
  }));
});

test("validateReleaseOptions allows Verdaccio rehearsal only without git mutation", () => {
  assert.doesNotThrow(() => validateReleaseOptions({
    dryRun: false,
    skipGit: true,
    skipPublish: false,
    registry: "http://127.0.0.1:4873",
    tag: "latest",
    nextVersion: "0.0.2",
  }));
  assert.throws(
    () => validateReleaseOptions({
      dryRun: false,
      skipGit: false,
      skipPublish: false,
      registry: "http://127.0.0.1:4873",
      tag: "latest",
      nextVersion: "0.0.2",
    }),
    /custom registry.*--skip-git/,
  );
});

test("validateReleaseOptions rejects public npm publish without git", () => {
  assert.throws(
    () => validateReleaseOptions({
      dryRun: false,
      skipGit: true,
      skipPublish: false,
      registry: PUBLIC_NPM_REGISTRY,
      tag: "latest",
      nextVersion: "0.0.2",
    }),
    /public npm.*without git/,
  );
});

test("validateReleaseOptions keeps skip-publish tied to skip-git", () => {
  assert.throws(
    () => validateReleaseOptions({
      dryRun: false,
      skipGit: false,
      skipPublish: true,
      registry: PUBLIC_NPM_REGISTRY,
      tag: "latest",
      nextVersion: "0.0.2",
    }),
    /--skip-publish requires --skip-git/,
  );
});

test("validateReleaseOptions rejects prerelease targeting the latest dist-tag", () => {
  assert.throws(
    () => validateReleaseOptions({
      dryRun: false,
      skipGit: false,
      skipPublish: false,
      registry: PUBLIC_NPM_REGISTRY,
      tag: "latest",
      nextVersion: "0.0.1-next.0",
    }),
    /prerelease.*latest/i,
  );
});

test("validateReleaseOptions allows core version on a non-latest dist-tag", () => {
  assert.doesNotThrow(() => validateReleaseOptions({
    dryRun: false,
    skipGit: false,
    skipPublish: false,
    registry: PUBLIC_NPM_REGISTRY,
    tag: "next",
    nextVersion: "0.0.1",
  }));
});

test("validateReleaseOptions allows prerelease targeting a non-latest dist-tag", () => {
  assert.doesNotThrow(() => validateReleaseOptions({
    dryRun: false,
    skipGit: false,
    skipPublish: false,
    registry: PUBLIC_NPM_REGISTRY,
    tag: "next",
    nextVersion: "0.0.1-next.0",
  }));
});

test("publishCommand always runs from one package dir and pins the target registry", () => {
  assert.deepEqual(publishCommand("packages/plugin-api", PUBLIC_NPM_REGISTRY), [
    "pnpm",
    "publish",
    "packages/plugin-api",
    "--access",
    "public",
    "--no-git-checks",
    "--registry",
    PUBLIC_NPM_REGISTRY,
    "--tag",
    "latest",
  ]);
});

test("publishCommand appends --tag when a dist-tag is provided", () => {
  assert.deepEqual(publishCommand("packages/plugin-api", PUBLIC_NPM_REGISTRY, { tag: "next" }), [
    "pnpm",
    "publish",
    "packages/plugin-api",
    "--access",
    "public",
    "--no-git-checks",
    "--registry",
    PUBLIC_NPM_REGISTRY,
    "--tag",
    "next",
  ]);
});

test("publishCommand emits --dry-run and --tag together", () => {
  assert.deepEqual(
    publishCommand("packages/cli", PUBLIC_NPM_REGISTRY, { tag: "next", dryRun: true }),
    [
      "pnpm",
      "publish",
      "packages/cli",
      "--access",
      "public",
      "--no-git-checks",
      "--registry",
      PUBLIC_NPM_REGISTRY,
      "--dry-run",
      "--tag",
      "next",
    ],
  );
});

test("publishCommands publishes dependency packages before the CLI", () => {
  const dirs = publishCommands(PUBLIC_NPM_REGISTRY).map((cmd) => cmd[cmd.indexOf("publish") + 1]);
  assert.deepEqual(dirs, [
    "packages/plugin-api",
    "packages/core",
    "packages/gateway",
    "packages/provider-cli-runtime",
    "packages/provider-feishu-auth",
    "packages/provider-feishu-sheets",
    "packages/provider-lark-im-notify",
    "packages/provider-trae-cli-v1",
    "packages/provider-trae-cli-v2",
    "packages/cli",
  ]);
});

test("shouldRunPublicNpmWhoami only applies to real public npm publishes", () => {
  assert.equal(shouldRunPublicNpmWhoami({ dryRun: true, skipPublish: false, registry: PUBLIC_NPM_REGISTRY }), false);
  assert.equal(shouldRunPublicNpmWhoami({ dryRun: false, skipPublish: true, registry: PUBLIC_NPM_REGISTRY }), false);
  assert.equal(shouldRunPublicNpmWhoami({ dryRun: false, skipPublish: false, registry: "http://127.0.0.1:4873" }), false);
  assert.equal(shouldRunPublicNpmWhoami({ dryRun: false, skipPublish: false, registry: PUBLIC_NPM_REGISTRY }), true);
});

test("git remote commands are explicit and refresh origin/main", () => {
  assert.deepEqual(originMainFetchCommand(), ["git", "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  assert.deepEqual(pushCommand(), ["git", "push", "origin", "main", "--follow-tags"]);
});

test("publish failure recovery message does not suggest rerunning the release bump", () => {
  const message = publishFailureRecoveryMessage("0.0.2", PUBLIC_NPM_REGISTRY);
  assert.match(message, /Do not rerun/);
  assert.match(message, /published/);
  assert.match(message, /missing packages/);
  assert.match(message, /git push origin main --follow-tags/);
  assert.doesNotMatch(message, new RegExp(["retry", "from", "this", "commit"].join(" ")));
});

// --- registry preflight ---
test("parseNpmVersionsOutput handles npm JSON shapes", () => {
  assert.deepEqual(parseNpmVersionsOutput(""), []);
  assert.deepEqual(parseNpmVersionsOutput("\"0.0.1\""), ["0.0.1"]);
  assert.deepEqual(
    parseNpmVersionsOutput("[\"0.0.1\",\"0.0.1-next.0\",\"1.0.0-beta.1\"]"),
    ["0.0.1", "0.0.1-next.0", "1.0.0-beta.1"],
  );
});

test("assertNoPublishedVersionConflicts accepts empty or older registry versions", () => {
  assert.doesNotThrow(() => assertNoPublishedVersionConflicts({
    pkgName: "@understand-anyway/cli",
    publishedVersions: [],
    baseline: "0.0.1",
    next: "0.0.2",
    registry: PUBLIC_NPM_REGISTRY,
  }));
  assert.doesNotThrow(() => assertNoPublishedVersionConflicts({
    pkgName: "@understand-anyway/cli",
    publishedVersions: ["0.0.1"],
    baseline: "0.0.1",
    next: "0.0.2",
    registry: PUBLIC_NPM_REGISTRY,
  }));
  assert.doesNotThrow(() => assertNoPublishedVersionConflicts({
    pkgName: "@understand-anyway/cli",
    publishedVersions: ["0.0.1", "not-a-version"],
    baseline: "0.0.1",
    next: "0.0.2",
    registry: PUBLIC_NPM_REGISTRY,
  }));
});

test("assertNoPublishedVersionConflicts rejects already published target", () => {
  assert.throws(
    () => assertNoPublishedVersionConflicts({
      pkgName: "@understand-anyway/cli",
      publishedVersions: ["0.0.1", "0.0.2"],
      baseline: "0.0.1",
      next: "0.0.2",
      registry: PUBLIC_NPM_REGISTRY,
    }),
    /target version already exists/,
  );
});

test("assertNoPublishedVersionConflicts rejects stale local baselines", () => {
  assert.throws(
    () => assertNoPublishedVersionConflicts({
      pkgName: "@understand-anyway/cli",
      publishedVersions: ["0.0.1", "0.0.3"],
      baseline: "0.0.1",
      next: "0.0.2",
      registry: PUBLIC_NPM_REGISTRY,
    }),
    /baseline 0\.0\.1 is stale/,
  );
});

test("assertNoPublishedVersionConflicts allows a prerelease bump when only older prereleases exist", () => {
  assert.doesNotThrow(() => assertNoPublishedVersionConflicts({
    pkgName: "@understand-anyway/cli",
    publishedVersions: ["0.0.1-next.0"],
    baseline: "0.0.1-next.0",
    next: "0.0.1-next.1",
    registry: PUBLIC_NPM_REGISTRY,
  }));
});

test("assertNoPublishedVersionConflicts rejects a prerelease that is already published", () => {
  assert.throws(
    () => assertNoPublishedVersionConflicts({
      pkgName: "@understand-anyway/cli",
      publishedVersions: ["0.0.1-next.0"],
      baseline: "0.0.1-next.0",
      next: "0.0.1-next.0",
      registry: PUBLIC_NPM_REGISTRY,
    }),
    /target version already exists/,
  );
});

test("assertNoPublishedVersionConflicts rejects stale prerelease baselines", () => {
  assert.throws(
    () => assertNoPublishedVersionConflicts({
      pkgName: "@understand-anyway/cli",
      publishedVersions: ["0.0.1-next.2"],
      baseline: "0.0.1-next.0",
      next: "0.0.1-next.1",
      registry: PUBLIC_NPM_REGISTRY,
    }),
    /stale/,
  );
});

test("assertNoPublishedVersionConflicts allows core release-out over older prereleases", () => {
  assert.doesNotThrow(() => assertNoPublishedVersionConflicts({
    pkgName: "@understand-anyway/cli",
    publishedVersions: ["0.0.1-next.2"],
    baseline: "0.0.1-next.0",
    next: "0.0.1",
    registry: PUBLIC_NPM_REGISTRY,
  }));
});

test("assertNoPublishedVersionConflicts rejects prerelease when core release already exists", () => {
  assert.throws(
    () => assertNoPublishedVersionConflicts({
      pkgName: "@understand-anyway/cli",
      publishedVersions: ["0.0.1"],
      baseline: "0.0.1",
      next: "0.0.1-next.0",
      registry: PUBLIC_NPM_REGISTRY,
    }),
    /stale/,
  );
});

process.stdout.write(process.exitCode ? "release.test.mjs: FAIL\n" : "release.test.mjs: all checks passed\n");
