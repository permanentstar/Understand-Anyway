import { describe, expect, it, vi } from "vitest";
import { runCompat } from "./compat.js";
import type { CompatArgs } from "./args.js";

function baseArgs(overrides: Partial<CompatArgs> = {}): CompatArgs {
  return { command: "compat", pluginRoot: null, json: false, update: false, ...overrides };
}

function okReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    installedVersion: "0.1.0",
    verifiedVersion: "0.1.0",
    versionMatch: true,
    pluginRoot: "/plugin",
    diff: { ok: true, fatal: [], warnings: [] },
    current: { nodeTypes: ["a"], edgeTypes: ["b"] },
    baseline: { nodeTypes: ["a"], edgeTypes: ["b"] },
    ...overrides,
  };
}

describe("runCompat", () => {
  it("returns ok and renders a human report on a clean check", async () => {
    const check = vi.fn().mockResolvedValue(okReport());
    const lines: string[] = [];
    const result = await runCompat(baseArgs(), { log: (m) => lines.push(m), deps: { check } });

    expect(check).toHaveBeenCalledWith({ pluginRoot: null });
    expect(result.ok).toBe(true);
    expect(lines.join("\n")).toContain("compat: OK");
  });

  it("forwards --plugin-root to the check", async () => {
    const check = vi.fn().mockResolvedValue(okReport());
    await runCompat(baseArgs({ pluginRoot: "/custom" }), { log: () => {}, deps: { check } });
    expect(check).toHaveBeenCalledWith({ pluginRoot: "/custom" });
  });

  it("returns not-ok and surfaces fatal drift", async () => {
    const report = okReport({
      ok: false,
      diff: {
        ok: false,
        fatal: [{ kind: "enum-removed", scope: "nodeTypes", value: "module", detail: "nodeTypes: upstream removed 'module'" }],
        warnings: [],
      },
    });
    const check = vi.fn().mockResolvedValue(report);
    const lines: string[] = [];
    const result = await runCompat(baseArgs(), { log: (m) => lines.push(m), deps: { check } });

    expect(result.ok).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("FATAL schema drift");
    expect(out).toContain("upstream removed 'module'");
  });

  it("surfaces warnings but stays ok", async () => {
    const report = okReport({
      diff: {
        ok: true,
        fatal: [],
        warnings: [{ kind: "enum-added", scope: "nodeTypes", value: "x", detail: "nodeTypes: upstream added 'x'" }],
      },
    });
    const check = vi.fn().mockResolvedValue(report);
    const lines: string[] = [];
    const result = await runCompat(baseArgs(), { log: (m) => lines.push(m), deps: { check } });
    expect(result.ok).toBe(true);
    expect(lines.join("\n")).toContain("upstream added 'x'");
  });

  it("emits JSON when --json is set", async () => {
    const check = vi.fn().mockResolvedValue(okReport());
    const lines: string[] = [];
    await runCompat(baseArgs({ json: true }), { log: (m) => lines.push(m), deps: { check } });
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.verifiedVersion).toBe("0.1.0");
  });

  it("prints a fresh baseline with --update and never calls check", async () => {
    const baseline = {
      verifiedUpstreamVersion: "0.2.0",
      schemaFingerprint: { nodeTypes: ["a"] },
      requiredCoreExports: ["GraphBuilder"],
      requiredScripts: ["scan-project.mjs"],
    };
    const build = vi.fn().mockResolvedValue(baseline);
    const check = vi.fn();
    const lines: string[] = [];
    const result = await runCompat(baseArgs({ update: true, json: true }), {
      log: (m) => lines.push(m),
      deps: { check, build },
    });

    expect(check).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith({ pluginRoot: null });
    expect(result.ok).toBe(true);
    expect(JSON.parse(lines.join("\n")).verifiedUpstreamVersion).toBe("0.2.0");
  });
});
