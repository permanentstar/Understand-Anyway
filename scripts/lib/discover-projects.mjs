#!/usr/bin/env node
// scripts/lib/discover-projects.mjs
//
// Resolve project entries from `<projects-root>/gateway/config/projects.json`.
// Any legacy location is rejected with an explicit migration error so that
// shell scripts stay in lockstep with the CLI's single-source-of-truth
// directory contract (see packages/cli/src/project-context.ts).
//
// Output: NDJSON to stdout, one line per visible project:
//   {"projectId":"...","repoPath":"...","stateDir":"...","visible":true}
//
// Used by scripts/{daily-update,nightly-project-sync,refresh-prod-server}.sh
// as the single source of truth for project discovery, so script-side ordering
// matches `understand-anyway` runtime behaviour.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_FALLBACK = resolve(SCRIPT_DIR, "..", "..");

function parseArgs(argv) {
  const args = {
    projectsRoot: process.env.UA_PROJECTS_ROOT || resolve(homedir(), "understand-projects"),
    filter: "",
    repoRoot: REPO_ROOT_FALLBACK,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--projects-root") {
      args.projectsRoot = argv[i + 1] ?? "";
      i += 1;
    } else if (flag === "--filter") {
      args.filter = argv[i + 1] ?? "";
      i += 1;
    } else if (flag === "--repo-root") {
      args.repoRoot = argv[i + 1] ?? "";
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: discover-projects.mjs [--projects-root <path>] [--filter <projectId>] [--repo-root <path>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`discover-projects: unknown argument: ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

function expandTemplate(value, vars) {
  return String(value || "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    return process.env[key] ?? "";
  });
}

function resolvePath(value, anchor) {
  if (!value) return "";
  return isAbsolute(value) ? resolve(value) : resolve(anchor, value);
}

function loadConfig({ projectsRoot, repoRoot }) {
  const runtimeConfig = resolve(projectsRoot, "gateway", "config", "projects.json");
  if (existsSync(runtimeConfig)) {
    return { path: runtimeConfig, anchor: projectsRoot };
  }
  const legacyRuntimeConfig = resolve(projectsRoot, "config", "projects.json");
  if (existsSync(legacyRuntimeConfig)) {
    return {
      legacyPath: legacyRuntimeConfig,
      expectedPath: runtimeConfig,
    };
  }
  // Old fallback used `<repoRoot>/projects.json`. The CLI never reads this
  // location, so keeping it would let cron scripts diverge silently from the
  // CLI's view of the world. Reject it the same way the CLI does — emit a
  // migration error and exit non-zero.
  const legacyRepoConfig = resolve(repoRoot, "projects.json");
  if (existsSync(legacyRepoConfig)) {
    return {
      legacyPath: legacyRepoConfig,
      expectedPath: runtimeConfig,
    };
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectsRoot = resolve(args.projectsRoot);
  const repoRoot = resolve(args.repoRoot);
  const found = loadConfig({ projectsRoot, repoRoot });
  if (!found) {
    process.stderr.write(
      `discover-projects: no projects.json at ${projectsRoot}/gateway/config/projects.json\n`,
    );
    process.exit(1);
  }
  if (found.legacyPath) {
    process.stderr.write(
      `discover-projects: legacy projects config found at ${found.legacyPath}; move it to ${found.expectedPath}\n`,
    );
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(found.path, "utf8"));
  } catch (err) {
    process.stderr.write(
      `discover-projects: failed to parse ${found.path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const projectBaseDir = resolvePath(payload.projectBaseDir || "..", found.anchor);
  const projects = Array.isArray(payload.projects) ? payload.projects : [];

  for (const entry of projects) {
    const projectId = String(entry?.projectId || "").trim();
    if (!projectId) continue;
    if (entry.visible === false) continue;
    if (args.filter && projectId !== args.filter) continue;

    const vars = {
      projectBaseDir,
      projectsRoot,
      projectId,
      HOME: homedir(),
    };

    const repoPathTemplate = entry.repoPath || `\${projectBaseDir}/${projectId}`;
    // State roots are an internal convention, not project metadata.
    // Ignore legacy stateDir entries so all scripts agree with the CLI.
    const stateDirTemplate = `\${projectsRoot}/projects/${projectId}`;
    const repoPath = resolvePath(expandTemplate(repoPathTemplate, vars), projectBaseDir);
    const stateDir = resolvePath(expandTemplate(stateDirTemplate, vars), projectsRoot);

    const record = {
      projectId,
      repoPath,
      stateDir,
      visible: entry.visible !== false,
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

main();
