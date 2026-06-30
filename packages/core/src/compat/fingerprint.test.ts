import { describe, expect, it } from "vitest";
import { extractSchemaFingerprint, FingerprintError } from "./fingerprint.js";

// Minimal zod-v4-like fakes: just the structural surface the extractor reads.
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
/** zod v4 optional wrapper. */
function zOptionalV4(inner: unknown) {
  return { def: { type: "optional", innerType: inner } };
}
/** zod v3 optional wrapper. */
function zOptionalV3(inner: unknown) {
  return { _def: { typeName: "ZodOptional", innerType: inner } };
}

function makeCore(opts: { optionalStyle?: "v4" | "v3" } = {}): Record<string, unknown> {
  const zOptional = opts.optionalStyle === "v3" ? zOptionalV3 : zOptionalV4;
  const nodeSchema = zObject({
    id: zScalar(),
    name: zScalar(),
    summary: zScalar(),
    tags: zScalar(),
    complexity: zScalar(),
    type: zEnum(["function", "file", "class"]),
    filePath: zOptional(zScalar()),
    lineRange: zOptional(zScalar()),
  });
  const edgeSchema = zObject({
    source: zScalar(),
    target: zScalar(),
    direction: zScalar(),
    weight: zScalar(),
    type: zEnum(["calls", "imports", "contains"]),
    description: zOptional(zScalar()),
  });
  const graphSchema = zObject({
    version: zScalar(),
    project: zScalar(),
    layers: zScalar(),
    tour: zScalar(),
    nodes: zArray(nodeSchema),
    edges: zArray(edgeSchema),
    kind: zOptional(zScalar()),
  });
  return { KnowledgeGraphSchema: graphSchema };
}

describe("extractSchemaFingerprint", () => {
  it("extracts sorted enums and partitioned fields (zod v4 optional)", () => {
    const fp = extractSchemaFingerprint(makeCore());
    expect(fp.nodeTypes).toEqual(["class", "file", "function"]);
    expect(fp.edgeTypes).toEqual(["calls", "contains", "imports"]);
    expect(fp.graphRequiredFields).toEqual(["edges", "layers", "nodes", "project", "tour", "version"]);
    expect(fp.graphOptionalFields).toEqual(["kind"]);
    expect(fp.nodeRequiredFields).toEqual(["complexity", "id", "name", "summary", "tags", "type"]);
    expect(fp.nodeOptionalFields).toEqual(["filePath", "lineRange"]);
    expect(fp.edgeRequiredFields).toEqual(["direction", "source", "target", "type", "weight"]);
    expect(fp.edgeOptionalFields).toEqual(["description"]);
  });

  it("detects optionality via the zod v3 wrapper shape too", () => {
    const fp = extractSchemaFingerprint(makeCore({ optionalStyle: "v3" }));
    expect(fp.graphOptionalFields).toEqual(["kind"]);
    expect(fp.nodeOptionalFields).toEqual(["filePath", "lineRange"]);
  });

  it("detects optionality via an isOptional() method", () => {
    const nodeSchema = zObject({
      id: zScalar(),
      type: zEnum(["function"]),
      filePath: { isOptional: () => true },
    });
    const core = {
      KnowledgeGraphSchema: zObject({
        version: zScalar(),
        nodes: zArray(nodeSchema),
        edges: zArray(zObject({ type: zEnum(["calls"]) })),
      }),
    };
    const fp = extractSchemaFingerprint(core);
    expect(fp.nodeOptionalFields).toEqual(["filePath"]);
    expect(fp.nodeRequiredFields).toEqual(["id", "type"]);
  });

  it("throws when KnowledgeGraphSchema is absent", () => {
    expect(() => extractSchemaFingerprint({})).toThrow(FingerprintError);
  });

  it("throws when the graph schema has no object shape", () => {
    expect(() => extractSchemaFingerprint({ KnowledgeGraphSchema: { options: ["x"] } })).toThrow(/no object shape/);
  });

  it("throws when nodes is not an array schema", () => {
    const core = {
      KnowledgeGraphSchema: zObject({ nodes: zScalar(), edges: zArray(zObject({ type: zEnum(["calls"]) })) }),
    };
    expect(() => extractSchemaFingerprint(core)).toThrow(/element schema/);
  });

  it("throws when node schema lacks a type enum", () => {
    const core = {
      KnowledgeGraphSchema: zObject({
        nodes: zArray(zObject({ id: zScalar() })),
        edges: zArray(zObject({ type: zEnum(["calls"]) })),
      }),
    };
    expect(() => extractSchemaFingerprint(core)).toThrow(/missing a `type` field/);
  });
});
