/**
 * Read-only prod data API.
 *
 * Serves the knowledge-graph family of JSON artifacts and a sandboxed
 * file-content endpoint over a shared token. Two invariants matter:
 *   - the dashboard runtime `token` query param gates every data endpoint
 *     (this is NOT auth/SSO — it is the per-project runtime token);
 *   - absolute `node.filePath` values are relativized to the source repo root
 *     so the served graph never leaks host paths.
 */

import {
  basename,
  dirname,
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { sendEmpty, sendJson } from "./http.js";
import { buildProjectSourceMirrorPath, buildProjectSourceMirrorRoot, readProjectVersionState } from "./versioning/project-state.js";
import { normalizeVersionId } from "./versioning/state.js";

export const PROD_DATA_ENDPOINTS = new Set([
  "/knowledge-graph.json",
  "/domain-graph.json",
  "/diff-overlay.json",
  "/meta.json",
  "/config.json",
  "/file-content.json",
]);

const MAX_PREVIEW_BYTES = 1024 * 1024;

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", py: "python",
  go: "go", rs: "rust", java: "java", rb: "ruby", sh: "bash", css: "css",
  html: "markup", md: "markdown", json: "json", yaml: "yaml", yml: "yaml",
  c: "c", cc: "cpp", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
};

export interface ProdDataApiOptions {
  stateRoot: string;
  token: string;
  /** Source repo root used to relativize node.filePath; falls back to a heuristic. */
  projectRoot?: string | null;
}

interface FileContentResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

interface SourceRoots {
  /** Root used to relativize graph node.filePath values into public paths. */
  graphRoot: string;
  /** Root used to read file-content bytes. May be a versioned source mirror. */
  contentRoot: string;
}

function graphFileCandidates(stateRoot: string, fileName: string): string[] {
  // Prefer the versioned `current/` symlink target so prod serves the published
  // version. Fall back to the flat layout for unmigrated / fixture state roots.
  return [
    resolve(stateRoot, "current", ".understand-anything", fileName),
    resolve(stateRoot, ".understand-anything", fileName),
  ];
}

function resolveVersionedSourceMirror(stateRoot: string, graphFile: string): string | null {
  const currentGraphRoot = resolve(stateRoot, "current", ".understand-anything");
  if (graphFile !== currentGraphRoot && !graphFile.startsWith(currentGraphRoot + sep)) return null;
  const state = readProjectVersionState(stateRoot);
  const version = normalizeVersionId(state.currentVersion);
  if (!version) return null;
  const mirrorRoot = buildProjectSourceMirrorRoot(stateRoot);
  const mirrorPath = buildProjectSourceMirrorPath(version, stateRoot);
  const realMirrorRoot = tryRealpath(mirrorRoot);
  const realMirrorPath = tryRealpath(mirrorPath);
  if (!realMirrorRoot || !realMirrorPath) return null;
  if (!isPathInsideRoot(realMirrorPath, realMirrorRoot)) return null;
  return mirrorPath;
}

function resolveGraphRoot(graphFile: string, projectRoot?: string | null): string {
  if (typeof projectRoot === "string" && projectRoot.trim()) return projectRoot;
  return dirname(dirname(graphFile));
}

function resolveSourceRoots(stateRoot: string, graphFile: string, projectRoot?: string | null): SourceRoots {
  const graphRoot = resolveGraphRoot(graphFile, projectRoot);
  const versionedMirror = resolveVersionedSourceMirror(stateRoot, graphFile);
  return { graphRoot, contentRoot: versionedMirror ?? graphRoot };
}

