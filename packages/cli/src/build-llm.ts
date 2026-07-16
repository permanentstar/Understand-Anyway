/**
 * Dynamically load the optional LLM provider for the build pipeline.
 *
 * Mirrors build-providers.ts: the open-source CLI never statically imports an
 * in-house LLM package. When LLM analysis is enabled, it loads the provider by
 * package name via `import()` and instantiates it through the well-known
 * factory export (PROVIDER_FACTORY_EXPORTS.llm). The package name comes from
 * `--llm-provider`, `--llm-profile`, or `providers.llm.package`; factory config
 * comes from the effective `providers.llm.config`. When analysis is disabled,
 * no provider is loaded.
 */

import type { LlmProvider, LlmProviderFactory, ProviderEntry, ResolvedConfig } from "@understand-anyway/plugin-api";
import { PROVIDER_FACTORY_EXPORTS } from "@understand-anyway/plugin-api";
import { ArgsError } from "./args.js";
import { createBuiltinLlmProvider } from "./builtin-llm.js";

export interface BuildLlmProviderOptions {
  /** Whether LLM analysis is enabled for this build. */
  enabled: boolean;
  /** Provider package name (CLI override > config). Null = none configured. */
  packageName: string | null;
  /** Resolved deploy config; effective `providers.llm.config` is passed to the factory. */
  config: ResolvedConfig;
  /** Dynamic module loader. Injectable for tests. */
  importModule?: (pkg: string) => Promise<Record<string, unknown>>;
}

export interface ResolvedLlmProfile {
  packageName: string;
  config: ResolvedConfig;
}

const defaultImportModule = (pkg: string): Promise<Record<string, unknown>> =>
  import(pkg) as Promise<Record<string, unknown>>;

export function resolveLlmProfile(config: ResolvedConfig, profileName: string): ResolvedLlmProfile {
  const entry = config.llmProfiles?.[profileName] as ProviderEntry | undefined;
  if (!entry) throw new ArgsError(`unknown --llm-profile: ${profileName}`);
  return {
    packageName: entry.package,
    config: {
      ...config,
      providers: {
        ...config.providers,
        llm: entry,
      },
    },
  };
}

export async function buildLlmProvider(options: BuildLlmProviderOptions): Promise<LlmProvider | undefined> {
  if (!options.enabled) return undefined;

  const packageName = options.packageName ?? options.config.providers?.llm?.package ?? null;
  if (!packageName) {
    throw new ArgsError(
      "--llm-analysis requires an LLM provider package (--llm-provider <pkg>, --llm-profile <name>, or providers.llm.package)",
    );
  }

  const builtin = createBuiltinLlmProvider(packageName, options.config.providers?.llm?.config as Record<string, unknown> ?? {});
  if (builtin) return builtin;

  const importModule = options.importModule ?? defaultImportModule;
  let mod: Record<string, unknown>;
  try {
    mod = await importModule(packageName);
  } catch (err) {
    throw new ArgsError(`failed to load LLM provider package '${packageName}': ${(err as Error).message}`);
  }

  const factory = mod[PROVIDER_FACTORY_EXPORTS.llm];
  if (typeof factory !== "function") {
    throw new ArgsError(`LLM provider package '${packageName}' does not export ${PROVIDER_FACTORY_EXPORTS.llm}()`);
  }

  return (factory as LlmProviderFactory)(options.config.providers?.llm?.config ?? {});
}
