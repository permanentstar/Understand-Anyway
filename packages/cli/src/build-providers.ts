/**
 * Dynamically assemble the optional gateway providers (auth, org policy) and
 * route options (portal, project route) from a resolved deploy config + flags.
 *
 * Each provider is loaded by package name via `import()` and instantiated
 * through the well-known factory export (PROVIDER_FACTORY_EXPORTS). The
 * open-source core therefore carries no dependency on — or knowledge of — the
 * concrete in-house provider packages: package names come only from the YAML
 * `providers.*.package` (or a `--*-provider` flag override). Secrets live in
 * the config's `{{ }}` placeholders, resolved before this runs.
 *
 * Layering (CLI > env > profile > base) is done upstream in serve; this module
 * receives the already-resolved package names / toggles / registry on `args`
 * and the factory configs on `deps.config`.
 */

import type {
  AuthProvider,
  AuthProviderFactory,
  OrgPolicyProvider,
  OrgPolicyProviderFactory,
  PortalAssets,
  PortalAssetsContribution,
  PortalAssetsFactory,
  ResolvedConfig,
} from "@understand-anyway/plugin-api";
import { PROVIDER_FACTORY_EXPORTS } from "@understand-anyway/plugin-api";
import type {
  PortalLinkView,
  PortalServeOptions,
  ProjectRouteOptions,
} from "@understand-anyway/gateway";
import { ArgsError, type ServeArgs } from "./args.js";

/** Portal page display config, resolved upstream from profile/base. */
export interface PortalDisplayConfig {
  title?: string;
  links?: PortalLinkView[];
  lang?: string;
  wordmarkAlt?: string;
}

export interface BuildProvidersDeps {
  /** Resolved deploy config (providers + profiles). Injectable for tests. */
  config: ResolvedConfig;
  /** Project registry path, shared by portal + project routing. */
  registryPath: string | null;
  /** Resolved portal display config (title/links/lang/wordmarkAlt). */
  portalDisplay?: PortalDisplayConfig;
  /**
   * `<projectsRoot>/gateway/portal-assets/` for the two-tier portal convention. When
   * supplied (and no `iconUrlFor` overlay is configured), the portal view
   * derives Layer 1 icon URLs from it.
   */
  portalAssetsRoot?: string;
  /**
   * `<projectsRoot>/gateway/config/projects.json` for the two-tier portal convention.
   * When supplied, the portal view honors per-project display fields
   * (sortOrder / visible filter / version / name override / description).
   */
  projectsConfigPath?: string;
  /** Optional relative subdir under `<projectsRoot>/gateway/portal-assets/`. */
  portalAssetsSubdir?: string;
  log?: (message: string) => void;
  /** Dynamic module loader. Injectable for tests. */
  importModule?: (pkg: string) => Promise<Record<string, unknown>>;
}

export interface BuiltProviders {
  authProvider?: AuthProvider;
  orgPolicy?: OrgPolicyProvider;
  portal?: PortalServeOptions;
  projectRoute?: ProjectRouteOptions;
}

const defaultImportModule = (pkg: string): Promise<Record<string, unknown>> =>
  import(pkg) as Promise<Record<string, unknown>>;

async function loadFactory<T>(
  pkg: string,
  exportName: string,
  importModule: (pkg: string) => Promise<Record<string, unknown>>,
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = await importModule(pkg);
  } catch (err) {
    throw new ArgsError(`failed to load provider package '${pkg}': ${(err as Error).message}`);
  }
  const factory = mod[exportName];
  if (typeof factory !== "function") {
    throw new ArgsError(`provider package '${pkg}' does not export ${exportName}()`);
  }
  return factory as T;
}

export async function loadPortalAssetsContribution(
  pkg: string,
  config: unknown,
  importModule: (pkg: string) => Promise<Record<string, unknown>> = defaultImportModule,
): Promise<PortalAssetsContribution> {
  const factory = await loadFactory<PortalAssetsFactory>(
    pkg,
    PROVIDER_FACTORY_EXPORTS.portalAssets,
    importModule,
  );
  return factory(config ?? {});
}

export async function buildProviders(args: ServeArgs, deps: BuildProvidersDeps): Promise<BuiltProviders> {
  const importModule = deps.importModule ?? defaultImportModule;
  const providers = deps.config.providers ?? {};
  const built: BuiltProviders = {};

  const authPackage = args.authProvider ?? providers.auth?.package ?? null;
  if (authPackage) {
    const factory = await loadFactory<AuthProviderFactory>(
      authPackage,
      PROVIDER_FACTORY_EXPORTS.auth,
      importModule,
    );
    built.authProvider = await factory(providers.auth?.config ?? {});
  }

  const orgPolicyPackage = args.orgPolicy ?? providers.orgPolicy?.package ?? null;
  if (orgPolicyPackage) {
    const factory = await loadFactory<OrgPolicyProviderFactory>(
      orgPolicyPackage,
      PROVIDER_FACTORY_EXPORTS.orgPolicy,
      importModule,
    );
    built.orgPolicy = await factory(providers.orgPolicy?.config ?? {});
  }

  if (args.portal) {
    const display = deps.portalDisplay ?? {};
    const portalAssetsPackage = args.portalAssets ?? providers.portalAssets?.package ?? null;
    let assetsDir: string | undefined;
    let assets: PortalAssets | undefined;
    if (portalAssetsPackage) {
      const contribution = await loadPortalAssetsContribution(
        portalAssetsPackage,
        providers.portalAssets?.config,
        importModule,
      );
      assetsDir = contribution.assetsDir;
      assets = contribution.assets;
    }
    const servedAssetsDir = assetsDir ?? deps.portalAssetsRoot;
    built.portal = {
      registryPath: deps.registryPath as string,
      title: display.title,
      links: display.links,
      lang: display.lang,
      wordmarkAlt: display.wordmarkAlt,
      assetsDir: servedAssetsDir,
      assets,
      portalAssetsRoot: deps.portalAssetsRoot,
      portalAssetsSubdir: assetsDir ? undefined : deps.portalAssetsSubdir,
      projectsConfigPath: deps.projectsConfigPath,
    };
  }

  if (args.projectRoute) {
    built.projectRoute = { registryPath: deps.registryPath as string };
  }

  return built;
}
