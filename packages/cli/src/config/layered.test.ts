import { describe, expect, it } from "vitest";
import { resolveLayered } from "./layered.js";

describe("resolveLayered", () => {
  it("prefers CLI over env over profile over base", () => {
    expect(resolveLayered({ cli: "c", env: "e", profile: "p", base: "b" })).toBe("c");
    expect(resolveLayered({ cli: null, env: "e", profile: "p", base: "b" })).toBe("e");
    expect(resolveLayered({ cli: null, env: undefined, profile: "p", base: "b" })).toBe("p");
    expect(resolveLayered({ cli: null, env: undefined, profile: undefined, base: "b" })).toBe("b");
  });

  it("treats null/undefined CLI as not provided", () => {
    expect(resolveLayered<boolean>({ cli: null, profile: true })).toBe(true);
  });

  it("returns undefined when no layer provides a value", () => {
    expect(resolveLayered({})).toBeUndefined();
  });

  it("resolves each field independently (no whole-section replacement)", () => {
    const profile = { portal: true, registry: undefined };
    const base = { portal: false, registry: "/r.json" };
    const portal = resolveLayered({ profile: profile.portal, base: base.portal });
    const registry = resolveLayered({ profile: profile.registry, base: base.registry });
    expect(portal).toBe(true);
    expect(registry).toBe("/r.json");
  });
});
