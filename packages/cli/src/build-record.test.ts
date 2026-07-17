import { describe, expect, it } from "vitest";
import { CompositeRecordProvider, LocalFileRecordProvider } from "@understand-anyway/gateway";
import { FeishuSheetsRecordProvider } from "@understand-anyway/provider-feishu-sheets";
import type { RecordSection } from "@understand-anyway/plugin-api";
import type { ServeArgs } from "./args.js";
import { buildRecordProvider } from "./build-record.js";

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

const sheetsConfig: RecordSection = {
  config: {
    "feishu-sheets": {
      appId: "cli_x",
      appSecret: "secret_x",
      spreadsheetToken: "shtTOKEN",
    },
  },
};

describe("buildRecordProvider", () => {
  it("returns undefined when no providers are requested", async () => {
    expect(await buildRecordProvider(serveArgs(), { stateRoot: "/state" })).toBeUndefined();
  });

  it("builds a local NDJSON sink rooted at the state dir by default", async () => {
    const provider = await buildRecordProvider(serveArgs({ recordProviders: ["local"] }), { stateRoot: "/state" });
    expect(provider).toBeInstanceOf(LocalFileRecordProvider);
    expect(provider?.name).toBe("local-file");
  });

  it("uses the config's record.providers when no flag is given", async () => {
    const provider = await buildRecordProvider(serveArgs(), {
      stateRoot: "/state",
      record: { providers: ["local"] },
    });
    expect(provider).toBeInstanceOf(LocalFileRecordProvider);
  });

  it("builds a feishu-sheets sink from the record config (lazy dynamic import)", async () => {
    const provider = await buildRecordProvider(serveArgs({ recordProviders: ["feishu-sheets"] }), {
      stateRoot: "/state",
      record: sheetsConfig,
    });
    expect(provider).toBeInstanceOf(FeishuSheetsRecordProvider);
  });

  it("composes multiple providers", async () => {
    const provider = await buildRecordProvider(serveArgs({ recordProviders: ["local", "feishu-sheets"] }), {
      stateRoot: "/state",
      record: sheetsConfig,
    });
    expect(provider).toBeInstanceOf(CompositeRecordProvider);
  });

  it("rejects feishu-sheets config missing token", async () => {
    await expect(
      buildRecordProvider(serveArgs({ recordProviders: ["feishu-sheets"] }), {
        stateRoot: "/state",
        record: {},
      }),
    ).rejects.toThrow(/spreadsheetToken/);
  });
});
