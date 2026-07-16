import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "@understand-anyway/plugin-api";
import type { ServeArgs } from "./args.js";
import { buildProviders } from "./build-providers.js";

function serveArgs(overrides: Partial<ServeArgs> = {}): ServeArgs {
  return {
    command: "serve",
    host: "127.0.0.1",
    port: 0,
    projectId: null,
    stateDir: "/state",
    distDir: "/dist",
    token: "tok",
    projectRoot: null,
    recordProviders: [],
    authProvider: null,
    orgPolicy: null,
    embeddingProvider: null,
    portal: false,
    portalAssets: null,
    projectRoute: false,
    registryPath: null,
    maintenanceEnabled: false,
    maintenanceScope: "global",
    maintenanceProjectIds: [],
    maintenanceTitle: null,
    maintenanceMessage: null,
    maintenanceEta: null,
    maintenanceContact: null,
    config: null,
    serveProfile: null,
    ...overrides,
  };
}

const fakeAuthModule = {
  createAuthProvider: (config: unknown) => ({
    name: "fake-auth",
    config,
    async authenticate() {
      return { authenticated: true };
    },
  }),
};

const fakeOrgModule = {
  createOrgPolicyProvider: (config: unknown) => ({
    name: "fake-org",
    config,
    async canAccessProject() {
      return { allowed: true };
    },
  }),
};

const fakePortalAssetsModule = {
  createPortalAssets: (config: unknown) => ({
    assetsDir: "/assets/nebula",
    assets: { background: "/portal-assets/bg.png" },
    config,
  }),
};

function importer(map: Record<string, Record<string, unknown>>) {
  return async (pkg: string) => {
    const mod = map[pkg];
    if (!mod) throw new Error(`module not found: ${pkg}`);
    return mod;
  };
}

describe("buildProviders", () => {
  it("returns an empty set when nothing is enabled", async () => {
    const built = await buildProviders(serveArgs(), { config: {}, registryPath: null });
    expect(built).toEqual({});
  });

  it("loads an auth provider via a --auth-provider flag override", async () => {
    const built = await buildProviders(serveArgs({ authProvider: "pkg-auth" }), {
      config: {},
      registryPath: null,
      importModule: importer({ "pkg-auth": fakeAuthModule }),
    });
    expect(built.authProvider?.name).toBe("fake-auth");
  });

  it("loads an auth provider from the config providers.auth.package", async () => {
    const config: ResolvedConfig = { providers: { auth: { package: "pkg-auth", config: { appId: "x" } } } };
    const built = await buildProviders(serveArgs(), {
      config,
      registryPath: null,
      importModule: importer({ "pkg-auth": fakeAuthModule }),
    });
    expect(built.authProvider?.name).toBe("fake-auth");
    expect((built.authProvider as { config?: unknown }).config).toEqual({ appId: "x" });
  });

  it("loads an org policy provider and passes its config section", async () => {
    const config: ResolvedConfig = {
      providers: { orgPolicy: { package: "pkg-org", config: { allowUsernames: ["alice"] } } },
    };
    const built = await buildProviders(serveArgs(), {
      config,
      registryPath: null,
      importModule: importer({ "pkg-org": fakeOrgModule }),
    });
    expect(built.orgPolicy?.name).toBe("fake-org");
    expect((built.orgPolicy as { config?: unknown }).config).toEqual({ allowUsernames: ["alice"] });
  });

  it("assembles portal options with assets from the portal-assets factory", async () => {
    const config: ResolvedConfig = {
      providers: { portalAssets: { package: "pkg-assets", config: { routePrefix: "/portal-assets/" } } },
    };
    const built = await buildProviders(serveArgs({ portal: true }), {
      config,
      registryPath: "/r/registry.json",
      portalDisplay: { title: "My Portal" },
      portalAssetsRoot: "/projects/gateway/portal-assets",
      importModule: importer({ "pkg-assets": fakePortalAssetsModule }),
    });
    expect(built.portal?.registryPath).toBe("/r/registry.json");
    expect(built.portal?.title).toBe("My Portal");
    expect(built.portal?.assetsDir).toBe("/assets/nebula");
    expect(built.portal?.assets?.background).toBe("/portal-assets/bg.png");
    expect(built).not.toHaveProperty("portalAssetSourceDir");
  });

  it("does not apply portalAssetsSubdir to provider-contributed assetsDir", async () => {
    const config: ResolvedConfig = {
      providers: { portalAssets: { package: "pkg-assets", config: { routePrefix: "/portal-assets/" } } },
    };
    const built = await buildProviders(serveArgs({ portal: true }), {
      config,
      registryPath: "/r/registry.json",
      portalAssetsRoot: "/projects/gateway/portal-assets",
      portalAssetsSubdir: "overlay",
      importModule: importer({ "pkg-assets": fakePortalAssetsModule }),
    });

    expect(built.portal?.assetsDir).toBe("/assets/nebula");
    expect(built.portal?.portalAssetsSubdir).toBeUndefined();
  });

  it("assembles portal options without assets when no portal-assets package", async () => {
    const built = await buildProviders(serveArgs({ portal: true }), {
      config: {},
      registryPath: "/r/registry.json",
      portalAssetsRoot: "/projects/gateway/portal-assets",
      portalAssetsSubdir: "overlay",
    });
    expect(built.portal?.registryPath).toBe("/r/registry.json");
    expect(built.portal?.assetsDir).toBe("/projects/gateway/portal-assets");
    expect(built.portal?.portalAssetsSubdir).toBe("overlay");
    expect(built.portal?.assets).toBeUndefined();
  });

  it("assembles project route options", async () => {
    const built = await buildProviders(serveArgs({ projectRoute: true }), {
      config: {},
      registryPath: "/r/registry.json",
    });
    expect(built.projectRoute?.registryPath).toBe("/r/registry.json");
  });

  it("throws when a package does not export the expected factory", async () => {
    await expect(
      buildProviders(serveArgs({ authProvider: "pkg-bad" }), {
        config: {},
        registryPath: null,
        importModule: importer({ "pkg-bad": { somethingElse: 1 } }),
      }),
    ).rejects.toThrow(/does not export createAuthProvider/);
  });

  it("throws when the package cannot be loaded", async () => {
    await expect(
      buildProviders(serveArgs({ authProvider: "missing-pkg" }), {
        config: {},
        registryPath: null,
        importModule: importer({}),
      }),
    ).rejects.toThrow(/failed to load provider package 'missing-pkg'/);
  });
});
