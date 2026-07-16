/**
 * Seed the two-tier `<projectsRoot>/gateway/portal-assets/` directory with the
 * neutral brand defaults bundled inside this package (`assets/portal/`).
 *
 * The open-source portal resolves branding by convention
 * (`portal-background` / `portal-wordmark` / `footer-left` / `footer-right`,
 * see the gateway's `resolveNamedPortalAssetUrl`). Shipping a default set and
 * seeding it on `gateway start` means a fresh install shows branded art with
 * zero configuration, while any operator-supplied file (any whitelisted
 * extension) is left untouched — we never overwrite on-disk assets, so this is
 * safe to run on every start.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTAL_ICON_EXTENSIONS } from "@understand-anyway/gateway";

export interface SeedPortalAssetsOptions {
  /**
   * Directory holding the bundled default assets. Defaults to this package's
   * `assets/portal/` (resolved relative to the built module).
   */
  sourceDir?: string;
}

export interface SeedPortalAssetsResult {
  /** File names copied into `portalAssetsRoot` during this run. */
  seeded: string[];
}

/** Absolute path to this package's bundled `assets/portal/` directory. */
export function defaultBundledPortalAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "assets", "portal");
}

/**
 * Copy every bundled default into `portalAssetsRoot` unless a file with the
 * same base name (any whitelisted extension) is already present. Missing
 * source dir or already-present targets are silently skipped so callers can
 * run this unconditionally.
 */
export function seedPortalAssets(
  portalAssetsRoot: string,
  options: SeedPortalAssetsOptions = {},
): SeedPortalAssetsResult {
  const sourceDir = options.sourceDir ?? defaultBundledPortalAssetsDir();
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    return { seeded: [] };
  }

  const sources = readdirSync(sourceDir).filter((name) => {
    const ext = extname(name).toLowerCase();
    return (PORTAL_ICON_EXTENSIONS as readonly string[]).includes(ext);
  });
  if (sources.length === 0) return { seeded: [] };

  mkdirSync(portalAssetsRoot, { recursive: true });
  const seeded: string[] = [];
  for (const fileName of sources) {
    const stem = basename(fileName, extname(fileName));
    if (hasConventionVariant(portalAssetsRoot, stem)) continue;
    copyFileSync(resolve(sourceDir, fileName), resolve(portalAssetsRoot, fileName));
    seeded.push(fileName);
  }
  return { seeded };
}

/** Whether `<root>/<stem>.<ext>` exists for any whitelisted extension. */
function hasConventionVariant(portalAssetsRoot: string, stem: string): boolean {
  for (const ext of PORTAL_ICON_EXTENSIONS) {
    if (existsSync(resolve(portalAssetsRoot, `${stem}${ext}`))) return true;
  }
  return false;
}
