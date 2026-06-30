/**
 * Read-only prod static serving for the built dashboard.
 *
 * Serves files from the dashboard dist directory and falls back to index.html
 * for SPA routes. When a runtime token is configured the index fallback
 * appends it (the dashboard runtime token, unrelated to SSO).
 */

import { resolve, sep } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { mimeForPath } from "./mime.js";
import { redirect, sendBuffer, sendHtml, sendText } from "./http.js";
import { buildSetCookie, mergeSetCookieHeader, parseCookies } from "./cookies.js";

export const RUNTIME_TOKEN_COOKIE = "ua_runtime_token";

export interface ProdStaticOptions {
  distDir: string;
  /** Optional runtime token appended to the SPA index fallback redirect. */
  token?: string | null;
  /** Runtime-token cookie name. Defaults to ua_runtime_token for single-project gateways. */
  runtimeTokenCookieName?: string;
  /** Cookie header used to authenticate static asset requests after index load. */
  cookieHeader?: string | null;
  /** Whether to mark the runtime-token cookie Secure. */
  secureCookies?: boolean;
  /** Optional HTML transform applied to the index fallback (e.g. overlay injection). */
  transformHtml?: (html: string) => string;
}

/**
 * True when `filePath` is exactly `root` or strictly nested under it.
 * Defense-in-depth against a stale `startsWith(root)` style check that lets
 * a sibling like `/srv/dist-evil/secret` slip past when root is `/srv/dist`.
 */
export function isPathInsideRoot(filePath: string, root: string): boolean {
  const r = resolve(root);
  const f = resolve(filePath);
  return f === r || f.startsWith(r + sep);
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function requestHasRuntimeToken(requestUrl: URL, options: ProdStaticOptions): boolean {
  if (!options.token) return true;
  if (requestUrl.searchParams.get("token") === options.token) return true;
  const cookieName = options.runtimeTokenCookieName ?? RUNTIME_TOKEN_COOKIE;
  return parseCookies(options.cookieHeader ?? undefined)[cookieName] === options.token;
}

function rememberRuntimeToken(res: ServerResponse, requestUrl: URL, options: ProdStaticOptions): void {
  if (!options.token || requestUrl.searchParams.get("token") !== options.token) return;
  const existing = res.getHeader("Set-Cookie") as string | string[] | undefined;
  const cookieName = options.runtimeTokenCookieName ?? RUNTIME_TOKEN_COOKIE;
  const cookie = buildSetCookie(cookieName, options.token, {
    sameSite: "Lax",
    secure: options.secureCookies,
  });
  res.setHeader("Set-Cookie", mergeSetCookieHeader(existing, cookie));
}

/**
 * Serve a static asset or SPA index fallback. Returns true when handled
 * (response written), false when no dist or path escapes the dist root.
 */
export function tryServeProdStatic(
  res: ServerResponse,
  requestPath: string,
  options: ProdStaticOptions,
): boolean {
  const requestUrl = new URL(requestPath, "http://localhost");
  const root = resolve(options.distDir);
  const filePath = resolve(root, requestUrl.pathname.slice(1));
  if (!isPathInsideRoot(filePath, root)) return false;
  const indexPath = resolve(options.distDir, "index.html");
  const realRoot = tryRealpath(root);
  if (!realRoot) return false;
  const realIndexPath = tryRealpath(indexPath);

  if (filePath === indexPath && options.token && requestUrl.searchParams.get("token") !== options.token) {
    const redirectUrl = new URL(requestPath, "http://localhost");
    redirectUrl.searchParams.set("token", options.token);
    redirect(res, `${redirectUrl.pathname}${redirectUrl.search}`);
    return true;
  }

  if (filePath === indexPath) {
    if (!realIndexPath || !isPathInsideRoot(realIndexPath, realRoot)) return false;
    rememberRuntimeToken(res, requestUrl, options);
    const html = readFileSync(realIndexPath, "utf8");
    sendHtml(res, 200, options.transformHtml ? options.transformHtml(html) : html);
    return true;
  }

  const realFilePath = tryRealpath(filePath);
  if (realFilePath && !isPathInsideRoot(realFilePath, realRoot)) return false;
  if (realFilePath && statSync(realFilePath, { throwIfNoEntry: false })?.isFile()) {
    if (!requestHasRuntimeToken(requestUrl, options)) {
      sendText(res, 403, "Forbidden: missing or invalid token");
      return true;
    }
    rememberRuntimeToken(res, requestUrl, options);
    sendBuffer(res, 200, mimeForPath(realFilePath), readFileSync(realFilePath));
    return true;
  }

  if (!realIndexPath || !isPathInsideRoot(realIndexPath, realRoot)) return false;

  if (options.token && requestUrl.searchParams.get("token") !== options.token) {
    const redirectUrl = new URL(requestPath, "http://localhost");
    redirectUrl.searchParams.set("token", options.token);
    redirect(res, `${redirectUrl.pathname}${redirectUrl.search}`);
    return true;
  }

  rememberRuntimeToken(res, requestUrl, options);
  const html = readFileSync(realIndexPath, "utf8");
  sendHtml(res, 200, options.transformHtml ? options.transformHtml(html) : html);
  return true;
}
