/**
 * Minimal read-only gateway server.
 *
 * Wires the request lifecycle for the open-source core:
 *   healthz -> AuthGate (no-op under NoAuthProvider) -> prod data API
 *   (runtime-token gated) -> semantic search / portal / project routes /
 *   maintenance -> prod static (SPA) -> 404.
 *
 * The dashboard runtime token (data API + static) is independent of SSO and is
 * always enforced regardless of the active AuthProvider. Project routing is
 * direct-prod only; deploy's dev proxy / multi-group proxy path is intentionally
 * excluded from OSS parity scope.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AuthProvider,
  AuthSession,
  EmbeddingProvider,
  OrgPolicyDecision,
  OrgPolicyProvider,
  RecordProvider,
} from "@understand-anyway/plugin-api";
import { NoAuthProvider, AllowAllOrgPolicyProvider, NoopRecordProvider } from "@understand-anyway/plugin-api";
import { buildUserEventPayload, type PortalEventInput } from "./portal-events.js";
import { AuthGate } from "./auth-gate.js";
import { SessionStore } from "./session-store.js";
import { tryServeProdDataApi } from "./prod-data-api.js";
import { tryServeProdStatic } from "./prod-static.js";
import { injectProjectLoadingOverlay } from "./project-loading-overlay.js";
import { tryServePortal, type PortalServeOptions } from "./portal-serve.js";
import { tryServeProjectRoute, type ProjectRouteOptions } from "./project-router.js";
import { parsePublicProjectPath } from "./project-registry.js";
import { renderDeniedPage } from "./access-pages.js";
import {
  isGlobalMaintenanceActive,
  writeMaintenanceForPath,
  type MaintenanceState,
} from "./maintenance.js";
import { sendEmpty, sendHtml, sendJson } from "./http.js";
import { readSemanticSearchArtifacts, searchSemantically } from "./semantic-search.js";

export interface GatewayServerOptions {
  host: string;
  port: number;
  /** State root holding `.understand-anything/` graph artifacts. */
  stateRoot: string;
  /** Dashboard dist directory for static serving. */
  distDir: string;
  /** Per-project dashboard runtime token (NOT auth). */
  runtimeToken: string;
  /** Source repo root used to relativize served graph paths. */
  projectRoot?: string | null;
  /** Auth provider; defaults to NoAuthProvider (allow-all, open-source default). */
  authProvider?: AuthProvider;
  /** Org policy provider; defaults to AllowAllOrgPolicyProvider. Gates /project/<id>/ access. */
  orgPolicy?: OrgPolicyProvider;
  /** Record sink for user/system events; defaults to NoopRecordProvider (no-op). */
  record?: RecordProvider;
  /** Embedding provider used by `/semantic-search`; omitted = semantic search disabled. */
  embeddingProvider?: EmbeddingProvider;
  /** Session cookie name when auth is enabled. */
  sessionCookieName?: string;
  /** Whether to mark the session cookie Secure. */
  secureCookies?: boolean;
  /** Default landing path after login / for root redirects. */
  defaultEntryPath?: string;
  /** When set, the portal landing page (and assets) are served opt-in. */
  portal?: PortalServeOptions;
  /** When set, `/project/<id>/...` routes are served (direct-prod, single process). */
  projectRoute?: ProjectRouteOptions;
  /** Resolves the current maintenance state per request; enables 503 short-circuit. */
  resolveMaintenanceState?: () => MaintenanceState | null | undefined;
  log?: (message: string) => void;
}

export interface RunningGateway {
  server: Server;
  close(): Promise<void>;
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  const provider = options.authProvider ?? new NoAuthProvider();
  const orgPolicy = options.orgPolicy ?? new AllowAllOrgPolicyProvider();
  const record = options.record ?? new NoopRecordProvider();
  const sessions = new SessionStore({ cookieName: options.sessionCookieName ?? "ua_session" });
  const log = options.log ?? (() => {});

