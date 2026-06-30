/**
 * @understand-anyway/gateway
 *
 * Read-only gateway: static dashboard serving + data API (token check + path
 * sanitization) + portal routing under /project/<id>/.
 *
 * Auth is delegated to an AuthProvider (default NoAuthProvider). The dashboard
 * runtime token is separate from auth and always retained.
 *
 * Migration in progress — SSO is extracted into AuthProvider (see AuthGate)
 * before the large dashboard-gateway file is split.
 */

export const GATEWAY_PACKAGE = "@understand-anyway/gateway";

export {
  sendJson,
  sendHtml,
  sendText,
  sendBuffer,
  sendEmpty,
  redirect,
} from "./http.js";
export { MIME_BY_EXT, PORTAL_IMAGE_EXTS, mimeForPath } from "./mime.js";
export {
  isMaintenanceActiveForProject,
  isGlobalMaintenanceActive,
  writeMaintenancePage,
  writeMaintenanceApi,
  writeMaintenanceAsset,
  writeMaintenanceForPath,
  type MaintenanceState,
} from "./maintenance.js";

export { SessionStore, type SessionStoreOptions } from "./session-store.js";
export { AuthGate, type AuthGateOptions, type AuthGateDecision } from "./auth-gate.js";
export { renderDeniedPage, renderLoginRequiredPage } from "./access-pages.js";
export { parseCookies, buildSetCookie, type SetCookieOptions } from "./cookies.js";
export {
  tryServeProdDataApi,
  PROD_DATA_ENDPOINTS,
  type ProdDataApiOptions,
} from "./prod-data-api.js";
export {
  cosineSimilarity,
  SemanticSearchEngine,
  searchSemantically,
  readSemanticSearchArtifacts,
  type SemanticSearchArtifacts,
  type SemanticSearchNode,
  type SemanticSearchResult,
} from "./semantic-search.js";
export { tryServeProdStatic, type ProdStaticOptions } from "./prod-static.js";
export { injectProjectLoadingOverlay } from "./project-loading-overlay.js";
export {
  createGatewayServer,
  startGatewayServer,
  type GatewayServerOptions,
  type RunningGateway,
} from "./server.js";
export {
  renderPortalPage,
  type PortalView,
  type PortalProjectView,
  type PortalLinkView,
  type PortalAssets,
} from "./portal-render.js";
export {
  PUBLIC_PROJECT_ROUTE_PREFIX,
  buildPublicProjectPath,
  parsePublicProjectPath,
  normalizeOrigin,
  createEmptyProjectRegistry,
  validateProjectRegistry,
  ProjectRegistryStore,
  hasProjectDirectProdRuntime,
  hasProjectProxyRuntime,
  hasProjectLiveAccess,
  type ProjectRegistry,
  type ProjectRegistryRecord,
  type ProjectRegistryValidation,
  type ProjectRegistryStoreOptions,
  type ProjectRuntimeMode,
  type UpsertProjectPayload,
  type ParsedPublicProjectPath,
} from "./project-registry.js";
export {
  assemblePortalView,
  mapRegistryRecordToProjectView,
  type AssemblePortalViewOptions,
} from "./portal-view.js";
export {
  PORTAL_ASSET_ROUTE_PREFIX,
  PORTAL_ICON_EXTENSIONS,
  resolveProjectIconUrl,
  resolvePortalAssetFsPath,
  tryServePortalAsset,
  type PortalIconExtension,
  type ResolveProjectIconUrlOptions,
} from "./portal-icon.js";
export {
  createEmptyProjectsConfig,
  readProjectsConfig,
  type ProjectsConfig,
  type ProjectsConfigEntry,
} from "./portal-projects-config.js";
export {
  tryServePortal,
  type PortalServeOptions,
} from "./portal-serve.js";
export {
  tryServeProjectRoute,
  ACTIVE_PROJECT_COOKIE,
  type ProjectRouteOptions,
} from "./project-router.js";
export {
  LocalFileRecordProvider,
  type LocalFileRecordProviderOptions,
} from "./record-local.js";
export {
  CompositeRecordProvider,
  type CompositeRecordProviderOptions,
} from "./record-composite.js";
export {
  LocalFileNotifyProvider,
  type LocalFileNotifyProviderDeps,
} from "./notify-local.js";
export { buildUserEventPayload, type PortalEventInput } from "./portal-events.js";
export {
  appendGatewayAudit,
  buildGatewayAuditPath,
  buildGatewayCurrentLinkPath,
  buildGatewayReleaseDistPath,
  buildGatewayReleaseManifestPath,
  buildGatewayReleasePath,
  buildGatewayReleasesPath,
  buildGatewayRuntimePath,
  buildGatewayStatePath,
  cleanupGatewayReleases,
  createEmptyGatewayState,
  createVersionId,
  isGatewayReleaseReady,
  listGatewayReleaseIds,
  listGatewayReleases,
  normalizeVersionId,
  pointGatewayCurrent,
  publishGatewayVersion,
  readGatewayCurrentLinkTarget,
  readGatewayReleaseManifest,
  readGatewayState,
  rollbackGatewayToStable,
  setStableGatewayVersion,
  writeGatewayState,
  type GatewayPendingAction,
  type GatewayReleaseInfo,
  type GatewayRetentionConfig,
  type GatewayStateRecord,
  type GatewayVersioningDeps,
  type PublishGatewayOptions,
} from "./versioning/state.js";
export {
  appendProjectAudit,
  buildProjectAuditPath,
  buildProjectCurrentLinkPath,
  buildProjectSourceMirrorPath,
  buildProjectSourceMirrorRoot,
  buildProjectStableLinkPath,
  buildProjectVersionDashboardDistPath,
  buildProjectVersionGraphRoot,
  buildProjectVersionPath,
  buildProjectVersionsPath,
  buildProjectVersionStatePath,
  cleanupProjectVersions,
  createEmptyProjectVersionState,
  isProjectVersionReady,
  listProjectVersionIds,
  pointProjectCurrent,
  pointProjectStable,
  readProjectCurrentLinkTarget,
  readProjectStableLinkTarget,
  readProjectVersionState,
  rollbackProjectToStable,
  seedProjectVersion,
  setStableProjectVersion,
  writeProjectVersionState,
  type ProjectVersioningDeps,
  type ProjectVersionRetentionConfig,
  type ProjectVersionStateRecord,
  type SeedProjectVersionOptions,
} from "./versioning/project-state.js";
