import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePortalView, mapRegistryRecordToProjectView } from "./portal-view.js";
import { ProjectRegistryStore, type ProjectRegistryRecord } from "./project-registry.js";
import type { ProjectVersionStateRecord } from "./versioning/project-state.js";
import type { ProjectsConfig } from "./portal-projects-config.js";

let dir: string;
let registryPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-portalview-"));
  registryPath = join(dir, "registry.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<ProjectRegistryRecord> = {}): ProjectRegistryRecord {
  return {
    id: "alpha",
    name: "Alpha",
    projectRoot: "/r/a",
    stateRoot: "/s/a",
    accessUrl: "",
    dashboardUrl: "",
    internalUrl: "",
    publicPath: "",
    runtimeMode: "",
    prodDistDir: "",
    prodToken: "",
    status: "running",
    ...overrides,
  };
}

function emptyVersionState(): ProjectVersionStateRecord {
  return {
    version: 1,
    currentVersion: null,
    stableVersion: null,
    retention: { maxVersions: 1 },
    updatedAt: null,
  };
}

describe("mapRegistryRecordToProjectView", () => {
  it("derives href from publicPath fallback", () => {
    const view = mapRegistryRecordToProjectView(record());
    expect(view.href).toBe("/project/alpha/");
    expect(view.name).toBe("Alpha");
  });

  it("adds the prod runtime token to portal links", () => {
    const view = mapRegistryRecordToProjectView(
      record({
        runtimeMode: "prod",
        prodDistDir: "/dist",
        prodToken: "tok 123",
        publicPath: "/project/alpha/",
      }),
    );
    expect(view.href).toBe("/project/alpha/?token=tok+123");
  });

  it("marks the current project", () => {
    const view = mapRegistryRecordToProjectView(record(), { currentProjectId: "alpha" });
    expect(view.current).toBe(true);
  });

  it("uses injected icon url resolver", () => {
    const view = mapRegistryRecordToProjectView(record(), {
      iconUrlFor: (r) => `/portal-assets/${r.id}.svg`,
    });
    expect(view.iconUrl).toBe("/portal-assets/alpha.svg");
  });

  it("fills display version + buildVersion from supplied state", () => {
    const view = mapRegistryRecordToProjectView(record(), {
      configEntry: { projectId: "alpha", version: "v1.2.3" },
      versionState: {
        ...emptyVersionState(),
        currentVersion: "20260629",
        stableVersion: "20260629",
      },
    });
    expect(view.version).toBe("v1.2.3");
    expect(view.buildVersion).toBe("20260629");
    expect(view.buildVersionIsStable).toBe(true);
  });

  it("marks buildVersion unstable when current differs from stable", () => {
    const view = mapRegistryRecordToProjectView(record(), {
      versionState: {
        ...emptyVersionState(),
        currentVersion: "20260629",
        stableVersion: "20260628",
      },
    });
    expect(view.buildVersionIsStable).toBe(false);
  });

  it("prefers configEntry name over record name", () => {
    const view = mapRegistryRecordToProjectView(record({ name: "RegName" }), {
      configEntry: { projectId: "alpha", name: "Brand Name" },
    });
    expect(view.name).toBe("Brand Name");
  });
});

