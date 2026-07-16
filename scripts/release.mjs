#!/usr/bin/env node
// Manual lockstep release for the ten `@understand-anyway/*` packages.
//
// Usage:
//   node scripts/release.mjs <patch|minor|major|X.Y.Z|X.Y.Z-tag.N|prerelease <tag>> [--tag <dist-tag>] [--dry-run] [--skip-git] [--skip-publish] [--registry <url>]
//
// Level forms:
//   patch|minor|major   — bump core from the current release. On a prerelease
//                         baseline (X.Y.Z-tag.N), `patch` means "release out"
//                         (drop the suffix, keep core), while minor/major bump
//                         core from X.Y.Z.
//   X.Y.Z               — explicit core version; must sort greater than current.
//   X.Y.Z-tag.N         — explicit prerelease target; must sort greater than
//                         current (except promoting from core X.Y.Z to
//                         X.Y.Z-tag.N is not allowed — use `prerelease <tag>`).
//   prerelease <tag>    — bump/introduce a `-<tag>.<N>` suffix. If baseline
//                         already carries the same tag, increment N; if the
//                         baseline is a plain core version or a different tag,
//                         start N=0.
//
// The dist-tag flag `--tag <name>` (default `latest`) controls which npm
// channel receives the release. Prerelease targets must NOT go to `latest`;
// the tool refuses to promote a prerelease to `latest` to avoid clobbering
// the semver-compliant "latest = stable" contract.
//
// Execution order (chosen for recoverability: commit/tag locally before the
// irreversible npm publish, push to the remote only after npm succeeds):
//   1. Sanity: valid bump, ten packages in lockstep, clean tree for real
//      execution, on `main` and synced with `origin/main` (unless --skip-git),
//      target versions absent from the registry, `npm whoami` succeeds for
//      public npm publishes (unless --skip-publish).
//   2. Compute the next version (semver bump, explicit target, or prerelease).
//   3. Rewrite every `packages/*/package.json` `version` field.
//   4. `pnpm install --lockfile-only` to refresh `pnpm-lock.yaml`.
//   5. `pnpm -r build`. Abort before publish if any package fails to build.
//   6. `pnpm --filter <pkg> publish --dry-run --tag <dist-tag>` in dependency
//      order. Abort before commit/tag on pack failures.
//   7. `git commit -am "chore(release): v<next> (--tag <dist-tag>)"` +
//      annotated `git tag` whose message records the dist-tag.
//   8. `pnpm --filter <pkg> publish --access public --no-git-checks --tag
//      <dist-tag>` in the same dependency order.
//   9. `git push origin main --follow-tags`. If this fails, retry the same
//      push command; the npm package already matches the local commit and tag.
//
// `--dry-run` prints the full plan (rewrite targets + shell commands) and
// exits before mutating anything. Public releases always pin
// https://registry.npmjs.org. `--skip-git` / `--skip-publish` and `--registry
// <url>` are escape hatches for local verification against a Verdaccio
// registry; custom registries require `--skip-git`, and `--skip-git` cannot
// publish to public npm.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_NAMES = [
  "plugin-api",
  "core",
  "gateway",
  "provider-cli-runtime",
  "provider-feishu-auth",
  "provider-feishu-sheets",
  "provider-lark-im-notify",
  "provider-trae-cli-v1",
  "provider-trae-cli-v2",
  "cli",
];
const PKG_PATHS = PKG_NAMES.map((name) => resolve(REPO_ROOT, "packages", name, "package.json"));
const SEMVER_FULL_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z][a-zA-Z0-9-]*)\.(0|[1-9]\d*))?$/;
export const TAG_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_DIST_TAG = "latest";

export function die(msg) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  process.stdout.write(`$ ${formatCmd(cmd)}\n`);
  const [binary, ...args] = cmd;
  return execFileSync(binary, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
}

function capture(cmd, opts = {}) {
  const [binary, ...args] = cmd;
  return execFileSync(binary, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], ...opts }).toString().trim();
}

export function parseFullVersion(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER_FULL_RE.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (match[4] === undefined) return { core, prerelease: null };
  return { core, prerelease: { tag: match[4], num: Number(match[5]) } };
}

