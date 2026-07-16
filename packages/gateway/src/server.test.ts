import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGatewayServer, startGatewayServer } from "./server.js";
import { ProjectRegistryStore } from "./project-registry.js";
import type { Server } from "node:http";
import type {
  AuthBeginResult,
  AuthCallbackResult,
  AuthProvider,
  AuthRequestContext,
  AuthResult,
  AuthSession,
  RecordEnvelope,
} from "@understand-anyway/plugin-api";

const TOKEN = "runtime-token-xyz";

let workdir: string;
let stateRoot: string;
let distDir: string;
let server: Server;
let base: string;

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "ua-gw-"));
  stateRoot = join(workdir, "state");
  distDir = join(workdir, "dist");
  const uaDir = join(stateRoot, ".understand-anything");
  mkdirSync(uaDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  // node.filePath is absolute under the source root; serving must relativize it.
  writeFileSync(
    join(uaDir, "knowledge-graph.json"),
    JSON.stringify({ nodes: [{ id: "n1", filePath: join(workdir, "src/app.ts") }] }),
  );
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>dash</title>");

  server = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    stateRoot,
    distDir,
    runtimeToken: TOKEN,
    projectRoot: workdir,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(workdir, { recursive: true, force: true });
});

describe("gateway server (NoAuthProvider default)", () => {
  it("healthz reports ok and no-auth", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, auth: "no-auth" });
  });

  it("data API rejects requests without the runtime token", async () => {
    const res = await fetch(`${base}/knowledge-graph.json`);
    expect(res.status).toBe(403);
  });

  it("data API serves and relativizes graph paths with a valid token", async () => {
    const res = await fetch(`${base}/knowledge-graph.json?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: { filePath: string }[] };
    expect(body.nodes[0]?.filePath).toBe("src/app.ts");
  });

  it("serves semantic search results with the runtime token", async () => {
    writeFileSync(
      join(stateRoot, ".understand-anything", "embeddings.json"),
      JSON.stringify({ n1: [1, 0] }),
    );
    await new Promise<void>((done) => server.close(() => done()));
    server = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot,
      distDir,
      runtimeToken: TOKEN,
      projectRoot: workdir,
      embeddingProvider: {
        name: "fake-embedding",
        embed: async () => [1, 0],
      },
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${base}/semantic-search?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "auth flow", limit: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [{ nodeId: "n1" }] });
  });

  it("static SPA index is served (no auth redirect under no-auth)", async () => {
    const res = await fetch(`${base}/dashboard?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("dash");
    expect(body).toContain("ua-project-loading-overlay-script");
  });

  it("static fallback redirects to append the runtime token when missing (token != auth)", async () => {
    const res = await fetch(`${base}/dashboard`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`token=${TOKEN}`);
  });
});

