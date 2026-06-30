import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPublicProjectPath,
  hasProjectLiveAccess,
  parsePublicProjectPath,
  ProjectRegistryStore,
  validateProjectRegistry,
} from "./project-registry.js";

let dir: string;
let registryPath: string;
let store: ProjectRegistryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ua-registry-"));
  registryPath = join(dir, "registry.json");
  store = new ProjectRegistryStore(registryPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("read", () => {
  it("returns empty registry when file missing", () => {
    expect(store.read()).toEqual({ version: 2, updatedAt: null, projects: {} });
  });

  it("falls back to empty on corrupt JSON", () => {
    writeFileSync(registryPath, "{ not json", "utf8");
    expect(store.read().projects).toEqual({});
  });

  it("falls back to empty when projects is not an object", () => {
    writeFileSync(registryPath, JSON.stringify({ version: 2, projects: [] }), "utf8");
    expect(store.read().projects).toEqual({});
  });

  it("does not warn for a schema-valid registry", () => {
    const onInvalid = vi.fn();
    new ProjectRegistryStore(registryPath, { onInvalid }).upsert("alpha", "/r/a", "/s/a", {
      name: "Alpha",
      runtimeMode: "dev",
    });
    new ProjectRegistryStore(registryPath, { onInvalid }).read();
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("warns but still returns the parsed object on schema violation", () => {
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 2,
        updatedAt: null,
        projects: { alpha: { id: "alpha", runtimeMode: "bogus" } },
      }),
      "utf8",
    );
    const onInvalid = vi.fn();
    const result = new ProjectRegistryStore(registryPath, { onInvalid }).read();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(result.projects.alpha?.runtimeMode).toBe("bogus");
  });
});

describe("validateProjectRegistry", () => {
  it("accepts an empty registry", () => {
    expect(validateProjectRegistry({ version: 2, updatedAt: null, projects: {} })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects an invalid runtimeMode enum", () => {
    const result = validateProjectRegistry({
      version: 2,
      updatedAt: null,
      projects: { a: { id: "a", runtimeMode: "bogus" } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("upsert + list round-trip", () => {
  it("upserts and reads back a normalized record", () => {
    const record = store.upsert("alpha", "/repo/alpha", "/state/alpha", {
      name: "Alpha",
      accessUrl: "http://localhost:1234/",
      runtimeMode: "dev",
    });
    expect(record.id).toBe("alpha");
    expect(record.name).toBe("Alpha");
    expect(record.publicPath).toBe("/project/alpha/");
    // dev runtime: internalUrl derives from accessUrl, origin-normalized (trailing slash stripped)
    expect(record.internalUrl).toBe("http://localhost:1234");

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("alpha");
  });

  it("prod runtime clears internalUrl", () => {
    const record = store.upsert("beta", "/repo/beta", "/state/beta", {
      runtimeMode: "prod",
      accessUrl: "http://example.com",
      internalUrl: "http://internal",
    });
    expect(record.internalUrl).toBe("");
  });

  it("does not overwrite a good projectRoot with empty", () => {
    store.upsert("gamma", "/repo/gamma", "/state/gamma", { name: "G" });
    const record = store.upsert("gamma", "", "/state/gamma", { name: "G2" });
    expect(record.projectRoot).toBe("/repo/gamma");
    expect(record.name).toBe("G2");
  });

  it("lists records sorted by name", () => {
    store.upsert("z", "/r/z", "/s/z", { name: "Zeta" });
    store.upsert("a", "/r/a", "/s/a", { name: "Alpha" });
    const names = store.list().map((r) => r.name);
    expect(names).toEqual(["Alpha", "Zeta"]);
  });

  it("preserves all records across sequential upserts (lock holds)", () => {
    for (let i = 0; i < 5; i += 1) {
      store.upsert(`p${i}`, `/r/p${i}`, `/s/p${i}`, { name: `P${i}` });
    }
    expect(store.list()).toHaveLength(5);
  });
});

describe("get / remove / clear", () => {
  it("gets a single record by id", () => {
    store.upsert("alpha", "/r/a", "/s/a", { name: "Alpha" });
    expect(store.get("alpha")?.name).toBe("Alpha");
    expect(store.get("missing")).toBeNull();
    expect(store.get("")).toBeNull();
  });

  it("removes a record", () => {
    store.upsert("alpha", "/r/a", "/s/a", {});
    expect(store.remove("alpha")).toBe(true);
    expect(store.remove("alpha")).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("clears the registry", () => {
    store.upsert("alpha", "/r/a", "/s/a", {});
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});

describe("public path helpers", () => {
  it("builds and parses public project paths round-trip", () => {
    expect(buildPublicProjectPath("alpha")).toBe("/project/alpha/");
    expect(buildPublicProjectPath("alpha", "/knowledge-graph.json")).toBe(
      "/project/alpha/knowledge-graph.json",
    );
    expect(buildPublicProjectPath("")).toBe("");

    const parsed = parsePublicProjectPath("/project/alpha/meta.json");
    expect(parsed).toEqual({ projectId: "alpha", upstreamPath: "/meta.json" });
    expect(parsePublicProjectPath("/project/alpha")).toEqual({
      projectId: "alpha",
      upstreamPath: "/",
    });
    expect(parsePublicProjectPath("/other/path")).toBeNull();
  });
});

describe("hasProjectLiveAccess", () => {
  it("is true for a running proxy runtime", () => {
    const record = store.upsert("alpha", "/r/a", "/s/a", {
      runtimeMode: "dev",
      accessUrl: "http://localhost:9",
    });
    expect(hasProjectLiveAccess(record)).toBe(true);
  });

  it("is true for a running direct prod runtime", () => {
    const record = store.upsert("alpha", "/r/a", "/s/a", {
      runtimeMode: "prod",
      prodDistDir: "/s/a/dashboard-dist",
      prodToken: "tok",
      status: "running",
    });
    expect(hasProjectLiveAccess(record)).toBe(true);
  });

  it("does not treat access URLs alone as live", () => {
    const record = store.upsert("alpha", "/r/a", "/s/a", {
      accessUrl: "http://127.0.0.1:18666/project/alpha/",
      dashboardUrl: "http://127.0.0.1:18666/project/alpha/",
      status: "running",
    });
    expect(hasProjectLiveAccess(record)).toBe(false);
  });

  it("is false when not running", () => {
    expect(hasProjectLiveAccess(null)).toBe(false);
    expect(
      hasProjectLiveAccess({
        id: "x",
        name: "x",
        projectRoot: "",
        stateRoot: "",
        accessUrl: "",
        dashboardUrl: "",
        internalUrl: "",
        publicPath: "",
        runtimeMode: "",
        prodDistDir: "",
        prodToken: "",
        status: "stopped",
      }),
    ).toBe(false);
  });
});
