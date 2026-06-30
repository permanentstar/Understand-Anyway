import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  PORTAL_ASSET_ROUTE_PREFIX,
  PORTAL_ICON_EXTENSIONS,
  resolvePortalAssetFsPath,
  resolveProjectIconUrl,
  tryServePortalAsset,
} from "./portal-icon.js";

let rootDir: string;
let portalAssetsRoot: string;
let iconsDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "ua-portal-icon-"));
  portalAssetsRoot = join(rootDir, "portal-assets");
  iconsDir = join(portalAssetsRoot, "icons");
  mkdirSync(iconsDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
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

describe("PORTAL_ICON_EXTENSIONS", () => {
  it("matches the documented Layer 1 lookup order", () => {
    expect([...PORTAL_ICON_EXTENSIONS]).toEqual([".svg", ".png", ".webp", ".jpg", ".jpeg"]);
  });
});

describe("resolveProjectIconUrl", () => {
  it("returns undefined when no convention file is on disk (Layer 2)", () => {
    expect(resolveProjectIconUrl({ projectId: "alpha", portalAssetsRoot })).toBeUndefined();
  });

  it("returns undefined when portalAssetsRoot is missing", () => {
    expect(resolveProjectIconUrl({ projectId: "alpha" })).toBeUndefined();
  });

  it("returns undefined when projectId is blank", () => {
    writeFileSync(join(iconsDir, "alpha.svg"), "<svg/>", "utf8");
    expect(resolveProjectIconUrl({ projectId: "", portalAssetsRoot })).toBeUndefined();
  });

  it("hits the highest-priority extension first", () => {
    writeFileSync(join(iconsDir, "alpha.svg"), "<svg/>", "utf8");
    writeFileSync(join(iconsDir, "alpha.png"), "PNG", "utf8");
    const url = resolveProjectIconUrl({ projectId: "alpha", portalAssetsRoot });
    expect(url).toMatch(/^\/portal-assets\/icons\/alpha\.svg\?v=\d+$/);
  });

  it("falls through to the next extension when a higher one is missing", () => {
    writeFileSync(join(iconsDir, "beta.png"), "PNG", "utf8");
    const url = resolveProjectIconUrl({ projectId: "beta", portalAssetsRoot });
    expect(url).toMatch(/^\/portal-assets\/icons\/beta\.png\?v=\d+$/);
  });

  it("encodes the projectId for safe URL embedding", () => {
    writeFileSync(join(iconsDir, "weird id.svg"), "<svg/>", "utf8");
    const url = resolveProjectIconUrl({ projectId: "weird id", portalAssetsRoot });
    expect(url).toMatch(/^\/portal-assets\/icons\/weird%20id\.svg\?v=\d+$/);
  });

  it("uses mtime as the cache-busting query value", () => {
    const file = join(iconsDir, "gamma.svg");
    writeFileSync(file, "<svg/>", "utf8");
    const fixed = new Date(2024, 0, 1);
    utimesSync(file, fixed, fixed);
    const expectedMtime = Math.trunc(fixed.getTime());
    const url = resolveProjectIconUrl({ projectId: "gamma", portalAssetsRoot });
    expect(url).toBe(`/portal-assets/icons/gamma.svg?v=${expectedMtime}`);
  });
});

describe("resolvePortalAssetFsPath", () => {
  it("returns null when the request prefix does not match", () => {
    expect(resolvePortalAssetFsPath("/knowledge-graph.json", portalAssetsRoot)).toBeNull();
  });

  it("rejects path traversal segments", () => {
    expect(
      resolvePortalAssetFsPath(`${PORTAL_ASSET_ROUTE_PREFIX}../secret.svg`, portalAssetsRoot),
    ).toBeNull();
  });

  it("rejects absolute relative paths", () => {
    expect(
      resolvePortalAssetFsPath(`${PORTAL_ASSET_ROUTE_PREFIX}/etc/passwd.svg`, portalAssetsRoot),
    ).toBeNull();
  });

  it("rejects unsupported extensions", () => {
    expect(
      resolvePortalAssetFsPath(`${PORTAL_ASSET_ROUTE_PREFIX}evil.js`, portalAssetsRoot),
    ).toBeNull();
  });

  it("rejects malformed percent encoding", () => {
    expect(
      resolvePortalAssetFsPath(`${PORTAL_ASSET_ROUTE_PREFIX}%E0%A4.svg`, portalAssetsRoot),
    ).toBeNull();
  });

  it("returns the absolute file path for a valid request", () => {
    const abs = resolvePortalAssetFsPath(
      `${PORTAL_ASSET_ROUTE_PREFIX}icons/alpha.svg`,
      portalAssetsRoot,
    );
    expect(abs).toBe(join(iconsDir, "alpha.svg"));
  });
});

describe("tryServePortalAsset", () => {
  it("returns false for non-matching prefixes", () => {
    const res = fakeRes();
    const handled = tryServePortalAsset(asRes(res), "/knowledge-graph.json", portalAssetsRoot);
    expect(handled).toBe(false);
  });

  it("returns false for traversal so the caller can fall through", () => {
    const res = fakeRes();
    const handled = tryServePortalAsset(
      asRes(res),
      `${PORTAL_ASSET_ROUTE_PREFIX}../secret.svg`,
      portalAssetsRoot,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
  });

  it("returns false for unsupported extensions", () => {
    const res = fakeRes();
    const handled = tryServePortalAsset(
      asRes(res),
      `${PORTAL_ASSET_ROUTE_PREFIX}evil.js`,
      portalAssetsRoot,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
  });

  it("writes 404 for a well-formed but missing asset", () => {
    const res = fakeRes();
    const handled = tryServePortalAsset(
      asRes(res),
      `${PORTAL_ASSET_ROUTE_PREFIX}icons/missing.png`,
      portalAssetsRoot,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("serves the file with cache-control on 200", () => {
    writeFileSync(join(iconsDir, "alpha.svg"), "<svg></svg>", "utf8");
    const res = fakeRes();
    const handled = tryServePortalAsset(
      asRes(res),
      `${PORTAL_ASSET_ROUTE_PREFIX}icons/alpha.svg`,
      portalAssetsRoot,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("image/svg+xml");
    expect(res.headers["Cache-Control"]).toBe("public, max-age=300");
    expect(String(res.body)).toBe("<svg></svg>");
  });

    it("does not serve symlinked assets outside portalAssetsRoot", () => {
      const outside = join(rootDir, "outside.svg");
      writeFileSync(outside, "<svg>secret</svg>", "utf8");
      symlinkSync(outside, join(iconsDir, "linked.svg"));
      const res = fakeRes();

      const handled = tryServePortalAsset(
        asRes(res),
        `${PORTAL_ASSET_ROUTE_PREFIX}icons/linked.svg`,
        portalAssetsRoot,
      );

      expect(handled).toBe(false);
      expect(res.statusCode).toBe(0);
      expect(String(res.body)).not.toContain("secret");
    });
});
