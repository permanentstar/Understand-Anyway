/**
 * Dashboard runtime patch — overrides three upstream dashboard sources
 * (GraphView.tsx / SearchBar.tsx / store.ts) to fix viewport / search / nav
 * issues that we have not (yet) upstreamed.
 *
 * Anchor strategy: each patch is `replaceOnce(source, anchor, replacement)`.
 * Anchor failure throws a hard error mentioning PATCH_ID so an upstream rev
 * can't silently regress the dashboard behaviour. This is the explicit choice
 * over silent fallback.
 *
 * Lives in `dashboard-shared/` so both prod (D3) and dev (D3-dev) can reuse
 * the same patch path; `preparePatchedUpstreamPluginRoot` is the only side-
 * effecting entry point and accepts injected fs primitives for tests.
 */

import {
  cpSync as nodeCpSync,
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  realpathSync as nodeRealpathSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  rmSync as nodeRmSync,
  symlinkSync as nodeSymlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

type LogFn = (message: string) => void;

export interface PreparedPatchedUpstreamPluginRoot {
  pluginRoot: string;
  dashboardDir: string;
  metadataPath: string;
  patchId: string;
  upstreamVersion: string;
}

export interface DashboardPatchDeps {
  cpSync?: typeof nodeCpSync;
  existsSync?: typeof nodeExistsSync;
  mkdirSync?: typeof nodeMkdirSync;
  realpathSync?: typeof nodeRealpathSync;
  readFileSync?: typeof nodeReadFileSync;
  readdirSync?: typeof nodeReaddirSync;
  rmSync?: typeof nodeRmSync;
  symlinkSync?: typeof nodeSymlinkSync;
  writeFileSync?: typeof nodeWriteFileSync;
  /** Override the wall clock used in patch metadata (tests). */
  now?: () => Date;
  log?: LogFn;
}

export const PATCH_ID = "dashboard-viewport-v2";
const PATCH_WORKSPACE_DIRNAME = "understand-anything-plugin-patched";
const PATCH_METADATA_FILENAME = "upstream-plugin-patch.json";
const GRAPH_VIEW_RELATIVE_PATH = "packages/dashboard/src/components/GraphView.tsx";
const APP_RELATIVE_PATH = "packages/dashboard/src/App.tsx";
const CODE_VIEWER_RELATIVE_PATH = "packages/dashboard/src/components/CodeViewer.tsx";
const SEARCH_BAR_RELATIVE_PATH = "packages/dashboard/src/components/SearchBar.tsx";
const STORE_RELATIVE_PATH = "packages/dashboard/src/store.ts";
const ROOT_PACKAGE_JSON = "package.json";

function readJsonFile<T>(filePath: string, read: typeof nodeReadFileSync): T {
  return JSON.parse(read(filePath, "utf8")) as T;
}

export function replaceOnce(source: string, search: string, replacement: string, label: string): string {
  if (!source.includes(search)) {
    throw new Error(`dashboard patch ${PATCH_ID} anchor not found: ${label}`);
  }
  return source.replace(search, replacement);
}

function readUpstreamVersion(pluginRoot: string, read: typeof nodeReadFileSync): string {
  const packageJsonPath = resolve(pluginRoot, ROOT_PACKAGE_JSON);
  const packageJson = readJsonFile<{ version?: string }>(packageJsonPath, read);
  return String(packageJson.version || "").trim();
}

function canonicalPluginRoot(pluginRoot: string, realpath: typeof nodeRealpathSync): string {
  try {
    return realpath(pluginRoot);
  } catch {
    return pluginRoot;
  }
}

export function patchGraphViewSource(source: string): string {
  let patched = source;

  patched = replaceOnce(
    patched,
    "} as const;\n\n// ── Helper components that must live inside <ReactFlow> ────────────────\n",
    "} as const;\n\nconst OVERVIEW_MIN_ZOOM = 0.05;\nconst LAYER_ENTRY_MIN_ZOOM = 0.12;\nconst NODE_FIT_MIN_ZOOM = 0.12;\n\n// ── Helper components that must live inside <ReactFlow> ────────────────\n",
    "zoom constants",
  );

  patched = replaceOnce(
    patched,
    "/** Centers the graph on the selected node (e.g. from search). */\nfunction SelectedNodeFitView() {\n  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);\n  const { fitView } = useReactFlow();\n  const prevRef = useRef<string | null>(null);\n\n  useEffect(() => {\n    if (selectedNodeId && selectedNodeId !== prevRef.current) {\n      // Delay slightly so this runs after any layer-level fitView triggered\n      // by navigateToNodeInLayer (which also changes activeLayerId).\n      const timer = setTimeout(() => {\n        fitView({\n          nodes: [{ id: selectedNodeId }],\n          duration: 500,\n          padding: 0.3,\n          maxZoom: 1.2,\n          minZoom: 0.01,\n        });\n      }, 100);\n      prevRef.current = selectedNodeId;\n      return () => clearTimeout(timer);\n    }\n    prevRef.current = selectedNodeId;\n  }, [selectedNodeId, fitView]);\n\n  return null;\n}\n",
    "/** Centers the graph on the active target node after layout settles. */\nfunction SelectedNodeFitView({\n  navigationLevel,\n  activeLayerId,\n  layoutStatus,\n}: {\n  navigationLevel: \"overview\" | \"layer-detail\";\n  activeLayerId: string | null;\n  layoutStatus: \"computing\" | \"ready\";\n}) {\n  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);\n  const focusNodeId = useDashboardStore((s) => s.focusNodeId);\n  const { fitView, getInternalNode } = useReactFlow();\n  const nodes = useNodes();\n  const stage1Tick = useDashboardStore((s) => s.stage1Tick);\n  const fittedKeyRef = useRef<string>(\"\");\n  const fallbackKeyRef = useRef<string>(\"\");\n\n  useEffect(() => {\n    const targetNodeId = focusNodeId || selectedNodeId;\n    if (!targetNodeId) {\n      fittedKeyRef.current = \"\";\n      fallbackKeyRef.current = \"\";\n      return;\n    }\n    if (navigationLevel === \"layer-detail\" && layoutStatus !== \"ready\") return;\n\n    const mode = focusNodeId ? \"focus\" : \"select\";\n    const targetKey = `${mode}:${navigationLevel}:${activeLayerId ?? \"\"}:${stage1Tick}:${targetNodeId}`;\n    if (targetKey === fittedKeyRef.current) return;\n\n    const MAX_FRAMES = 240;\n    let frame = 0;\n    let cancelled = false;\n    let rafId = 0;\n\n    const tick = () => {\n      if (cancelled) return;\n      const internal = getInternalNode(targetNodeId);\n      if (internal?.measured?.width && internal?.measured?.height) {\n        fitView({\n          nodes: [{ id: targetNodeId }],\n          duration: 500,\n          padding: focusNodeId ? 0.28 : 0.24,\n          maxZoom: 1.2,\n          minZoom: NODE_FIT_MIN_ZOOM,\n        });\n        fittedKeyRef.current = targetKey;\n        fallbackKeyRef.current = \"\";\n        return;\n      }\n      if (++frame < MAX_FRAMES) {\n        rafId = requestAnimationFrame(tick);\n        return;\n      }\n      if (fallbackKeyRef.current !== targetKey && nodes.length > 0) {\n        fitView({\n          nodes: nodes.slice(0, 120).map((node) => ({ id: node.id })),\n          duration: 400,\n          padding: 0.2,\n          minZoom: navigationLevel === \"layer-detail\" ? LAYER_ENTRY_MIN_ZOOM : OVERVIEW_MIN_ZOOM,\n        });\n        fallbackKeyRef.current = targetKey;\n      }\n    };\n\n    rafId = requestAnimationFrame(tick);\n    return () => {\n      cancelled = true;\n      cancelAnimationFrame(rafId);\n    };\n  }, [\n    selectedNodeId,\n    focusNodeId,\n    navigationLevel,\n    activeLayerId,\n    layoutStatus,\n    stage1Tick,\n    nodes,\n    fitView,\n    getInternalNode,\n  ]);\n\n  return null;\n}\n",
    "selected node fit view",
  );

  patched = replaceOnce(
    patched,
    "  const activeLayerId = useDashboardStore((s) => s.activeLayerId);\n  const selectNode = useDashboardStore((s) => s.selectNode);\n  const drillIntoLayer = useDashboardStore((s) => s.drillIntoLayer);\n  const focusNodeId = useDashboardStore((s) => s.focusNodeId);\n",
    "  const activeLayerId = useDashboardStore((s) => s.activeLayerId);\n  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);\n  const selectNode = useDashboardStore((s) => s.selectNode);\n  const drillIntoLayer = useDashboardStore((s) => s.drillIntoLayer);\n  const focusNodeId = useDashboardStore((s) => s.focusNodeId);\n",
    "selected node selector in GraphViewInner",
  );

  patched = replaceOnce(
    patched,
    "  const { fitView, getViewport, setCenter } = useReactFlow();\n",
    "  const { fitView, getInternalNode, getViewport, setCenter } = useReactFlow();\n",
    "reactflow accessors in GraphViewInner",
  );

  patched = replaceOnce(
    patched,
    "  useEffect(() => {\n    if (!pendingFitRef.current) return;\n    if (nodes.length === 0) return;\n    pendingFitRef.current = false;\n    // One frame so React Flow has positioned the nodes before fit.\n    const raf = requestAnimationFrame(() => {\n      fitView({ duration: 400, padding: 0.2 });\n    });\n    return () => cancelAnimationFrame(raf);\n  }, [nodes, fitView]);\n",
    "  useEffect(() => {\n    if (!pendingFitRef.current) return;\n    if (nodes.length === 0) return;\n    if (layoutStatus !== \"ready\") return;\n    if (selectedNodeId || focusNodeId) return;\n\n    const MAX_FRAMES = 180;\n    let frame = 0;\n    let cancelled = false;\n    let rafId = 0;\n\n    const tick = () => {\n      if (cancelled) return;\n      const sampleSize = Math.min(nodes.length, 24);\n      let measured = 0;\n      for (let index = 0; index < sampleSize; index += 1) {\n        const internal = getInternalNode(nodes[index].id);\n        if (internal?.measured?.width && internal?.measured?.height) measured += 1;\n      }\n      if (measured >= Math.min(3, sampleSize)) {\n        pendingFitRef.current = false;\n        fitView({\n          duration: 400,\n          padding: 0.2,\n          minZoom: navigationLevel === \"layer-detail\" ? LAYER_ENTRY_MIN_ZOOM : OVERVIEW_MIN_ZOOM,\n        });\n        return;\n      }\n      if (++frame < MAX_FRAMES) {\n        rafId = requestAnimationFrame(tick);\n      }\n    };\n\n    rafId = requestAnimationFrame(tick);\n    return () => {\n      cancelled = true;\n      cancelAnimationFrame(rafId);\n    };\n  }, [nodes, fitView, getInternalNode, layoutStatus, navigationLevel, selectedNodeId, focusNodeId]);\n",
    "layer entry fit view",
  );

  patched = replaceOnce(
    patched,
    "  // Focus: when focusNodeId resolves to a node inside a container, expand it.\n  // Reading expandContainer is stable (Zustand setter); intentionally omitting\n  // expandedContainers from deps so focus changes are the only trigger.\n  useEffect(() => {\n    if (!focusNodeId || !nodeToContainer) return;\n    const cid = nodeToContainer.get(focusNodeId);\n    // Self-maps mean ungrouped nodes have cid === focusNodeId — skip those.\n    if (cid && cid !== focusNodeId) expandContainer(cid);\n  }, [focusNodeId, nodeToContainer, expandContainer]);\n",
    "  // Selection/focus: when the target node resolves to a node inside a\n  // container, expand it so search navigation and focus share the same\n  // viewport prep. Search-owned expansion must not mark pendingFocusContainer:\n  // that lock is for manual expansion and can override the target-node fit.\n  useEffect(() => {\n    const targetNodeId = focusNodeId || selectedNodeId;\n    if (!targetNodeId || !nodeToContainer) return;\n    const cid = nodeToContainer.get(targetNodeId);\n    if (cid && cid !== targetNodeId) {\n      expandContainer(cid);\n      if (navigationLevel === \"overview\") drillIntoLayer(cid);\n    }\n  }, [focusNodeId, selectedNodeId, nodeToContainer, expandContainer, drillIntoLayer, navigationLevel]);\n",
    "selection and focus auto expand",
  );

  patched = replaceOnce(
    patched,
    "        fitViewOptions={{ minZoom: 0.01, padding: 0.1 }}\n        minZoom={0.01}\n",
    "        fitViewOptions={{ minZoom: OVERVIEW_MIN_ZOOM, padding: 0.1 }}\n        minZoom={OVERVIEW_MIN_ZOOM}\n",
    "reactflow min zoom",
  );

  patched = replaceOnce(
    patched,
    "        <TourFitView />\n        <SelectedNodeFitView />\n",
    "        <TourFitView />\n        <SelectedNodeFitView\n          layoutStatus={layoutStatus}\n          navigationLevel={navigationLevel}\n          activeLayerId={activeLayerId}\n        />\n",
    "selected node fit usage",
  );

  return patched;
}

export function patchSearchBarSource(source: string): string {
  let patched = source;

  patched = replaceOnce(
    patched,
    "import { useCallback, useEffect, useMemo, useRef, useState } from \"react\";\n",
    "import { useCallback, useEffect, useMemo, useRef, useState } from \"react\";\n\nconst SEARCH_INPUT_DEBOUNCE_MS = 200;\n",
    "search debounce constant",
  );

  patched = replaceOnce(
    patched,
    "  const [dropdownOpen, setDropdownOpen] = useState(false);\n  const containerRef = useRef<HTMLDivElement>(null);\n  const inputRef = useRef<HTMLInputElement>(null);\n",
    "  const [dropdownOpen, setDropdownOpen] = useState(false);\n  const [inputValue, setInputValue] = useState(searchQuery);\n  const containerRef = useRef<HTMLDivElement>(null);\n  const inputRef = useRef<HTMLInputElement>(null);\n",
    "search bar local input state",
  );

  patched = replaceOnce(
    patched,
    "  const topResults = searchResults.slice(0, 5);\n\n  const handleInputChange = useCallback(\n    (e: React.ChangeEvent<HTMLInputElement>) => {\n      setSearchQuery(e.target.value);\n      setDropdownOpen(true);\n    },\n    [setSearchQuery],\n  );\n",
    "  const topResults = searchResults.slice(0, 5);\n\n  useEffect(() => {\n    setInputValue(searchQuery);\n  }, [searchQuery]);\n\n  useEffect(() => {\n    if (inputValue === searchQuery) return;\n    const timer = window.setTimeout(() => {\n      setSearchQuery(inputValue);\n    }, SEARCH_INPUT_DEBOUNCE_MS);\n    return () => window.clearTimeout(timer);\n  }, [inputValue, searchQuery, setSearchQuery]);\n\n  const handleInputChange = useCallback(\n    (e: React.ChangeEvent<HTMLInputElement>) => {\n      setInputValue(e.target.value);\n      setDropdownOpen(true);\n    },\n    [],\n  );\n",
    "search debounce effects",
  );

  patched = replaceOnce(
    patched,
    "  const showDropdown = dropdownOpen && searchQuery.trim() && topResults.length > 0;\n",
    "  const showDropdown = dropdownOpen && inputValue.trim() && topResults.length > 0;\n",
    "search dropdown visibility uses local input",
  );

  patched = replaceOnce(
    patched,
    "          value={searchQuery}\n",
    "          value={inputValue}\n",
    "search input value uses local state",
  );

  patched = replaceOnce(
    patched,
    "        {searchQuery.trim() && (\n",
    "        {inputValue.trim() && (\n",
    "search summary visibility uses local input",
  );

  patched = replaceOnce(
    patched,
    "  const nodeMap = useMemo(\n    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),\n    [graph],\n  );\n\n  const topResults = searchResults.slice(0, 5);\n",
    "  const nodeMap = useMemo(\n    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),\n    [graph],\n  );\n\n  const sourceMap = useMemo(() => {\n    const map = new Map<string, string>();\n    if (!graph) return map;\n    const parentMap = new Map<string, string>();\n    for (const edge of graph.edges) {\n      if (edge.type === \"contains\") {\n        const parent = nodeMap.get(edge.source);\n        if (parent) parentMap.set(edge.target, parent.name);\n      }\n    }\n    for (const node of graph.nodes) {\n      const source = node.filePath || parentMap.get(node.id);\n      if (source) map.set(node.id, source);\n    }\n    return map;\n  }, [graph, nodeMap]);\n\n  const topResults = searchResults.slice(0, 5);\n",
    "search result source map",
  );

  patched = replaceOnce(
    patched,
    "                {/* Node name */}\n                <span className=\"text-sm text-text-primary truncate flex-1\">\n                  {node.name}\n                </span>",
    "                {/* Node name */}\n                <span className=\"flex-1 min-w-0\">\n                  <span className=\"text-sm text-text-primary truncate block\">\n                    {node.name}\n                  </span>\n                  {sourceMap.get(result.nodeId) && (\n                    <span className=\"text-[10px] text-text-muted truncate block\">\n                      {sourceMap.get(result.nodeId)}\n                    </span>\n                  )}\n                </span>",
    "search result show source",
  );

  return patched;
}

export function patchAppSource(source: string): string {
  return replaceOnce(
    source,
    "  const path = `/${fileName}`;\n  return token ? `${path}?token=${encodeURIComponent(token)}` : path;\n",
    "  const match = window.location.pathname.match(/^\\/project\\/[^/]+/);\n  const routePrefix = match ? match[0] : \"\";\n  const path = `${routePrefix}/${fileName}`;\n  return token ? `${path}?token=${encodeURIComponent(token)}` : path;\n",
    "App.tsx dashboard data url respects project route prefix",
  );
}

export function patchCodeViewerSource(source: string): string {
  return replaceOnce(
    source,
    "  return `/file-content.json?${params.toString()}`;\n",
    "  const match = window.location.pathname.match(/^\\/project\\/[^/]+/);\n  const routePrefix = match ? match[0] : \"\";\n  return `${routePrefix}/file-content.json?${params.toString()}`;\n",
    "CodeViewer file-content URL respects project route prefix",
  );
}

export function patchStoreSource(source: string): string {
  let patched = source;

  patched = replaceOnce(
    patched,
    "function buildGraphIndexes(graph: KnowledgeGraph): {\n  nodesById: Map<string, GraphNode>;\n  nodeIdToLayerId: Map<string, string>;\n  nodeIdToLayerIds: Map<string, Set<string>>;\n} {\n  const nodesById = new Map<string, GraphNode>();\n  for (const node of graph.nodes) nodesById.set(node.id, node);\n  const nodeIdToLayerId = new Map<string, string>();\n  const nodeIdToLayerIds = new Map<string, Set<string>>();\n  for (const layer of graph.layers) {\n    for (const nid of layer.nodeIds) {\n      if (!nodeIdToLayerId.has(nid)) nodeIdToLayerId.set(nid, layer.id);\n      let set = nodeIdToLayerIds.get(nid);\n      if (!set) {\n        set = new Set<string>();\n        nodeIdToLayerIds.set(nid, set);\n      }\n      set.add(layer.id);\n    }\n  }\n  return { nodesById, nodeIdToLayerId, nodeIdToLayerIds };\n}\n",
    "function buildGraphIndexes(graph: KnowledgeGraph): {\n  nodesById: Map<string, GraphNode>;\n  nodeIdToLayerId: Map<string, string>;\n  nodeIdToLayerIds: Map<string, Set<string>>;\n} {\n  const nodesById = new Map<string, GraphNode>();\n  for (const node of graph.nodes) nodesById.set(node.id, node);\n  const nodeIdToLayerId = new Map<string, string>();\n  const nodeIdToLayerIds = new Map<string, Set<string>>();\n\n  const addLayerMembership = (nodeId: string, layerId: string) => {\n    if (!nodeIdToLayerId.has(nodeId)) nodeIdToLayerId.set(nodeId, layerId);\n    let set = nodeIdToLayerIds.get(nodeId);\n    if (!set) {\n      set = new Set<string>();\n      nodeIdToLayerIds.set(nodeId, set);\n    }\n    set.add(layerId);\n  };\n\n  for (const layer of graph.layers) {\n    for (const nid of layer.nodeIds) addLayerMembership(nid, layer.id);\n  }\n\n  // LLM semantic layers are file-oriented. Search results can be classes or\n  // functions, so inherit layer membership through contains edges from the\n  // parent file/class. This lets navigateToNodeInLayer drill into the correct\n  // layer for sub-file symbols instead of leaving them selected off-canvas.\n  let changed = true;\n  while (changed) {\n    changed = false;\n    for (const edge of graph.edges) {\n      if (edge.type !== \"contains\") continue;\n      const parentLayers = nodeIdToLayerIds.get(edge.source);\n      if (!parentLayers || parentLayers.size === 0) continue;\n      for (const layerId of parentLayers) {\n        const before = nodeIdToLayerIds.get(edge.target)?.size ?? 0;\n        addLayerMembership(edge.target, layerId);\n        const after = nodeIdToLayerIds.get(edge.target)?.size ?? 0;\n        if (after > before) changed = true;\n      }\n    }\n  }\n\n  return { nodesById, nodeIdToLayerId, nodeIdToLayerIds };\n}\n",
    "store graph indexes include contained symbols",
  );

  patched = replaceOnce(
    patched,
    "  navigateToNodeInLayer: (nodeId) => {\n    const { graph, selectedNodeId, nodeHistory, nodeIdToLayerId } = get();\n    if (!graph) return;\n    const layerId = nodeIdToLayerId.get(nodeId) ?? null;\n    const newHistory =\n      selectedNodeId && nodeId !== selectedNodeId\n        ? [...nodeHistory, selectedNodeId].slice(-MAX_HISTORY)\n        : nodeHistory;\n    if (layerId) {\n      set({\n        navigationLevel: \"layer-detail\",\n        activeLayerId: layerId,\n        selectedNodeId: nodeId,\n        focusNodeId: null,\n        codeViewerOpen: false,\n        codeViewerNodeId: null,\n        codeViewerExpanded: false,\n        nodeHistory: newHistory,\n      });\n    } else {\n      set({\n        selectedNodeId: nodeId,\n        nodeHistory: newHistory,\n      });\n    }\n  },\n",
    "  navigateToNodeInLayer: (nodeId) => {\n    const { graph, selectedNodeId, nodeHistory, nodeIdToLayerId, nodesById } = get();\n    if (!graph) return;\n    const layerId = nodeIdToLayerId.get(nodeId) ?? null;\n    const targetNode = nodesById.get(nodeId);\n    const showSymbolDetail = targetNode?.type === \"class\" || targetNode?.type === \"function\";\n    const showFunctionDetail = targetNode?.type === \"function\";\n    const newHistory =\n      selectedNodeId && nodeId !== selectedNodeId\n        ? [...nodeHistory, selectedNodeId].slice(-MAX_HISTORY)\n        : nodeHistory;\n    if (layerId) {\n      set({\n        navigationLevel: \"layer-detail\",\n        activeLayerId: layerId,\n        selectedNodeId: nodeId,\n        // Symbol nodes are often deep inside large containers. Search should\n        // reuse the same narrowed graph path as the manual Focus action so the\n        // target materializes reliably instead of waiting on the full container.\n        focusNodeId: showSymbolDetail ? nodeId : null,\n        codeViewerOpen: false,\n        codeViewerNodeId: null,\n        codeViewerExpanded: false,\n        nodeHistory: newHistory,\n        ...(showSymbolDetail ? { detailLevel: \"class\" as const } : {}),\n        ...(showFunctionDetail ? { showFunctionsInClassView: true } : {}),\n        containerLayoutCache: new Map(),\n        containerSizeMemory: new Map(),\n        pendingFocusContainer: null,\n      });\n    } else {\n      set({\n        selectedNodeId: nodeId,\n        nodeHistory: newHistory,\n      });\n    }\n  },\n",
    "navigate sub-file symbols into visible detail",
  );

  patched = replaceOnce(
    patched,
    "  setSearchMode: (mode) => set({ searchMode: mode }),\n",
    "  setSearchMode: (mode) => {\n    set({ searchMode: mode });\n    const query = get().searchQuery;\n    if (query.trim()) void get().setSearchQuery(query);\n  },\n",
    "semantic mode switch refreshes current query",
  );

  patched = replaceOnce(
    patched,
    "  setSearchQuery: (query) => {\n    const engine = get().searchEngine;\n    const mode = get().searchMode;\n    if (!engine || !query.trim()) {\n      set({ searchQuery: query, searchResults: [] });\n      return;\n    }\n    // Currently both modes use the same fuzzy engine\n    // When embeddings are available, \"semantic\" mode will use SemanticSearchEngine\n    void mode;\n    const searchResults = engine.search(query);\n    set({ searchQuery: query, searchResults });\n  },\n",
    "  setSearchQuery: (query) => {\n    const engine = get().searchEngine;\n    const mode = get().searchMode;\n    if (!engine || !query.trim()) {\n      set({ searchQuery: query, searchResults: [] });\n      return;\n    }\n    if (mode !== \"semantic\") {\n      const searchResults = engine.search(query);\n      set({ searchQuery: query, searchResults });\n      return;\n    }\n\n    set({ searchQuery: query });\n    const queryToken = new URLSearchParams(window.location.search).get(\"token\");\n    const storedToken = window.sessionStorage.getItem(\"understand-anything-token\");\n    const token = queryToken || storedToken || \"\";\n    const projectMatch = window.location.pathname.match(/^\\/project\\/[^/]+/);\n    const routePrefix = projectMatch ? projectMatch[0] : \"\";\n    const url = `${routePrefix}/semantic-search?token=${encodeURIComponent(token)}`;\n    void fetch(url, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ query }),\n    })\n      .then((res) => (res.ok ? res.json() : null))\n      .then((payload) => {\n        if (get().searchQuery !== query) return;\n        const results = Array.isArray(payload?.results) ? payload.results : [];\n        set({ searchResults: results });\n      })\n      .catch(() => {\n        if (get().searchQuery !== query) return;\n        set({ searchResults: [] });\n      });\n  },\n",
    "semantic search fetch wiring",
  );

  return patched;
}

function applyDashboardPatches(
  patchedRoot: string,
  upstreamVersion: string,
  read: typeof nodeReadFileSync,
  write: typeof nodeWriteFileSync,
): { patchedFiles: string[] } {
  try {
    const graphViewPath = resolve(patchedRoot, GRAPH_VIEW_RELATIVE_PATH);
    const originalSource = read(graphViewPath, "utf8");
    const patchedSource = patchGraphViewSource(originalSource);
    write(graphViewPath, patchedSource, "utf8");
    const appPath = resolve(patchedRoot, APP_RELATIVE_PATH);
    const originalAppSource = read(appPath, "utf8");
    const patchedAppSource = patchAppSource(originalAppSource);
    write(appPath, patchedAppSource, "utf8");
    const codeViewerPath = resolve(patchedRoot, CODE_VIEWER_RELATIVE_PATH);
    const originalCodeViewerSource = read(codeViewerPath, "utf8");
    const patchedCodeViewerSource = patchCodeViewerSource(originalCodeViewerSource);
    write(codeViewerPath, patchedCodeViewerSource, "utf8");
    const searchBarPath = resolve(patchedRoot, SEARCH_BAR_RELATIVE_PATH);
    const originalSearchBarSource = read(searchBarPath, "utf8");
    const patchedSearchBarSource = patchSearchBarSource(originalSearchBarSource);
    write(searchBarPath, patchedSearchBarSource, "utf8");
    const storePath = resolve(patchedRoot, STORE_RELATIVE_PATH);
    const originalStoreSource = read(storePath, "utf8");
    const patchedStoreSource = patchStoreSource(originalStoreSource);
    write(storePath, patchedStoreSource, "utf8");
    return {
      patchedFiles: [
        GRAPH_VIEW_RELATIVE_PATH,
        APP_RELATIVE_PATH,
        CODE_VIEWER_RELATIVE_PATH,
        SEARCH_BAR_RELATIVE_PATH,
        STORE_RELATIVE_PATH,
      ],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `dashboard patch ${PATCH_ID} failed against upstream version ${upstreamVersion || "unknown"}: ${reason}. The patch anchors no longer match this upstream dashboard source; review packages/cli/src/dashboard-shared/dashboard-patch.ts against the new upstream.`,
    );
  }
}

function copyPluginWorkspaceWithoutNodeModules(
  pluginRoot: string,
  patchedRoot: string,
  cp: typeof nodeCpSync,
  rm: typeof nodeRmSync,
  mkdir: typeof nodeMkdirSync,
): void {
  rm(patchedRoot, { recursive: true, force: true });
  mkdir(patchedRoot, { recursive: true });
  cp(pluginRoot, patchedRoot, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (sourcePath) => {
      const relPath = relative(pluginRoot, sourcePath);
      if (!relPath) return true;
      const segments = relPath.split(/[/\\]+/).filter(Boolean);
      if (segments.includes(".git")) return false;
      if (segments.includes("node_modules")) return false;
      return true;
    },
  });
}

