import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { runServe } from "./serve.js";
import type { RunningGateway } from "@understand-anyway/gateway";
import type { ServeArgs } from "./args.js";

const TOKEN = "runtime-token-cli";

let workdir: string;
let stateRoot: string;
let distDir: string;
let running: RunningGateway | null;
let base: string;

function serveArgs(): ServeArgs {
  return {
    command: "serve",
    host: "127.0.0.1",
    port: 0,
    projectId: null,
    stateDir: stateRoot,
    distDir,
    token: TOKEN,
    projectRoot: workdir,
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
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ua-cli-"));
  stateRoot = join(workdir, "state");
  distDir = join(workdir, "dist");
  const uaDir = join(stateRoot, ".understand-anything");
  mkdirSync(uaDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(uaDir, "knowledge-graph.json"),
    JSON.stringify({ nodes: [{ id: "n1", filePath: join(workdir, "src/app.ts") }] }),
  );
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>dash</title>");
  running = null;
});

afterEach(async () => {
  if (running) await running.close();
  rmSync(workdir, { recursive: true, force: true });
});

async function start(): Promise<void> {
  running = await runServe(serveArgs(), { log: () => {}, installSignalHandlers: false, config: {} });
  const addr = running.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}

describe("runServe (prod default = NoAuthProvider, no SSO guard)", () => {
  it("starts the gateway and healthz reports no-auth without any SSO config", async () => {
    await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, auth: "no-auth" });
  });

  it("still enforces the runtime token on the data API (token != auth)", async () => {
    await start();
    expect((await fetch(`${base}/knowledge-graph.json`)).status).toBe(403);
    const ok = await fetch(`${base}/knowledge-graph.json?token=${TOKEN}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { nodes: { filePath: string }[] };
    expect(body.nodes[0]?.filePath).toBe("src/app.ts");
  });

  it("rejects a non-existent state directory", async () => {
    const bad = { ...serveArgs(), stateDir: join(workdir, "missing") };
    await expect(runServe(bad, { log: () => {}, installSignalHandlers: false })).rejects.toThrow(/--state-dir/);
  });

  it("serves a global maintenance 503 when maintenance flags are enabled", async () => {
    running = await runServe(
      { ...serveArgs(), maintenanceEnabled: true, maintenanceTitle: "Down", maintenanceMessage: "Back soon" },
      { log: () => {}, installSignalHandlers: false, config: {} },
    );
    const addr = running.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${base}/knowledge-graph.json?token=${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "maintenance", title: "Down", message: "Back soon" });
  });

  it("lets UA_SERVE_PORT override YAML deploy port", async () => {
    running = await runServe(
      serveArgs(),
      {
        log: () => {},
        installSignalHandlers: false,
        config: { deploy: { port: 65535 } },
        loadDeps: { env: { UA_SERVE_PORT: "0" } },
      },
    );
    const addr = running.server.address() as AddressInfo;
    expect(addr.port).not.toBe(65535);
  });

  it("lets explicit CLI default port override env and YAML layers", async () => {
    running = await runServe(
      { ...serveArgs(), port: 0, portExplicit: true },
      {
        log: () => {},
        installSignalHandlers: false,
        config: { deploy: { port: 65535 } },
        loadDeps: { env: { UA_SERVE_PORT: "65535" } },
      },
    );
    const addr = running.server.address() as AddressInfo;
    expect(addr.port).not.toBe(65535);
  });

  it("rejects invalid UA_SERVE_PORT", async () => {
    await expect(
      runServe(
        serveArgs(),
        {
          log: () => {},
          installSignalHandlers: false,
          config: {},
          loadDeps: { env: { UA_SERVE_PORT: "bad" } },
        },
      ),
    ).rejects.toThrow(/invalid UA_SERVE_PORT/);
  });

  it("loads an embedding provider and exposes semantic search", async () => {
    const embeddingProvider = { name: "fake-embedding", embed: async () => [1, 0] };
    running = await runServe(
      { ...serveArgs(), embeddingProvider: "pkg-embedding" } as any,
      {
        log: () => {},
        installSignalHandlers: false,
        config: { providers: { embedding: { package: "pkg-embedding" } } },
        buildEmbeddingProvider: async () => embeddingProvider,
      } as any,
    );
    const addr = running.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    writeFileSync(
      join(stateRoot, ".understand-anything", "embeddings.json"),
      JSON.stringify({ n1: [1, 0] }),
    );
    const res = await fetch(`${base}/semantic-search?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "auth flow", limit: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [{ nodeId: "n1" }] });
  });

  it("loads embedding provider from config even without CLI flag", async () => {
    const embeddingProvider = { name: "fake-embedding", embed: async () => [1, 0] };
    const buildEmbeddingProvider = async () => embeddingProvider;
    running = await runServe(
      serveArgs(),
      {
        log: () => {},
        installSignalHandlers: false,
        config: { providers: { embedding: { package: "pkg-embedding" } } },
        buildEmbeddingProvider,
      } as any,
    );
    const addr = running.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    writeFileSync(
      join(stateRoot, ".understand-anything", "embeddings.json"),
      JSON.stringify({ n1: [1, 0] }),
    );
    const res = await fetch(`${base}/semantic-search?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "auth flow", limit: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [{ nodeId: "n1" }] });
  });
});
