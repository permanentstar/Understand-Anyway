/**
 * Config file discovery (Spring Boot-style search chain).
 *
 * Locating the config never depends on env-as-bootstrap-key: it uses only the
 * explicit `--config`, an optional `$UA_CONFIG`, the cwd, and the executable's
 * own root (derived from `import.meta.url`). No user home absolute dir is ever
 * part of the default chain — new deploy environments must not assume
 * `~/understand-projects`-style layouts.
 *
 * Priority (first existing hit wins):
 *   1. --config <path>                         explicit
 *   2. $UA_CONFIG                              optional env pointer
 *   3. cwd/deploy.yaml, cwd/config/deploy.yaml
 *   4. exe-root/deploy.yaml, exe-root/config/deploy.yaml
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_ENV_VAR, CONFIG_FILE_NAMES } from "@understand-anyway/plugin-api";

export interface DiscoverDeps {
  /** Defaults to fs.existsSync. */
  fileExists?: (path: string) => boolean;
  /** Process working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Process env. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Executable project root. Defaults to inferred from import.meta.url. */
  exeRoot?: string;
}

/** Files that mark a directory as the executable project root. */
const ROOT_MARKERS = ["package.json"] as const;

const defaultFileExists = (path: string): boolean => existsSync(path);

/** Walk up from this module's location to the nearest dir holding a marker. */
function inferExeRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(resolve(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/**
 * Resolve a config path. `$UA_CONFIG` and `--config` may point at either a file
 * or a directory; a directory is probed with {@link CONFIG_FILE_NAMES}.
 * Returns the absolute path of the first hit, or null when nothing is found.
 */
export function discoverConfigPath(
  explicit: string | null,
  deps: DiscoverDeps = {},
): string | null {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const exeRoot = deps.exeRoot ?? inferExeRoot();

  const probeBase = (base: string): string | null => {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolve(base, name);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  };

  // A pointer may be a config file directly or a directory holding one.
  const probePointer = (raw: string): string | null => {
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    return probeBase(abs) ?? (fileExists(abs) ? abs : null);
  };

  if (explicit) return probePointer(explicit);

  const envPointer = env[CONFIG_ENV_VAR];
  if (envPointer) {
    const hit = probePointer(envPointer);
    if (hit) return hit;
  }

  return probeBase(cwd) ?? probeBase(exeRoot);
}
