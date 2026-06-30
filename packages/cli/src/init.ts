/**
 * `init` command: register or update a project in
 * `<projectsRoot>/gateway/config/projects.json`.
 *
 * The command is idempotent: it upserts (`projectId`-keyed) the entry with
 * whichever fields were explicitly supplied (tracked in `args.explicit`).
 * Re-running it with no flags is a no-op. Conflicts on the few re-targeting
 * fields (currently only `repoPath`) require `--force` so changes that would
 * silently relocate a project are visible.
 *
 * Side effects beyond projects.json:
 *  - `--icon-file <path>`: copies the file into
 *    `<projectsRoot>/gateway/portal-assets/icons/<projectId>.<ext>`. The entry never
 *    records the icon path — the portal scans the convention.
 *  - `--dry-run`: prints the planned action as JSON and exits 0 without
 *    touching the filesystem (no projects.json write, no icon copy).
 *
 * `stateDir` is intentionally NOT a flag; it is always
 * `<projectsRoot>/projects/<projectId>`, and historical `stateDir` entries are dropped
 * the next time `init` rewrites the file.
 */

import { basename, resolve } from "node:path";
import { ArgsError, type InitArgs } from "./args.js";
import { resolveProjectsRoot } from "./project-context.js";
import {
  buildPortalAssetsRoot,
  buildProjectsConfigPath,
  copyIconFile,
  IconExtensionError,
  readProjectsConfig,
  upsertEntry,
  withProjectsConfigLock,
  writeProjectsConfigUnlocked,
  type ProjectsConfig,
  type ProjectsConfigEntry,
} from "./projects-config.js";

export interface RunInitDeps {
  /** Override projectsRoot resolution; defaults to `resolveProjectsRoot()`. */
  resolveProjectsRoot?: typeof resolveProjectsRoot;
  /** Reader for projects.json; tolerant of missing/corrupt files. */
  readProjectsConfig?: typeof readProjectsConfig;
  /** Write helper called inside the lock; does not re-acquire it. */
  writeProjectsConfigUnlocked?: typeof writeProjectsConfigUnlocked;
  /** Lock helper around the projects.json mkdir-lock. */
  withProjectsConfigLock?: typeof withProjectsConfigLock;
  /** Icon copy primitive. */
  copyIconFile?: typeof copyIconFile;
  /** Process env override (mainly for tests). */
  env?: NodeJS.ProcessEnv;
}

export interface RunInitOptions {
  log?: (message: string) => void;
  deps?: RunInitDeps;
}

export type InitAction = "created" | "updated" | "no-op" | "dry-run";

export interface RunInitResult {
  action: InitAction;
  projectId: string;
  projectsRoot: string;
  projectsConfigPath: string;
  portalAssetsRoot: string;
  entry: ProjectsConfigEntry;
  iconPath: string | null;
  warnings: string[];
}

/**
 * Run `init`. Returns the structured result and also emits the same payload
 * as a single-line JSON to `log` (default: process.stdout) so deploy tooling
 * can consume it without a second parser.
 */
export async function runInit(args: InitArgs, options: RunInitOptions = {}): Promise<RunInitResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const deps = options.deps ?? {};
  const env = deps.env ?? process.env;

  const resolveRoot = deps.resolveProjectsRoot ?? resolveProjectsRoot;
  const readCfg = deps.readProjectsConfig ?? readProjectsConfig;
  const writeCfg = deps.writeProjectsConfigUnlocked ?? writeProjectsConfigUnlocked;
  const lock = deps.withProjectsConfigLock ?? withProjectsConfigLock;
  const copyIcon = deps.copyIconFile ?? copyIconFile;

  const projectId = (args.projectId ?? basename(resolve(args.repo))).trim();
  if (!projectId) {
    throw new ArgsError("init: cannot infer projectId from repo path; pass --project <id>");
  }

  const projectsRoot = resolveRoot({ env });
  const projectsConfigPath = buildProjectsConfigPath(projectsRoot);
  const portalAssetsRoot = buildPortalAssetsRoot(projectsRoot);

  const patch: ProjectsConfigEntry = { projectId };
  if (args.explicit.has("version")) patch.version = args.version ?? undefined;
  if (args.explicit.has("sortOrder")) patch.sortOrder = args.sortOrder ?? undefined;
  if (args.explicit.has("repoPath")) patch.repoPath = args.repoPath ?? undefined;

  const warnings: string[] = [];

  if (args.dryRun) {
    const config = readCfg(projectsConfigPath);
    const result = upsertEntry(config, patch, { force: args.force });
    if (result.conflicts.length > 0 && !args.force) {
      throw new ArgsError(
        `init: conflicting fields require --force: ${result.conflicts.join(", ")}`,
      );
    }
    if (args.explicit.has("iconFile") && args.iconFile) {
      warnings.push(`dry-run: would copy ${args.iconFile} to ${portalAssetsRoot}/icons/${projectId}.<ext>`);
    }
    const payload: RunInitResult = {
      action: "dry-run",
      projectId,
      projectsRoot,
      projectsConfigPath,
      portalAssetsRoot,
      entry: result.entry,
      iconPath: null,
      warnings,
    };
    log(JSON.stringify(payload));
    return payload;
  }

  let action: InitAction = "no-op";
  let finalEntry: ProjectsConfigEntry = patch;
  let iconPath: string | null = null;

  lock(projectsConfigPath, () => {
    const config = readCfg(projectsConfigPath);
    const before = config.projects.find((entry) => entry.projectId === projectId);
    const result = upsertEntry(config, patch, { force: args.force });
    if (result.conflicts.length > 0 && !args.force) {
      throw new ArgsError(
        `init: conflicting fields require --force: ${result.conflicts.join(", ")}`,
      );
    }
    finalEntry = result.entry;

    if (args.explicit.has("iconFile") && args.iconFile) {
      try {
        const copyResult = copyIcon(args.iconFile, portalAssetsRoot, projectId);
        iconPath = copyResult.destination;
      } catch (err) {
        if (err instanceof IconExtensionError) {
          throw new ArgsError(err.message);
        }
        throw err;
      }
    }

    if (result.created) {
      action = "created";
    } else if (entriesEqual(before, finalEntry)) {
      action = iconPath ? "updated" : "no-op";
    } else {
      action = "updated";
    }

    const persist: ProjectsConfig = { ...config };
    writeCfg(projectsConfigPath, persist);
  });

  const payload: RunInitResult = {
    action,
    projectId,
    projectsRoot,
    projectsConfigPath,
    portalAssetsRoot,
    entry: finalEntry,
    iconPath,
    warnings,
  };
  log(JSON.stringify(payload));
  return payload;
}

function entriesEqual(
  a: ProjectsConfigEntry | undefined,
  b: ProjectsConfigEntry | undefined,
): boolean {
  if (!a || !b) return false;
  const keys: (keyof ProjectsConfigEntry)[] = [
    "projectId",
    "repoPath",
    "name",
    "version",
    "sortOrder",
    "visible",
    "description",
    "excludeTests",
  ];
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
