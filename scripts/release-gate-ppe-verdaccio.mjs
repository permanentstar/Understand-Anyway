#!/usr/bin/env node

// Publish the ten @understand-anyway/* packages into a Verdaccio registry that
// runs locally on the PPE host, so the standard OSS install path can be
// exercised there without touching public npm.
//
// Flow (real run):
//   1. local: pnpm -r build
//   2. local: npm pack each package (dependency order) -> tarballs
//   3. remote (ssh -n): start Verdaccio on 127.0.0.1:4873 in a temp dir
//   4. local: scp tarballs to the remote temp dir
//   5. remote (ssh -n): npm publish each tarball in dependency order
//
// --dry-run prints the plan and exits without touching anything.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, run } from "./lib/release-gate-helpers.mjs";

// Dependency order: dependencies first, cli last.
const PKG_DIRS = [
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

function usage() {
  return [
    "Usage: node scripts/release-gate-ppe-verdaccio.mjs [--dry-run]",
    "",
    "Builds and packs the ten @understand-anyway/* packages locally, then starts",
    "a Verdaccio registry on the PPE host and publishes the tarballs into it.",
    "",
    "Required env:",
    "  UA_RELEASE_GATE_PPE_HOST",
    "  UA_RELEASE_GATE_PPE_USER",
    "  UA_RELEASE_GATE_PPE_ROOT",
    "",
    "Optional env:",
    "  UA_RELEASE_GATE_PPE_REGISTRY            default: http://127.0.0.1:4873",
    "  UA_RELEASE_GATE_PPE_VERDACCIO_STORAGE  default: <ROOT>/verdaccio-storage",
    "  UA_RELEASE_GATE_PPE_TARBALL_DIR        default: <ROOT>/verdaccio-tarballs",
    "",
  ].join("\n");
}

export function parseArgs(argv) {
  const out = { dryRun: false };
  for (const arg of argv) {
    switch (arg) {
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function buildEnv() {
  const host = requiredEnv("UA_RELEASE_GATE_PPE_HOST");
  const user = requiredEnv("UA_RELEASE_GATE_PPE_USER");
  const root = requiredEnv("UA_RELEASE_GATE_PPE_ROOT");
  const registry = process.env.UA_RELEASE_GATE_PPE_REGISTRY || "http://127.0.0.1:4873";
  const storage = process.env.UA_RELEASE_GATE_PPE_VERDACCIO_STORAGE || `${root}/verdaccio-storage`;
  const tarballDir = process.env.UA_RELEASE_GATE_PPE_TARBALL_DIR || `${root}/verdaccio-tarballs`;
  const listen = registry.replace(/^https?:\/\//, "");
  return { host, user, root, registry, storage, tarballDir, listen };
}

function tarballName(pkgDir) {
  return `understand-anyway-${pkgDir}.tgz`;
}

// Verdaccio config that allows anonymous publish to the local registry only.
function verdaccioConfig(env) {
  return [
    `storage: ${env.storage}`,
    "uplinks:",
    "  npmjs:",
    "    url: https://registry.npmjs.org/",
    "packages:",
    "  '@understand-anyway/*':",
    "    access: $all",
    "    publish: $all",
    "    unpublish: $all",
    "  '**':",
    "    access: $all",
    "    proxy: npmjs",
    "publish:",
    "  allow_offline: true",
    "log: { type: stdout, format: pretty, level: warn }",
    "",
  ].join("\n");
}

export function planLines(env) {
  const lines = [];
  lines.push("[verdaccio] plan");
  lines.push(`registry: ${env.registry}`);
  lines.push("");
  lines.push("# 1. local build");
  lines.push("pnpm -r build");
  lines.push("");
  lines.push("# 2. local pack (dependency order)");
  for (const pkg of PKG_DIRS) {
    lines.push(`npm pack ./packages/${pkg} --pack-destination <local-tmp>   # -> ${tarballName(pkg)}`);
  }
  lines.push("");
  lines.push("# 3. start Verdaccio on PPE");
  lines.push(
    `ssh -n -o BatchMode=yes ${env.user}@${env.host} ` +
      quote(
        [
          `mkdir -p ${quote(env.storage)} ${quote(env.tarballDir)}`,
          `npx --yes verdaccio@6 --listen ${env.listen} --config <remote>/verdaccio.yaml &`,
        ].join("; "),
      ),
  );
  lines.push("");
  lines.push("# 4. scp tarballs to PPE");
  for (const pkg of PKG_DIRS) {
    lines.push(`scp <local-tmp>/${tarballName(pkg)} ${env.user}@${env.host}:${env.tarballDir}/`);
  }
  lines.push("");
  lines.push("# 5. publish into Verdaccio (dependency order)");
  for (const pkg of PKG_DIRS) {
    lines.push(
      `ssh -n -o BatchMode=yes ${env.user}@${env.host} ` +
        quote(`npm publish ${quote(`${env.tarballDir}/${tarballName(pkg)}`)} --registry ${env.registry}`),
    );
  }
  return lines;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    process.exit(2);
  }

  let env;
  try {
    env = buildEnv();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  if (args.dryRun) {
    process.stdout.write(`${planLines(env).join("\n")}\n`);
    return;
  }

  const localTmp = resolve(REPO_ROOT, ".release-gate", "verdaccio-tarballs");
  mkdirSync(localTmp, { recursive: true });

  // 1. build
  run("pnpm", ["-r", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

  // 2. pack (dependency order). pnpm pack rewrites `workspace:*` into concrete
  // versions; npm pack would leave `workspace:` and the publish would fail.
  for (const pkg of PKG_DIRS) {
    run("pnpm", ["pack", "--pack-destination", localTmp], {
      cwd: resolve(REPO_ROOT, "packages", pkg),
      stdio: "inherit",
    });
  }

  // 3. write remote verdaccio config + start registry
  const remoteConfig = `${env.root}/verdaccio.yaml`;
  const encodedConfig = Buffer.from(verdaccioConfig(env), "utf8").toString("base64");
  const startRemote = [
    `mkdir -p ${quote(env.storage)} ${quote(env.tarballDir)}`,
    `printf %s ${quote(encodedConfig)} | base64 -d > ${quote(remoteConfig)}`,
    `pkill -f 'verdaccio.*${env.listen}' 2>/dev/null || true`,
    // Fully detach the daemon from this ssh channel: setsid + </dev/null and
    // redirected stdout/stderr. The background launch (`&`) must stay on one
    // segment as `cmd & sleep 4` — a `;` right after `&` is a bash syntax error.
    `setsid nohup npx --yes verdaccio@6 --listen ${env.listen} --config ${quote(remoteConfig)} </dev/null >${quote(`${env.root}/verdaccio.log`)} 2>&1 & sleep 4`,
    "exit 0",
  ].join("; ");
  run("ssh", ["-n", "-o", "BatchMode=yes", `${env.user}@${env.host}`, startRemote], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  // 4. scp tarballs
  for (const pkg of PKG_DIRS) {
    // npm pack names tarballs as understand-anyway-<pkg>-<version>.tgz; use a
    // glob-free deterministic copy by resolving the actual filename first.
    run("bash", ["-c", `scp ${quote(`${localTmp}/understand-anyway-${pkg}-*.tgz`)} ${env.user}@${env.host}:${quote(`${env.tarballDir}/`)}`], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }

  // 5. publish in dependency order
  for (const pkg of PKG_DIRS) {
    const publishRemote = `for f in ${quote(`${env.tarballDir}/understand-anyway-${pkg}-*.tgz`)}; do npm publish "$f" --registry ${env.registry}; done`;
    run("ssh", ["-n", "-o", "BatchMode=yes", `${env.user}@${env.host}`, publishRemote], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }

  const artifactDir = resolve(REPO_ROOT, ".release-gate", "ppe");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(resolve(artifactDir, "verdaccio-registry.txt"), `${env.registry}\n`, "utf8");
  process.stdout.write(`[verdaccio] published to ${env.registry}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[release-gate-ppe-verdaccio] fatal: ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
}