  const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  };

  const trackEvent = (
    session: AuthSession | null,
    req: IncomingMessage,
    input: PortalEventInput,
  ): void => {
    void record.write(buildUserEventPayload(session, req, input)).catch((err) => {
      log(`record write failed: ${(err as Error).message}`);
    });
  };

  const orgAuditInput = (decision: OrgPolicyDecision): Pick<
    PortalEventInput,
    "authReason" | "departmentPaths" | "matchedDepartmentPath" | "targetDepartment" | "extra"
  > => {
    const authReason = decision.authReason ?? decision.reason ?? "";
    const extra: Record<string, unknown> = {
      reason: decision.reason ?? authReason,
      authReason,
    };
    if (decision.departmentPaths) extra.departmentPaths = decision.departmentPaths;
    if (decision.matchedDepartmentPath) extra.matchedDepartmentPath = decision.matchedDepartmentPath;
    if (decision.targetDepartment) extra.targetDepartment = decision.targetDepartment;
    return {
      authReason,
      departmentPaths: decision.departmentPaths ?? [],
      matchedDepartmentPath: decision.matchedDepartmentPath ?? [],
      targetDepartment: decision.targetDepartment ?? [],
      extra,
    };
  };

  const authGate = new AuthGate({
    provider,
    sessions,
    defaultEntryPath: options.defaultEntryPath ?? "/",
    secure: options.secureCookies,
    async onLoginSuccess({ req, session }) {
      let orgDecision: OrgPolicyDecision | null = null;
      try {
        orgDecision = await orgPolicy.canAccessProject(session.user, "");
      } catch (err) {
        log(`login org policy audit failed: ${(err as Error).message}`);
      }
      trackEvent(session, req, {
        eventType: "login",
        ...(orgDecision ? orgAuditInput(orgDecision) : {}),
      });
    },
  });

  const isProjectPageNavigation = (req: IncomingMessage, upstreamPath: string): boolean => {
    if ((req.method ?? "GET").toUpperCase() !== "GET") return false;
    if (upstreamPath === "/" || upstreamPath === "/index.html") return true;
    const accept = req.headers.accept;
    const acceptHeader = Array.isArray(accept) ? accept.join(",") : accept ?? "";
    return acceptHeader.toLowerCase().includes("text/html");
  };

  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, auth: provider.name });
      return;
    }

    let session: AuthSession | null = null;
    try {
      const decision = await authGate.handle(req, res, url);
      if (decision.handled) return;
      session = decision.session ?? null;
    } catch (err) {
      log(`auth gate error: ${(err as Error).message}`);
      sendJson(res, 500, { error: "auth failure" });
      return;
    }

    const requestPath = `${url.pathname}${url.search}`;

    const maintenanceState = options.resolveMaintenanceState?.();
    if (isGlobalMaintenanceActive(maintenanceState)) {
      writeMaintenanceForPath(res, requestPath, maintenanceState!);
      return;
    }

    if (options.portal && tryServePortal(res, requestPath, options.portal)) return;

    const projectMatch = parsePublicProjectPath(url.pathname);
    if (projectMatch) {
      const orgDecision = await orgPolicy.canAccessProject(session?.user, projectMatch.projectId);
      const audit = orgAuditInput(orgDecision);
      if (!orgDecision.allowed) {
        trackEvent(session, req, {
          eventType: "authz_denied",
          targetType: "project",
          targetId: projectMatch.projectId,
          targetName: projectMatch.projectId,
          targetUrl: url.pathname,
          ...audit,
        });
        sendHtml(res, 403, orgDecision.html ?? renderDeniedPage(orgDecision.reason));
        return;
      }
      if (options.projectRoute) {
        const shouldTrackProjectView = isProjectPageNavigation(req, projectMatch.upstreamPath);
        const handled = await tryServeProjectRoute(req, res, requestPath, {
          ...options.projectRoute,
          embeddingProvider: options.embeddingProvider,
          maintenanceState: maintenanceState ?? options.projectRoute.maintenanceState,
        });
        if (handled) {
          if (shouldTrackProjectView && res.statusCode >= 200 && res.statusCode < 300) {
            trackEvent(session, req, {
              eventType: "project_view",
              targetType: "project",
              targetId: projectMatch.projectId,
              targetName: projectMatch.projectId,
              targetUrl: url.pathname,
              ...audit,
            });
          }
          return;
        }
      }
    }

    if (options.projectRoute && await tryServeProjectRoute(req, res, requestPath, {
      ...options.projectRoute,
      embeddingProvider: options.embeddingProvider,
      maintenanceState: maintenanceState ?? options.projectRoute.maintenanceState,
    })) return;

    if (tryServeProdDataApi(res, requestPath, {
      stateRoot: options.stateRoot,
      token: options.runtimeToken,
      projectRoot: options.projectRoot ?? null,
    })) return;

    if (url.pathname === "/semantic-search") {
      if (url.searchParams.get("token") !== options.runtimeToken) {
        sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
        return;
      }
      if ((req.method ?? "GET").toUpperCase() !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (!query) {
          sendJson(res, 400, { error: "Missing query" });
          return;
        }
        if (!options.embeddingProvider) {
          sendJson(res, 200, { results: [] });
          return;
        }
        const artifacts = readSemanticSearchArtifacts(options.stateRoot);
        if (artifacts.nodes.length === 0 || Object.keys(artifacts.embeddings).length === 0) {
          sendJson(res, 200, { results: [] });
          return;
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
      } catch (error) {
        log(`semantic search failed: ${(error as Error).message}`);
        sendJson(res, 500, { error: "semantic search failed" });
      }
      return;
    }

    if (tryServeProdStatic(res, requestPath, {
      distDir: options.distDir,
      token: options.runtimeToken,
      cookieHeader: req.headers.cookie,
      secureCookies: options.secureCookies,
      transformHtml: injectProjectLoadingOverlay,
    })) return;

    sendEmpty(res, 404);
  });
}

export function startGatewayServer(options: GatewayServerOptions): Promise<RunningGateway> {
  const server = createGatewayServer(options);
  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(options.port, options.host, () => {
      (options.log ?? (() => {}))(`gateway listening on http://${options.host}:${options.port}`);
      maybeWarnPublicNoAuth(options);
      resolveStart({
        server,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Hosts treated as loopback for the public-no-auth warning. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::", "localhost"]);

/**
 * Print a single stderr WARN when a `no-auth` provider is bound to a
 * non-loopback host. We do NOT refuse to listen — operators may legitimately
 * want this on a trusted LAN — but the situation deserves a visible nudge so
 * nobody discovers it the hard way via copy-pasted example yaml.
 *
 * Goes through `process.stderr` rather than `options.log` so it cannot be
 * silenced by an injected no-op logger.
 */
function maybeWarnPublicNoAuth(options: GatewayServerOptions): void {
  const provider = options.authProvider ?? new NoAuthProvider();
  if (provider.name !== "no-auth") return;
  if (LOOPBACK_HOSTS.has(options.host)) return;
  process.stderr.write(
    `[WARN] gateway: listening on ${options.host}:${options.port} with no auth provider — ` +
      `anyone reachable on this network can read every project's data API. ` +
      `Configure an AuthProvider (e.g. provider-feishu-auth) before exposing it.\n`,
  );
}
