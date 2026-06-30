/**
 * Schema fingerprint extraction (drift probe).
 *
 * Reads the upstream `KnowledgeGraphSchema` (a runtime zod object, not a
 * TS-only type) and derives a stable, comparable fingerprint of the graph
 * contract: node/edge type enums + per-level required/optional field sets.
 *
 * We deliberately drill down from the single `KnowledgeGraphSchema` export that
 * the upstream main barrel guarantees, rather than importing the per-element
 * schemas from the `./schema` subpath (which the barrel does not re-export).
 * This keeps the probe working against the documented public surface.
 *
 * zod-version note: the installed upstream dep is zod v4. Optionality detection
 * tolerates both v4 (`def.type === "optional"`) and v3 (`_def.typeName ===
 * "ZodOptional"`) shapes so the probe survives a resolved-zod downgrade.
 */

export interface SchemaFingerprint {
  nodeTypes: string[];
  edgeTypes: string[];
  graphRequiredFields: string[];
  graphOptionalFields: string[];
  nodeRequiredFields: string[];
  nodeOptionalFields: string[];
  edgeRequiredFields: string[];
  edgeOptionalFields: string[];
}

export class FingerprintError extends Error {}

type ZodLike = {
  shape?: Record<string, unknown>;
  element?: unknown;
  options?: unknown;
  def?: { type?: string; innerType?: unknown };
  _def?: { typeName?: string; innerType?: unknown };
  isOptional?: () => boolean;
};

function asZod(value: unknown, what: string): ZodLike {
  if (value === null || typeof value !== "object") {
    throw new FingerprintError(`expected a zod schema for ${what}, got ${value === null ? "null" : typeof value}`);
  }
  return value as ZodLike;
}

function shapeOf(schema: ZodLike, what: string): Record<string, unknown> {
  // zod v4/v3 both expose `.shape` on objects; v4 may expose it as a getter.
  const shape = schema.shape;
  if (!shape || typeof shape !== "object") {
    throw new FingerprintError(`schema for ${what} has no object shape (not a ZodObject?)`);
  }
  return shape as Record<string, unknown>;
}

function isOptional(field: ZodLike): boolean {
  if (typeof field.isOptional === "function") {
    try {
      return field.isOptional();
    } catch {
      // fall through to structural detection
    }
  }
  if (field.def?.type === "optional") return true;
  if (field._def?.typeName === "ZodOptional") return true;
  return false;
}

function enumOptions(field: unknown, what: string): string[] {
  const z = asZod(field, what);
  const options = z.options;
  if (!Array.isArray(options)) {
    throw new FingerprintError(`enum for ${what} has no string options array`);
  }
  const values = options.filter((o): o is string => typeof o === "string");
  if (values.length === 0) {
    throw new FingerprintError(`enum for ${what} produced no string values`);
  }
  return [...values].sort();
}

/** Unwrap `.optional()` (and similar) to reach the inner schema. */
function unwrap(field: ZodLike): ZodLike {
  let current: ZodLike = field;
  for (let i = 0; i < 8; i += 1) {
    const inner = current.def?.innerType ?? current._def?.innerType;
    if (inner === undefined) break;
    current = asZod(inner, "wrapped schema");
  }
  return current;
}

/** Resolve the element schema of a `ZodArray` (zod v4 `.element`). */
function arrayElement(field: unknown, what: string): ZodLike {
  const z = asZod(field, what);
  if (z.element !== undefined) return asZod(z.element, `${what}.element`);
  const inner = z.def?.["element" as keyof typeof z.def] ?? (z._def as Record<string, unknown> | undefined)?.["type"];
  if (inner !== undefined) return asZod(inner, `${what}.element`);
  throw new FingerprintError(`array schema for ${what} exposes no element schema`);
}

function partitionFields(shape: Record<string, unknown>, what: string): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    if (isOptional(asZod(value, `${what}.${key}`))) optional.push(key);
    else required.push(key);
  }
  return { required: required.sort(), optional: optional.sort() };
}

/**
 * Extract the graph-contract fingerprint from an upstream core module.
 * Requires `core.KnowledgeGraphSchema` (guaranteed by the upstream barrel).
 */
export function extractSchemaFingerprint(core: unknown): SchemaFingerprint {
  asZod(core, "upstream core module");
  // `core` is a module namespace, not a zod object; read the named export.
  const schema = asZod((core as Record<string, unknown>).KnowledgeGraphSchema, "KnowledgeGraphSchema");

  const graphShape = shapeOf(schema, "KnowledgeGraphSchema");
  const graphFields = partitionFields(graphShape, "graph");

  const nodesField = graphShape["nodes"];
  if (nodesField === undefined) throw new FingerprintError("KnowledgeGraphSchema is missing a `nodes` field");
  const nodeSchema = arrayElement(unwrap(asZod(nodesField, "graph.nodes")), "graph.nodes");
  const nodeShape = shapeOf(nodeSchema, "node");
  const nodeFields = partitionFields(nodeShape, "node");
  const nodeTypeField = nodeShape["type"];
  if (nodeTypeField === undefined) throw new FingerprintError("node schema is missing a `type` field");
  const nodeTypes = enumOptions(unwrap(asZod(nodeTypeField, "node.type")), "node.type");

  const edgesField = graphShape["edges"];
  if (edgesField === undefined) throw new FingerprintError("KnowledgeGraphSchema is missing an `edges` field");
  const edgeSchema = arrayElement(unwrap(asZod(edgesField, "graph.edges")), "graph.edges");
  const edgeShape = shapeOf(edgeSchema, "edge");
  const edgeFields = partitionFields(edgeShape, "edge");
  const edgeTypeField = edgeShape["type"];
  if (edgeTypeField === undefined) throw new FingerprintError("edge schema is missing a `type` field");
  const edgeTypes = enumOptions(unwrap(asZod(edgeTypeField, "edge.type")), "edge.type");

  return {
    nodeTypes,
    edgeTypes,
    graphRequiredFields: graphFields.required,
    graphOptionalFields: graphFields.optional,
    nodeRequiredFields: nodeFields.required,
    nodeOptionalFields: nodeFields.optional,
    edgeRequiredFields: edgeFields.required,
    edgeOptionalFields: edgeFields.optional,
  };
}