function ensureSymlinkedDir(
  sourcePath: string,
  targetPath: string,
  rm: typeof nodeRmSync,
  mkdir: typeof nodeMkdirSync,
  symlink: typeof nodeSymlinkSync,
): void {
  rm(targetPath, { recursive: true, force: true });
  mkdir(dirname(targetPath), { recursive: true });
  symlink(sourcePath, targetPath, "dir");
}

function collectNodeModuleDirectories(
  pluginRoot: string,
  exists: typeof nodeExistsSync,
  readdir: typeof nodeReaddirSync,
): string[] {
  const relPaths = ["node_modules"];
  const packagesDir = resolve(pluginRoot, "packages");
  if (exists(packagesDir)) {
    for (const entry of readdir(packagesDir, { withFileTypes: true })) {
      if (typeof entry === "object" && "isDirectory" in entry && !entry.isDirectory()) continue;
      const name = typeof entry === "string" ? entry : entry.name;
      const relPath = `packages/${name}/node_modules`;
      if (exists(resolve(pluginRoot, relPath))) relPaths.push(relPath);
    }
  }
  const homepageNodeModules = resolve(pluginRoot, "homepage", "node_modules");
  if (exists(homepageNodeModules)) relPaths.push("homepage/node_modules");
  return relPaths;
}

