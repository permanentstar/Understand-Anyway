/**
 * Fixed-location `.env` loader (secret values only).
 *
 * The chain is `~/.env` (global fallback) → `<configDir>/.env` (deploy-owned,
 * highest priority). The intent is that each deploy owns a `.env` next to its
 * `deploy.yaml`, and `~/.env` only exists as a last-resort fallback for hosts
 * that predate the separation. Runtime cwd is intentionally NOT part of the
 * chain, to keep prod behavior stable regardless of the invoking directory.
 *
 * The result is consumed ONLY to resolve `{{ }}` secret placeholders in
 * deploy.yaml; it never carries non-secret deploy parameters.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface LoadDotenvDeps {
  /** Deploy config directory. When set, `<configDir>/.env` overrides ~/.env. */
  configDir?: string | null;
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
 * Load the secret `.env` chain. Order is `~/.env` then `<configDir>/.env`,
 * with later entries overriding earlier ones (so config-adjacent values win).
 */
export function loadDotenv(deps: LoadDotenvDeps = {}): Record<string, string> {
  const home = deps.home ?? homedir();
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  const chain: string[] = [resolve(home, ".env")];
  if (deps.configDir) chain.push(resolve(deps.configDir, ".env"));

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