describe("gateway server with portal enabled", () => {
  let portalWorkdir: string;
  let portalServer: Server;
  let portalBase: string;

  beforeEach(async () => {
    portalWorkdir = mkdtempSync(join(tmpdir(), "ua-gw-portal-"));
    const portalStateRoot = join(portalWorkdir, "state");
    const portalDistDir = join(portalWorkdir, "dist");
    mkdirSync(join(portalStateRoot, ".understand-anything"), { recursive: true });
    mkdirSync(portalDistDir, { recursive: true });
    const registryPath = join(portalWorkdir, "registry.json");
    new ProjectRegistryStore(registryPath).upsert("alpha", "/r/a", "/s/a", { name: "Alpha" });

    portalServer = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot: portalStateRoot,
      distDir: portalDistDir,
      runtimeToken: TOKEN,
      portal: { registryPath, title: "Portal E2E" },
    });
    await new Promise<void>((done) => portalServer.listen(0, "127.0.0.1", done));
    const addr = portalServer.address() as AddressInfo;
    portalBase = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => portalServer.close(() => done()));
    rmSync(portalWorkdir, { recursive: true, force: true });
  });

  it("serves the portal landing page at root", async () => {
    const res = await fetch(`${portalBase}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Portal E2E");
    expect(body).toContain("/project/alpha/");
  });

  it("still gates the data API behind the runtime token", async () => {
    const res = await fetch(`${portalBase}/knowledge-graph.json`);
    expect(res.status).toBe(403);
  });
});

describe("gateway server with project routing enabled", () => {
  let projWorkdir: string;
  let projServer: Server;
  let projBase: string;

  beforeEach(async () => {
    projWorkdir = mkdtempSync(join(tmpdir(), "ua-gw-proj-"));
    const gwState = join(projWorkdir, "gw-state");
    const gwDist = join(projWorkdir, "gw-dist");
    mkdirSync(join(gwState, ".understand-anything"), { recursive: true });
    mkdirSync(gwDist, { recursive: true });

    const projState = join(projWorkdir, "alpha-state");
    const projDist = join(projWorkdir, "alpha-dist");
    mkdirSync(join(projState, ".understand-anything"), { recursive: true });
    mkdirSync(projDist, { recursive: true });
    writeFileSync(
      join(projState, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
    );
    writeFileSync(join(projDist, "app.js"), "console.log('alpha')");

    const registryPath = join(projWorkdir, "registry.json");
    new ProjectRegistryStore(registryPath).upsert("alpha", join(projWorkdir, "alpha-repo"), projState, {
      name: "Alpha",
      runtimeMode: "prod",
      prodDistDir: projDist,
      prodToken: "alpha-tok",
      status: "running",
    });

    projServer = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot: gwState,
      distDir: gwDist,
      runtimeToken: TOKEN,
      projectRoute: { registryPath },
    });
    await new Promise<void>((done) => projServer.listen(0, "127.0.0.1", done));
    const addr = projServer.address() as AddressInfo;
    projBase = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => projServer.close(() => done()));
    rmSync(projWorkdir, { recursive: true, force: true });
  });

  it("serves a project's data API with the per-project token", async () => {
    const res = await fetch(`${projBase}/project/alpha/knowledge-graph.json?token=alpha-tok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodes: [] });
  });

  it("403s a project's data API without the per-project token", async () => {
    const res = await fetch(`${projBase}/project/alpha/knowledge-graph.json`);
    expect(res.status).toBe(403);
  });

  it("302s to the portal when the project has no live runtime", async () => {
    const res = await fetch(`${projBase}/project/ghost/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("sets the active-project cookie on GET", async () => {
    const res = await fetch(`${projBase}/project/alpha/app.js?token=alpha-tok`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("ua_active_project=alpha");
  });

  it("injects the loading overlay into project SPA html", async () => {
    writeFileSync(join(projWorkdir, "alpha-dist", "index.html"), "<!doctype html><html><body><div id='root'></div></body></html>");
    const res = await fetch(`${projBase}/project/alpha/?token=alpha-tok`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("ua-project-loading-overlay-script");
    expect(body).toContain("Loading project...");
  });
});

describe("gateway server with an org policy that denies access", () => {
  let oServer: Server;
  let oBase: string;
  let oWorkdir: string;

  beforeEach(async () => {
    oWorkdir = mkdtempSync(join(tmpdir(), "ua-gw-org-"));
    const gwState = join(oWorkdir, "gw-state");
    const gwDist = join(oWorkdir, "gw-dist");
    mkdirSync(join(gwState, ".understand-anything"), { recursive: true });
    mkdirSync(gwDist, { recursive: true });
    writeFileSync(
      join(gwState, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
    );

    const projState = join(oWorkdir, "alpha-state");
    const projDist = join(oWorkdir, "alpha-dist");
    mkdirSync(join(projState, ".understand-anything"), { recursive: true });
    mkdirSync(projDist, { recursive: true });
    writeFileSync(
      join(projState, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
    );

    const registryPath = join(oWorkdir, "registry.json");
    new ProjectRegistryStore(registryPath).upsert("alpha", join(oWorkdir, "alpha-repo"), projState, {
      name: "Alpha",
      runtimeMode: "prod",
      prodDistDir: projDist,
      prodToken: "alpha-tok",
      status: "running",
    });

    oServer = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot: gwState,
      distDir: gwDist,
      runtimeToken: TOKEN,
      projectRoute: { registryPath },
      orgPolicy: {
        name: "deny-all",
        async canAccessProject() {
          return { allowed: false, reason: "department_scope_not_authorized" };
        },
      },
    });
    await new Promise<void>((done) => oServer.listen(0, "127.0.0.1", done));
    const addr = oServer.address() as AddressInfo;
    oBase = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => oServer.close(() => done()));
    rmSync(oWorkdir, { recursive: true, force: true });
  });

  it("403s a project route when the org policy denies access", async () => {
    const res = await fetch(`${oBase}/project/alpha/knowledge-graph.json?token=alpha-tok`);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("department_scope_not_authorized");
  });

  it("does not gate non-project routes", async () => {
    const res = await fetch(`${oBase}/knowledge-graph.json?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });
});