function linkWorkspaceNodeModules(
  pluginRoot: string,
  patchedRoot: string,
  exists: typeof nodeExistsSync,
  readdir: typeof nodeReaddirSync,
  rm: typeof nodeRmSync,
  mkdir: typeof nodeMkdirSync,
  symlink: typeof nodeSymlinkSync,
): void {
  for (const relPath of collectNodeModuleDirectories(pluginRoot, exists, readdir)) {
    ensureSymlinkedDir(resolve(pluginRoot, relPath), resolve(patchedRoot, relPath), rm, mkdir, symlink);
  }
}

export function preparePatchedUpstreamPluginRoot(
  pluginRoot: string,
  stateRoot: string,
  deps: DashboardPatchDeps = {},
): PreparedPatchedUpstreamPluginRoot {
  const cp = deps.cpSync ?? nodeCpSync;
  const exists = deps.existsSync ?? nodeExistsSync;
  const mkdir = deps.mkdirSync ?? nodeMkdirSync;
  const realpath = deps.realpathSync ?? nodeRealpathSync;
  const read = deps.readFileSync ?? nodeReadFileSync;
  const readdir = deps.readdirSync ?? nodeReaddirSync;
  const rm = deps.rmSync ?? nodeRmSync;
  const symlink = deps.symlinkSync ?? nodeSymlinkSync;
  const write = deps.writeFileSync ?? nodeWriteFileSync;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  const resolvedPluginRoot = canonicalPluginRoot(pluginRoot, realpath);
  const upstreamVersion = readUpstreamVersion(resolvedPluginRoot, read);
  const uaDir = resolve(stateRoot, ".understand-anything");
  const patchedRoot = resolve(uaDir, PATCH_WORKSPACE_DIRNAME);
  mkdir(uaDir, { recursive: true });

  copyPluginWorkspaceWithoutNodeModules(resolvedPluginRoot, patchedRoot, cp, rm, mkdir);
  linkWorkspaceNodeModules(resolvedPluginRoot, patchedRoot, exists, readdir, rm, mkdir, symlink);
  const { patchedFiles } = applyDashboardPatches(patchedRoot, upstreamVersion, read, write);

  const metadataPath = resolve(uaDir, PATCH_METADATA_FILENAME);
  write(
    metadataPath,
    JSON.stringify(
      {
        patchId: PATCH_ID,
        upstreamVersion,
        upstreamPluginRoot: resolvedPluginRoot,
        patchedPluginRoot: patchedRoot,
        patchedFiles,
        generatedAt: now().toISOString(),
        upstreamCandidates: [
          "focus viewport recenter after container auto-expand",
          "large layer initial zoom floor",
          "search input debounce for large graphs",
          "sub-file symbol navigation inherits file layer membership",
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  log(`dashboard patch ${PATCH_ID} prepared at ${patchedRoot}`);

  return {
    pluginRoot: patchedRoot,
    dashboardDir: resolve(patchedRoot, "packages/dashboard"),
    metadataPath,
    patchId: PATCH_ID,
    upstreamVersion,
  };
}
