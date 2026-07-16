import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedPortalAssets } from "./portal-assets-seed.js";

let dir: string;
let sourceDir: string;
let portalAssetsRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-portal-seed-"));
  sourceDir = join(dir, "bundled");
  portalAssetsRoot = join(dir, "portal-assets");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "portal-background.png"), "BG", "utf8");
  writeFileSync(join(sourceDir, "portal-wordmark.png"), "WM", "utf8");
  writeFileSync(join(sourceDir, "footer-left.png"), "FL", "utf8");
  writeFileSync(join(sourceDir, "footer-right.png"), "FR", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("seedPortalAssets", () => {
  it("copies bundled defaults into an empty portal-assets root", () => {
    const result = seedPortalAssets(portalAssetsRoot, { sourceDir });
    expect(result.seeded.sort()).toEqual(
      ["footer-left.png", "footer-right.png", "portal-background.png", "portal-wordmark.png"],
    );
    expect(readFileSync(join(portalAssetsRoot, "portal-background.png"), "utf8")).toBe("BG");
    expect(existsSync(join(portalAssetsRoot, "footer-right.png"))).toBe(true);
  });

  it("never overwrites an operator-provided asset (any extension variant)", () => {
    mkdirSync(portalAssetsRoot, { recursive: true });
    writeFileSync(join(portalAssetsRoot, "portal-background.svg"), "<svg/>", "utf8");
    const result = seedPortalAssets(portalAssetsRoot, { sourceDir });
    // background already present as .svg → skip; the others still seed.
    expect(result.seeded).not.toContain("portal-background.png");
    expect(existsSync(join(portalAssetsRoot, "portal-background.png"))).toBe(false);
    expect(readFileSync(join(portalAssetsRoot, "portal-background.svg"), "utf8")).toBe("<svg/>");
    expect(existsSync(join(portalAssetsRoot, "portal-wordmark.png"))).toBe(true);
  });

  it("is idempotent — a second run seeds nothing", () => {
    seedPortalAssets(portalAssetsRoot, { sourceDir });
    const second = seedPortalAssets(portalAssetsRoot, { sourceDir });
    expect(second.seeded).toEqual([]);
  });

  it("returns empty when the bundled source dir is absent", () => {
    const result = seedPortalAssets(portalAssetsRoot, { sourceDir: join(dir, "missing") });
    expect(result.seeded).toEqual([]);
    expect(existsSync(portalAssetsRoot)).toBe(false);
  });
});
