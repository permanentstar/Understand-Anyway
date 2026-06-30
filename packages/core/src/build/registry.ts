/**
 * Builds the upstream analyzer registry (tree-sitter + language parsers) from a
 * loaded upstream core module. Ported verbatim from deploy `createAnalyzerRegistry`.
 */

export async function createAnalyzerRegistry(core: any): Promise<any> {
  const { TreeSitterPlugin, PluginRegistry, builtinLanguageConfigs, registerAllParsers } = core;
  const tsPlugin = new TreeSitterPlugin(builtinLanguageConfigs.filter((c: any) => c.treeSitter));
  await tsPlugin.init();
  const registry = new PluginRegistry();
  registry.register(tsPlugin);
  registerAllParsers(registry);
  return registry;
}
