/**
 * Schema fingerprint diff.
 *
 * Compares a committed baseline fingerprint against the one extracted from the
 * currently installed upstream, classifying changes by severity:
 *
 * - warning: upstream ADDED an enum value (a new node/edge type, or a new
 *   OPTIONAL field). Our orchestration keeps working; we just don't yet exploit
 *   the new capability. Surfaced, not blocking.
 * - fatal: upstream REMOVED an enum value, removed a field, or changed a
 *   field's required-ness in a way that can break our pipeline (a previously
 *   required field disappearing, or a previously optional field becoming
 *   required). These mean the contract we build against has drifted.
 */

import type { SchemaFingerprint } from "./fingerprint.js";

export interface FingerprintChange {
  kind:
    | "enum-added"
    | "enum-removed"
    | "field-added-optional"
    | "field-added-required"
    | "field-removed"
    | "field-required-to-optional"
    | "field-optional-to-required";
  scope: "nodeTypes" | "edgeTypes" | "graph" | "node" | "edge";
  value: string;
  detail: string;
}

export interface FingerprintDiff {
  ok: boolean;
  fatal: FingerprintChange[];
  warnings: FingerprintChange[];
}

function diffEnum(
  scope: "nodeTypes" | "edgeTypes",
  baseline: string[],
  current: string[],
  fatal: FingerprintChange[],
  warnings: FingerprintChange[],
): void {
  const base = new Set(baseline);
  const cur = new Set(current);
  for (const value of current) {
    if (!base.has(value)) {
      warnings.push({ kind: "enum-added", scope, value, detail: `${scope}: upstream added '${value}'` });
    }
  }
  for (const value of baseline) {
    if (!cur.has(value)) {
      fatal.push({ kind: "enum-removed", scope, value, detail: `${scope}: upstream removed '${value}'` });
    }
  }
}

function diffFields(
  scope: "graph" | "node" | "edge",
  baselineRequired: string[],
  baselineOptional: string[],
  currentRequired: string[],
  currentOptional: string[],
  fatal: FingerprintChange[],
  warnings: FingerprintChange[],
): void {
  const baseReq = new Set(baselineRequired);
  const baseOpt = new Set(baselineOptional);
  const curReq = new Set(currentRequired);
  const curOpt = new Set(currentOptional);
  const baseAll = new Set([...baseReq, ...baseOpt]);
  const curAll = new Set([...curReq, ...curOpt]);

  for (const field of curAll) {
    if (baseAll.has(field)) continue;
    if (curReq.has(field)) {
      fatal.push({
        kind: "field-added-required",
        scope,
        value: field,
        detail: `${scope}.${field}: upstream added a new REQUIRED field`,
      });
    } else {
      warnings.push({
        kind: "field-added-optional",
        scope,
        value: field,
        detail: `${scope}.${field}: upstream added a new optional field`,
      });
    }
  }

  for (const field of baseAll) {
    if (!curAll.has(field)) {
      fatal.push({
        kind: "field-removed",
        scope,
        value: field,
        detail: `${scope}.${field}: upstream removed this field`,
      });
      continue;
    }
    const wasRequired = baseReq.has(field);
    const isRequired = curReq.has(field);
    if (wasRequired && !isRequired) {
      warnings.push({
        kind: "field-required-to-optional",
        scope,
        value: field,
        detail: `${scope}.${field}: required -> optional`,
      });
    } else if (!wasRequired && isRequired) {
      fatal.push({
        kind: "field-optional-to-required",
        scope,
        value: field,
        detail: `${scope}.${field}: optional -> required`,
      });
    }
  }
}

export function diffFingerprint(baseline: SchemaFingerprint, current: SchemaFingerprint): FingerprintDiff {
  const fatal: FingerprintChange[] = [];
  const warnings: FingerprintChange[] = [];

  diffEnum("nodeTypes", baseline.nodeTypes, current.nodeTypes, fatal, warnings);
  diffEnum("edgeTypes", baseline.edgeTypes, current.edgeTypes, fatal, warnings);
  diffFields(
    "graph",
    baseline.graphRequiredFields,
    baseline.graphOptionalFields,
    current.graphRequiredFields,
    current.graphOptionalFields,
    fatal,
    warnings,
  );
  diffFields(
    "node",
    baseline.nodeRequiredFields,
    baseline.nodeOptionalFields,
    current.nodeRequiredFields,
    current.nodeOptionalFields,
    fatal,
    warnings,
  );
  diffFields(
    "edge",
    baseline.edgeRequiredFields,
    baseline.edgeOptionalFields,
    current.edgeRequiredFields,
    current.edgeOptionalFields,
    fatal,
    warnings,
  );

  return { ok: fatal.length === 0, fatal, warnings };
}
