/**
 * Fixed-location `.env` loader (secret values only).
 *
 * Resolves the secret search chain `./.env` → `~/.env` and merges them so that
 * earlier files win (cwd `.env` overrides home `.env`). The parsing mirrors the
 * deploy repo's simple env reader (export prefix, `KEY=value`, quote stripping)
 * but is an independent copy owned by the open-source CLI — there is no
 * cross-repo dependency. The result is consumed ONLY to resolve `{{ }}` secret
 * placeholders; it never carries non-secret deploy parameters.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface LoadDotenvDeps {
  cwd?: string;
  home?: string;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

/** Parse a single simple `.env` file; missing/unreadable → {}. */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load the fixed secret `.env` chain. Earlier paths take precedence, so the
 * returned map has `./.env` values overriding `~/.env`.
 */
export function loadDotenv(deps: LoadDotenvDeps = {}): Record<string, string> {
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  // Lower priority first; later spreads override.
  const chain = [resolve(home, ".env"), resolve(cwd, ".env")];
  const merged: Record<string, string> = {};
  for (const path of chain) {
    if (!fileExists(path)) continue;
    try {
      Object.assign(merged, parseDotenv(readFile(path)));
    } catch {
      /* ignore unreadable .env */
    }
  }
  return merged;
}
