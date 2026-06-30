import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { tryServePortal } from "./portal-serve.js";
import { ProjectRegistryStore } from "./project-registry.js";

let dir: string;
let registryPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-portalserve-"));
  registryPath = join(dir, "registry.json");
  assetsDir = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(chunk?: string | Buffer): void;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
}

function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse;
}

describe("tryServePortal", () => {
  it("renders the portal page at the portal path", () => {
    new ProjectRegistryStore(registryPath).upsert("alpha", "/r/a", "/s/a", { name: "Alpha" });
    const res = fakeRes();
    const handled = tryServePortal(asRes(res), "/", { registryPath, title: "My Portal" });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(String(res.body)).toContain("My Portal");
    expect(String(res.body)).toContain("/project/alpha/");
  });

  it("returns false for unrelated paths", () => {
    const res = fakeRes();
    expect(tryServePortal(asRes(res), "/knowledge-graph.json", { registryPath })).toBe(false);
  });

  it("serves a portal asset file", () => {
    writeFileSync(join(assetsDir, "logo.svg"), "<svg></svg>", "utf8");
    const res = fakeRes();
    const handled = tryServePortal(asRes(res), "/portal-assets/logo.svg", {
      registryPath,
      assetsDir,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("image/svg+xml");
  });

  it("404s a missing portal asset", () => {
    const res = fakeRes();
    const handled = tryServePortal(asRes(res), "/portal-assets/missing.png", {
      registryPath,
      assetsDir,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("rejects path traversal in portal assets", () => {
    const res = fakeRes();
    const handled = tryServePortal(asRes(res), "/portal-assets/../secret.svg", {
      registryPath,
      assetsDir,
    });
    expect(handled).toBe(false);
  });

  it("rejects disallowed asset extensions", () => {
    const res = fakeRes();
    const handled = tryServePortal(asRes(res), "/portal-assets/evil.js", {
      registryPath,
      assetsDir,
    });
    expect(handled).toBe(false);
  });
});
