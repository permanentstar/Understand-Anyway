#!/usr/bin/env node

import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

/**
 * Resolve an import specifier (file:// URL) for the gateway dist entry that
 * exports ProjectRegistryStore.
 *
 * Order:
 *   1. Installed package `@understand-anyway/gateway` via import.meta.resolve
 *      (npm deploy layout; honors the package's ESM `exports`).
 *   2. Monorepo `<rootDir>/packages/gateway/dist/index.js` (source checkout).
 *
 * `deps` is injectable for testing (metaResolve/exists).
 */
export function resolveGatewayEntry(rootDir, deps = {}) {
  const metaResolve = deps.metaResolve
    ?? ((spec) => import.meta.resolve(spec));
  const exists = deps.exists ?? existsSync;
  try {
    const resolved = metaResolve("@understand-anyway/gateway");
    if (resolved) return resolved;
  } catch {
    // fall through to source layout
  }
  const sourceEntry = resolve(rootDir ?? process.cwd(), "packages", "gateway", "dist", "index.js");
  if (exists(sourceEntry)) {
    return pathToFileURL(sourceEntry).href;
  }
  throw new Error(
    `gateway dist not found: install @understand-anyway/gateway or build ${sourceEntry}`,
  );
}

export async function loadProjectRegistryStore(rootDir) {
  const gatewayEntry = resolveGatewayEntry(rootDir);
  const mod = await import(gatewayEntry);
  if (typeof mod.ProjectRegistryStore !== "function") {
    throw new Error(`gateway dist at ${gatewayEntry} does not export ProjectRegistryStore`);
  }
  return mod.ProjectRegistryStore;
}

export async function upsertProdRegistryRecord(
  options,
  deps = {},
) {
  const {
    registryPath,
    projectId,
    projectRoot,
    stateRoot,
    host,
    port,
  } = options;
  if (!registryPath || !projectId || !projectRoot || !stateRoot || !host || !port) {
    throw new Error("upsertProdRegistryRecord requires registryPath/projectId/projectRoot/stateRoot/host/port");
  }
  const Store = deps.Store ?? await loadProjectRegistryStore(options.rootDir ?? process.cwd());
  const tokenFactory = deps.tokenFactory ?? (() => randomBytes(16).toString("hex"));
  const store = new Store(resolve(registryPath));
  const current = typeof store.get === "function" ? store.get(projectId) : null;
  const token = typeof current?.prodToken === "string" && current.prodToken.trim()
    ? current.prodToken.trim()
    : tokenFactory();
  const accessHost = normalizeAccessHost(host);
  const accessUrl = `http://${accessHost}:${port}/project/${encodeURIComponent(projectId)}/`;
  return store.upsert(
    projectId,
    resolve(projectRoot),
    resolve(stateRoot),
    {
      name: current?.name ?? projectId,
      accessUrl,
      dashboardUrl: accessUrl,
      runtimeMode: "prod",
      prodDistDir: resolveProdDistDir(resolve(stateRoot)),
      prodToken: token,
      status: "running",
    },
  );
}

/**
 * Resolve the dashboard-dist directory for a project state root.
 *
 * Standard versioned layout (preferred): `<stateRoot>/current/dashboard-dist`,
 * where `current` is a symlink pointing at `versions/<vid>`. Returning the
 * symlink path (not the resolved target) keeps the registry stable across
 * rolling deploys: `project-state publish` only retargets the symlink, the
 * registry record stays valid without rewriting.
 *
 * Flat fallback: `<stateRoot>/dashboard-dist`. Only used during the migration
 * window and by legacy fixtures; new projects must publish into versions/.
 */
export function resolveProdDistDir(stateRoot) {
  const currentLink = resolve(stateRoot, "current");
  if (isSymlink(currentLink) || existsSync(currentLink)) {
    return resolve(currentLink, "dashboard-dist");
  }
  return resolve(stateRoot, "dashboard-dist");
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function pruneRegistryRecords(
  options,
  deps = {},
) {
  const { registryPath, projectIds } = options;
  if (!registryPath || !Array.isArray(projectIds)) {
    throw new Error("pruneRegistryRecords requires registryPath/projectIds");
  }
  const keep = new Set(projectIds.map((id) => String(id || "").trim()).filter(Boolean));
  const Store = deps.Store ?? await loadProjectRegistryStore(options.rootDir ?? process.cwd());
  const store = new Store(resolve(registryPath));
  const records = typeof store.list === "function" ? store.list() : [];
  const removed = [];
  for (const record of records) {
    const id = String(record?.id || "").trim();
    if (!id || keep.has(id)) continue;
    if (typeof store.remove !== "function") {
      throw new Error("ProjectRegistryStore does not expose remove()");
    }
    if (store.remove(id)) removed.push(id);
  }
  return removed;
}

export function normalizeAccessHost(host) {
  const trimmed = String(host || "").trim();
  if (trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") return "127.0.0.1";
  return trimmed;
}

function parseArgs(argv) {
  const args = {
    rootDir: "",
    registryPath: "",
    projectId: "",
    projectRoot: "",
    stateRoot: "",
    host: "",
    port: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--root-dir":
        args.rootDir = requireValue(arg, argv[++i]);
        break;
      case "--registry-path":
        args.registryPath = requireValue(arg, argv[++i]);
        break;
      case "--project-id":
        args.projectId = requireValue(arg, argv[++i]);
        break;
      case "--project-root":
        args.projectRoot = requireValue(arg, argv[++i]);
        break;
      case "--state-root":
        args.stateRoot = requireValue(arg, argv[++i]);
        break;
      case "--host":
        args.host = requireValue(arg, argv[++i]);
        break;
      case "--port":
        args.port = requireValue(arg, argv[++i]);
        break;
      case "--help":
      case "-h":
        process.stdout.write("upsert-project-registry.mjs --root-dir <dir> --registry-path <file> --project-id <id> --project-root <dir> --state-root <dir> --host <host> --port <port>\n");
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await upsertProdRegistryRecord(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exit(1);
  }
}
