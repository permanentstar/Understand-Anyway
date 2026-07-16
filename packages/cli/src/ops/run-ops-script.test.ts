import { describe, it, expect } from "vitest";
import { resolveOpsScriptPath, OPS_SCRIPTS } from "./run-ops-script.js";

describe("resolveOpsScriptPath", () => {
  it("maps known names to dist-scripts path", () => {
    const p = resolveOpsScriptPath("daily-update", "/pkg");
    expect(p).toBe("/pkg/dist-scripts/daily-update.sh");
  });

  it("rejects unknown names", () => {
    expect(() => resolveOpsScriptPath("rm-rf", "/pkg")).toThrow(/unknown ops script/);
  });

  it("exposes the three ops entrypoints", () => {
    expect(OPS_SCRIPTS).toEqual(["daily-update", "nightly-project-sync", "refresh-prod-server"]);
  });
});
