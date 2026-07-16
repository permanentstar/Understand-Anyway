import { describe, expect, it, vi } from "vitest";
import {
  PATCH_ID,
  patchGraphViewSource,
  patchAppSource,
  patchCodeViewerSource,
  patchSearchBarSource,
  patchStoreSource,
  preparePatchedUpstreamPluginRoot,
  replaceOnce,
} from "./dashboard-patch.js";

const GRAPHVIEW_ANCHORS = [
  "} as const;\n\n// ── Helper components that must live inside <ReactFlow> ────────────────\n",
  "/** Centers the graph on the selected node (e.g. from search). */\nfunction SelectedNodeFitView()",
  "  const activeLayerId = useDashboardStore((s) => s.activeLayerId);\n  const selectNode = useDashboardStore((s) => s.selectNode);\n  const drillIntoLayer = useDashboardStore((s) => s.drillIntoLayer);\n  const focusNodeId = useDashboardStore((s) => s.focusNodeId);\n",
  "  const { fitView, getViewport, setCenter } = useReactFlow();\n",
  "  useEffect(() => {\n    if (!pendingFitRef.current) return;\n    if (nodes.length === 0) return;\n    pendingFitRef.current = false;",
  "  // Focus: when focusNodeId resolves to a node inside a container, expand it.",
  "        fitViewOptions={{ minZoom: 0.01, padding: 0.1 }}\n        minZoom={0.01}\n",
  "        <TourFitView />\n        <SelectedNodeFitView />\n",
];

describe("replaceOnce", () => {
  it("replaces an exact match once", () => {
    expect(replaceOnce("hello world", "world", "earth", "x")).toBe("hello earth");
  });
  it("throws when the anchor is missing — error mentions PATCH_ID + label", () => {
    try {
      replaceOnce("nope", "missing", "x", "the-label");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain(PATCH_ID);
      expect((err as Error).message).toContain("the-label");
    }
  });
});

describe("patchGraphViewSource", () => {
  it("throws on the first missing anchor", () => {
    expect(() => patchGraphViewSource("totally unrelated source")).toThrow(/anchor not found/);
  });

  it("ports the upstream-anchor coverage that deploy expects (smoke)", () => {
    // We don't need a real GraphView source: just confirm the function names
    // each anchor it expects, so an upstream rename surfaces immediately
    // by missing-anchor rather than silent regression.
    const fnSrc = patchGraphViewSource.toString();
    for (const anchor of GRAPHVIEW_ANCHORS) {
      expect(fnSrc).toContain(JSON.stringify(anchor.slice(0, 40)).slice(1, -1));
    }
  });
});

describe("patchSearchBarSource", () => {
  it("throws on the first missing anchor", () => {
    expect(() => patchSearchBarSource("totally unrelated source")).toThrow(/anchor not found/);
  });
});

describe("patchAppSource", () => {
  it("routes dashboard data URLs through /project/<id>/ when mounted under the portal gateway", () => {
    const source = "  const path = `/${fileName}`;\n  return token ? `${path}?token=${encodeURIComponent(token)}` : path;\n";
    const patched = patchAppSource(source);
    expect(patched).toContain("window.location.pathname.match(/^\\/project\\/[^/]+/)");
    expect(patched).toContain("const path = `${routePrefix}/${fileName}`;");
  });
});

describe("patchCodeViewerSource", () => {
  it("routes file-content URLs through /project/<id>/ when mounted under the portal gateway", () => {
    const source = "  return `/file-content.json?${params.toString()}`;\n";
    const patched = patchCodeViewerSource(source);
    expect(patched).toContain("window.location.pathname.match(/^\\/project\\/[^/]+/)");
    expect(patched).toContain("return `${routePrefix}/file-content.json?${");
  });
});

