import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ServerResponse } from "node:http";
import { Socket } from "node:net";
import { isPathInsideRoot, tryServeProdStatic } from "./prod-static.js";

function makeRes(): {
  res: ServerResponse;
  chunks: Buffer[];
  status: () => number;
  header: (name: string) => number | string | string[] | undefined;
} {
  const socket = new Socket();
  const res = new ServerResponse({ method: "GET", url: "/", httpVersionMajor: 1, httpVersionMinor: 1, headers: {} } as any);
  res.assignSocket(socket);
  const chunks: Buffer[] = [];
  const headers: Record<string, number | string | string[] | undefined> = {};
  res.writeHead = ((code: number, values?: Record<string, number | string | string[]>) => {
    res.statusCode = code;
    Object.assign(headers, values ?? {});
    return res;
  }) as any;
  res.write = ((chunk: any) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }) as any;
  res.end = ((chunk?: any) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return res as any;
  }) as any;
  return { res, chunks, status: () => res.statusCode, header: (name: string) => headers[name] ?? res.getHeader(name) };
}

describe("isPathInsideRoot (boundary unit)", () => {
  it("accepts a file strictly under root", () => {
    expect(isPathInsideRoot(`${sep}srv${sep}dist${sep}index.html`, `${sep}srv${sep}dist`)).toBe(true);
  });
  it("accepts root itself", () => {
    expect(isPathInsideRoot(`${sep}srv${sep}dist`, `${sep}srv${sep}dist`)).toBe(true);
  });
  it("rejects a sibling sharing a prefix (the bug this fix targets)", () => {
    // Pre-fix `filePath.startsWith(distDir)` would return TRUE here because
    // `/srv/dist-evil/secret`.startsWith(`/srv/dist`) === true.
    expect(isPathInsideRoot(`${sep}srv${sep}dist-evil${sep}secret.txt`, `${sep}srv${sep}dist`)).toBe(false);
  });
  it("rejects a parent directory", () => {
    expect(isPathInsideRoot(`${sep}srv`, `${sep}srv${sep}dist`)).toBe(false);
  });
});

let workdir: string;
let distDir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ua-prodstatic-"));
  distDir = join(workdir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>dash</title>");
  writeFileSync(join(distDir, "ok.txt"), "hello");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("tryServeProdStatic", () => {
  it("serves a file under distDir", () => {
    const { res, chunks, status } = makeRes();
    const handled = tryServeProdStatic(res, "/ok.txt", { distDir });
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
  });

  it("falls back to index.html for an unknown route", () => {
    const { res, chunks, status } = makeRes();
    const handled = tryServeProdStatic(res, "/some/spa/route", { distDir });
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(Buffer.concat(chunks).toString("utf8")).toContain("<!doctype html>");
  });

    it("redirects direct index requests to append the runtime token when missing", () => {
      const { res, chunks, status, header } = makeRes();
      const handled = tryServeProdStatic(res, "/index.html", { distDir, token: "tok-123" });
      expect(handled).toBe(true);
      expect(status()).toBe(302);
      expect(header("Location")).toBe("/index.html?token=tok-123");
      expect(Buffer.concat(chunks).toString("utf8")).toBe("");
    });

    it("sets a runtime token cookie when serving index with a valid query token", () => {
      const { res, status, header } = makeRes();
      const handled = tryServeProdStatic(res, "/index.html?token=tok-123", { distDir, token: "tok-123" });
      expect(handled).toBe(true);
      expect(status()).toBe(200);
      expect(String(header("Set-Cookie"))).toContain("ua_runtime_token=tok-123");
    });

    it("rejects static assets without the runtime token", () => {
      const { res, chunks, status } = makeRes();
      const handled = tryServeProdStatic(res, "/ok.txt", { distDir, token: "tok-123" });
      expect(handled).toBe(true);
      expect(status()).toBe(403);
      expect(Buffer.concat(chunks).toString("utf8")).not.toContain("hello");
    });

    it("serves static assets when the runtime token cookie is present", () => {
      const { res, chunks, status } = makeRes();
      const handled = tryServeProdStatic(res, "/ok.txt", {
        distDir,
        token: "tok-123",
        cookieHeader: "ua_runtime_token=tok-123",
      });
      expect(handled).toBe(true);
      expect(status()).toBe(200);
      expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
    });

    it("rejects static assets with malformed cookies instead of throwing", () => {
      const { res, chunks, status } = makeRes();
      const handled = tryServeProdStatic(res, "/ok.txt", {
        distDir,
        token: "tok-123",
        cookieHeader: "ua_runtime_token=%",
      });
      expect(handled).toBe(true);
      expect(status()).toBe(403);
      expect(Buffer.concat(chunks).toString("utf8")).not.toContain("hello");
    });

    it("does not serve symlinked files outside distDir", () => {
      const outside = join(workdir, "outside-secret.txt");
      writeFileSync(outside, "OUTSIDE_STATIC_SECRET", "utf8");
      symlinkSync(outside, join(distDir, "linked.txt"));
      const { res, chunks } = makeRes();

      const handled = tryServeProdStatic(res, "/linked.txt", { distDir });

      expect(handled).toBe(false);
      expect(Buffer.concat(chunks).toString("utf8")).toBe("");
    });
});
