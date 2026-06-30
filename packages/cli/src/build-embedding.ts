import type {
  EmbeddingProvider,
  EmbeddingProviderFactory,
  ResolvedConfig,
} from "@understand-anyway/plugin-api";
import { PROVIDER_FACTORY_EXPORTS } from "@understand-anyway/plugin-api";
import { ArgsError } from "./args.js";

export interface BuildEmbeddingProviderOptions {
  enabled: boolean;
  packageName: string | null;
  config: ResolvedConfig;
  importModule?: (pkg: string) => Promise<Record<string, unknown>>;
}

const defaultImportModule = (pkg: string): Promise<Record<string, unknown>> =>
  import(pkg) as Promise<Record<string, unknown>>;

export async function buildEmbeddingProvider(
  options: BuildEmbeddingProviderOptions,
): Promise<EmbeddingProvider | undefined> {
  if (!options.enabled) return undefined;

  const packageName = options.packageName ?? options.config.providers?.embedding?.package ?? null;
  if (!packageName) {
    throw new ArgsError("--embedding-provider <pkg> required when semantic embeddings are enabled");
  }

  const importModule = options.importModule ?? defaultImportModule;
  let mod: Record<string, unknown>;
  try {
    mod = await importModule(packageName);
  } catch (err) {
    throw new ArgsError(`failed to load embedding provider package '${packageName}': ${(err as Error).message}`);
  }

  const factory = mod[PROVIDER_FACTORY_EXPORTS.embedding];
  if (typeof factory !== "function") {
    throw new ArgsError(
      `embedding provider package '${packageName}' does not export ${PROVIDER_FACTORY_EXPORTS.embedding}()`,
    );
  }

  return (factory as EmbeddingProviderFactory)(options.config.providers?.embedding?.config ?? {});
}