describe("assemblePortalView", () => {
  function setupRegistry() {
    const store = new ProjectRegistryStore(registryPath);
    store.upsert("alpha", "/r/a", "/s/a", {
      name: "Alpha",
      runtimeMode: "dev",
      accessUrl: "http://localhost:1",
    });
    store.upsert("beta", "/r/b", "/s/b", { name: "Beta" });
    store.upsert("gamma", "/r/g", "/s/g", { name: "Gamma" });
  }

  it("assembles a view from registry records", () => {
    new ProjectRegistryStore(registryPath).upsert("alpha", "/r/a", "/s/a", {
      name: "Alpha",
      runtimeMode: "dev",
      accessUrl: "http://localhost:1",
    });
    new ProjectRegistryStore(registryPath).upsert("beta", "/r/b", "/s/b", { name: "Beta" });
    const view = assemblePortalView({ registryPath, currentProjectId: "beta", title: "T" });
    expect(view.title).toBe("T");
    expect(view.projects.map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(view.projects.find((p) => p.id === "beta")?.current).toBe(true);
    expect(view.projects.find((p) => p.id === "alpha")?.live).toBe(true);
  });

  it("returns empty projects for an empty registry", () => {
    const view = assemblePortalView({ registryPath });
    expect(view.projects).toEqual([]);
  });

  it("filters visible=false entries and respects sortOrder from projects.json", () => {
    setupRegistry();
    const config: ProjectsConfig = {
      version: 1,
      projects: [
        { projectId: "alpha", sortOrder: 30, version: "1.0.0" },
        { projectId: "beta", sortOrder: 10 },
        { projectId: "gamma", sortOrder: 20, visible: false },
      ],
    };
    const view = assemblePortalView({
      registryPath,
      projectsConfigPath: "/ignored.json",
      readProjectsConfig: () => config,
      readVersionState: () => emptyVersionState(),
    });
    expect(view.projects.map((p) => p.id)).toEqual(["beta", "alpha"]);
    expect(view.projects.find((p) => p.id === "alpha")?.version).toBe("1.0.0");
  });

  it("falls back to alphabetical order when sortOrder is missing", () => {
    setupRegistry();
    const view = assemblePortalView({
      registryPath,
      projectsConfigPath: "/ignored.json",
      readProjectsConfig: () => ({ version: 1, projects: [] }),
      readVersionState: () => emptyVersionState(),
    });
    expect(view.projects.map((p) => p.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("resolves icon urls from portalAssetsRoot (Layer 1)", () => {
    new ProjectRegistryStore(registryPath).upsert("alpha", "/r/a", "/s/a", { name: "Alpha" });
    new ProjectRegistryStore(registryPath).upsert("beta", "/r/b", "/s/b", { name: "Beta" });
    const portalAssetsRoot = join(dir, "portal-assets");
    mkdirSync(join(portalAssetsRoot, "icons"), { recursive: true });
    writeFileSync(join(portalAssetsRoot, "icons", "alpha.svg"), "<svg/>", "utf8");
    const view = assemblePortalView({
      registryPath,
      portalAssetsRoot,
      readVersionState: () => emptyVersionState(),
    });
    expect(view.projects.find((p) => p.id === "alpha")?.iconUrl).toMatch(
      /^\/portal-assets\/icons\/alpha\.svg\?v=\d+$/,
    );
    expect(view.projects.find((p) => p.id === "beta")?.iconUrl).toBeUndefined();
  });

  it("resolves icon urls from the configured asset subdir", () => {
    new ProjectRegistryStore(registryPath).upsert("alpha", "/r/a", "/s/a", { name: "Alpha" });
    const portalAssetsRoot = join(dir, "portal-assets");
    mkdirSync(join(portalAssetsRoot, "overlay", "icons"), { recursive: true });
    writeFileSync(join(portalAssetsRoot, "overlay", "icons", "alpha.svg"), "<svg/>", "utf8");
    const view = assemblePortalView({
      registryPath,
      portalAssetsRoot,
      portalAssetsSubdir: "overlay",
      readVersionState: () => emptyVersionState(),
    });
    expect(view.projects[0]?.iconUrl).toMatch(/^\/portal-assets\/overlay\/icons\/alpha\.svg\?v=\d+$/);
  });

  it("prefers explicit iconUrlFor over portalAssetsRoot convention", () => {
    new ProjectRegistryStore(registryPath).upsert("alpha", "/r/a", "/s/a", { name: "Alpha" });
    const portalAssetsRoot = join(dir, "portal-assets");
    mkdirSync(join(portalAssetsRoot, "icons"), { recursive: true });
    writeFileSync(join(portalAssetsRoot, "icons", "alpha.svg"), "<svg/>", "utf8");
    const view = assemblePortalView({
      registryPath,
      portalAssetsRoot,
      iconUrlFor: (r) => `https://cdn.example/${r.id}.png`,
      readVersionState: () => emptyVersionState(),
    });
    expect(view.projects[0]?.iconUrl).toBe("https://cdn.example/alpha.png");
  });

  it("tolerates a readVersionState that throws", () => {
    new ProjectRegistryStore(registryPath).upsert("alpha", "/r/a", "/s/a", { name: "Alpha" });
    const view = assemblePortalView({
      registryPath,
      readVersionState: () => {
        throw new Error("boom");
      },
    });
    expect(view.projects[0]?.buildVersion).toBeUndefined();
    expect(view.projects[0]?.buildVersionIsStable).toBe(false);
  });
});

describe("assemblePortalView brand assets (convention)", () => {
  it("fills pageBackground/wordmark/footer avatars from portalAssetsRoot by convention", () => {
    const portalAssetsRoot = join(dir, "portal-assets");
    mkdirSync(portalAssetsRoot, { recursive: true });
    writeFileSync(join(portalAssetsRoot, "portal-background.png"), "PNG", "utf8");
    writeFileSync(join(portalAssetsRoot, "portal-wordmark.png"), "PNG", "utf8");
    writeFileSync(join(portalAssetsRoot, "footer-left.png"), "PNG", "utf8");
    writeFileSync(join(portalAssetsRoot, "footer-right.png"), "PNG", "utf8");
    const view = assemblePortalView({
      registryPath,
      portalAssetsRoot,
      readVersionState: () => emptyVersionState(),
    });
    expect(view.assets?.pageBackground).toMatch(/^\/portal-assets\/portal-background\.png\?v=\d+$/);
    expect(view.assets?.wordmark).toMatch(/^\/portal-assets\/portal-wordmark\.png\?v=\d+$/);
    expect(view.assets?.footerLeft).toMatch(/^\/portal-assets\/footer-left\.png\?v=\d+$/);
    expect(view.assets?.footerRight).toMatch(/^\/portal-assets\/footer-right\.png\?v=\d+$/);
  });

  it("fills brand assets from the configured asset subdir", () => {
    const portalAssetsRoot = join(dir, "portal-assets");
    const overlayRoot = join(portalAssetsRoot, "overlay");
    mkdirSync(overlayRoot, { recursive: true });
    writeFileSync(join(overlayRoot, "portal-background.png"), "PNG", "utf8");
    writeFileSync(join(overlayRoot, "portal-wordmark.png"), "PNG", "utf8");
    writeFileSync(join(overlayRoot, "footer-left.png"), "PNG", "utf8");
    writeFileSync(join(overlayRoot, "footer-right.png"), "PNG", "utf8");
    const view = assemblePortalView({
      registryPath,
      portalAssetsRoot,
      portalAssetsSubdir: "overlay",
      readVersionState: () => emptyVersionState(),
    });
    expect(view.assets?.pageBackground).toMatch(/^\/portal-assets\/overlay\/portal-background\.png\?v=\d+$/);
    expect(view.assets?.wordmark).toMatch(/^\/portal-assets\/overlay\/portal-wordmark\.png\?v=\d+$/);
    expect(view.assets?.footerLeft).toMatch(/^\/portal-assets\/overlay\/footer-left\.png\?v=\d+$/);
    expect(view.assets?.footerRight).toMatch(/^\/portal-assets\/overlay\/footer-right\.png\?v=\d+$/);
  });

  it("omits brand asset fields when no convention file exists", () => {
    const portalAssetsRoot = join(dir, "portal-assets");
    mkdirSync(portalAssetsRoot, { recursive: true });
    const view = assemblePortalView({
      registryPath,
      portalAssetsRoot,
      readVersionState: () => emptyVersionState(),
    });
    expect(view.assets?.pageBackground).toBeUndefined();
    expect(view.assets?.wordmark).toBeUndefined();
    expect(view.assets?.footerLeft).toBeUndefined();
    expect(view.assets?.footerRight).toBeUndefined();
  });

  it("prefers explicit assets over the portalAssetsRoot convention", () => {
    const portalAssetsRoot = join(dir, "portal-assets");
    mkdirSync(portalAssetsRoot, { recursive: true });
    writeFileSync(join(portalAssetsRoot, "portal-background.png"), "PNG", "utf8");
    const view = assemblePortalView({
      registryPath,
      portalAssetsRoot,
      assets: { pageBackground: "https://cdn.example/bg.png" },
      readVersionState: () => emptyVersionState(),
    });
    expect(view.assets?.pageBackground).toBe("https://cdn.example/bg.png");
  });
});