export function compareVersions(left, right) {
  // Accepts either the shape returned by parseFullVersion, or a raw
  // [maj, min, pat] tuple (legacy internal callers).
  const l = normalizeCompareOperand(left);
  const r = normalizeCompareOperand(right);
  for (let i = 0; i < 3; i += 1) {
    if (l.core[i] !== r.core[i]) return l.core[i] > r.core[i] ? 1 : -1;
  }
  // core equal — prerelease sorts before its release
  if (l.prerelease === null && r.prerelease === null) return 0;
  if (l.prerelease === null) return 1;
  if (r.prerelease === null) return -1;
  if (l.prerelease.tag !== r.prerelease.tag) {
    return l.prerelease.tag < r.prerelease.tag ? -1 : 1;
  }
  if (l.prerelease.num !== r.prerelease.num) {
    return l.prerelease.num > r.prerelease.num ? 1 : -1;
  }
  return 0;
}

function normalizeCompareOperand(value) {
  if (Array.isArray(value)) return { core: value.slice(0, 3), prerelease: null };
  return value;
}

export function isPrereleaseVersion(version) {
  const parsed = parseFullVersion(version);
  return parsed !== null && parsed.prerelease !== null;
}

export function bumpVersion(current, level, tag) {
  const parsedCurrent = parseFullVersion(current);
  if (!parsedCurrent) {
    throw new Error(`current version '${current}' is not X.Y.Z`);
  }
  const [maj, min, pat] = parsedCurrent.core;

  // Explicit version target (core or prerelease)
  const parsedLevel = parseFullVersion(level);
  if (parsedLevel) {
    if (compareVersions(parsedLevel, parsedCurrent) > 0) {
      return level;
    }
    // Special case: allow entering a prerelease of the same core when the
    // current baseline is a plain core version (X.Y.Z -> X.Y.Z-tag.N).
    if (
      parsedLevel.prerelease
      && !parsedCurrent.prerelease
      && parsedLevel.core[0] === maj
      && parsedLevel.core[1] === min
      && parsedLevel.core[2] === pat
    ) {
      return level;
    }
    throw new Error(`explicit version '${level}' must be greater than current version '${current}'`);
  }

  if (level === "prerelease") {
    if (typeof tag !== "string" || tag.length === 0) {
      throw new Error("prerelease bump requires a tag argument, e.g. `prerelease next`");
    }
    if (!TAG_RE.test(tag)) {
      throw new Error(`invalid prerelease tag '${tag}' (must match [a-zA-Z][a-zA-Z0-9-]*)`);
    }
    if (parsedCurrent.prerelease && parsedCurrent.prerelease.tag === tag) {
      return `${maj}.${min}.${pat}-${tag}.${parsedCurrent.prerelease.num + 1}`;
    }
    return `${maj}.${min}.${pat}-${tag}.0`;
  }

  if (level === "patch") {
    // If the baseline is a prerelease of X.Y.Z, "patch" means release-out to
    // X.Y.Z (drop the suffix, keep the same core). Otherwise increment patch.
    if (parsedCurrent.prerelease) return `${maj}.${min}.${pat}`;
    return `${maj}.${min}.${pat + 1}`;
  }
  if (level === "minor") return `${maj}.${min + 1}.0`;
  if (level === "major") return `${maj + 1}.0.0`;
  throw new Error(`bump level must be patch|minor|major|X.Y.Z|X.Y.Z-tag.N|prerelease <tag>, got '${level}'`);
}

export function readLockstepVersion(pkgPaths, readFile = readFileSync) {
  const versions = pkgPaths.map((p) => JSON.parse(readFile(p, "utf8")).version);
  const baseline = versions[0];
  if (versions.some((v) => v !== baseline)) {
    const detail = pkgPaths.map((p, i) => `${p.split("/").at(-2)}=${versions[i]}`).join(", ");
    throw new Error(`packages are not in lockstep: ${detail}`);
  }
  return baseline;
}

export function parseFlags(args) {
  const flags = {
    dryRun: false,
    skipGit: false,
    skipPublish: false,
    registry: PUBLIC_NPM_REGISTRY,
    tag: DEFAULT_DIST_TAG,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--skip-git") {
      flags.skipGit = true;
    } else if (arg === "--skip-publish") {
      flags.skipPublish = true;
    } else if (arg === "--registry") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--registry requires a value");
      flags.registry = validateRegistryUrl(value);
      i += 1;
    } else if (arg === "--tag") {
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error("--tag requires a value");
      }
      if (!TAG_RE.test(value)) {
        throw new Error(`invalid --tag '${value}' (must match [a-zA-Z][a-zA-Z0-9-]*)`);
      }
      flags.tag = value;
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return flags;
}

