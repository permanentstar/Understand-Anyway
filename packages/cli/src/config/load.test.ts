import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ServeArgs } from "../args.js";
import { loadResolvedConfig, selectProfile } from "./load.js";

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
    config: "/deploy.yaml",
    serveProfile: null,
    ...overrides,
  };
}

const YAML_TEXT = `
version: 1
deploy:
  host: 0.0.0.0
  port: 18666
providers:
  auth:
    package: "@example/auth"
    config:
      appId: cli_x
      appSecret: "{{ FEISHU_APP_SECRET }}"
profiles:
  sso-portal:
    portal: true
    use: [auth, portalAssets]
    registry: /r/registry.json
`;

function fakeDeps(text = YAML_TEXT, env: Record<string, string> = { FEISHU_APP_SECRET: "real-secret" }) {
  return {
    cwd: "/work",
    env,
    fileExists: (p: string) => p === "/deploy.yaml",
    readFile: (p: string) => {
      if (p === "/deploy.yaml") return text;
      throw new Error(`unexpected read ${p}`);
    },
    parseYaml: (t: string) => parseYaml(t) as unknown,
    dotenv: {},
  };
}

describe("loadResolvedConfig", () => {
  it("returns {} when no config is discovered", () => {
    const config = loadResolvedConfig(serveArgs({ config: null }), {
      cwd: "/work",
      env: {},
      fileExists: () => false,
      exeRoot: "/exe",
    });
    expect(config).toEqual({});
  });

  it("throws when an explicit --config path does not exist", () => {
    expect(() => loadResolvedConfig(serveArgs({ config: "/missing.yaml" }), {
      cwd: "/work",
      env: {},
      fileExists: () => false,
      exeRoot: "/exe",
    })).toThrow(/config not found: \/missing\.yaml/);
  });

  it("returns {} when a derived default config path does not exist", () => {
    const config = loadResolvedConfig({ config: "/projects/alpha/deploy.yaml", configExplicit: false }, {
      cwd: "/work",
      env: {},
      fileExists: () => false,
      exeRoot: "/exe",
    });
    expect(config).toEqual({});
  });

  it("parses YAML and resolves secret placeholders from env", () => {
    const config = loadResolvedConfig(serveArgs(), fakeDeps());
    expect(config.deploy?.host).toBe("0.0.0.0");
    expect(config.providers?.auth?.package).toBe("@example/auth");
    expect((config.providers?.auth?.config as { appSecret: string }).appSecret).toBe("real-secret");
  });

  it("applies deployProfiles to deploy and gateway defaults", () => {
    const text = `
version: 1
deploy:
  host: 0.0.0.0
  port: 18666
gateway:
  retain: 3
deployProfiles:
  ppe:
    deploy:
      port: 18690
      outputLanguage: zh
    gateway:
      retain: 2
`;
    const config = loadResolvedConfig({ ...serveArgs(), deployProfile: "ppe" }, fakeDeps(text));
    expect(config.deploy).toMatchObject({ host: "0.0.0.0", port: 18690, outputLanguage: "zh" });
    expect(config.gateway).toEqual({ retain: 2 });
  });

  it("keeps secrets out of the YAML source (only placeholders in the text)", () => {
    expect(YAML_TEXT).not.toContain("real-secret");
    expect(YAML_TEXT).toContain("{{ FEISHU_APP_SECRET }}");
  });

  it("throws on an unresolved secret placeholder", () => {
    expect(() => loadResolvedConfig(serveArgs(), fakeDeps(YAML_TEXT, {}))).toThrow(/unresolved/);
  });

  it("throws when a known provider key is misspelled (closed set)", () => {
    const text = `
version: 1
providers:
  atuh:
    package: "@typo/auth"
`;
    expect(() => loadResolvedConfig(serveArgs(), fakeDeps(text))).toThrow(/atuh|additional/i);
  });

  it("throws when version is missing", () => {
    const text = `
deploy:
  host: 0.0.0.0
`;
    expect(() => loadResolvedConfig(serveArgs(), fakeDeps(text))).toThrow(/version/);
  });

  it("throws when a known field has the wrong type", () => {
    const text = `
version: 1
deploy:
  port: "not-a-number"
`;
    expect(() => loadResolvedConfig(serveArgs(), fakeDeps(text))).toThrow(/port/);
  });
});

describe("selectProfile", () => {
  it("returns the named profile section", () => {
    const config = loadResolvedConfig(serveArgs(), fakeDeps());
    const profile = selectProfile(config, "sso-portal");
    expect(profile?.portal).toBe(true);
    expect(profile?.use).toEqual(["auth", "portalAssets"]);
    expect(profile?.registry).toBe("/r/registry.json");
  });

  it("returns undefined for no profile name", () => {
    const config = loadResolvedConfig(serveArgs(), fakeDeps());
    expect(selectProfile(config, null)).toBeUndefined();
  });

  it("throws for an unknown profile", () => {
    const config = loadResolvedConfig(serveArgs(), fakeDeps());
    expect(() => selectProfile(config, "nope")).toThrow(/unknown --serve-profile/);
  });
});