function relativizeFilePath(abs: string, sourceRoot: string): string {
  if (isAbsolute(abs)) {
    const rel = relative(sourceRoot, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  }
  return isAbsolute(abs) ? basename(abs) : abs;
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const r = resolve(root);
  const f = resolve(filePath);
  return f === r || f.startsWith(r + sep);
}

function sanitizeGraphNodes(raw: { nodes?: unknown }, sourceRoot: string): unknown {
  if (!Array.isArray(raw.nodes)) return raw;
  const nodes = raw.nodes.map((node: { filePath?: unknown }) => {
    if (typeof node.filePath !== "string") return node;
    return { ...node, filePath: relativizeFilePath(node.filePath, sourceRoot) };
  });
  return { ...raw, nodes };
}

function readSourceFile(requestedPath: string, stateRoot: string, projectRoot?: string | null): FileContentResult {
  if (!requestedPath) return { statusCode: 400, payload: { error: "Missing path" } };
  if (requestedPath.includes("\0")) return { statusCode: 400, payload: { error: "Invalid path" } };
  if (isAbsolute(requestedPath)) return { statusCode: 400, payload: { error: "Absolute paths are not allowed" } };
  const normalizedPath = normalize(requestedPath);
  if (normalizedPath === "." || normalizedPath.startsWith("..") || isAbsolute(normalizedPath)) {
    return { statusCode: 400, payload: { error: "Path must stay inside the project" } };
  }
  const graphFile = graphFileCandidates(stateRoot, "knowledge-graph.json").find((c) => existsSync(c));
  if (!graphFile) return { statusCode: 404, payload: { error: "No knowledge graph found" } };
  const { graphRoot, contentRoot } = resolveSourceRoots(stateRoot, graphFile, projectRoot);
  const contentFile = resolve(contentRoot, normalizedPath);
  const relativeToContentRoot = relative(contentRoot, contentFile);
  if (!relativeToContentRoot || relativeToContentRoot.startsWith("..") || isAbsolute(relativeToContentRoot)) {
    return { statusCode: 400, payload: { error: "Path must stay inside the project" } };
  }
  const safeRelativePath = normalizedPath.split(sep).join("/");
  try {
    const raw = JSON.parse(readFileSync(graphFile, "utf8")) as { nodes?: { filePath?: unknown }[] };
    const allowedPaths = new Set<string>();
    for (const node of raw.nodes || []) {
      if (typeof node.filePath !== "string") continue;
      const normalized = relativizeFilePath(node.filePath, graphRoot);
      if (normalized) allowedPaths.add(normalized);
    }
    if (!allowedPaths.has(safeRelativePath)) {
      return { statusCode: 404, payload: { error: "File is not in the knowledge graph" } };
    }
  } catch {
    return { statusCode: 500, payload: { error: "Failed to read knowledge graph" } };
  }
  const realSourceRoot = tryRealpath(contentRoot);
  if (!realSourceRoot) return { statusCode: 404, payload: { error: "Source root not found" } };
  const realFile = tryRealpath(contentFile);
  if (!realFile) return { statusCode: 404, payload: { error: "File not found" } };
  const realRelativeToRoot = relative(realSourceRoot, realFile);
  if (!realRelativeToRoot || realRelativeToRoot.startsWith("..") || isAbsolute(realRelativeToRoot)) {
    return { statusCode: 400, payload: { error: "Path must stay inside the project" } };
  }
  let stat;
  try {
    stat = statSync(realFile);
  } catch {
    return { statusCode: 404, payload: { error: "File not found" } };
  }
  if (!stat.isFile()) return { statusCode: 400, payload: { error: "Path is not a file" } };
  if (stat.size > MAX_PREVIEW_BYTES) return { statusCode: 413, payload: { error: "File is too large to preview" } };
  const buffer = readFileSync(realFile);
  if (buffer.includes(0)) return { statusCode: 415, payload: { error: "Binary files cannot be previewed" } };
  const content = buffer.toString("utf8");
  const ext = extname(safeRelativePath).slice(1).toLowerCase();
  return {
    statusCode: 200,
    payload: {
      path: safeRelativePath,
      language: LANGUAGE_BY_EXT[ext] || "text",
      content,
      sizeBytes: buffer.byteLength,
      lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length,
    },
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  sendJson(res, status, body);
}

/**
 * Serve a prod data endpoint. Returns true when the request matched a data
 * endpoint (response written), false otherwise (caller continues routing).
 */
export function tryServeProdDataApi(
  res: ServerResponse,
  requestPath: string,
  options: ProdDataApiOptions,
): boolean {
  const requestUrl = new URL(requestPath, "http://localhost");
  const pathname = requestUrl.pathname;
  if (!PROD_DATA_ENDPOINTS.has(pathname)) return false;

  if (requestUrl.searchParams.get("token") !== options.token) {
    writeJson(res, 403, { error: "Forbidden: missing or invalid token" });
    return true;
  }

  if (pathname === "/file-content.json") {
    const result = readSourceFile(requestUrl.searchParams.get("path") || "", options.stateRoot, options.projectRoot);
    writeJson(res, result.statusCode, result.payload);
    return true;
  }

  if (pathname === "/config.json") {
    const candidate = graphFileCandidates(options.stateRoot, "config.json").find((c) => existsSync(c));
    if (candidate) {
      try {
        writeJson(res, 200, readFileSync(candidate, "utf8"));
      } catch {
        writeJson(res, 500, { error: "Failed to read config file" });
      }
      return true;
    }
    writeJson(res, 200, { autoUpdate: false, outputLanguage: "en" });
    return true;
  }

  const fileName = pathname === "/diff-overlay.json" ? "diff-overlay.json"
    : pathname === "/meta.json" ? "meta.json"
    : pathname === "/domain-graph.json" ? "domain-graph.json"
    : "knowledge-graph.json";
  const candidate = graphFileCandidates(options.stateRoot, fileName).find((c) => existsSync(c));
  if (candidate) {
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as { nodes?: unknown };
      const { graphRoot } = resolveSourceRoots(options.stateRoot, candidate, options.projectRoot);
      writeJson(res, 200, sanitizeGraphNodes(raw, graphRoot));
    } catch {
      writeJson(res, 500, { error: "Failed to read graph file" });
    }
    return true;
  }

  if (pathname === "/knowledge-graph.json") {
    writeJson(res, 404, { error: "No knowledge graph found. Run /understand first." });
  } else {
    sendEmpty(res, 404);
  }
  return true;
}