describe("patchStoreSource", () => {
  it("throws on the first missing anchor", () => {
    expect(() => patchStoreSource("totally unrelated source")).toThrow(/anchor not found/);
  });

  it("adds semantic-search wiring to the patched store", () => {
    const source = [
      "function buildGraphIndexes(graph: KnowledgeGraph): {\n  nodesById: Map<string, GraphNode>;\n  nodeIdToLayerId: Map<string, string>;\n  nodeIdToLayerIds: Map<string, Set<string>>;\n} {\n  const nodesById = new Map<string, GraphNode>();\n  for (const node of graph.nodes) nodesById.set(node.id, node);\n  const nodeIdToLayerId = new Map<string, string>();\n  const nodeIdToLayerIds = new Map<string, Set<string>>();\n  for (const layer of graph.layers) {\n    for (const nid of layer.nodeIds) {\n      if (!nodeIdToLayerId.has(nid)) nodeIdToLayerId.set(nid, layer.id);\n      let set = nodeIdToLayerIds.get(nid);\n      if (!set) {\n        set = new Set<string>();\n        nodeIdToLayerIds.set(nid, set);\n      }\n      set.add(layer.id);\n    }\n  }\n  return { nodesById, nodeIdToLayerId, nodeIdToLayerIds };\n}\n",
      "  navigateToNodeInLayer: (nodeId) => {\n    const { graph, selectedNodeId, nodeHistory, nodeIdToLayerId } = get();\n    if (!graph) return;\n    const layerId = nodeIdToLayerId.get(nodeId) ?? null;\n    const newHistory =\n      selectedNodeId && nodeId !== selectedNodeId\n        ? [...nodeHistory, selectedNodeId].slice(-MAX_HISTORY)\n        : nodeHistory;\n    if (layerId) {\n      set({\n        navigationLevel: \"layer-detail\",\n        activeLayerId: layerId,\n        selectedNodeId: nodeId,\n        focusNodeId: null,\n        codeViewerOpen: false,\n        codeViewerNodeId: null,\n        codeViewerExpanded: false,\n        nodeHistory: newHistory,\n      });\n    } else {\n      set({\n        selectedNodeId: nodeId,\n        nodeHistory: newHistory,\n      });\n    }\n  },\n",
      "  setSearchMode: (mode) => set({ searchMode: mode }),\n",
      "  setSearchQuery: (query) => {\n    const engine = get().searchEngine;\n    const mode = get().searchMode;\n    if (!engine || !query.trim()) {\n      set({ searchQuery: query, searchResults: [] });\n      return;\n    }\n    // Currently both modes use the same fuzzy engine\n    // When embeddings are available, \"semantic\" mode will use SemanticSearchEngine\n    void mode;\n    const searchResults = engine.search(query);\n    set({ searchQuery: query, searchResults });\n  },\n",
    ].join("");

    const patched = patchStoreSource(source);
    expect(patched).toContain("/semantic-search?token=");
    expect(patched).toContain("new URLSearchParams(window.location.search).get(\"token\")");
    expect(patched).toContain("const token = queryToken || storedToken || \"\"");
    expect(patched).toContain("setSearchMode: (mode) => {");
  });
});

