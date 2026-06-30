/**
 * Portal HTTP handler: serves the portal landing page and (optionally) static
 * portal asset files (branded art) from a directory.
 *
 * Page rendering and view assembly are delegated to {@link renderPortalPage}
 * and {@link assemblePortalView}; asset serving is delegated to
 * {@link tryServePortalAsset} so path-traversal guards, extension whitelisting
 * and Cache-Control live in exactly one place. This module owns request
 * routing only.
 */

import type { ServerResponse } from "node:http";
import { renderPortalPage } from "./portal-render.js";
import { assemblePortalView, type AssemblePortalViewOptions } from "./portal-view.js";
import { PORTAL_ASSET_ROUTE_PREFIX, tryServePortalAsset } from "./portal-icon.js";
import { sendHtml } from "./http.js";

export { PORTAL_ASSET_ROUTE_PREFIX };

export interface PortalServeOptions extends Omit<AssemblePortalViewOptions, "currentProjectId"> {
  /** Resolves the active project id for a given request (e.g. from a cookie). */
  resolveCurrentProjectId?: (requestPath: string) => string | undefined;
  /**
   * Directory holding portal asset files served under /portal-assets/.
   *
   * In two-tier convention deployments this is `<projectsRoot>/gateway/portal-assets/`
   * (also passed as {@link AssemblePortalViewOptions.portalAssetsRoot}); they
   * map to the same directory.
   */
  assetsDir?: string;
  /** Path that renders the portal page. Defaults to "/". */
  portalPath?: string;
}

/**
 * Try to serve a portal route. Returns true when handled, false otherwise.
 */
export function tryServePortal(
  res: ServerResponse,
  requestPath: string,
  options: PortalServeOptions,
): boolean {
  const url = new URL(requestPath, "http://localhost");
  const portalPath = options.portalPath ?? "/";

  if (options.assetsDir && url.pathname.startsWith(PORTAL_ASSET_ROUTE_PREFIX)) {
    return tryServePortalAsset(res, url.pathname, options.assetsDir);
  }

  if (url.pathname !== portalPath) return false;

  const view = assemblePortalView({
    registryPath: options.registryPath,
    currentProjectId: options.resolveCurrentProjectId?.(requestPath),
    title: options.title,
    links: options.links,
    assets: options.assets,
    lang: options.lang,
    wordmarkAlt: options.wordmarkAlt,
    iconUrlFor: options.iconUrlFor,
    projectsConfigPath: options.projectsConfigPath,
    portalAssetsRoot: options.portalAssetsRoot,
    readVersionState: options.readVersionState,
    readProjectsConfig: options.readProjectsConfig,
  });
  sendHtml(res, 200, renderPortalPage(view));
  return true;
}
