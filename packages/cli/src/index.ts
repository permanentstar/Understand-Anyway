/**
 * @understand-anyway/cli — programmatic entry.
 */

export const CLI_PACKAGE = "@understand-anyway/cli";

export {
  parseArgs,
  helpText,
  ArgsError,
  type ParsedArgs,
  type ServeArgs,
  type HelpArgs,
  type RecordProviderName,
} from "./args.js";
export { runServe, type RunServeOptions } from "./serve.js";
export { buildRecordProvider, type BuildRecordProviderDeps } from "./build-record.js";
export {
  buildProviders,
  type BuildProvidersDeps,
  type BuiltProviders,
  type PortalDisplayConfig,
} from "./build-providers.js";
export {
  loadResolvedConfig,
  selectProfile,
  type LoadConfigDeps,
} from "./config/load.js";
export { discoverConfigPath, type DiscoverDeps } from "./config/discover.js";
export { interpolate, type InterpolateDeps } from "./config/interpolate.js";
export { loadDotenv, parseDotenv, type LoadDotenvDeps } from "./config/dotenv.js";
export { resolveLayered, type LayeredInput } from "./config/layered.js";
export {
  buildDeployConfigPath,
  buildGatewayOperationsRoot,
  buildGatewayRegistryPath,
  buildGatewayRoot,
  buildPortalAssetsRoot,
  buildPortalIconPath,
  buildProjectStateRoot,
  buildProjectsConfigPath,
  copyIconFile,
  expandTemplate,
  IconExtensionError,
  PORTAL_ICON_EXTENSIONS,
  readProjectsConfig,
  resolveTemplatePath,
  resolveTemplateVars,
  upsertEntry,
  withProjectsConfigLock,
  writeProjectsConfigAtomic,
  type CopyIconFileResult,
  type PortalIconExtension,
  type ProjectsConfig,
  type ProjectsConfigEntry,
  type ProjectsConfigTemplateVars,
  type UpsertEntryOptions,
  type UpsertEntryResult,
} from "./projects-config.js";
export {
  resolveProjectContext,
  resolveProjectDistDir,
  resolveProjectsRoot,
  type ProjectContext,
  type ResolveProjectContextOptions,
  type ResolveProjectsRootOptions,
} from "./project-context.js";
