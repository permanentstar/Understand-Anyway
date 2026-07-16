/**
 * Determines portal project icon URLs via a two-tier convention so the
 * gateway never needs runtime CLI flags to find branded art:
 *
 *   Layer 1 (convention)  `<portalAssetsRoot>/icons/<projectId><ext>` —
 *                          first match in {@link PORTAL_ICON_EXTENSIONS}
 *                          wins; the result URL carries an `?v=<mtime>` query
 *                          so browsers re-fetch when the file updates.
 *   Layer 2 (generic)      `<portalAssetsRoot>/generic<ext>` — fallback used
 *                          when a project-specific icon is absent.
 *   Layer 3 (placeholder)  Returns `undefined`, letting the renderer fall
 *                          back to the inline placeholder SVG.
 *
 * External URLs are intentionally not supported — every icon must be served
 * by the portal itself out of `<portalAssetsRoot>` so the page is offline-safe
 * and CSP-friendly.
 *
 * This module is also responsible for safely serving anything under
 * `/portal-assets/`: path-traversal rejection, extension whitelist, and
 * cache-control headers all live here so we share one implementation across
 * the page renderer and the static-file handler.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep as pathSep } from "node:path";
import type { ServerResponse } from "node:http";
import { mimeForPath } from "./mime.js";
import { sendBuffer, sendText } from "./http.js";

export const PORTAL_ASSET_ROUTE_PREFIX = "/portal-assets/";

/**
 * Allowed icon extensions, ordered by Layer 1 lookup preference. Kept in
 * lockstep with `@understand-anyway/cli`'s `PORTAL_ICON_EXTENSIONS` so a
 * file the CLI accepts via `init --icon-file` is always discoverable by the
 * portal.
 */
export const PORTAL_ICON_EXTENSIONS = [".svg", ".png", ".webp", ".jpg", ".jpeg"] as const;
export type PortalIconExtension = (typeof PORTAL_ICON_EXTENSIONS)[number];

export interface ResolveProjectIconUrlOptions {
  projectId: string;
  portalAssetsRoot?: string;
}

/**
 * Resolve the public icon URL for a project. Returns `undefined` when no
 * convention file is on disk; the renderer then uses its inline placeholder.
 */
export function resolveProjectIconUrl(
  options: ResolveProjectIconUrlOptions,
): string | undefined {
  const projectId = (options.projectId ?? "").trim();
  if (!projectId) return undefined;
  const portalAssetsRoot = options.portalAssetsRoot;
  if (!portalAssetsRoot) return undefined;
  return resolveConventionAssetUrl(portalAssetsRoot, "icons", projectId)
    ?? resolveConventionAssetUrl(portalAssetsRoot, "", "generic");
}

/**
 * Resolve the public URL of a root-level branded asset by convention name
 * (`<portalAssetsRoot>/<baseName>.<ext>`, first match in
 * {@link PORTAL_ICON_EXTENSIONS} wins). Returns `undefined` when no file is on
 * disk. Used for the neutral portal brand set (background / wordmark / footer
 * avatars) so the open-source portal is zero-config: dropping a conventionally
 * named file into `portal-assets/` is enough to light it up.
 */
export function resolveNamedPortalAssetUrl(
  portalAssetsRoot: string,
  baseName: string,
): string | undefined {
  const root = (portalAssetsRoot ?? "").trim();
  const name = (baseName ?? "").trim();
  if (!root || !name) return undefined;
  return resolveConventionAssetUrl(root, "", name);
}

/**
 * Shared Layer 1 convention resolver: scan `<root>/<subdir>/<baseName><ext>`
 * for the first whitelisted extension on disk and return its public URL with a
 * `?v=<mtime>` cache-buster. `subdir` may be empty for root-level assets.
 */
function resolveConventionAssetUrl(
  portalAssetsRoot: string,
  subdir: string,
  baseName: string,
): string | undefined {
  for (const ext of PORTAL_ICON_EXTENSIONS) {
    const absolute = subdir
      ? resolve(portalAssetsRoot, subdir, `${baseName}${ext}`)
      : resolve(portalAssetsRoot, `${baseName}${ext}`);
    if (!existsSync(absolute)) continue;
    const routeSuffix = subdir
      ? `${subdir}/${encodeURIComponent(baseName)}${ext}`
      : `${encodeURIComponent(baseName)}${ext}`;
    const url = `${PORTAL_ASSET_ROUTE_PREFIX}${routeSuffix}`;
    try {
      const mtime = Math.trunc(lstatSync(absolute).mtimeMs);
      return Number.isFinite(mtime) && mtime > 0 ? `${url}?v=${mtime}` : url;
    } catch {
      return url;
    }
  }
  return undefined;
}

/**
 * Safe-resolve `/portal-assets/<something>` to an absolute file path. Returns
 * `null` when the request would escape `portalAssetsRoot`, decode-fails, or
 * targets an unwhitelisted extension. The caller decides whether to respond
 * 404 or proceed.
 */
export function resolvePortalAssetFsPath(
  requestPath: string,
  portalAssetsRoot: string,
): string | null {
  if (!requestPath || !requestPath.startsWith(PORTAL_ASSET_ROUTE_PREFIX)) return null;
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(requestPath.slice(PORTAL_ASSET_ROUTE_PREFIX.length));
  } catch {
    return null;
  }
  relativePath = relativePath.replaceAll("\\", "/");
  if (!relativePath) return null;
  if (relativePath.startsWith("/")) return null;
  if (relativePath.split("/").some((segment) => segment === "..")) return null;
  const root = resolve(portalAssetsRoot);
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + pathSep)) return null;
  const ext = extname(absolute).toLowerCase();
  if (!PORTAL_ICON_EXTENSIONS.includes(ext as PortalIconExtension)) return null;
  return absolute;
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const r = resolve(root);
  const f = resolve(filePath);
  return f === r || f.startsWith(r + pathSep);
}

/**
 * Try to serve a `/portal-assets/...` request.
 *
 *   - Returns `false` when the request does not match the asset prefix or fails
 *     safe-resolution (path traversal, unsupported extension, decode failure).
 *     The caller keeps dispatching — this mirrors {@link tryServePortal}'s
 *     existing semantics so the global handler can issue its own 404.
 *   - Returns `true` after writing a 404 when the request is well-formed but
 *     the file is missing on disk.
 *   - Returns `true` after writing a 200 with the file body on success.
 */
export function tryServePortalAsset(
  res: ServerResponse,
  requestPath: string,
  portalAssetsRoot: string,
): boolean {
  if (!requestPath.startsWith(PORTAL_ASSET_ROUTE_PREFIX)) return false;
  const absolute = resolvePortalAssetFsPath(requestPath, portalAssetsRoot);
  if (!absolute) return false;
  if (!existsSync(absolute) || !statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
    sendText(res, 404, "portal asset not found");
    return true;
  }
  const realRoot = tryRealpath(portalAssetsRoot);
  const realAsset = tryRealpath(absolute);
  if (!realRoot || !realAsset || !isPathInsideRoot(realAsset, realRoot)) return false;
  sendBuffer(res, 200, mimeForPath(absolute), readFileSync(absolute), {
    "Cache-Control": "public, max-age=300",
  });
  return true;
}
