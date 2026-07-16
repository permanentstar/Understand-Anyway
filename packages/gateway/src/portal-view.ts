/**
 * Assemble a neutral {@link PortalView} from the project registry, optionally
 * enriched with metadata from `<projectsRoot>/gateway/config/projects.json` and per-
 * project versioned-state pointers.
 *
 * The view model is deliberately neutral — no in-house multi-project config,
 * no deploy overlay coupling — but two OSS-friendly conveniences live here:
 *
 *   - `projectsConfigPath` lets the assembler honor display fields the operator
 *     maintains in `projects.json` (sortOrder / visible / version /
 *     description / name override). When omitted, registry records are listed
 *     as-is.
 *   - `portalAssetsRoot` lets the assembler resolve Layer 1 icon URLs without
 *     forcing every caller to wire `iconUrlFor` by hand. Callers that need
 *     vendor-supplied branding can still pass `iconUrlFor` to override.
 *
 * `readProjectVersionState` is dependency-injected as `readVersionState` so
 * tests don't need on-disk versioned state to assert the mapping logic.
 */

import {
  buildPublicProjectPath,
  hasProjectDirectProdRuntime,
  hasProjectLiveAccess,
  ProjectRegistryStore,
  type ProjectRegistryRecord,
} from "./project-registry.js";
import { resolveNamedPortalAssetUrl, resolveProjectIconUrl } from "./portal-icon.js";
import {
  readProjectVersionState as defaultReadProjectVersionState,
  type ProjectVersionStateRecord,
} from "./versioning/project-state.js";
import {
  readProjectsConfig as defaultReadProjectsConfig,
  type ProjectsConfig,
  type ProjectsConfigEntry,
} from "./portal-projects-config.js";
import type { PortalAssets, PortalLinkView, PortalProjectView, PortalView } from "./portal-render.js";

export interface AssemblePortalViewOptions {
  /** Registry file path to read project records from. */
  registryPath: string;
  /** Marks the card for the currently active project. */
  currentProjectId?: string;
  title?: string;
  links?: PortalLinkView[];
  assets?: PortalAssets;
  lang?: string;
  wordmarkAlt?: string;
  /** Optional per-record icon URL resolver (overlay-supplied branding). */
  iconUrlFor?: (record: ProjectRegistryRecord) => string | undefined;
  /**
   * Optional `<projectsRoot>/gateway/config/projects.json` path. When present, the
   * matching entry contributes sortOrder / visible filter / display version /
   * name override / description.
   */
  projectsConfigPath?: string;
  /**
   * Optional `<projectsRoot>/gateway/portal-assets/` path. When present and
   * `iconUrlFor` is not supplied, Layer 1 convention lookups
   * (`icons/<projectId>.<ext>`) are used to fill `iconUrl`.
   */
  portalAssetsRoot?: string;
  /**
   * Optional resolver for `<stateRoot>/versioned-state.json`. Defaults to the
   * gateway's built-in reader; tests inject a stub to avoid touching disk.
   */
  readVersionState?: (stateRoot: string) => ProjectVersionStateRecord;
  /** Optional projects-config reader override (for tests). */
  readProjectsConfig?: (configPath: string) => ProjectsConfig;
}

function appendToken(href: string, token: string): string {
  const url = new URL(href, "http://localhost");
  url.searchParams.set("token", token);
  return `${url.pathname}${url.search}${url.hash}`;
}

interface MapOptions {
  currentProjectId?: string;
  iconUrlFor?: AssemblePortalViewOptions["iconUrlFor"];
  configEntry?: ProjectsConfigEntry;
  versionState?: ProjectVersionStateRecord;
}

export function mapRegistryRecordToProjectView(
  record: ProjectRegistryRecord,
  options: MapOptions = {},
): PortalProjectView {
  const baseHref = record.publicPath || buildPublicProjectPath(record.id);
  const href = hasProjectDirectProdRuntime(record) && record.prodToken
    ? appendToken(baseHref, record.prodToken)
    : baseHref;
  const configEntry = options.configEntry;
  const versionState = options.versionState;
  const buildVersion = String(versionState?.currentVersion || "").trim();
  const stableVersion = String(versionState?.stableVersion || "").trim();
  return {
    id: record.id,
    name: configEntry?.name || record.name || record.id,
    href,
    iconUrl: options.iconUrlFor?.(record),
    version: configEntry?.version || undefined,
    buildVersion: buildVersion || undefined,
    buildVersionIsStable: Boolean(buildVersion) && buildVersion === stableVersion,
    live: hasProjectLiveAccess(record),
    current: Boolean(options.currentProjectId) && record.id === options.currentProjectId,
  };
}

