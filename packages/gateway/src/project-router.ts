/**
 * Public project routing for `/project/<id>/...`.
 *
 * Single-process model: every project is served in-process via direct prod
 * (the project's own dist + data API, gated by its runtime token). There is no
 * per-project worker process to forward to, so this router does NOT proxy —
 * the `internalUrl`/dev-proxy path from the deploy tool is intentionally
 * dropped here. When a project has no live prod runtime the request is sent
 * back to the portal (portal-first).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "@understand-anyway/plugin-api";
import { buildSetCookie, mergeSetCookieHeader } from "./cookies.js";
import { redirect, sendEmpty, sendJson } from "./http.js";
import {
  buildPublicProjectPath,
  hasProjectDirectProdRuntime,
  parsePublicProjectPath,
  ProjectRegistryStore,
} from "./project-registry.js";
import { tryServeProdDataApi } from "./prod-data-api.js";
import { tryServeProdStatic } from "./prod-static.js";
import { injectProjectLoadingOverlay } from "./project-loading-overlay.js";
import { readSemanticSearchArtifacts, searchSemantically } from "./semantic-search.js";
import {
  isMaintenanceActiveForProject,
  writeMaintenanceForPath,
  type MaintenanceState,
} from "./maintenance.js";

export const ACTIVE_PROJECT_COOKIE = "ua_active_project";
const PROJECT_RUNTIME_TOKEN_COOKIE_PREFIX = "ua_runtime_token_";
const ACTIVE_PROJECT_COOKIE_MAX_AGE = 12 * 60 * 60;

function addTokenToProjectRoute(projectId: string, upstreamPath: string, token: string): string {
  const href = buildPublicProjectPath(projectId, upstreamPath);
  const url = new URL(href, "http://localhost");
  url.searchParams.set("token", token);
  return `${url.pathname}${url.search}${url.hash}`;
}

function rewriteProjectHtmlAssetPaths(html: string, projectId: string): string {
  const prefix = buildPublicProjectPath(projectId).replace(/\/$/, "");
  return html
    .replace(/\b(src|href)="\/(assets\/[^"]+)"/g, `$1="${prefix}/$2"`)
    .replace(/\bhref="\/favicon\.svg"/g, `href="${prefix}/favicon.svg"`);
}

function projectRuntimeTokenCookieName(projectId: string): string {
  const digest = createHash("sha256").update(projectId).digest("hex").slice(0, 16);
  return `${PROJECT_RUNTIME_TOKEN_COOKIE_PREFIX}${digest}`;
}

export interface ProjectRouteOptions {
  /** Path to the project registry JSON file. */
  registryPath: string;
  /** Portal path to redirect to when a project has no live runtime. Defaults to "/". */
  portalPath?: string;
  /** Active-project cookie name. Defaults to ua_active_project. */
  activeProjectCookieName?: string;
  /** Whether to mark the active-project cookie Secure. */
  secureCookies?: boolean;
  /** Current maintenance state; when it covers this project a 503 is served. */
  maintenanceState?: MaintenanceState | null;
  /** Shared embedding provider used by semantic-search endpoints. */
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Try to serve a `/project/<id>/...` request. Returns true when handled
 * (response written), false when the path is not a public project route.
 */
export async function tryServeProjectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  options: ProjectRouteOptions,
): Promise<boolean> {
  const readJsonBody = async (): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  };

  const url = new URL(requestPath, "http://localhost");
  const parsed = parsePublicProjectPath(url.pathname);
  if (!parsed) return false;

  if (isMaintenanceActiveForProject(options.maintenanceState, parsed.projectId)) {
    writeMaintenanceForPath(res, parsed.upstreamPath, options.maintenanceState!);
    return true;
  }

  const portalPath = options.portalPath ?? "/";
  const record = new ProjectRegistryStore(options.registryPath).get(parsed.projectId);

  if (!hasProjectDirectProdRuntime(record)) {
    redirect(res, portalPath);
    return true;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    const cookie = buildSetCookie(options.activeProjectCookieName ?? ACTIVE_PROJECT_COOKIE, parsed.projectId, {
      maxAge: ACTIVE_PROJECT_COOKIE_MAX_AGE,
      sameSite: "Lax",
      secure: options.secureCookies,
    });
    const existing = res.getHeader("Set-Cookie") as string | string[] | undefined;
    res.setHeader("Set-Cookie", mergeSetCookieHeader(existing, cookie));
  }

  const upstreamRequestPath = `${parsed.upstreamPath}${url.search}`;
  if (
    (method === "GET" || method === "HEAD")
    && (parsed.upstreamPath === "/" || parsed.upstreamPath === "/index.html")
    && url.searchParams.get("token") !== record!.prodToken
  ) {
    redirect(res, addTokenToProjectRoute(parsed.projectId, parsed.upstreamPath, record!.prodToken));
    return true;
  }

  if (parsed.upstreamPath === "/semantic-search") {
    if (url.searchParams.get("token") !== record!.prodToken) {
      sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
      return true;
    }
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      const body = await readJsonBody();
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) {
        sendJson(res, 400, { error: "Missing query" });
        return true;
      }
      if (!options.embeddingProvider) {
        sendJson(res, 200, { results: [] });
        return true;
      }
      const artifacts = readSemanticSearchArtifacts(record!.stateRoot);
      if (artifacts.nodes.length === 0 || Object.keys(artifacts.embeddings).length === 0) {
        sendJson(res, 200, { results: [] });
        return true;
      }
      const results = await searchSemantically({
        provider: options.embeddingProvider,
        query,
        nodes: artifacts.nodes,
        embeddings: artifacts.embeddings,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        threshold: typeof body.threshold === "number" ? body.threshold : undefined,
        types: Array.isArray(body.types) ? body.types.filter((item): item is string => typeof item === "string") : undefined,
      });
      sendJson(res, 200, { results });
    } catch {
      sendJson(res, 500, { error: "semantic search failed" });
    }
    return true;
  }

  if (
    tryServeProdDataApi(res, upstreamRequestPath, {
      stateRoot: record!.stateRoot,
      token: record!.prodToken,
      projectRoot: record!.projectRoot || null,
    })
  ) {
    return true;
  }

  if (
    tryServeProdStatic(res, upstreamRequestPath, {
      distDir: record!.prodDistDir,
      token: record!.prodToken,
      runtimeTokenCookieName: projectRuntimeTokenCookieName(parsed.projectId),
      cookieHeader: req.headers.cookie,
      secureCookies: options.secureCookies,
      transformHtml: (html) => injectProjectLoadingOverlay(rewriteProjectHtmlAssetPaths(html, parsed.projectId)),
    })
  ) {
    return true;
  }

  sendEmpty(res, 404);
  return true;
}
