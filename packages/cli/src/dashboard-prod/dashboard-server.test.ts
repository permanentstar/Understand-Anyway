import { describe, expect, it, vi } from "vitest";
import type { ServeArgs } from "../args.js";
import { runDashboardServer } from "./dashboard-server.js";

function makeArgs(overrides: Partial<ServeArgs> = {}): ServeArgs {
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

describe("runDashboardServer", () => {
  it("normalizes wildcard bind hosts in the surfaced dashboard URL", async () => {
    const send = vi.fn(() => true);
    await runDashboardServer(makeArgs({ host: "0.0.0.0", port: 18666 }), {
      runServe: vi.fn(async () => ({
        server: { address: () => ({ port: 18666 }) },
      })) as never,
      send,
      log: vi.fn(),
    });

    expect(send).toHaveBeenCalledWith({
      type: "dashboard-ready",
      host: "0.0.0.0",
      port: 18666,
      url: "http://127.0.0.1:18666/?token=tok",
    });
  });
});