interface PortalViewCandidate {
  entry: ProjectsConfigEntry | undefined;
  view: PortalProjectView;
}

function compareProjects(left: PortalViewCandidate, right: PortalViewCandidate): number {
  const leftOrder = Number.isFinite(Number(left.entry?.sortOrder))
    ? Number(left.entry?.sortOrder)
    : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(Number(right.entry?.sortOrder))
    ? Number(right.entry?.sortOrder)
    : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left.view.name || left.view.id).localeCompare(
    String(right.view.name || right.view.id),
  );
}

export function assemblePortalView(options: AssemblePortalViewOptions): PortalView {
  const records = new ProjectRegistryStore(options.registryPath).list();
  const readVersionState = options.readVersionState ?? defaultReadProjectVersionState;
  const readConfig = options.readProjectsConfig ?? defaultReadProjectsConfig;

  const config = options.projectsConfigPath ? readConfig(options.projectsConfigPath) : undefined;
  const entriesById = new Map<string, ProjectsConfigEntry>();
  if (config) {
    for (const entry of config.projects) {
      if (entry?.projectId) entriesById.set(entry.projectId, entry);
    }
  }

  const iconUrlFor: AssemblePortalViewOptions["iconUrlFor"] =
    options.iconUrlFor
      ?? (options.portalAssetsRoot
        ? (record) =>
            resolveProjectIconUrl({
              projectId: record.id,
              portalAssetsRoot: options.portalAssetsRoot,
            })
        : undefined);

  const candidates: PortalViewCandidate[] = [];
  for (const record of records) {
    const configEntry = entriesById.get(record.id);
    if (configEntry?.visible === false) continue;
    let versionState: ProjectVersionStateRecord | undefined;
    try {
      versionState = record.stateRoot ? readVersionState(record.stateRoot) : undefined;
    } catch {
      versionState = undefined;
    }
    const view = mapRegistryRecordToProjectView(record, {
      currentProjectId: options.currentProjectId,
      iconUrlFor,
      configEntry,
      versionState,
    });
    candidates.push({ entry: configEntry, view });
  }

  candidates.sort(compareProjects);

  return {
    title: options.title,
    projects: candidates.map(({ view }) => view),
    links: options.links,
    assets: resolveBrandAssets(options),
    lang: options.lang,
    wordmarkAlt: options.wordmarkAlt,
  };
}

/**
 * Convention names for the neutral brand asset set, resolved as
 * `<portalAssetsRoot>/<name>.<ext>`. Kept in lockstep with the CLI's bundled
 * `assets/portal/` seed files.
 */
const BRAND_ASSET_CONVENTION = {
  pageBackground: "portal-background",
  wordmark: "portal-wordmark",
  footerLeft: "footer-left",
  footerRight: "footer-right",
} as const;

/**
 * Resolve the portal brand assets. Explicit `assets` (overlay-supplied
 * branding) always win and short-circuit the convention scan, keeping the
 * open-source convention fully isolated from injected art. When no explicit
 * assets are given but a `portalAssetsRoot` exists, fill each field from the
 * `portal-assets/<name>.<ext>` convention; fields with no file on disk are
 * omitted so the renderer degrades to gradients / text.
 */
function resolveBrandAssets(options: AssemblePortalViewOptions): PortalAssets | undefined {
  if (options.assets) return options.assets;
  const root = options.portalAssetsRoot;
  if (!root) return undefined;
  const assets: PortalAssets = {};
  for (const [field, baseName] of Object.entries(BRAND_ASSET_CONVENTION)) {
    const url = resolveNamedPortalAssetUrl(root, baseName);
    if (url) assets[field as keyof typeof BRAND_ASSET_CONVENTION] = url;
  }
  return Object.keys(assets).length > 0 ? assets : undefined;
}
