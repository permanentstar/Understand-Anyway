/**
 * Layered field resolution: CLI > env > profile > base.
 *
 * Returns the first layer that "explicitly provided" a value, mirroring the
 * design's four-layer priority model. Whether the CLI layer counts as explicit
 * is decided by the caller (serve only passes a CLI value when the user
 * actually typed the flag), so a flag left at its default never shadows lower
 * layers. Layering is per-field, not whole-section replacement.
 */

export interface LayeredInput<T> {
  /** Layer 1: CLI explicit value (undefined/null = not provided). */
  cli?: T | null;
  /** Layer 2: env override (undefined = not provided). */
  env?: T;
  /** Layer 3: selected profile field. */
  profile?: T;
  /** Layer 4: config base field. */
  base?: T;
}

function provided<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/** Pick the highest-priority explicitly-provided value across the four layers. */
export function resolveLayered<T>(input: LayeredInput<T>): T | undefined {
  if (provided(input.cli)) return input.cli;
  if (provided(input.env)) return input.env;
  if (provided(input.profile)) return input.profile;
  if (provided(input.base)) return input.base;
  return undefined;
}