describe("preparePatchedUpstreamPluginRoot — anchor failure surfaces with PATCH_ID + version", () => {
  it("wraps the inner error with the patchId and upstream version", () => {
    const fakeFs = {
      cpSync: vi.fn(),
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn((path: unknown) => {
        if (String(path).endsWith("package.json")) return JSON.stringify({ version: "9.9.9" });
        // Anchorless source — first patch will throw.
        return "no anchors here";
      }),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
      symlinkSync: vi.fn(),
      writeFileSync: vi.fn(),
      log: vi.fn(),
    };

    expect(() =>
      preparePatchedUpstreamPluginRoot("/fake/plugin", "/fake/state", fakeFs as never),
    ).toThrow(new RegExp(`dashboard patch ${PATCH_ID} failed against upstream version 9\\.9\\.9`));
  });

  it("symlinks workspace node_modules through the upstream realpath", () => {
    const fakeFs = {
      cpSync: vi.fn(),
      existsSync: vi.fn((path: unknown) => {
        const p = String(path);
        return p === "/link/plugin/packages"
          || p === "/real/plugin/packages"
          || p === "/link/plugin/node_modules"
          || p === "/real/plugin/node_modules"
          || p === "/link/plugin/packages/dashboard/node_modules"
          || p === "/real/plugin/packages/dashboard/node_modules";
      }),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn((path: unknown) => {
        if (String(path).endsWith("package.json")) return JSON.stringify({ version: "1.2.3" });
        return "no anchors here";
      }),
      readdirSync: vi.fn((path: unknown) => {
        if (String(path).endsWith("/packages")) {
          return [{ name: "dashboard", isDirectory: () => true }];
        }
        return [];
      }),
      realpathSync: vi.fn((path: unknown) => (String(path) === "/link/plugin" ? "/real/plugin" : String(path))),
      rmSync: vi.fn(),
      symlinkSync: vi.fn(),
      writeFileSync: vi.fn(),
      log: vi.fn(),
    };

    expect(() =>
      preparePatchedUpstreamPluginRoot("/link/plugin", "/fake/state", fakeFs as never),
    ).toThrow(/anchor not found/);
    expect(fakeFs.symlinkSync).toHaveBeenCalledWith(
      "/real/plugin/node_modules",
      "/fake/state/.understand-anything/understand-anything-plugin-patched/node_modules",
      "dir",
    );
    expect(fakeFs.symlinkSync).toHaveBeenCalledWith(
      "/real/plugin/packages/dashboard/node_modules",
      "/fake/state/.understand-anything/understand-anything-plugin-patched/packages/dashboard/node_modules",
      "dir",
    );
  });

  it("writes patch metadata when patches succeed (smoke; injects fixture sources)", () => {
    const sources = new Map<string, string>([
      [
        "GraphView.tsx",
        // Stub source that contains every GraphView anchor verbatim.
        "" +
          "} as const;\n\n// ── Helper components that must live inside <ReactFlow> ────────────────\n" +
          "/** Centers the graph on the selected node (e.g. from search). */\nfunction SelectedNodeFitView() {\n  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);\n  const { fitView } = useReactFlow();\n  const prevRef = useRef<string | null>(null);\n\n  useEffect(() => {\n    if (selectedNodeId && selectedNodeId !== prevRef.current) {\n      // Delay slightly so this runs after any layer-level fitView triggered\n      // by navigateToNodeInLayer (which also changes activeLayerId).\n      const timer = setTimeout(() => {\n        fitView({\n          nodes: [{ id: selectedNodeId }],\n          duration: 500,\n          padding: 0.3,\n          maxZoom: 1.2,\n          minZoom: 0.01,\n        });\n      }, 100);\n      prevRef.current = selectedNodeId;\n      return () => clearTimeout(timer);\n    }\n    prevRef.current = selectedNodeId;\n  }, [selectedNodeId, fitView]);\n\n  return null;\n}\n" +
          "  const activeLayerId = useDashboardStore((s) => s.activeLayerId);\n  const selectNode = useDashboardStore((s) => s.selectNode);\n  const drillIntoLayer = useDashboardStore((s) => s.drillIntoLayer);\n  const focusNodeId = useDashboardStore((s) => s.focusNodeId);\n" +
          "  const { fitView, getViewport, setCenter } = useReactFlow();\n" +
          "  useEffect(() => {\n    if (!pendingFitRef.current) return;\n    if (nodes.length === 0) return;\n    pendingFitRef.current = false;\n    // One frame so React Flow has positioned the nodes before fit.\n    const raf = requestAnimationFrame(() => {\n      fitView({ duration: 400, padding: 0.2 });\n    });\n    return () => cancelAnimationFrame(raf);\n  }, [nodes, fitView]);\n" +
          "  // Focus: when focusNodeId resolves to a node inside a container, expand it.\n  // Reading expandContainer is stable (Zustand setter); intentionally omitting\n  // expandedContainers from deps so focus changes are the only trigger.\n  useEffect(() => {\n    if (!focusNodeId || !nodeToContainer) return;\n    const cid = nodeToContainer.get(focusNodeId);\n    // Self-maps mean ungrouped nodes have cid === focusNodeId — skip those.\n    if (cid && cid !== focusNodeId) expandContainer(cid);\n  }, [focusNodeId, nodeToContainer, expandContainer]);\n" +
          "        fitViewOptions={{ minZoom: 0.01, padding: 0.1 }}\n        minZoom={0.01}\n" +
          "        <TourFitView />\n        <SelectedNodeFitView />\n",
      ],
      [
          "App.tsx",
          "  const path = `/${fileName}`;\n  return token ? `${path}?token=${encodeURIComponent(token)}` : path;\n",
        ],
      [
        "CodeViewer.tsx",
        "  return `/file-content.json?${params.toString()}`;\n",
      ],
      [
        "SearchBar.tsx",
        "" +
          'import { useCallback, useEffect, useMemo, useRef, useState } from "react";\n' +
          "  const [dropdownOpen, setDropdownOpen] = useState(false);\n  const containerRef = useRef<HTMLDivElement>(null);\n  const inputRef = useRef<HTMLInputElement>(null);\n" +
          "  const nodeMap = useMemo(\n    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),\n    [graph],\n  );\n\n  const topResults = searchResults.slice(0, 5);\n" +
          "  const topResults = searchResults.slice(0, 5);\n\n  const handleInputChange = useCallback(\n    (e: React.ChangeEvent<HTMLInputElement>) => {\n      setSearchQuery(e.target.value);\n      setDropdownOpen(true);\n    },\n    [setSearchQuery],\n  );\n" +
          "  const showDropdown = dropdownOpen && searchQuery.trim() && topResults.length > 0;\n" +
          "          value={searchQuery}\n" +
          "        {searchQuery.trim() && (\n" +
          '                {/* Node name */}\n                <span className="text-sm text-text-primary truncate flex-1">\n                  {node.name}\n                </span>',
      ],
      [
        "store.ts",
        "" +
          "function buildGraphIndexes(graph: KnowledgeGraph): {\n  nodesById: Map<string, GraphNode>;\n  nodeIdToLayerId: Map<string, string>;\n  nodeIdToLayerIds: Map<string, Set<string>>;\n} {\n  const nodesById = new Map<string, GraphNode>();\n  for (const node of graph.nodes) nodesById.set(node.id, node);\n  const nodeIdToLayerId = new Map<string, string>();\n  const nodeIdToLayerIds = new Map<string, Set<string>>();\n  for (const layer of graph.layers) {\n    for (const nid of layer.nodeIds) {\n      if (!nodeIdToLayerId.has(nid)) nodeIdToLayerId.set(nid, layer.id);\n      let set = nodeIdToLayerIds.get(nid);\n      if (!set) {\n        set = new Set<string>();\n        nodeIdToLayerIds.set(nid, set);\n      }\n      set.add(layer.id);\n    }\n  }\n  return { nodesById, nodeIdToLayerId, nodeIdToLayerIds };\n}\n" +
          "  navigateToNodeInLayer: (nodeId) => {\n    const { graph, selectedNodeId, nodeHistory, nodeIdToLayerId } = get();\n    if (!graph) return;\n    const layerId = nodeIdToLayerId.get(nodeId) ?? null;\n    const newHistory =\n      selectedNodeId && nodeId !== selectedNodeId\n        ? [...nodeHistory, selectedNodeId].slice(-MAX_HISTORY)\n        : nodeHistory;\n    if (layerId) {\n      set({\n        navigationLevel: \"layer-detail\",\n        activeLayerId: layerId,\n        selectedNodeId: nodeId,\n        focusNodeId: null,\n        codeViewerOpen: false,\n        codeViewerNodeId: null,\n        codeViewerExpanded: false,\n        nodeHistory: newHistory,\n      });\n    } else {\n      set({\n        selectedNodeId: nodeId,\n        nodeHistory: newHistory,\n      });\n    }\n  },\n" +
          "  setSearchMode: (mode) => set({ searchMode: mode }),\n" +
          "  setSearchQuery: (query) => {\n    const engine = get().searchEngine;\n    const mode = get().searchMode;\n    if (!engine || !query.trim()) {\n      set({ searchQuery: query, searchResults: [] });\n      return;\n    }\n    // Currently both modes use the same fuzzy engine\n    // When embeddings are available, \"semantic\" mode will use SemanticSearchEngine\n    void mode;\n    const searchResults = engine.search(query);\n    set({ searchQuery: query, searchResults });\n  },\n",
      ],
    ]);

    const written = new Map<string, string>();
    const fakeFs = {
      cpSync: vi.fn(),
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn((path: unknown) => {
        const p = String(path);
        if (p.endsWith("package.json")) return JSON.stringify({ version: "1.2.3" });
        if (p.endsWith("/GraphView.tsx")) return sources.get("GraphView.tsx") ?? "";
        if (p.endsWith("/App.tsx")) return sources.get("App.tsx") ?? "";
        if (p.endsWith("/CodeViewer.tsx")) return sources.get("CodeViewer.tsx") ?? "";
        if (p.endsWith("/SearchBar.tsx")) return sources.get("SearchBar.tsx") ?? "";
        if (p.endsWith("/store.ts")) return sources.get("store.ts") ?? "";
        return "";
      }),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
      symlinkSync: vi.fn(),
      writeFileSync: vi.fn((path: unknown, data: unknown) => {
        written.set(String(path), String(data));
      }),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      log: vi.fn(),
    };

    const result = preparePatchedUpstreamPluginRoot("/fake/plugin", "/fake/state", fakeFs as never);
    expect(result.patchId).toBe(PATCH_ID);
    expect(result.upstreamVersion).toBe("1.2.3");
    expect(fakeFs.cpSync).toHaveBeenCalledWith(
      "/fake/plugin",
      "/fake/state/.understand-anything/understand-anything-plugin-patched",
      expect.objectContaining({ dereference: true }),
    );
    expect(result.metadataPath.endsWith("upstream-plugin-patch.json")).toBe(true);
    const metadataRaw = written.get(result.metadataPath);
    expect(metadataRaw).toBeDefined();
    const metadata = JSON.parse(metadataRaw!);
    expect(metadata.patchId).toBe(PATCH_ID);
    expect(metadata.upstreamVersion).toBe("1.2.3");
    expect(metadata.patchedFiles).toEqual([
      "packages/dashboard/src/components/GraphView.tsx",
      "packages/dashboard/src/App.tsx",
      "packages/dashboard/src/components/CodeViewer.tsx",
      "packages/dashboard/src/components/SearchBar.tsx",
      "packages/dashboard/src/store.ts",
    ]);
    expect(metadata.generatedAt).toBe("2026-06-23T00:00:00.000Z");
  });
});
