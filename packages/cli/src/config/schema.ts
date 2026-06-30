/**
 * Deploy-config schema validation backed by a hand-written JSON Schema.
 *
 * The schema in `deploy.schema.json` is the single source of truth: ajv
 * validates the discovered + interpolated config against it at load time, and
 * editors can point `$schema` at the same file for completion. Known fields are
 * strictly typed/enumerated; `deploy` and profile sections keep
 * `additionalProperties: true` so the existing `[key: string]: unknown`
 * passthrough (portal title/links/lang/wordmarkAlt) still works.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import deploySchema from "./deploy.schema.json" with { type: "json" };

export interface DeployConfigValidation {
  valid: boolean;
  errors: ErrorObject[];
}

let compiled: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (compiled) return compiled;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  compiled = ajv.compile(deploySchema as object);
  return compiled;
}

/** Validate a parsed deploy config against the schema. */
export function validateDeployConfig(config: unknown): DeployConfigValidation {
  const validate = getValidator();
  const valid = validate(config) as boolean;
  return { valid, errors: valid ? [] : [...(validate.errors ?? [])] };
}

/** Render ajv errors into a single human-readable string (empty when none). */
export function formatSchemaErrors(errors: ErrorObject[]): string {
  return errors
    .map((err) => {
      const where = err.instancePath || "(root)";
      const extra =
        err.keyword === "additionalProperties" && err.params && "additionalProperty" in err.params
          ? ` (${(err.params as { additionalProperty: string }).additionalProperty})`
          : "";
      return `${where} ${err.message ?? "is invalid"}${extra}`;
    })
    .join("; ");
}
