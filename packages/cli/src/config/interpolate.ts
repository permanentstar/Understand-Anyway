/**
 * `{{ }}` placeholder interpolation (Jinja-style).
 *
 * Two placeholder forms are supported inside any string field of a parsed YAML
 * document:
 *   - `{{ KEY }}`          → resolved from shell env, then the fixed `.env` map
 *   - `{{ file('/path') }}` → contents of the file, trimmed
 *
 * This is how secrets reach the config without ever being written into YAML:
 * the YAML only holds the placeholder, the real value comes from env / .env /
 * a dedicated secret file. Resolution order for `{{ KEY }}` is env > dotenv,
 * matching the design's secret source chain (shell env wins). Unresolved
 * placeholders throw, so a missing secret fails fast rather than silently
 * serving an empty value.
 */

export interface InterpolateDeps {
  /** Shell process env (highest priority for `{{ KEY }}`). */
  env?: Record<string, string | undefined>;
  /** Fixed-location `.env` values (fallback for `{{ KEY }}`). */
  dotenv?: Record<string, string>;
  /** Reads a secret file for `{{ file('...') }}`. */
  readFile?: (path: string) => string;
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;
const FILE_FORM = /^file\(\s*(['"])([^'"]+)\1\s*\)$/;

function resolveToken(token: string, deps: Required<InterpolateDeps>): string {
  const fileMatch = FILE_FORM.exec(token);
  if (fileMatch) {
    const path = fileMatch[2]!;
    try {
      return deps.readFile(path).trim();
    } catch (err) {
      throw new Error(`failed to read secret file '${path}': ${(err as Error).message}`);
    }
  }
  const envValue = deps.env[token];
  if (envValue !== undefined) return envValue;
  const dotenvValue = deps.dotenv[token];
  if (dotenvValue !== undefined) return dotenvValue;
  throw new Error(`unresolved config placeholder: {{ ${token} }}`);
}

function interpolateString(value: string, deps: Required<InterpolateDeps>): string {
  return value.replace(PLACEHOLDER, (_match, token: string) => resolveToken(token.trim(), deps));
}

/** Recursively interpolate every string in a parsed config value. */
export function interpolate<T>(value: T, deps: InterpolateDeps = {}): T {
  const resolved: Required<InterpolateDeps> = {
    env: deps.env ?? {},
    dotenv: deps.dotenv ?? {},
    readFile: deps.readFile ?? (() => {
      throw new Error("file() placeholder used but no readFile provided");
    }),
  };
  return walk(value, resolved) as T;
}

function walk(value: unknown, deps: Required<InterpolateDeps>): unknown {
  if (typeof value === "string") return interpolateString(value, deps);
  if (Array.isArray(value)) return value.map((item) => walk(item, deps));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = walk(val, deps);
    }
    return out;
  }
  return value;
}
