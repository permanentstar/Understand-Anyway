import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tryServeProdDataApi } from "./prod-data-api.js";

function makeRes(): { res: ServerResponse; body: () => string; status: () => number } {
  const socket = new Socket();
  const res = new ServerResponse({ method: "GET", url: "/", httpVersionMajor: 1, httpVersionMinor: 1, headers: {} } as any);
  res.assignSocket(socket);
  let body = "";
  res.write = ((chunk: any) => {
    if (chunk) body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  }) as any;
  res.end = ((chunk?: any) => {
    if (chunk) body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return res as any;
  }) as any;
  return { res, body: () => body, status: () => res.statusCode };
}

let workdir: string;
let stateRoot: string;
let uaDir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ua-proddata-"));
  stateRoot = join(workdir, "state");
  uaDir = join(stateRoot, ".understand-anything");
  mkdirSync(uaDir, { recursive: true });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("tryServeProdDataApi", () => {
  it("does not read file-content when the knowledge graph is unreadable", () => {
    writeFileSync(join(uaDir, "knowledge-graph.json"), "{not-json", "utf8");
    writeFileSync(join(workdir, "secret.txt"), "SECRET=leaked", "utf8");

    const { res, body, status } = makeRes();
    const handled = tryServeProdDataApi(res, "/file-content.json?token=tok&path=secret.txt", {
      stateRoot,
      token: "tok",
      projectRoot: workdir,
    });

    expect(handled).toBe(true);
    expect(status()).toBe(500);
    expect(body()).not.toContain("SECRET=leaked");
  });

  it("does not treat sibling path prefixes as source-root children", () => {
    writeFileSync(
      join(uaDir, "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "n1", filePath: `${workdir}-old/app.ts` }] }),
      "utf8",
    );

    const { res, body, status } = makeRes();
    const handled = tryServeProdDataApi(res, "/knowledge-graph.json?token=tok", {
      stateRoot,
      token: "tok",
      projectRoot: workdir,
    });

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(JSON.parse(body()).nodes[0].filePath).toBe("app.ts");
  });

  it("does not follow graph-allowed symlinks outside the source root", () => {
    const repoRoot = join(workdir, "repo");
    const outside = join(workdir, "outside-secret.txt");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(outside, "OUTSIDE_SECRET", "utf8");
    symlinkSync(outside, join(repoRoot, "linked-secret.txt"));
    writeFileSync(
      join(uaDir, "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "n1", filePath: join(repoRoot, "linked-secret.txt") }] }),
      "utf8",
    );

    const { res, body, status } = makeRes();
    const handled = tryServeProdDataApi(res, "/file-content.json?token=tok&path=linked-secret.txt", {
      stateRoot,
      token: "tok",
      projectRoot: repoRoot,
    });

    expect(handled).toBe(true);
    expect(status()).toBe(400);
    expect(body()).not.toContain("OUTSIDE_SECRET");
  });

  it("serves file-content from the current version source mirror when available", () => {
    const repoRoot = join(workdir, "repo");
    const versionRoot = join(stateRoot, "versions", "v1");
    const versionUaDir = join(versionRoot, ".understand-anything");
    const mirrorRoot = join(stateRoot, "source-mirror", "v1");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(versionUaDir, { recursive: true });
    mkdirSync(join(mirrorRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "a.txt"), "LIVE_NEW", "utf8");
    writeFileSync(join(mirrorRoot, "src", "a.txt"), "PUBLISHED_OLD", "utf8");
    writeFileSync(join(stateRoot, "versioned-state.json"), JSON.stringify({ currentVersion: "v1" }), "utf8");
    symlinkSync(versionRoot, join(stateRoot, "current"));
    writeFileSync(
      join(versionUaDir, "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "n1", filePath: join(repoRoot, "src", "a.txt") }] }),
      "utf8",
    );

    const { res, body, status } = makeRes();
    const handled = tryServeProdDataApi(res, "/file-content.json?token=tok&path=src/a.txt", {
      stateRoot,
      token: "tok",
      projectRoot: repoRoot,
    });

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(body()).toContain("PUBLISHED_OLD");
    expect(body()).not.toContain("LIVE_NEW");
  });

  it("does not allow currentVersion to escape source-mirror", () => {
    const repoRoot = join(workdir, "repo");
    const versionRoot = join(stateRoot, "versions", "v1");
    const versionUaDir = join(versionRoot, ".understand-anything");
    const outsideMirror = join(workdir, "outside");
    const mirrorRoot = join(stateRoot, "source-mirror");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(versionUaDir, { recursive: true });
    mkdirSync(outsideMirror, { recursive: true });
    mkdirSync(mirrorRoot, { recursive: true });
    writeFileSync(join(repoRoot, "a.txt"), "LIVE_SAFE", "utf8");
    writeFileSync(join(outsideMirror, "a.txt"), "OUTSIDE_SECRET", "utf8");
    writeFileSync(join(mirrorRoot, "a.txt"), "MIRROR_ROOT_SECRET", "utf8");
    writeFileSync(join(stateRoot, "versioned-state.json"), JSON.stringify({ currentVersion: "../../outside" }), "utf8");
    symlinkSync(versionRoot, join(stateRoot, "current"));
    writeFileSync(
      join(versionUaDir, "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "n1", filePath: join(repoRoot, "a.txt") }] }),
      "utf8",
    );

    const { res, body, status } = makeRes();
    const handled = tryServeProdDataApi(res, "/file-content.json?token=tok&path=a.txt", {
      stateRoot,
      token: "tok",
      projectRoot: repoRoot,
    });

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(body()).toContain("LIVE_SAFE");
    expect(body()).not.toContain("OUTSIDE_SECRET");
    expect(body()).not.toContain("MIRROR_ROOT_SECRET");
  });
});
