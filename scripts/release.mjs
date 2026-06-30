#!/usr/bin/env node
// Manual lockstep release for the six `@understand-anyway/*` packages.
//
// Usage:
//   node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--skip-git] [--skip-publish] [--registry <url>]
//
// Execution order (chosen for recoverability: commit/tag locally before the
// irreversible npm publish, push to the remote only after npm succeeds):
//   1. Sanity: valid bump, six packages in lockstep, clean tree for real
//      execution, on `main` and synced with `origin/main` (unless --skip-git),
//      target versions absent from the registry, `npm whoami` succeeds for
//      public npm publishes (unless --skip-publish).
//   2. Compute the next version (semver bump or explicit X.Y.Z).
//   3. Rewrite every `packages/*/package.json` `version` field.
//   4. `pnpm install --lockfile-only` to refresh `pnpm-lock.yaml`.
//   5. `pnpm -r build`. Abort before publish if any package fails to build.
//   6. `pnpm --filter <pkg> publish --dry-run` in dependency order. Abort
//      before commit/tag on pack failures.
//   7. `git commit -am "chore(release): v<next>"` + annotated `git tag`.
//   8. `pnpm --filter <pkg> publish --access public --no-git-checks` in the
//      same dependency order.
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
const PKG_NAMES = ["plugin-api", "core", "gateway", "provider-feishu-auth", "provider-feishu-sheets", "cli"];
const PKG_PATHS = PKG_NAMES.map((name) => resolve(REPO_ROOT, "packages", name, "package.json"));
const SEMVER_CORE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

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

export function bumpVersion(current, level) {
  const parts = parseCoreVersion(current);
  if (!parts) {
    throw new Error(`current version '${current}' is not X.Y.Z`);
  }
  const [maj, min, pat] = parts;
  const explicit = parseCoreVersion(level);
  if (explicit) {
    if (compareVersions(explicit, parts) <= 0) {
      throw new Error(`explicit version '${level}' must be greater than current version '${current}'`);
    }
    return level;
  }
  if (level === "patch") return `${maj}.${min}.${pat + 1}`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  if (level === "major") return `${maj + 1}.0.0`;
  throw new Error(`bump level must be patch|minor|major|X.Y.Z, got '${level}'`);
}

function parseCoreVersion(value) {
  const match = SEMVER_CORE_RE.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
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
  const flags = { dryRun: false, skipGit: false, skipPublish: false, registry: PUBLIC_NPM_REGISTRY };
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
  return values.filter((value) => typeof value === "string" && parseCoreVersion(value));
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
  const baselineParts = parseCoreVersion(baseline);
  if (!baselineParts) throw new Error(`current version '${baseline}' is not X.Y.Z`);
  const corePublishedVersions = publishedVersions.filter((version) => parseCoreVersion(version));
  if (corePublishedVersions.includes(next)) {
    throw new Error(`target version already exists on ${registry}: ${pkgName}@${next}`);
  }
  const newer = corePublishedVersions
    .filter((version) => compareVersions(parseCoreVersion(version), baselineParts) > 0)
    .sort((a, b) => compareVersions(parseCoreVersion(b), parseCoreVersion(a)));
  if (newer.length > 0) {
    throw new Error(
      `local baseline ${baseline} is stale for ${pkgName}; registry already has ${newer[0]}. Pull the latest release commit before releasing.`,
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
  const [, , levelArg, ...rest] = process.argv;
  if (!levelArg || levelArg === "-h" || levelArg === "--help") {
    process.stdout.write(
      "usage: release.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--skip-git] [--skip-publish] [--registry <url>]\n",
    );
    process.exit(levelArg ? 0 : 1);
  }
  let flags;
  try {
    flags = parseFlags(rest);
    validateReleaseOptions(flags);
  } catch (err) {
    die(err.message);
  }
  const { dryRun, skipGit, skipPublish, registry } = flags;

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
    next = bumpVersion(baseline, levelArg);
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
    `1. preflight on real run: clean tree, main branch, origin/main sync, registry availability (${registry})`,
    `2. rewrite version field: ${baseline} -> ${next} in ${PKG_PATHS.length} files:`,
    ...PKG_PATHS.map((p) => `     ${p.replace(REPO_ROOT + "/", "")}`),
    `3. run: pnpm install --lockfile-only`,
    `4. run: pnpm -r build`,
      skipPublish ? `5. [skipped] package publish dry-runs` : `5. run in order:\n${formatCommandList(publishCommands(registry, { dryRun: true }), "       ")}`,
    skipGit ? `6. [skipped] git commit + annotated tag` : `6. run: git commit -am "chore(release): v${next}" && git tag -a v${next} -m "v${next}"`,
      skipPublish ? `7. [skipped] package publish` : `7. run in order:\n${formatCommandList(publishCommands(registry), "       ")}`,
    skipGit ? `8. [skipped] git push origin main --follow-tags` : `8. run: ${formatCmd(pushCommand())}`,
  ];

  process.stdout.write(`release: plan for @understand-anyway/* ${baseline} -> ${next}\n`);
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
      for (const cmd of publishCommands(registry, { dryRun: true })) run(cmd);
  } else {
      process.stdout.write("release: --skip-publish, not running package publish dry-runs\n");
  }

  if (!skipGit) {
    run(["git", "commit", "-am", `chore(release): v${next}`]);
    run(["git", "tag", "-a", `v${next}`, "-m", `v${next}`]);
  } else {
    process.stdout.write("release: --skip-git, not committing / tagging\n");
  }

  if (!skipPublish) {
    try {
        for (const cmd of publishCommands(registry)) run(cmd);
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
  process.stdout.write(`release: done. v${next} ${published}, ${pushed}.\n`);
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
  ];
}

export function publishCommands(registry, options = {}) {
  return readPackageMetas(PKG_PATHS).map((pkg) => publishCommand(pkg.dir, registry, options));
}

export function originMainFetchCommand() {
  return ["git", "fetch", "origin", "main:refs/remotes/origin/main"];
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