export function validateReleaseOptions(flags) {
  if (flags.skipPublish && !flags.skipGit) {
    throw new Error("--skip-publish requires --skip-git (do not create/push a release tag without publishing)");
  }
  const publicRegistry = isPublicRegistry(flags.registry);
  if (!flags.skipGit && !publicRegistry) {
    throw new Error("custom registry rehearsals require --skip-git (do not push a public release tag for a non-public registry)");
  }
  if (flags.skipGit && !flags.skipPublish && publicRegistry) {
    throw new Error("refusing to publish to public npm without git commit/tag/push; remove --skip-git or pass --skip-publish");
  }
  if (
    flags.tag === DEFAULT_DIST_TAG
    && typeof flags.nextVersion === "string"
    && isPrereleaseVersion(flags.nextVersion)
  ) {
    throw new Error(
      `refusing to publish prerelease '${flags.nextVersion}' to the 'latest' dist-tag; pass --tag <name> (e.g. --tag next)`,
    );
  }
}

export function shouldRunPublicNpmWhoami(flags) {
  return !flags.dryRun && !flags.skipPublish && isPublicRegistry(flags.registry);
}

function isPublicRegistry(registry) {
  return validateRegistryUrl(registry) === PUBLIC_NPM_REGISTRY;
}

function validateRegistryUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("query/hash not allowed");
    }
    if (parsed.username || parsed.password) {
      throw new Error("credentials not allowed");
    }
  } catch {
    throw new Error(`invalid --registry URL: ${value}`);
  }
  if (/[\s"'`;|&<>$\\]/.test(value)) {
    throw new Error(`invalid --registry URL: ${value}`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname === "/" ? "" : pathname}`;
}

function readPackageMetas(pkgPaths) {
  return pkgPaths.map((p) => {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    if (!pkg.name) throw new Error(`missing package name in ${p}`);
      return { path: p, dir: dirname(p).replace(REPO_ROOT + "/", ""), name: pkg.name, version: pkg.version };
  });
}

export function parseNpmVersionsOutput(output) {
  if (!output.trim()) return [];
  const parsed = JSON.parse(output);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter((value) => typeof value === "string" && parseFullVersion(value) !== null);
}

function readPublishedVersions(pkgName, registry) {
  try {
    return parseNpmVersionsOutput(capture(["npm", "view", pkgName, "versions", "--json", "--registry", registry]));
  } catch (err) {
    if (isNpmMissingPackageError(err)) return [];
    const detail = commandErrorText(err);
    throw new Error(`could not query ${pkgName} on ${registry}: ${detail || err.message}`);
  }
}

function isNpmMissingPackageError(err) {
  return /\bE404\b|404 Not Found|is not in this registry|No match found/i.test(commandErrorText(err));
}

function commandErrorText(err) {
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString() : "";
  const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString() : "";
  return `${stderr}\n${stdout}\n${err.message ?? ""}`.trim();
}

function assertRegistryPreflight(pkgMetas, baseline, next, registry) {
  for (const pkg of pkgMetas) {
    assertNoPublishedVersionConflicts({
      pkgName: pkg.name,
      publishedVersions: readPublishedVersions(pkg.name, registry),
      baseline,
      next,
      registry,
    });
  }
}

export function assertNoPublishedVersionConflicts({ pkgName, publishedVersions, baseline, next, registry }) {
  const parsedBaseline = parseFullVersion(baseline);
  if (!parsedBaseline) throw new Error(`current version '${baseline}' is not X.Y.Z or X.Y.Z-tag.N`);
  const parsedNext = parseFullVersion(next);
  if (!parsedNext) throw new Error(`target version '${next}' is not X.Y.Z or X.Y.Z-tag.N`);

  const parsedPublished = publishedVersions
    .map((version) => ({ raw: version, parsed: parseFullVersion(version) }))
    .filter((entry) => entry.parsed !== null);

  if (parsedPublished.some((entry) => entry.raw === next)) {
    throw new Error(`target version already exists on ${registry}: ${pkgName}@${next}`);
  }

  const newer = parsedPublished
    .filter((entry) => compareVersions(entry.parsed, parsedNext) >= 0)
    .sort((a, b) => compareVersions(b.parsed, a.parsed));
  if (newer.length > 0) {
    throw new Error(
      `local baseline ${baseline} is stale for ${pkgName}; registry already has ${newer[0].raw} which is >= target ${next}. Pull the latest release commit before releasing.`,
    );
  }
}

function assertMainSyncedWithOrigin() {
  run(originMainFetchCommand());
  const head = capture(["git", "rev-parse", "HEAD"]);
  const origin = capture(["git", "rev-parse", "refs/remotes/origin/main"]);
  if (head !== origin) {
    throw new Error("local main is not synced with origin/main; pull/rebase before releasing");
  }
}

// The 'main' entry runs the CLI. Tests import bumpVersion / readLockstepVersion
// / die without triggering the CLI side-effects.
const isMain = typeof process !== "undefined"
  && process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const rawArgs = process.argv.slice(2);
  const levelArg = rawArgs[0];
  if (!levelArg || levelArg === "-h" || levelArg === "--help") {
    process.stdout.write(
      "usage: release.mjs <patch|minor|major|X.Y.Z|X.Y.Z-tag.N|prerelease <tag>> [--tag <dist-tag>] [--dry-run] [--skip-git] [--skip-publish] [--registry <url>]\n",
    );
    process.exit(levelArg ? 0 : 1);
  }

  // If level is `prerelease`, the next positional arg is the prerelease tag.
  let prereleaseTag;
  let rest;
  if (levelArg === "prerelease") {
    prereleaseTag = rawArgs[1];
    if (!prereleaseTag || prereleaseTag.startsWith("--")) {
      die("`prerelease` requires a tag argument, e.g. `release.mjs prerelease next`");
    }
    rest = rawArgs.slice(2);
  } else {
    rest = rawArgs.slice(1);
  }

  let flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    die(err.message);
  }
  const { dryRun, skipGit, skipPublish, registry, tag } = flags;

  for (const p of PKG_PATHS) {
    if (!existsSync(p)) die(`missing ${p}`);
  }

  let baseline;
  let packageMetas;
  try {
    packageMetas = readPackageMetas(PKG_PATHS);
    baseline = readLockstepVersion(PKG_PATHS);
  } catch (err) {
    die(err.message);
  }

  let next;
  try {
    next = bumpVersion(baseline, levelArg, prereleaseTag);
  } catch (err) {
    die(err.message);
  }

  try {
    validateReleaseOptions({ ...flags, nextVersion: next });
  } catch (err) {
    die(err.message);
  }

  if (!dryRun) {
    const status = capture(["git", "status", "--porcelain"]);
    if (status) die(`working tree not clean:\n${status}`);
  }
  if (!skipGit) {
    const branch = capture(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== "main") die(`must release from 'main', currently on '${branch}'`);
    if (!dryRun) {
      try {
        assertMainSyncedWithOrigin();
      } catch (err) {
        die(err.message);
      }
    }
  }

  const plan = [
    `1. preflight on real run: clean tree, main branch, origin/main sync, registry availability (${registry}), dist-tag=${tag}`,
    `2. rewrite version field: ${baseline} -> ${next} in ${PKG_PATHS.length} files:`,
    ...PKG_PATHS.map((p) => `     ${p.replace(REPO_ROOT + "/", "")}`),
    `3. run: pnpm install --lockfile-only`,
    `4. run: pnpm -r build`,
      skipPublish ? `5. [skipped] package publish dry-runs` : `5. run in order:\n${formatCommandList(publishCommands(registry, { tag, dryRun: true }), "       ")}`,
    skipGit ? `6. [skipped] git commit + annotated tag` : `6. run: git commit -am "chore(release): v${next} (--tag ${tag})" && git tag -a v${next} -m "v${next} (--tag ${tag})"`,
      skipPublish ? `7. [skipped] package publish` : `7. run in order:\n${formatCommandList(publishCommands(registry, { tag }), "       ")}`,
    skipGit ? `8. [skipped] git push origin main --follow-tags` : `8. run: ${formatCmd(pushCommand())}`,
  ];

  process.stdout.write(`release: plan for @understand-anyway/* ${baseline} -> ${next} (dist-tag=${tag})\n`);
  for (const line of plan) process.stdout.write(`  ${line}\n`);

  if (dryRun) {
    process.stdout.write("release: --dry-run, exiting before step 1. Re-run without --dry-run to execute the plan above.\n");
    process.exit(0);
  }

  if (shouldRunPublicNpmWhoami(flags)) {
    try {
      const whoamiCmd = ["npm", "whoami", "--registry", registry];
      const who = capture(whoamiCmd);
      process.stdout.write(`release: ${formatCmd(whoamiCmd)} -> ${who}\n`);
    } catch {
      die("not logged in to public npm (`npm whoami --registry https://registry.npmjs.org` failed); run `npm login` or pass --skip-publish");
    }
  } else if (!skipPublish) {
    process.stdout.write(`release: custom registry ${registry}; skipping public npm whoami preflight\n`);
  }

  if (!skipPublish) {
    try {
      assertRegistryPreflight(packageMetas, baseline, next, registry);
    } catch (err) {
      die(err.message);
    }
  }

  for (const p of PKG_PATHS) {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    pkg.version = next;
    writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  process.stdout.write(`release: rewrote ${PKG_PATHS.length} package.json version fields\n`);

  run(["pnpm", "install", "--lockfile-only"]);
  run(["pnpm", "-r", "build"]);

  if (!skipPublish) {
      for (const cmd of publishCommands(registry, { tag, dryRun: true })) run(cmd);
  } else {
      process.stdout.write("release: --skip-publish, not running package publish dry-runs\n");
  }

  if (!skipGit) {
    run(["git", "commit", "-am", `chore(release): v${next} (--tag ${tag})`]);
    run(["git", "tag", "-a", `v${next}`, "-m", `v${next} (--tag ${tag})`]);
  } else {
    process.stdout.write("release: --skip-git, not committing / tagging\n");
  }

  if (!skipPublish) {
    try {
        for (const cmd of publishCommands(registry, { tag })) run(cmd);
    } catch (err) {
      if (!skipGit) {
        process.stderr.write(publishFailureRecoveryMessage(next, registry));
      }
      process.exit(typeof err.status === "number" ? err.status : 1);
    }
  } else {
      process.stdout.write("release: --skip-publish, not publishing packages\n");
  }

  if (!skipGit) {
    run(pushCommand());
  } else {
    process.stdout.write("release: --skip-git, not pushing commit or tag\n");
  }

  const published = skipPublish ? "not published (--skip-publish)" : "published";
  const pushed = skipGit ? "not pushed (--skip-git)" : "pushed";
  process.stdout.write(`release: done. v${next} (--tag ${tag}) ${published}, ${pushed}.\n`);
  if (skipGit) {
    process.stdout.write(
      "release: note: --skip-git leaves package.json/pnpm-lock.yaml changes in the working tree; restore them after rehearsal if needed.\n",
    );
  }
}

export function publishFailureRecoveryMessage(version, registry) {
  return [
    `release: publish failed after local commit/tag v${version} were created, but before any git push.`,
    `release: Do not rerun release.mjs for v${version}; the version bump will reject or advance the already-bumped version.`,
    "release: Recovery: inspect which packages are already published, publish only missing packages from this commit, then push:",
    `release:   npm view <pkg> versions --json --registry ${registry}`,
      `release:   pnpm publish packages/<pkg-dir> --access public --no-git-checks --registry ${registry}`,
    "release:   git push origin main --follow-tags",
    "release: If no package was published, delete the local tag/commit before another release attempt.",
    "",
  ].join("\n");
}

export function publishCommand(pkgDir, registry, options = {}) {
  const tag = options.tag ?? DEFAULT_DIST_TAG;
  return [
    "pnpm",
    "publish",
    pkgDir,
    "--access",
    "public",
    "--no-git-checks",
    "--registry",
    registry,
    ...(options.dryRun ? ["--dry-run"] : []),
    "--tag",
    tag,
  ];
}

export function publishCommands(registry, options = {}) {
  return readPackageMetas(PKG_PATHS).map((pkg) => publishCommand(pkg.dir, registry, options));
}

export function originMainFetchCommand() {
  // Force-refspec avoids a git 2.39 (Apple Git) quirk where
  // `main:refs/remotes/origin/main` gets interpreted as a deletion when the
  // local remote-tracking ref happens to be missing.
  return ["git", "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"];
}

export function pushCommand() {
  return ["git", "push", "origin", "main", "--follow-tags"];
}

function formatCmd(cmd) {
  return cmd.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function formatCommandList(commands, prefix = "") {
  return commands.map((cmd) => `${prefix}${formatCmd(cmd)}`).join("\n");
}
