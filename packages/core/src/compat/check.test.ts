import { describe, expect, it, vi } from "vitest";
import {
  buildBaseline,
  CompatError,
  defaultBaselinePath,
  loadBaseline,
  runCompatCheck,
  type CompatBaseline,
} from "./check.js";
import type { SchemaFingerprint } from "./fingerprint.js";

function zEnum(values: string[]) {
  return { options: values };
}
function zObject(shape: Record<string, unknown>) {
  return { shape };
}
function zArray(element: unknown) {
  return { element };
}
function zScalar() {
  return {};
}
function zOptional(inner: unknown) {
  return { def: { type: "optional", innerType: inner } };
}

function fakeCore(): Record<string, unknown> {
  return {
    KnowledgeGraphSchema: zObject({
      version: zScalar(),
      nodes: zArray(zObject({ id: zScalar(), type: zEnum(["file", "function"]), filePath: zOptional(zScalar()) })),
      edges: zArray(zObject({ source: zScalar(), type: zEnum(["calls", "imports"]) })),
    }),
  };
}

function fakeFingerprint(): SchemaFingerprint {
  return {
    nodeTypes: ["file", "function"],
    edgeTypes: ["calls", "imports"],
    graphRequiredFields: ["edges", "nodes", "version"],
    graphOptionalFields: [],
    nodeRequiredFields: ["id", "type"],
    nodeOptionalFields: ["filePath"],
    edgeRequiredFields: ["source", "type"],
    edgeOptionalFields: [],
  };
}

function baselineObject(overrides: Partial<CompatBaseline> = {}): CompatBaseline {
  return {
    verifiedUpstreamVersion: "0.1.0",
    schemaFingerprint: fakeFingerprint(),
    requiredCoreExports: ["GraphBuilder"],
    requiredScripts: ["scan-project.mjs"],
    ...overrides,
  };
}

function fakeBootstrap(pluginRoot = "/plugin") {
  return vi.fn().mockResolvedValue({
    pluginRoot,
    skillDir: `${pluginRoot}/skills/understand`,
    core: fakeCore(),
    resolvedRoot: pluginRoot,
    coreModule: { modulePath: `${pluginRoot}/core.js` },
  });
}

describe("loadBaseline", () => {
  it("parses a valid baseline", () => {
    const read = () => JSON.stringify(baselineObject());
    const parsed = loadBaseline("/x/compat.json", read);
    expect(parsed.verifiedUpstreamVersion).toBe("0.1.0");
  });

  it("throws CompatError when the file cannot be read", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(() => loadBaseline("/missing.json", read)).toThrow(/unable to read compat baseline/);
  });

  it("throws CompatError on invalid JSON", () => {
    expect(() => loadBaseline("/x.json", () => "{not json")).toThrow(/not valid JSON/);
  });

  it("throws CompatError when required fields are missing", () => {
    expect(() => loadBaseline("/x.json", () => JSON.stringify({ foo: 1 }))).toThrow(/missing required fields/);
  });
});

describe("defaultBaselinePath", () => {
  it("walks up to find compat.json", () => {
    const path = defaultBaselinePath((p) => String(p).endsWith("/compat.json"));
    expect(path).toMatch(/compat\.json$/);
  });

  it("throws CompatError when no compat.json is found in ancestors", () => {
    expect(() => defaultBaselinePath(() => false)).toThrow(CompatError);
  });
});

describe("runCompatCheck", () => {
  it("reports ok and version match against a matching upstream", async () => {
    const read = (p: string) => {
      if (p.endsWith("compat.json")) return JSON.stringify(baselineObject());
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      throw new Error(`unexpected read ${p}`);
    };
    const report = await runCompatCheck(
      { baselinePath: "/x/compat.json" },
      { readFileSync: read, bootstrap: fakeBootstrap() },
    );
    expect(report.ok).toBe(true);
    expect(report.installedVersion).toBe("0.1.0");
    expect(report.verifiedVersion).toBe("0.1.0");
    expect(report.versionMatch).toBe(true);
    expect(report.diff.fatal).toEqual([]);
  });

  it("flags a fatal diff when upstream drops an enum value", async () => {
    const drifted = baselineObject();
    drifted.schemaFingerprint.nodeTypes = ["file", "function", "module"]; // baseline has 'module', upstream lacks it
    const read = (p: string) => {
      if (p.endsWith("compat.json")) return JSON.stringify(drifted);
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      throw new Error(`unexpected read ${p}`);
    };
    const report = await runCompatCheck(
      { baselinePath: "/x/compat.json" },
      { readFileSync: read, bootstrap: fakeBootstrap() },
    );
    expect(report.ok).toBe(false);
    expect(report.diff.fatal[0]).toMatchObject({ kind: "enum-removed", value: "module" });
  });

  it("reports version mismatch but stays ok when only the version differs", async () => {
    const read = (p: string) => {
      if (p.endsWith("compat.json")) return JSON.stringify(baselineObject({ verifiedUpstreamVersion: "0.1.0" }));
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.2.0" });
      throw new Error(`unexpected read ${p}`);
    };
    const report = await runCompatCheck(
      { baselinePath: "/x/compat.json" },
      { readFileSync: read, bootstrap: fakeBootstrap() },
    );
    expect(report.ok).toBe(true);
    expect(report.versionMatch).toBe(false);
    expect(report.installedVersion).toBe("0.2.0");
  });

  it("returns null installedVersion when the upstream package.json is unreadable", async () => {
    const read = (p: string) => {
      if (p.endsWith("compat.json")) return JSON.stringify(baselineObject());
      throw new Error("ENOENT");
    };
    const report = await runCompatCheck(
      { baselinePath: "/x/compat.json" },
      { readFileSync: read, bootstrap: fakeBootstrap() },
    );
    expect(report.installedVersion).toBeNull();
    expect(report.versionMatch).toBe(false);
  });
});

describe("buildBaseline", () => {
  it("builds a baseline object from a live upstream", async () => {
    const read = (p: string) => {
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.1.0" });
      throw new Error(`unexpected read ${p}`);
    };
    const baseline = await buildBaseline({}, { readFileSync: read, bootstrap: fakeBootstrap() });
    expect(baseline.verifiedUpstreamVersion).toBe("0.1.0");
    expect(baseline.schemaFingerprint.nodeTypes).toEqual(["file", "function"]);
    expect(baseline.requiredCoreExports.length).toBeGreaterThan(0);
    expect(baseline.requiredScripts.length).toBeGreaterThan(0);
  });

  it("falls back to 'unknown' version when package.json is unreadable", async () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    const baseline = await buildBaseline({}, { readFileSync: read, bootstrap: fakeBootstrap() });
    expect(baseline.verifiedUpstreamVersion).toBe("unknown");
  });
});
