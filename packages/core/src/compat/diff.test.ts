import { describe, expect, it } from "vitest";
import { diffFingerprint } from "./diff.js";
import type { SchemaFingerprint } from "./fingerprint.js";

function baseFingerprint(): SchemaFingerprint {
  return {
    nodeTypes: ["class", "file", "function"],
    edgeTypes: ["calls", "contains", "imports"],
    graphRequiredFields: ["edges", "nodes", "version"],
    graphOptionalFields: ["kind"],
    nodeRequiredFields: ["id", "type"],
    nodeOptionalFields: ["filePath"],
    edgeRequiredFields: ["source", "target", "type"],
    edgeOptionalFields: ["description"],
  };
}

describe("diffFingerprint", () => {
  it("reports ok with no changes for identical fingerprints", () => {
    const diff = diffFingerprint(baseFingerprint(), baseFingerprint());
    expect(diff.ok).toBe(true);
    expect(diff.fatal).toEqual([]);
    expect(diff.warnings).toEqual([]);
  });

  it("treats an added enum value as a non-blocking warning", () => {
    const current = baseFingerprint();
    current.nodeTypes = [...current.nodeTypes, "module"];
    const diff = diffFingerprint(baseFingerprint(), current);
    expect(diff.ok).toBe(true);
    expect(diff.warnings).toHaveLength(1);
    expect(diff.warnings[0]).toMatchObject({ kind: "enum-added", scope: "nodeTypes", value: "module" });
  });

  it("treats a removed enum value as fatal", () => {
    const current = baseFingerprint();
    current.edgeTypes = current.edgeTypes.filter((t) => t !== "imports");
    const diff = diffFingerprint(baseFingerprint(), current);
    expect(diff.ok).toBe(false);
    expect(diff.fatal).toHaveLength(1);
    expect(diff.fatal[0]).toMatchObject({ kind: "enum-removed", scope: "edgeTypes", value: "imports" });
  });

  it("treats a new optional field as a warning", () => {
    const current = baseFingerprint();
    current.nodeOptionalFields = [...current.nodeOptionalFields, "knowledgeMeta"];
    const diff = diffFingerprint(baseFingerprint(), current);
    expect(diff.ok).toBe(true);
    expect(diff.warnings[0]).toMatchObject({ kind: "field-added-optional", scope: "node", value: "knowledgeMeta" });
  });

  it("treats a new required field as fatal", () => {
    const current = baseFingerprint();
    current.nodeRequiredFields = [...current.nodeRequiredFields, "owner"];
    const diff = diffFingerprint(baseFingerprint(), current);
    expect(diff.ok).toBe(false);
    expect(diff.fatal[0]).toMatchObject({ kind: "field-added-required", scope: "node", value: "owner" });
  });

  it("treats a removed field as fatal", () => {
    const current = baseFingerprint();
    current.nodeOptionalFields = [];
    const diff = diffFingerprint(baseFingerprint(), current);
    expect(diff.ok).toBe(false);
    expect(diff.fatal[0]).toMatchObject({ kind: "field-removed", scope: "node", value: "filePath" });
  });

  it("treats required -> optional as a warning", () => {
    const current = baseFingerprint();
    current.nodeRequiredFields = ["id"];
    current.nodeOptionalFields = ["filePath", "type"];
    const diff = diffFingerprint(baseFingerprint(), current);
    expect(diff.ok).toBe(true);
    expect(diff.warnings[0]).toMatchObject({ kind: "field-required-to-optional", scope: "node", value: "type" });
  });

  it("treats optional -> required as fatal", () => {
    const current = baseFingerprint();
    current.nodeOptionalFields = [];
    current.nodeRequiredFields = ["filePath", "id", "type"];
    const diff = diffFingerprint(baseFingerprint(), current);
    expect(diff.ok).toBe(false);
    expect(diff.fatal[0]).toMatchObject({ kind: "field-optional-to-required", scope: "node", value: "filePath" });
  });
});