describe("gateway server with global maintenance active", () => {
  let mServer: Server;
  let mBase: string;
  let mWorkdir: string;

  beforeEach(async () => {
    mWorkdir = mkdtempSync(join(tmpdir(), "ua-gw-maint-"));
    const mState = join(mWorkdir, "state");
    const mDist = join(mWorkdir, "dist");
    mkdirSync(join(mState, ".understand-anything"), { recursive: true });
    mkdirSync(mDist, { recursive: true });
    writeFileSync(join(mDist, "index.html"), "<!doctype html><title>dash</title>");

    mServer = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot: mState,
      distDir: mDist,
      runtimeToken: TOKEN,
      resolveMaintenanceState: () => ({
        enabled: true,
        scope: "global",
        title: "Down",
        message: "Back soon",
      }),
    });
    await new Promise<void>((done) => mServer.listen(0, "127.0.0.1", done));
    const addr = mServer.address() as AddressInfo;
    mBase = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => mServer.close(() => done()));
    rmSync(mWorkdir, { recursive: true, force: true });
  });

  it("503s data endpoints with a JSON maintenance body", async () => {
    const res = await fetch(`${mBase}/knowledge-graph.json?token=${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "maintenance", title: "Down" });
  });

  it("503s static requests with an HTML maintenance page", async () => {
    const res = await fetch(`${mBase}/dashboard?token=${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Back soon");
  });

  it("still answers healthz", async () => {
    const res = await fetch(`${mBase}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe("gateway server with a record provider", () => {
  let rServer: Server;
  let rBase: string;
  let rWorkdir: string;
  let events: RecordEnvelope[];

  beforeEach(async () => {
    rWorkdir = mkdtempSync(join(tmpdir(), "ua-gw-rec-"));
    const gwState = join(rWorkdir, "gw-state");
    const gwDist = join(rWorkdir, "gw-dist");
    mkdirSync(join(gwState, ".understand-anything"), { recursive: true });
    mkdirSync(gwDist, { recursive: true });
    writeFileSync(
      join(gwState, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
    );

    const projState = join(rWorkdir, "alpha-state");
    const projDist = join(rWorkdir, "alpha-dist");
    mkdirSync(join(projState, ".understand-anything"), { recursive: true });
    mkdirSync(projDist, { recursive: true });
    writeFileSync(
      join(projState, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
    );

    const betaState = join(rWorkdir, "beta-state");
    const betaDist = join(rWorkdir, "beta-dist");
    mkdirSync(join(betaState, ".understand-anything"), { recursive: true });
    mkdirSync(betaDist, { recursive: true });
    writeFileSync(
      join(betaState, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
    );
    writeFileSync(join(betaDist, "index.html"), "<!doctype html><html><body>beta</body></html>");
    writeFileSync(join(betaDist, "app.js"), "console.log('beta')");
    writeFileSync(join(betaDist, "config.json"), JSON.stringify({ project: "beta" }));

    const registryPath = join(rWorkdir, "registry.json");
    const registry = new ProjectRegistryStore(registryPath);
    registry.upsert("alpha", join(rWorkdir, "alpha-repo"), projState, {
      name: "Alpha",
      runtimeMode: "prod",
      prodDistDir: projDist,
      prodToken: "alpha-tok",
      status: "running",
    });
    registry.upsert("beta", join(rWorkdir, "beta-repo"), betaState, {
      name: "Beta",
      runtimeMode: "prod",
      prodDistDir: betaDist,
      prodToken: "beta-tok",
      status: "running",
    });

    events = [];
    rServer = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot: gwState,
      distDir: gwDist,
      runtimeToken: TOKEN,
      projectRoute: { registryPath },
      orgPolicy: {
        name: "deny-alpha",
        async canAccessProject(_user, projectId) {
          return projectId === "alpha"
            ? {
                allowed: false,
                reason: "department_scope_not_authorized",
                authReason: "department_scope_not_authorized",
                departmentPaths: [["Data", "Other"]],
                targetDepartment: ["Data", "Allowed"],
              }
            : {
                allowed: true,
                reason: "department_exact_match",
                authReason: "department_exact_match",
                departmentPaths: [["Data", "Allowed"]],
                matchedDepartmentPath: ["Data", "Allowed"],
                targetDepartment: ["Data", "Allowed"],
              };
        },
      },
      record: {
        name: "spy",
        async write(record) {
          events.push(record);
        },
      },
    });
    await new Promise<void>((done) => rServer.listen(0, "127.0.0.1", done));
    const addr = rServer.address() as AddressInfo;
    rBase = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => rServer.close(() => done()));
    rmSync(rWorkdir, { recursive: true, force: true });
  });

  it("records an authz_denied user-event when org policy denies a project", async () => {
    const res = await fetch(`${rBase}/project/alpha/knowledge-graph.json?token=alpha-tok`);
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("user-event");
    expect(events[0]!.payload.eventType).toBe("authz_denied");
    expect(events[0]!.payload.targetId).toBe("alpha");
  });

  it("records one project_view for a project page click that follows the runtime-token redirect", async () => {
    const res = await fetch(`${rBase}/project/beta/`, {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));

    const projectViews = events.filter((event) => event.payload.eventType === "project_view");
    expect(projectViews).toHaveLength(1);
    expect(projectViews[0]!.payload.targetId).toBe("beta");
    expect(projectViews[0]!.payload.authReason).toBe("department_exact_match");
    expect(projectViews[0]!.payload.departmentPaths).toEqual([["Data", "Allowed"]]);
  });

  it("does not record project_view for project assets or JSON artifacts", async () => {
    await fetch(`${rBase}/project/beta/app.js?token=beta-tok`);
    await fetch(`${rBase}/project/beta/config.json?token=beta-tok`);
    await fetch(`${rBase}/project/beta/knowledge-graph.json?token=beta-tok`);
    await new Promise((r) => setTimeout(r, 20));

    expect(events.filter((event) => event.payload.eventType === "project_view")).toHaveLength(0);
  });

  it("keeps authz_denied recording for project JSON requests and includes org audit fields", async () => {
    const res = await fetch(`${rBase}/project/alpha/knowledge-graph.json?token=alpha-tok`);
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.eventType).toBe("authz_denied");
    expect(events[0]!.payload.authReason).toBe("department_scope_not_authorized");
    expect(events[0]!.payload.departmentPaths).toEqual([["Data", "Other"]]);
    expect(events[0]!.payload.extra).toMatchObject({
      reason: "department_scope_not_authorized",
      authReason: "department_scope_not_authorized",
      targetDepartment: ["Data", "Allowed"],
    });
  });
});

class CallbackLoginProvider implements AuthProvider {
  readonly name = "callback-login";

  async authenticate(_ctx: AuthRequestContext, session?: AuthSession | null): Promise<AuthResult> {
    return session ? { authenticated: true, user: session.user } : { authenticated: false };
  }

  async beginLogin(_ctx: AuthRequestContext, nextPath: string): Promise<AuthBeginResult> {
    return { redirectTo: `/auth/callback?next=${encodeURIComponent(nextPath)}` };
  }

  async handleCallback(): Promise<AuthCallbackResult> {
    return {
      ok: true,
      session: {
        user: {
          id: "ou_login",
          email: "alice@example.com",
          displayName: "Alice",
          raw: { open_id: "ou_login", en_name: "Alice En" },
        },
        createdAt: Date.now(),
      },
      redirectTo: "/",
    };
  }
}

describe("gateway server login user-events", () => {
  let loginServer: Server;
  let loginBase: string;
  let loginWorkdir: string;
  let events: RecordEnvelope[];

  beforeEach(async () => {
    loginWorkdir = mkdtempSync(join(tmpdir(), "ua-gw-login-"));
    const state = join(loginWorkdir, "state");
    const dist = join(loginWorkdir, "dist");
    mkdirSync(join(state, ".understand-anything"), { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");

    events = [];
    loginServer = createGatewayServer({
      host: "127.0.0.1",
      port: 0,
      stateRoot: state,
      distDir: dist,
      runtimeToken: TOKEN,
      authProvider: new CallbackLoginProvider(),
      orgPolicy: {
        name: "login-audit",
        async canAccessProject() {
          return {
            allowed: true,
            reason: "department_exact_match",
            authReason: "department_exact_match",
            departmentPaths: [["Data", "Allowed"]],
            matchedDepartmentPath: ["Data", "Allowed"],
            targetDepartment: ["Data", "Allowed"],
          };
        },
      },
      record: {
        name: "spy",
        async write(record) {
          events.push(record);
        },
      },
    });
    await new Promise<void>((done) => loginServer.listen(0, "127.0.0.1", done));
    const addr = loginServer.address() as AddressInfo;
    loginBase = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => loginServer.close(() => done()));
    rmSync(loginWorkdir, { recursive: true, force: true });
  });

  it("records one login user-event with identity and org audit fields after callback success", async () => {
    const res = await fetch(`${loginBase}/auth/callback?ok=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.eventType).toBe("login");
    expect(events[0]!.payload.displayName).toBe("Alice");
    expect(events[0]!.payload.email).toBe("alice@example.com");
    expect(events[0]!.payload.raw).toMatchObject({ open_id: "ou_login", en_name: "Alice En" });
    expect(events[0]!.payload.authReason).toBe("department_exact_match");
    expect(events[0]!.payload.departmentPaths).toEqual([["Data", "Allowed"]]);
  });
});

