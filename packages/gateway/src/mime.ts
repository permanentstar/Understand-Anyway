/**
 * Static asset MIME lookup, shared by static dashboard serving and portal
 * asset serving. One table is the source of truth; callers pick the subset
 * they allow by checking membership before serving.
 */

import { extname } from "node:path";

export const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/** Image extensions allowed for portal branded assets. */
export const PORTAL_IMAGE_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"]);

const DEFAULT_MIME = "application/octet-stream";

/** Resolve a content-type from a file path; falls back to octet-stream. */
export function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? DEFAULT_MIME;
}
