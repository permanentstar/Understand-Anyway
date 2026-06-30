/**
 * Maintenance window handling for the gateway.
 *
 * When maintenance is active (global, or scoped to specific projects), requests
 * are short-circuited with a 503 in one of three shapes, matched by the same
 * routing taxonomy the prod runtime uses:
 *   - data API path  -> JSON `{ code: "maintenance", ... }` (machine readable)
 *   - static asset    -> plain text (so the SPA's asset loader fails cleanly)
 *   - everything else -> HTML maintenance page
 *
 * State is injected by the caller (read from wherever the deployment keeps it);
 * this module owns only the active-check and the response shapes, reusing the
 * shared response primitives (http.ts) and HTML shell (access-pages.ts).
 */

import type { ServerResponse } from "node:http";
import { sendHtml, sendJson, sendText } from "./http.js";
import { page, escapeHtml } from "./access-pages.js";
import { PROD_DATA_ENDPOINTS } from "./prod-data-api.js";

const PROD_ASSET_PREFIX = "/assets/";
const DEFAULT_TITLE = "Under maintenance";
const DEFAULT_MESSAGE = "This service is temporarily unavailable. Please try again later.";

export interface MaintenanceState {
  enabled: boolean;
  /** Global blocks everything; project scopes to {@link projectIds}. */
  scope: "global" | "project";
  /** Project ids affected when scope is "project". */
  projectIds?: string[];
  title?: string | null;
  message?: string | null;
  /** Estimated time of recovery (free-form). */
  eta?: string | null;
  /** Contact hint shown to users. */
  contact?: string | null;
}

/** Whether maintenance applies to a given project (or globally). */
export function isMaintenanceActiveForProject(state: MaintenanceState | null | undefined, projectId: string): boolean {
  if (!state?.enabled) return false;
  if (state.scope === "global") return true;
  return (state.projectIds ?? []).includes(projectId);
}

/** Whether a global maintenance window is active. */
export function isGlobalMaintenanceActive(state: MaintenanceState | null | undefined): boolean {
  return Boolean(state?.enabled && state.scope === "global");
}

function renderMaintenanceBody(state: MaintenanceState): string {
  const message = escapeHtml(state.message || DEFAULT_MESSAGE);
  const eta = state.eta ? `<p>Estimated recovery: <code>${escapeHtml(state.eta)}</code></p>` : "";
  const contact = state.contact ? `<p>Contact: <code>${escapeHtml(state.contact)}</code></p>` : "";
  return `<h1>${escapeHtml(state.title || DEFAULT_TITLE)}</h1>
     <p>${message}</p>
     ${eta}
     ${contact}`;
}

export function writeMaintenancePage(res: ServerResponse, state: MaintenanceState): void {
  sendHtml(res, 503, page(state.title || DEFAULT_TITLE, renderMaintenanceBody(state)));
}

export function writeMaintenanceApi(res: ServerResponse, state: MaintenanceState): void {
  sendJson(res, 503, {
    code: "maintenance",
    title: state.title || DEFAULT_TITLE,
    message: state.message || DEFAULT_MESSAGE,
    eta: state.eta || null,
    contact: state.contact || null,
  });
}

export function writeMaintenanceAsset(res: ServerResponse, state: MaintenanceState): void {
  sendText(res, 503, state.message || DEFAULT_MESSAGE);
}

/**
 * Write the 503 response shape that matches the request path:
 * JSON for data endpoints, plain text for static assets, HTML otherwise.
 */
export function writeMaintenanceForPath(res: ServerResponse, requestPath: string, state: MaintenanceState): void {
  const pathname = new URL(requestPath, "http://localhost").pathname;
  if (PROD_DATA_ENDPOINTS.has(pathname)) {
    writeMaintenanceApi(res, state);
  } else if (pathname.startsWith(PROD_ASSET_PREFIX)) {
    writeMaintenanceAsset(res, state);
  } else {
    writeMaintenancePage(res, state);
  }
}
