import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tryServeProjectRoute, ACTIVE_PROJECT_COOKIE } from "./project-router.js";
import { ProjectRegistryStore } from "./project-registry.js";

let dir: string;
let registryPath: string;
let stateRoot: string;
let distDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-projroute-"));
  registryPath = join(dir, "registry.json");
  stateRoot = join(dir, "state");
  distDir = join(dir, "dist");
  mkdirSync(join(stateRoot, ".understand-anything"), { recursive: true });
  mkdirSync(distDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface FakeRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
  writeHead(code: number, headers?: Record<string, string>): void;
  getHeader(name: string): string | string[] | undefined;
  setHeader(name: string, value: string | string[]): void;
  end(chunk?: string | Buffer): void;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) this.headers = { ...this.headers, ...headers };
    },
    getHeader(name) {
      return this.headers[name];
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
}

function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse;
}

function setCookies(res: FakeRes): string[] {
  const header = res.headers["Set-Cookie"];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

function cookieHeaderFrom(...responses: FakeRes[]): string {
  return responses.flatMap((res) => setCookies(res).map((cookie) => cookie.split(";")[0])).join("; ");
}

function fakeReq(method = "GET"): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

function registerDirectProd(projectId: string): void {
  new ProjectRegistryStore(registryPath).upsert(projectId, join(dir, "repo"), stateRoot, {
    name: projectId,
    runtimeMode: "prod",
    prodDistDir: distDir,
    prodToken: "tok-123",
    status: "running",
  });
}

describe("tryServeProjectRoute", () => {
  it("returns false for non-project paths", async () => {
    const res = fakeRes();
    expect(await tryServeProjectRoute(fakeReq(), asRes(res), "/", { registryPath })).toBe(false);
    expect(await tryServeProjectRoute(fakeReq(), asRes(res), "/knowledge-graph.json", { registryPath })).toBe(false);
  });

  it("302s to portal when the project has no live prod runtime", async () => {
    const res = fakeRes();
    const handled = await tryServeProjectRoute(fakeReq(), asRes(res), "/project/ghost/", { registryPath });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe("/");
  });

  it("302s to a custom portal path when configured", async () => {
    const res = fakeRes();
    await tryServeProjectRoute(fakeReq(), asRes(res), "/project/ghost/", {
      registryPath,
      portalPath: "/portal",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe("/portal");
  });

  it("serves the project data API with the per-project token and path rewrite", async () => {
    writeFileSync(
      join(stateRoot, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
      "utf8",
    );
    registerDirectProd("alpha");
    const res = fakeRes();
    const handled = await tryServeProjectRoute(
      fakeReq(),
      asRes(res),
      "/project/alpha/knowledge-graph.json?token=tok-123",
      { registryPath },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("nodes");
  });

  it("403s the project data API without the per-project token", async () => {
    writeFileSync(
      join(stateRoot, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [] }),
      "utf8",
    );
    registerDirectProd("alpha");
    const res = fakeRes();
    const handled = await tryServeProjectRoute(
      fakeReq(),
      asRes(res),
      "/project/alpha/knowledge-graph.json",
      { registryPath },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it("serves project static assets", async () => {
    writeFileSync(join(distDir, "app.js"), "console.log(1)", "utf8");
    registerDirectProd("alpha");
    const res = fakeRes();
    const handled = await tryServeProjectRoute(fakeReq(), asRes(res), "/project/alpha/app.js?token=tok-123", {
      registryPath,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("application/javascript");
  });

  it("injects the loading overlay into project SPA html", async () => {
      writeFileSync(
        join(distDir, "index.html"),
        '<!doctype html><html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>',
        "utf8",
      );
    registerDirectProd("alpha");
    const res = fakeRes();
    const handled = await tryServeProjectRoute(
      fakeReq(),
      asRes(res),
      "/project/alpha/?token=tok-123",
      { registryPath },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("ua-project-loading-overlay-script");
    expect(String(res.body)).toContain("Loading project...");
      expect(String(res.body)).toContain('src="/project/alpha/assets/app.js"');
      expect(String(res.body)).toContain('href="/project/alpha/assets/app.css"');
    });

  it("rewrites project HTML asset paths when index.html is requested directly", async () => {
    writeFileSync(
      join(distDir, "index.html"),
      '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
      "utf8",
    );
    registerDirectProd("alpha");
    const res = fakeRes();
    const handled = await tryServeProjectRoute(
      fakeReq(),
      asRes(res),
      "/project/alpha/index.html?token=tok-123",
      { registryPath },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("ua-project-loading-overlay-script");
    expect(String(res.body)).toContain('src="/project/alpha/assets/app.js"');
  });

  it("keeps runtime token cookies isolated between projects on the same gateway origin", async () => {
    const alphaDist = join(dir, "alpha-dist");
    const betaDist = join(dir, "beta-dist");
    mkdirSync(alphaDist, { recursive: true });
    mkdirSync(betaDist, { recursive: true });
    writeFileSync(join(alphaDist, "index.html"), "<!doctype html><html><body>alpha</body></html>", "utf8");
    writeFileSync(join(alphaDist, "app.js"), "alpha()", "utf8");
    writeFileSync(join(betaDist, "index.html"), "<!doctype html><html><body>beta</body></html>", "utf8");
    const store = new ProjectRegistryStore(registryPath);
    store.upsert("alpha", join(dir, "alpha-repo"), stateRoot, {
      name: "alpha",
      runtimeMode: "prod",
      prodDistDir: alphaDist,
      prodToken: "alpha-tok",
      status: "running",
    });
    store.upsert("beta", join(dir, "beta-repo"), stateRoot, {
      name: "beta",
      runtimeMode: "prod",
      prodDistDir: betaDist,
      prodToken: "beta-tok",
      status: "running",
    });

    const alphaIndex = fakeRes();
    await tryServeProjectRoute(fakeReq(), asRes(alphaIndex), "/project/alpha/?token=alpha-tok", { registryPath });
    const betaIndex = fakeRes();
    await tryServeProjectRoute(fakeReq(), asRes(betaIndex), "/project/beta/?token=beta-tok", { registryPath });

    const req = fakeReq();
    req.headers.cookie = cookieHeaderFrom(alphaIndex, betaIndex);
    const asset = fakeRes();
    await tryServeProjectRoute(req, asRes(asset), "/project/alpha/app.js", { registryPath });

    expect(asset.statusCode).toBe(200);
    expect(String(asset.body)).toBe("alpha()");
  });

  it("does not collide runtime token cookies for similar project ids", async () => {
    const dottedDist = join(dir, "dotted-dist");
    const underscoredDist = join(dir, "underscored-dist");
    mkdirSync(dottedDist, { recursive: true });
    mkdirSync(underscoredDist, { recursive: true });
    writeFileSync(join(dottedDist, "index.html"), "<!doctype html><html><body>dotted</body></html>", "utf8");
    writeFileSync(join(dottedDist, "app.js"), "dotted()", "utf8");
    writeFileSync(join(underscoredDist, "index.html"), "<!doctype html><html><body>underscored</body></html>", "utf8");
    const store = new ProjectRegistryStore(registryPath);
    store.upsert("alpha.one", join(dir, "dotted-repo"), stateRoot, {
      name: "dotted",
      runtimeMode: "prod",
      prodDistDir: dottedDist,
      prodToken: "dotted-tok",
      status: "running",
    });
    store.upsert("alpha_one", join(dir, "underscored-repo"), stateRoot, {
      name: "underscored",
      runtimeMode: "prod",
      prodDistDir: underscoredDist,
      prodToken: "underscored-tok",
      status: "running",
    });

    const dottedIndex = fakeRes();
    await tryServeProjectRoute(fakeReq(), asRes(dottedIndex), "/project/alpha.one/?token=dotted-tok", { registryPath });
    const underscoredIndex = fakeRes();
    await tryServeProjectRoute(fakeReq(), asRes(underscoredIndex), "/project/alpha_one/?token=underscored-tok", { registryPath });

    const req = fakeReq();
    req.headers.cookie = cookieHeaderFrom(dottedIndex, underscoredIndex);
    const asset = fakeRes();
    await tryServeProjectRoute(req, asRes(asset), "/project/alpha.one/app.js", { registryPath });

    expect(asset.statusCode).toBe(200);
    expect(String(asset.body)).toBe("dotted()");
  });

    it("keeps project navigation on the project route when adding a missing token", async () => {
      writeFileSync(join(distDir, "index.html"), "<!doctype html><html><body><div id='root'></div></body></html>", "utf8");
      registerDirectProd("alpha");
      const res = fakeRes();
      const handled = await tryServeProjectRoute(
        fakeReq(),
        asRes(res),
        "/project/alpha/",
        { registryPath },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(302);
      expect(res.headers.Location).toBe("/project/alpha/?token=tok-123");
  });

  it("sets the active-project cookie on GET", async () => {
    writeFileSync(join(distDir, "app.js"), "x", "utf8");
    registerDirectProd("alpha");
    const res = fakeRes();
    await tryServeProjectRoute(fakeReq("GET"), asRes(res), "/project/alpha/app.js?token=tok-123", { registryPath });
    expect(setCookies(res)).toContainEqual(expect.stringContaining(`${ACTIVE_PROJECT_COOKIE}=alpha`));
    expect(setCookies(res)).toContainEqual(expect.stringContaining("SameSite=Lax"));
  });

  it("preserves an existing Set-Cookie header when setting the active-project cookie", async () => {
    writeFileSync(join(distDir, "app.js"), "x", "utf8");
    registerDirectProd("alpha");
    const res = fakeRes();
    res.setHeader("Set-Cookie", "ua_session=abc; Path=/; HttpOnly");
    await tryServeProjectRoute(fakeReq("GET"), asRes(res), "/project/alpha/app.js?token=tok-123", { registryPath });
    expect(setCookies(res)).toContain("ua_session=abc; Path=/; HttpOnly");
    expect(setCookies(res)).toContainEqual(expect.stringContaining(`${ACTIVE_PROJECT_COOKIE}=alpha`));
  });

  it("does not set the active-project cookie on POST", async () => {
    registerDirectProd("alpha");
    const res = fakeRes();
    await tryServeProjectRoute(fakeReq("POST"), asRes(res), "/project/alpha/data", { registryPath });
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  it("503s a project under maintenance before touching the runtime", async () => {
    registerDirectProd("alpha");
    const res = fakeRes();
    const handled = await tryServeProjectRoute(fakeReq(), asRes(res), "/project/alpha/index.html", {
      registryPath,
      maintenanceState: { enabled: true, scope: "project", projectIds: ["alpha"] },
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Content-Type"]).toContain("text/html");
  });

  it("ignores maintenance scoped to a different project", async () => {
    writeFileSync(join(distDir, "app.js"), "x", "utf8");
    registerDirectProd("alpha");
    const res = fakeRes();
    await tryServeProjectRoute(fakeReq(), asRes(res), "/project/alpha/app.js?token=tok-123", {
      registryPath,
      maintenanceState: { enabled: true, scope: "project", projectIds: ["beta"] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("serves project semantic-search with the per-project token", async () => {
    writeFileSync(
      join(stateRoot, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "n1", type: "file", name: "app" }] }),
      "utf8",
    );
    writeFileSync(
      join(stateRoot, ".understand-anything", "embeddings.json"),
      JSON.stringify({ n1: [1, 0] }),
      "utf8",
    );
    registerDirectProd("alpha");
    const req = {
      method: "POST",
      headers: {},
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ query: "auth flow", limit: 5 }));
      },
    } as unknown as IncomingMessage;
    const res = fakeRes();

    const handled = await tryServeProjectRoute(
      req,
      asRes(res),
      "/project/alpha/semantic-search?token=tok-123",
      {
        registryPath,
        embeddingProvider: { name: "fake-embedding", embed: async () => [1, 0] },
      },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("\"nodeId\":\"n1\"");
  });
});
