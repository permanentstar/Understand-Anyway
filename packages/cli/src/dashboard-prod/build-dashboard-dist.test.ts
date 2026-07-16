import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashboardDist,
  type BuildDashboardDistDeps,
} from "./build-dashboard-dist.js";

let stateRoot: string;
let pluginRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(resolve(tmpdir(), "ua-dist-state-"));
  pluginRoot = mkdtempSync(resolve(tmpdir(), "ua-dist-plugin-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(pluginRoot, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
  pid = 9001;
}

function fakeSpawn(exit: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null }) {
  const child = new FakeChild();
  return {
    spawn: vi.fn(() => {
      queueMicrotask(() => child.emit("close", exit.code, exit.signal));
      return child as unknown as ChildProcess;
    }),
    child,
  };
}

function makeDeps(overrides: Partial<BuildDashboardDistDeps> = {}): BuildDashboardDistDeps {
  return {
    log: vi.fn(),
    pnpmBin: "fake-pnpm",
    ...overrides,
  };
}

describe("buildDashboardDist", () => {
  it("reuses an existing populated dashboard-dist by default", async () => {
    const distDir = resolve(stateRoot, "dashboard-dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, "index.html"), "<html></html>");

    const { spawn } = fakeSpawn();
    const result = await buildDashboardDist(pluginRoot, stateRoot, makeDeps({ spawn: spawn as never }));
    expect(result.reused).toBe(true);
    expect(result.distDir).toBe(distDir);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rebuilds when --force is set even if dist exists", async () => {
    const distDir = resolve(stateRoot, "dashboard-dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, "old.txt"), "old");

    const events: string[] = [];
    const { spawn } = fakeSpawn();
    const fakePatchDeps = makeFakePatchDeps(() => events.push("patch"));
    const cp = vi.fn();
    const rm = vi.fn();
    await buildDashboardDist(pluginRoot, stateRoot, makeDeps({
      spawn: spawn as never,
      cpSync: cp as never,
      rmSync: rm as never,
      existsSync: () => true,
      readdirSync: () => ["index.html"] as never,
      patchDeps: fakePatchDeps,
      force: true,
    }));
    expect(events).toEqual(["patch"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(cp).toHaveBeenCalled();
    // rm removes the existing dist before copy.
    expect(rm).toHaveBeenCalled();
  });

  it("builds when dist is missing", async () => {
    const events: string[] = [];
    const { spawn } = fakeSpawn();
    const cp = vi.fn();
    const result = await buildDashboardDist(pluginRoot, stateRoot, makeDeps({
      spawn: spawn as never,
      cpSync: cp as never,
      existsSync: ((p: unknown) => /package\.json|packages|homepage|builtdist/.test(String(p))) as never,
      readdirSync: () => [] as never,
      patchDeps: makeFakePatchDeps(() => events.push("patch")),
    }));
    expect(result.reused).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(cp).toHaveBeenCalledTimes(1);
    expect(result.patchId).toBe("dashboard-viewport-v2");
  });

  it("installs dashboard-dist under current/ when a versioned project state exists", async () => {
    mkdirSync(resolve(stateRoot, "current"), { recursive: true });

    const { spawn } = fakeSpawn();
    const cp = vi.fn();
    const result = await buildDashboardDist(pluginRoot, stateRoot, makeDeps({
      spawn: spawn as never,
      cpSync: cp as never,
      existsSync: ((p: unknown) => {
        const path = String(p);
        return path === resolve(stateRoot, "current")
          || /package\.json|packages|homepage/.test(path);
      }) as never,
      readdirSync: () => [] as never,
      patchDeps: makeFakePatchDeps(),
    }));

    const expectedDist = resolve(stateRoot, "current", "dashboard-dist");
    expect(result.distDir).toBe(expectedDist);
    expect(cp).toHaveBeenCalledWith(
      expect.stringContaining("/packages/dashboard/dist"),
      expectedDist,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("builds dashboard workspace dependencies before building the dashboard package", async () => {
    const child = new FakeChild();
    const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child as unknown as ChildProcess;
    });

    await buildDashboardDist(pluginRoot, stateRoot, makeDeps({
      spawn: spawn as never,
      existsSync: ((p: unknown) => /package\.json|packages|homepage|builtdist/.test(String(p))) as never,
      readdirSync: () => [] as never,
      cpSync: vi.fn() as never,
      patchDeps: makeFakePatchDeps(),
    }));

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "fake-pnpm",
      ["--filter", "@understand-anything/dashboard^...", "build"],
      expect.objectContaining({ cwd: pluginRoot, stdio: "inherit" }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "fake-pnpm",
      ["-C", expect.stringContaining("/packages/dashboard"), "build"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("rejects when spawn fails to launch", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT pnpm")));
      return child as unknown as ChildProcess;
    });
    await expect(buildDashboardDist(pluginRoot, stateRoot, makeDeps({
      spawn: spawn as never,
      existsSync: () => false,
      readdirSync: () => [] as never,
      patchDeps: makeFakePatchDeps(),
    }))).rejects.toThrow(/ENOENT pnpm/);
  });

  it("rejects when the build exits non-zero", async () => {
    const { spawn } = fakeSpawn({ code: 1, signal: null });
    await expect(buildDashboardDist(pluginRoot, stateRoot, makeDeps({
      spawn: spawn as never,
      existsSync: () => false,
      readdirSync: () => [] as never,
      patchDeps: makeFakePatchDeps(),
    }))).rejects.toThrow(/dashboard workspace dependency build failed/);
  });

  it("rejects when the build succeeds but produces no dist output", async () => {
    const { spawn } = fakeSpawn();
    await expect(buildDashboardDist(pluginRoot, stateRoot, makeDeps({
      spawn: spawn as never,
      // dashboard-dist absent AND post-build dist absent.
      existsSync: () => false,
      readdirSync: () => [] as never,
      patchDeps: makeFakePatchDeps(),
    }))).rejects.toThrow(/produced no output/);
  });
});

/**
 * Fake DashboardPatchDeps that satisfies preparePatchedUpstreamPluginRoot
 * without touching the real filesystem. All injected stubs are no-ops; the
 * onCall hook lets tests count invocations.
 */
function makeFakePatchDeps(onCall?: () => void): NonNullable<BuildDashboardDistDeps["patchDeps"]> {
  return {
    cpSync: (() => { onCall?.(); }) as never,
    existsSync: (() => false) as never,
    mkdirSync: (() => {}) as never,
    readFileSync: ((path: unknown) => {
      if (String(path).endsWith("package.json")) return JSON.stringify({ version: "1.2.3" });
      // Provide minimal anchorless source — but we want patches to succeed.
      // Return strings whose anchors are present using the known anchors.
      return STUB_SOURCES.get(String(path).split("/").pop() ?? "") ?? "";
    }) as never,
    readdirSync: (() => []) as never,
    rmSync: (() => {}) as never,
    symlinkSync: (() => {}) as never,
    writeFileSync: (() => {}) as never,
    now: () => new Date("2026-06-23T00:00:00Z"),
    log: () => {},
  };
}

const STUB_SOURCES = new Map<string, string>([
  [
    "GraphView.tsx",
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