describe("startGatewayServer NoAuth + non-loopback WARN", () => {
  // We spin up real servers on 127.0.0.1 with port=0 (loopback) but pass an
  // explicit `host` value to the option object — `maybeWarnPublicNoAuth`
  // inspects `options.host`, not the bound socket. This lets us exercise the
  // warning logic without listening on a real public interface.
  let warnDir: string;
  let warnState: string;
  let warnDist: string;

  beforeEach(() => {
    warnDir = mkdtempSync(join(tmpdir(), "ua-gw-warn-"));
    warnState = join(warnDir, "state");
    warnDist = join(warnDir, "dist");
    mkdirSync(join(warnState, ".understand-anything"), { recursive: true });
    mkdirSync(warnDist, { recursive: true });
    writeFileSync(join(warnDist, "index.html"), "<!doctype html>");
  });

  afterEach(() => {
    rmSync(warnDir, { recursive: true, force: true });
  });

  async function startAndCapture(host: string, authProvider?: AuthProvider): Promise<string> {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const running = await startGatewayServer({
        host,
        port: 0,
        stateRoot: warnState,
        distDir: warnDist,
        runtimeToken: TOKEN,
        projectRoot: warnDir,
        authProvider,
      });
      await running.close();
      const writes = spy.mock.calls.map((c) => String(c[0]));
      return writes.join("");
    } finally {
      spy.mockRestore();
    }
  }

  it("does NOT warn when host is loopback (127.0.0.1)", async () => {
    const out = await startAndCapture("127.0.0.1");
    expect(out).not.toContain("[WARN]");
  });

  it("does NOT warn when host is localhost", async () => {
    const out = await startAndCapture("localhost");
    expect(out).not.toContain("[WARN]");
  });

  it("WARNs when host is 0.0.0.0 with default (NoAuth) provider", async () => {
    // listen() needs a bindable interface; spin up on 127.0.0.1 anyway by
    // matching the WARN check to a non-loopback host string. We construct a
    // running server directly and only inspect the warn behavior.
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const running = await startGatewayServer({
        host: "0.0.0.0",
        port: 0,
        stateRoot: warnState,
        distDir: warnDist,
        runtimeToken: TOKEN,
        projectRoot: warnDir,
      });
      await running.close();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("[WARN]");
      expect(out).toContain("no auth provider");
      expect(out).toContain("0.0.0.0");
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT warn when a real auth provider is configured (even on 0.0.0.0)", async () => {
    const fakeProvider: AuthProvider = {
      name: "fake-sso",
      async authenticate() {
        return { authenticated: true, user: { id: "u" } };
      },
    };
    // Run on 0.0.0.0 with the fake provider; no WARN expected because the
    // provider name is not "no-auth".
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const running = await startGatewayServer({
        host: "0.0.0.0",
        port: 0,
        stateRoot: warnState,
        distDir: warnDist,
        runtimeToken: TOKEN,
        projectRoot: warnDir,
        authProvider: fakeProvider,
      });
      await running.close();
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).not.toContain("[WARN]");
    } finally {
      spy.mockRestore();
    }
  });
});
